/**
 * Turning a candidate into the chain artifact its ticket must name.
 *
 * Two planes have to agree on bytes without trusting each other: the decision plane builds the
 * signing payload and seals its digest into the ticket, and `ari-signer` re-derives a digest from
 * whatever bytes it is handed and compares. This file is the first half. It is deliberately a leaf:
 * it reads no database and opens no socket, because the alternative — a "what will be signed" answer
 * that depends on a network call — cannot be replayed, pinned, or reviewed after the fact.
 *
 * What it refuses, and why each refusal is a refusal rather than a default:
 *
 *   - **A wallet with no chain address.** The sender is not recoverable from an unsigned payload and
 *     this build performs no ECDSA recovery, so the address the deployment registered for the wallet
 *     *is* the assertion about who signs. Guessing one would put a sentence in the ticket that nothing
 *     checked.
 *   - **A token the deployment has not declared.** `decimals` and `symbol` decide the asset identity a
 *     limit is compared against. The candidate carries both, and the candidate is written by the agent
 *     asking to pay — so trusting it would let a request pick its own asset, which is the same class of
 *     bug as letting it pick its own price feed.
 *   - **Any chain other than EVM today.** `@ari/chain-sui` can decode but nothing constructs Sui bytes
 *     yet. A ticket for a chain that cannot name its bytes must not exist, so this says so.
 */

import { createHash } from 'node:crypto';
import type { CandidateTransaction } from '@ari/schemas';
import type { ChainArtifact } from '@ari/ledger';
import {
  constructEvmTransaction,
  type EvmValidationPolicy,
  type NetworkId,
} from '@ari/chain-evm';

export interface ChainBindingConfig {
  /** The chain families this deployment will mint tickets for. Anything else refuses at minting. */
  readonly supported: readonly ('evm' | 'sui' | 'solana')[];
  /** Human-readable network label recorded on the artifact; `identifier` is what binds. */
  readonly networkName: NetworkId['name'];
  /** Decimal `chainId`s this deployment signs for. A candidate naming another is a replay risk. */
  readonly allowedChainIds: readonly string[];
  /** Upper bound on `gasLimit × maxFeePerGas`, in wei. */
  readonly maxFeeCostWei: bigint;
  readonly maxGasLimit: bigint;
  /**
   * Operator-declared token metadata, keyed by lowercase contract address. This is the only honest
   * source of `decimals` for an ERC-20: the candidate states it too, and the candidate is the agent's.
   */
  readonly tokens: Readonly<Record<string, { readonly decimals: bigint; readonly symbol: string }>>;
}

export type ChainArtifactResult =
  | { readonly ok: true; readonly artifact: ChainArtifact }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

export function chainArtifactFor(
  candidate: CandidateTransaction,
  walletAddress: string | null,
  config: ChainBindingConfig,
): ChainArtifactResult {
  if (!config.supported.includes('evm')) {
    return { ok: false, reason: 'CHAIN_UNSUPPORTED', detail: `this deployment mints for no chain family (${config.supported.join(',') || 'none'})` };
  }
  if (candidate.kind === 'unknown' || candidate.chain !== 'ethereum') {
    return {
      ok: false,
      reason: 'CHAIN_UNSUPPORTED',
      detail: `no construction path for chain ${candidate.kind === 'unknown' ? candidate.reportedChain : candidate.chain}; only EVM signing payloads are built in this build`,
    };
  }
  if (walletAddress === null || !EVM_ADDRESS.test(walletAddress)) {
    return {
      ok: false,
      reason: 'WALLET_ADDRESS_UNKNOWN',
      detail: 'the ticket must name a signer, and an unsigned payload asserts no sender — the wallet row carries no address',
    };
  }

  // Evidence for the token the envelope will call. `contract_call` on an unknown selector needs none,
  // and `constructEvmTransaction` refuses that shape before metadata is ever consulted.
  const contract = candidate.kind === 'transfer' ? (candidate.asset.kind === 'erc20' ? candidate.asset.contract : null) : candidate.contract;
  const declared = contract === null ? undefined : config.tokens[contract.toLowerCase()];
  // A mutable local, widened to the barrel's readonly shape only when it is handed over.
  const evidenceEntries: { id: string; contentBase64: string; contentHash: string; readAtSlotOrEpoch: bigint }[] = [];
  if (contract !== null) {
    if (declared === undefined) {
      return {
        ok: false,
        reason: 'ASSET_NOT_DECLARED',
        detail: `token ${contract} is not in this deployment's asset registry; decimals and symbol come from the operator, never from the request that is asking to spend`,
      };
    }
    const content = Buffer.from(JSON.stringify({ decimals: declared.decimals.toString(), symbol: declared.symbol })).toString('base64');
    evidenceEntries.push({
      id: contract,
      contentBase64: content,
      contentHash: createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex'),
      readAtSlotOrEpoch: 0n,
    });
  }

  const policy: EvmValidationPolicy = {
    allowedChainIds: new Set(config.allowedChainIds),
    maxFeeCostWei: config.maxFeeCostWei,
    maxGasLimit: config.maxGasLimit,
    signerAddress: walletAddress,
    // No observed sequence yet: `@ari/simulation` speaks five methods and `eth_getTransactionCount`
    // is not one of them, so the guard stays open and `validate.ts` simply does not apply it. A
    // caller-chosen nonce is therefore still possible — recorded as an open item, not papered over.
    expectedNonce: null,
  };
  const network: NetworkId = { name: config.networkName, identifier: candidate.replayProtection.scheme === 'account_sequence' ? candidate.replayProtection.chainId : '0' };

  const result = constructEvmTransaction(candidate, network, { entries: evidenceEntries, readBy: 'ari-api chain-artifact' }, policy);
  if (!result.supported) {
    return { ok: false, reason: result.reason, detail: result.detail };
  }

  return {
    ok: true,
    artifact: {
      chain: result.chain,
      signingDigest: result.signingDigest,
      // Null on EVM: the transaction hash covers the signature and no signature exists yet.
      txDigest: result.txDigest,
      bytesSha256: result.bytesSha256,
      byteLength: result.byteLength,
    },
  };
}
