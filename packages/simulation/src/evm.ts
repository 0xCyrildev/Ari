/**
 * A real JSON-RPC client for a real chain, written against plain `fetch`.
 *
 * Three things this file is not, and each is why it looks the way it does.
 *
 * It is not a provider SDK. `viem` and `ethers` both pull in a dependency that compiles
 * or patches something at install time, and `pnpm-workspace.yaml`'s `allowBuilds` exists
 * to keep this repository free of those — including for `esbuild`. The surface needed is
 * five methods and a response envelope, which is smaller than the supply-chain decision
 * required to avoid writing it.
 *
 * It is not a fork. `ASSUMPTIONS.md` §1 says anvil is running on this box — true, and it
 * is someone else's anvil on 8545 — and forking needs an upstream RPC URL with a key,
 * which this machine does not have (`cast` fails on every default, `$MAINNET_RPC_URL` is
 * unset). So this provider simulates against whatever chain `chainId` names, and records
 * the block number and timestamp it read on every answer. Nothing here can claim mainnet.
 *
 * It is not allowed to answer about the wrong chain. The guard runs in both directions:
 * the node's `eth_chainId` against the configured one, and the candidate's own
 * `replayProtection.chainId` against the node's. Without it, a request aimed at a state
 * root where the token does not exist returns empty data, and empty data parses as
 * success — which is the one failure mode where simulation makes a dangerous transaction
 * look clean rather than making a safe one look broken.
 */

import { computeDigest } from '@ari/transaction-engine';
import type { CanonicalDigest } from '@ari/schemas';
import { encodable, encodeCall, interpretReturn, type CallRequest } from './encoding.js';
import {
  unavailable,
  type SimulationProvider,
  type SimulationResult,
  type SimulationSubject,
  type UnavailableReason,
} from './index.js';

export interface EvmProviderConfig {
  readonly name?: string;
  readonly url: string;
  /**
   * Decimal, because that is how a candidate names its chain and how a policy is written.
   * The node's hex form is converted at this boundary and the comparison is on integers.
   */
  readonly chainId: string;
  /** `latest`, or a `0x` block number that pins every simulation to one state root. */
  readonly blockTag?: string;
  /**
   * Refuse an answer whose block is older than this many seconds. Off by default, on
   * purpose: a development chain mines on transaction, so an idle hour makes its own head
   * "stale" by wall clock while remaining the only head there is. Turn this on where a
   * chain is expected to produce blocks — and know that switching it on against a node
   * that is not, with a policy that says `onSimulationUnavailable: deny`, converts a quiet
   * endpoint into an outage that looks like a policy decision.
   */
  readonly maxStalenessSeconds?: number;
  readonly timeoutMs?: number;
}

/** A JSON-RPC error object, kept as code + shape rather than as the node's sentence. */
class RpcFailure extends Error {
  constructor(
    readonly code: number,
    readonly data: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'RpcFailure';
  }
}

const SELECTOR_REVERT_STRING = '0x08c379a0'; // Error(string)
// Not hypothetical: **mainnet USDC takes this path.** Verified on-chain 2026-09-29 — a transfer
// from an empty wallet reverts with `Error(string)` ("ERC20: transfer amount exceeds balance"),
// while this repository's own anvil fixture deploys a token that uses the custom errors below. So
// the specific reason an ERC-20 payment failed is reachable by selector on the fixture and
// deliberately *not* reachable on the token the product actually targets. Weighed and kept: the
// wording is the contract author's, and it changes without this repository changing.

/**
 * `keccak256(signature)[0:4]` for the reverts worth naming.
 *
 * The table exists because a node's `message` is a sentence some other project chose. The
 * probe on this box confirmed OpenZeppelin's `ERC20InsufficientBalance` reason string was
 * absent from the JSON-RPC message entirely — so a classifier matching on text would have
 * silently dropped the most common revert in a payment system. A four-byte selector cannot
 * drift with wording.
 */
// Every selector below was produced on this box with `cast sig '<Name>(<types>)'`, and the
// signature is written beside it because the four bytes are only as good as the string they
// came from. The first draft of this table copied five values from a research probe and
// `ERC20InsufficientBalance` was not one of them — 0x37e748ba is somebody else's error.
// A wrong entry here does not fail: it labels one revert as another, which is precisely the
// kind of quiet misreading this repository's own rules say to refuse.
const CUSTOM_ERRORS: readonly { readonly selector: string; readonly name: string; readonly signature: string }[] = [
  { selector: '0xe450d38c', name: 'ERC20_INSUFFICIENT_BALANCE', signature: 'ERC20InsufficientBalance(address,uint256,uint256)' },
  { selector: '0xfb8f41b2', name: 'ERC20_INSUFFICIENT_ALLOWANCE', signature: 'ERC20InsufficientAllowance(address,uint256,uint256)' },
  { selector: '0x96c6fd1e', name: 'ERC20_INVALID_SENDER', signature: 'ERC20InvalidSender(address)' },
  { selector: '0xec442f05', name: 'ERC20_INVALID_RECEIVER', signature: 'ERC20InvalidReceiver(address)' },
  { selector: '0xe602df05', name: 'ERC20_INVALID_APPROVER', signature: 'ERC20InvalidApprover(address)' },
];

/**
 * Map whatever went wrong onto the closed vocabulary in `index.ts`.
 *
 * Provider text never survives as a reason and never decides a branch by itself. With no
 * selector and no structural signal the answer is `REVERT_UNCLASSIFIED` — a name for "it
 * failed and we do not know why", which is worth recording and not worth guessing about.
 */
export function describeError(error: unknown): {
  reason: UnavailableReason | null;
  revert: string | null;
  data: string | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  const named = error instanceof Error ? error.name : '';
  if (named === 'TimeoutError' || named === 'AbortError') {
    return { reason: 'RPC_TIMEOUT', revert: null, data: null, warnings };
  }
  if (!(error instanceof RpcFailure)) {
    // fetch reports a refused connection as a `TypeError` wrapping the syscall error in
    // `cause`, and the syscall code is the part that survives Node versions. Anything
    // without either marker is a bug in this file or in the caller — and both are "we have
    // no answer", never "the chain said no".
    const cause = (error as { cause?: { code?: string } } | null)?.cause;
    const syscall = typeof cause?.code === 'string' ? cause.code : '';
    const unreachable = named === 'TypeError' || /^(ECONN|EHOST|ENET|EAI|ETIMEDOUT|EPFNOSUPPORT)/.test(syscall);
    return {
      reason: unreachable ? 'RPC_UNREACHABLE' : 'RPC_ERROR',
      revert: null,
      data: null,
      warnings: unreachable ? [] : ['the simulation plane raised something this file does not model'],
    };
  }

  const data = error.data;
  if (typeof data === 'string' && data.length >= 10) {
    const selector = data.slice(0, 10).toLowerCase();
    const known = CUSTOM_ERRORS.find((entry) => entry.selector === selector);
    if (known !== undefined) return { reason: null, revert: known.name, data, warnings };
    if (selector === SELECTOR_REVERT_STRING) {
      // `Error(string)` is a standard ABI shape, so its *presence* is classifiable. Its
      // content belongs to whoever wrote the contract, which is why it is not decoded into
      // the audit trail: a reason string is how a project says "insufficient funds" today
      // and something else next release.
      return { reason: null, revert: 'REVERT_WITH_MESSAGE', data, warnings };
    }
    return { reason: null, revert: 'REVERT_CUSTOM_UNKNOWN', data, warnings: [`unrecognised revert selector ${selector}`] };
  }

  // No return data. "execution reverted" on a bare `require(false)` looks like this, and so
  // does an out-of-gas and a node that cannot fetch a block — three different claims, only
  // one of which is about the transaction.
  const message = error.message.toLowerCase();
  if (message.includes('gas') && message.includes('exceed')) {
    return { reason: 'RPC_ERROR', revert: null, data: null, warnings: ['the call needs more gas than the node will spend, which is a question about the node'] };
  }
  if (message.includes('unknown block') || message.includes('cannot fetch') || message.includes('not found')) {
    return { reason: 'BLOCK_UNRESOLVED', revert: null, data: null, warnings };
  }
  if (message.includes('revert')) {
    return { reason: null, revert: 'REVERT_UNCLASSIFIED', data: null, warnings: ['the node reported a revert with no return data to classify'] };
  }
  return { reason: 'RPC_ERROR', revert: null, data: null, warnings: [`json-rpc code ${String(error.code)}`] };
}

const hex = (value: string): string => `0x${BigInt(value).toString(16)}`;

export class EvmForkProvider implements SimulationProvider {
  readonly name: string;
  private readonly url: string;
  private readonly chainId: string;
  private readonly blockTag: string;
  private readonly maxStalenessSeconds: number | undefined;
  private readonly timeoutMs: number;
  /** One id per request. A shared id across two calls makes log correlation impossible. */
  private sequence = 0;

  constructor(config: EvmProviderConfig) {
    const local = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(config.url);
    if (!config.url.startsWith('https://') && !local) {
      // The same rule the operator's tool applies to a bearer secret: plain HTTP is only
      // ever this machine. A simulation request carries no secret, but it carries a wallet
      // address and an intent to move money, and deciding that is safe is not this file's
      // call to make silently.
      throw new Error(`EvmForkProvider url must be https:// or http://127.0.0.1, got ${config.url}`);
    }
    if (!/^\d{1,39}$/.test(config.chainId)) throw new Error('chainId must be a decimal integer');
    const blockTag = config.blockTag ?? 'latest';
    if (blockTag !== 'latest' && !/^0x[0-9a-f]{1,16}$/i.test(blockTag)) {
      throw new Error(`blockTag must be "latest" or a 0x block number, got ${blockTag}`);
    }
    this.url = config.url;
    this.chainId = config.chainId;
    this.blockTag = blockTag;
    this.maxStalenessSeconds = config.maxStalenessSeconds;
    this.timeoutMs = config.timeoutMs ?? 3_000;
    this.name = config.name ?? `evm-${config.chainId}`;
  }

  supports(candidate: Parameters<SimulationProvider['supports']>[0]): boolean {
    return encodable(candidate);
  }

  async simulate(subject: SimulationSubject): Promise<SimulationResult> {
    const requestedAt = Date.now();
    const digest = this.digestOf(subject);
    const refuse = (reason: UnavailableReason, warnings: readonly string[] = []): SimulationResult =>
      unavailable({ provider: this.name, digest, reason, warnings });

    const encoded = encodeCall(subject);
    if (!encoded.ok) {
      // No digest is claimed here: nothing was run, so this answer is about no candidate in
      // particular, and an unbound refusal cannot become a verdict on the binding check.
      return unavailable({ provider: this.name, digest: null, reason: encoded.reason, warnings: [encoded.detail] });
    }

    let nodeChainId: string;
    try {
      nodeChainId = BigInt(await this.rpc<string>('eth_chainId', [])).toString();
    } catch (error) {
      const described = describeError(error);
      return refuse(described.reason ?? 'RPC_UNREACHABLE', described.warnings);
    }
    if (nodeChainId !== this.chainId) {
      return refuse('CHAIN_ID_MISMATCH', [`the node answered ${nodeChainId}, this provider is configured for ${this.chainId}`]);
    }
    const askedChainId =
      subject.candidate.kind === 'unknown' || subject.candidate.replayProtection.scheme !== 'account_sequence'
        ? null
        : subject.candidate.replayProtection.chainId;
    if (askedChainId !== null && /^\d{1,39}$/.test(askedChainId) && askedChainId !== nodeChainId) {
      return refuse('CHAIN_ID_MISMATCH', [`the candidate names chain ${askedChainId}, the node is on ${nodeChainId}`]);
    }

    let blockNumber: string;
    let blockTimestampSeconds: number;
    try {
      blockNumber = this.blockTag === 'latest' ? await this.rpc<string>('eth_blockNumber', []) : hex(this.blockTag);
      const block = await this.rpc<{ number: string; timestamp: string } | null>('eth_getBlockByNumber', [blockNumber, false]);
      if (block === null || typeof block.timestamp !== 'string') {
        // A pinned block the node has since dropped is a different question than a node
        // that is down, and it must not be answered by quietly simulating at the head
        // instead — the caller pinned it because the head was not the state in question.
        return refuse('BLOCK_UNRESOLVED', [`this node has no block ${blockNumber}`]);
      }
      blockTimestampSeconds = Number(BigInt(block.timestamp));
    } catch (error) {
      const described = describeError(error);
      return refuse(described.reason ?? 'BLOCK_UNRESOLVED', described.warnings);
    }

    if (this.maxStalenessSeconds !== undefined) {
      const ageSeconds = Math.round(requestedAt / 1000) - blockTimestampSeconds;
      if (ageSeconds > this.maxStalenessSeconds) {
        return refuse('BLOCK_STALE', [`the block is ${String(ageSeconds)}s old and the bound is ${String(this.maxStalenessSeconds)}s`]);
      }
    }

    const base = {
      provider: this.name,
      // True on the type, and it earns it: this answer came from a node that identified
      // itself, on the chain this provider is configured for, at a block that exists.
      trustworthy: true,
      digest,
      chainId: nodeChainId,
      blockNumber,
      blockTimestampSeconds,
      requestedAt,
    } as const;

    // The gate that keeps a missing contract out of the "succeeded" column. An `eth_call`
    // to an address with no code returns `0x`, and `0x` is also what a real token returns
    // on success when it does not implement the boolean — so a payment to an ordinary
    // account, or to a contract that was never deployed on this chain, would otherwise be
    // reported as a simulation that passed. `eth_estimateGas` does the same (21 000, no
    // error), so there is no cheaper proxy for "something is there".
    try {
      const code = await this.rpc<string>('eth_getCode', [encoded.call.to, blockNumber]);
      if (code === '0x' || code === '0x0' || code === '') {
        return refuse('TARGET_HAS_NO_CODE', [`nothing is deployed at ${encoded.call.to} at block ${blockNumber}`]);
      }
    } catch (error) {
      const described = describeError(error);
      return refuse(described.reason ?? 'RPC_ERROR', described.warnings);
    }

    let returned: string;
    try {
      returned = await this.rpc<string>('eth_call', [toCallParam(encoded.call), blockNumber]);
    } catch (error) {
      const described = describeError(error);
      if (described.revert === null) return refuse(described.reason ?? 'RPC_ERROR', described.warnings);
      return {
        ...base,
        status: 'SIMULATED_REVERT',
        available: true,
        success: false,
        mismatch: false,
        warningCount: described.warnings.length,
        warnings: described.warnings,
        reason: null,
        revert: described.revert,
        gasUsed: null,
        returnData: described.data,
      };
    }

    const data = returned === '0x' || returned === '' ? '0x' : returned;
    // Only a token transfer has a documented return to read. A `contract_call`'s calldata
    // belongs to whoever wrote the contract, and guessing what its output means is exactly
    // the kind of inference this repository's own rules refuse to make.
    const interpreted = encoded.call.what === 'erc20-transfer' ? interpretReturn(data) : { succeeded: true, warning: null };
    const warnings = interpreted.warning === null ? [] : [interpreted.warning];
    return {
      ...base,
      status: 'SIMULATED_OK',
      // `false` from a token is neither a revert nor a success: the call would run and move
      // nothing, which is the one answer a payment system must not read as clean.
      available: true,
      success: interpreted.succeeded,
      mismatch: false,
      warningCount: warnings.length,
      warnings,
      reason: null,
      revert: null,
      gasUsed: null,
      returnData: data,
    };
  }

  private digestOf(subject: SimulationSubject): CanonicalDigest {
    // Imported, never reimplemented: one canonicaliser, one allowlist, and the digest this
    // answer carries is comparable with the one the kernel evaluated.
    return computeDigest(subject.candidate, { policyVersionId: subject.policyVersionId });
  }

  private async rpc<T>(method: string, params: readonly unknown[]): Promise<T> {
    this.sequence += 1;
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.sequence, method, params }),
      // Per call, and no retry: a silent retry turns one timeout into two rounds against a
      // node that is already not answering, and each with an id a log cannot correlate.
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new RpcFailure(-1, null, `http ${String(response.status)}`);
    const body = (await response.json().catch(() => null)) as
      | { result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
      | null;
    if (body === null) throw new RpcFailure(-1, null, 'unparseable json-rpc envelope');
    if (body.error !== undefined) {
      throw new RpcFailure(body.error.code ?? -1, typeof body.error.data === 'string' ? body.error.data : null, body.error.message ?? 'json-rpc error');
    }
    if (body.result === undefined) throw new RpcFailure(-1, null, 'json-rpc result is missing');
    return body.result as T;
  }
}

function toCallParam(call: CallRequest): Record<string, string> {
  return { from: call.from, to: call.to, data: call.data, value: call.value };
}
