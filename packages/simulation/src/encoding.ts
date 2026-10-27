/**
 * Candidate → `eth_call`, and nothing else.
 *
 * Two of the three shapes a candidate can have need no ABI knowledge at all: a
 * `contract_call` already carries the selector and calldata the agent asked for, so
 * simulating it is passing them along. A token `transfer` is the one place this file has
 * to *build* bytes from a claim, and that is exactly where an encoder could become a
 * second source of truth about what a payment is — so the encoding is a total function
 * over a parsed candidate, it reads only fields the digest already commits to
 * (`recipient.address`, `amount.raw`, `asset.contract`), and its output is checked
 * against `cast calldata` output in `packages/simulation/test/encoding.test.ts`.
 *
 * Nothing here accepts a raw string from a caller. If it did, the bytes simulated and
 * the bytes signed would be chosen by whoever sent the request.
 */

import type { CandidateTransaction } from '@ari/schemas';
import type { SimulationSubject } from './index.js';

/**
 * The two ERC-20 selectors, as `keccak256(sig)[0:4]`.
 *
 * Verified on this box with `cast sig 'transfer(address,uint256)'` and
 * `cast sig 'approve(address,uint256)'`; `encoding.test.ts` asserts both against stored
 * `cast calldata` vectors, because these four bytes are the difference between moving
 * someone's USDC and approving an allowance, and a typo here is not a typo the type
 * system can see.
 */
export const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';
export const ERC20_APPROVE_SELECTOR = '0x095ea7b3';

/**
 * Could a candidate of this shape be encoded at all, ignoring whose wallet it is?
 *
 * The question `SimulationProvider.supports` answers, and it is deliberately separable
 * from `encodeCall`: the pipeline asks this one before reading any row, so a tenant on
 * bitcoin does not pay for a grant lookup to be told there is nothing to simulate.
 */
export function encodable(candidate: CandidateTransaction): boolean {
  if (candidate.kind === 'unknown' || candidate.chain !== 'ethereum') return false;
  if (candidate.kind === 'contract_call') return true;
  return candidate.asset.kind === 'erc20';
}

export interface CallRequest {
  readonly to: string;
  readonly data: string;
  readonly from: string;
  /** Hex, and `0x0` for a token transfer: an ERC-20 movement carries no native value. */
  readonly value: string;
  readonly what: 'erc20-transfer' | 'contract-call';
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HEX = /^0x[0-9a-f]*$/;

/** Left-padded to 32 bytes, the way every ABI word is written. */
export function pad32(hexNoPrefix: string): string {
  return hexNoPrefix.padStart(64, '0');
}

export function uint256Hex(value: bigint): string {
  if (value < 0n) throw new Error('a uint256 word cannot be negative');
  // The upper bound is not pedantry. `pad32` pads and never truncates, so without this check an amount
  // of 2^256 produced a **68.5-byte** calldata — odd-length hex, not a call anyone can decode — and the
  // node's answer about it came back as a revert. That is a defect in our encoder reported as a fact
  // about the chain, which is the one thing this package's `available` distinction exists to prevent.
  // `amount.raw` is an unbounded non-negative bigint by design, so the reach is a caller's.
  if (value >= 1n << 256n) throw new Error(`the amount ${value} does not fit a uint256 word`);
  return value.toString(16);
}

/** A lowercase `0x` + 40 hex address as a 32-byte ABI word (left-padded, no sign extension). */
export function addressWord(address: string): string {
  if (!ADDRESS.test(address)) throw new Error(`not an EVM address: ${address.slice(0, 10)}…`);
  return pad32(address.slice(2));
}

export function encodeTransfer(recipient: string, amountRaw: bigint): string {
  return `${ERC20_TRANSFER_SELECTOR}${addressWord(recipient)}${pad32(uint256Hex(amountRaw))}`;
}

/**
 * What to ask the node, or why there is nothing to ask.
 *
 * `null` is returned with a named reason rather than throwing: "this candidate cannot be
 * simulated" is an ordinary answer for a bitcoin request, and the pipeline has to be able
 * to hand it to a policy's fallback instead of catching an exception that means the same
 * thing as a node being down.
 */
export function encodeCall(subject: SimulationSubject):
  | { readonly ok: true; readonly call: CallRequest }
  | {
      readonly ok: false;
      readonly reason: 'NOT_SUPPORTED_BY_PROVIDER' | 'WALLET_ADDRESS_UNKNOWN' | 'VALUE_NOT_UINT256';
      readonly detail: string;
    } {
  const { candidate, walletAddress } = subject;

  if (candidate.kind === 'unknown') {
    return { ok: false, reason: 'NOT_SUPPORTED_BY_PROVIDER', detail: `unrecognised transaction: ${candidate.reason}` };
  }
  if (candidate.chain !== 'ethereum') {
    return { ok: false, reason: 'NOT_SUPPORTED_BY_PROVIDER', detail: `no EVM call for chain "${candidate.chain}"` };
  }
  if (walletAddress === null || !ADDRESS.test(walletAddress)) {
    return {
      ok: false,
      reason: 'WALLET_ADDRESS_UNKNOWN',
      detail: 'an eth_call needs a `from`, and no address is recorded for this wallet',
    };
  }

  if (candidate.kind === 'contract_call') {
    if (!HEX.test(candidate.selector) || !HEX.test(candidate.calldata)) {
      // The schema already requires both, so reaching here means a caller built a candidate
      // without parsing it — which is a bug worth naming rather than a chain question worth
      // asking with half-encoded bytes.
      return { ok: false, reason: 'NOT_SUPPORTED_BY_PROVIDER', detail: 'selector and calldata must be hex' };
    }
    return {
      ok: true,
      call: {
        to: candidate.contract,
        data: `${candidate.selector}${candidate.calldata.slice(2)}`,
        from: walletAddress,
        value: `0x${candidate.value.toString(16)}`,
        what: 'contract-call',
      },
    };
  }

  // A transfer of native ETH would need an address to send *to* and a value to move; the
  // asset grammar says `native`, and the amount is in that unit. There is no recipient
  // field ambiguity there either, so this could be encoded — but the policy language has no
  // native-value limit to bound it with (the same unit-confusion `CONTRACT_VALUE_NOT_PERMITTED`
  // refuses for a contract call), so the kernel denies a native transfer before any
  // simulation of it could matter. Refuse to answer rather than simulate a candidate that
  // can never be authorised, which would be a claim about a payment system that does not
  // exist.
  if (candidate.asset.kind !== 'erc20') {
    return {
      ok: false,
      reason: 'NOT_SUPPORTED_BY_PROVIDER',
      detail: `no encoding for a ${candidate.asset.kind} transfer, and none should be invented here`,
    };
  }

  let data: string;
  try {
    data = encodeTransfer(candidate.recipient.address, candidate.amount.raw);
  } catch (error) {
    // A refusal with a name, not a throw: a caller that catches an exception here cannot tell this
    // apart from a broken wallet address, and the two have different answers for an operator.
    const message = error instanceof Error ? error.message : 'the ABI word could not be encoded';
    return { ok: false, reason: 'VALUE_NOT_UINT256', detail: message };
  }

  return {
    ok: true,
    call: {
      to: candidate.asset.contract,
      data,
      from: walletAddress,
      value: '0x0',
      what: 'erc20-transfer',
    },
  };
}

/**
 * What an ERC-20 `transfer` actually returned, read without optimism.
 *
 * The standard says `bool`; real tokens return nothing at all (USDT), or nothing on
 * success and a revert on failure. A zero-length return is therefore *not* a failure —
 * but it is not the promise the standard makes either, so it is recorded as a warning
 * rather than silently accepted. The one thing that must never be silently accepted is
 * `false`, which means the call would succeed and move nothing.
 */
export function interpretReturn(data: string): { readonly succeeded: boolean; readonly warning: string | null } {
  if (data === '0x' || data === '') {
    return { succeeded: true, warning: 'the token returned no value, which the ERC-20 ABI permits and the standard does not require' };
  }
  if (data === `0x${pad32('1')}`) return { succeeded: true, warning: null };
  if (data === `0x${pad32('0')}`) return { succeeded: false, warning: null };
  return { succeeded: true, warning: `unrecognised return encoding: ${data.slice(0, 18)}…` };
}
