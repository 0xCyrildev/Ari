/**
 * The encoding layer's own tests — the file `encoding.ts`'s header has cited since it was written,
 * and which did not exist until 2026-10-27.
 *
 * What is checked against the outside world rather than against this repository's own reasoning:
 * the two selectors and the `transfer` calldata are `cast sig` / `cast calldata` output, inlined as
 * literals with their provenance so the suite needs no toolchain to run. The first version of this
 * file's ground truth was copied from a research probe once and was wrong (`0x37e748ba` for
 * `ERC20InsufficientBalance`), which is the exact failure mode these literals exist to prevent.
 *
 * The last block is the one that matters most for the platform: `@ari/simulation` and
 * `@ari/chain-evm` both know how to build `transfer(address,uint256)` bytes — one for `eth_call`,
 * one for the envelope that gets signed. Two encoders for the same payment is the drift this repo
 * names as the T10 shape, and the honest guard is a byte-for-byte agreement test, not a comment
 * asking people to keep them in step. If they ever disagree, the simulated call and the signed
 * transaction are about different payments while `simBound` still reads green.
 */

import { CandidateTransaction } from '@ari/schemas';
// A path import, not `@ari/chain-evm`: adding the workspace package as a devDependency needs a lockfile
// change, and `pnpm install --offline` refuses one here (supply-chain policy check on 188 entries plus no
// mirror for `es-module-lexer`). A test that cannot be installed deterministically is a test that will
// pass on one machine and error on another, so the drift guard reaches the other encoder by path.
import { encodeErc20TransferCalldata } from '../../chain-evm/src/construct.js';
import { describe, expect, it } from 'vitest';
import {
  ERC20_APPROVE_SELECTOR,
  ERC20_TRANSFER_SELECTOR,
  addressWord,
  encodable,
  encodeCall,
  encodeTransfer,
  interpretReturn,
  pad32,
  uint256Hex,
} from '../src/encoding.js';
import type { SimulationSubject } from '../src/index.js';

const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const UINT256_MAX = (1n << 256n) - 1n;

const commonFields = {
  requestId: 'req_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
  agentId: 'agt_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
  walletId: 'wal_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
  deadline: '2026-12-31T23:59:59.000Z',
  idempotencyKey: 'inv-1',
  usdEstimate: null,
  replayProtection: {
    scheme: 'account_sequence',
    nonce: '12',
    chainId: '1',
    gasLimit: '21000',
    maxFeePerUnit: '20000000000',
    maxPriorityFeePerUnit: '1000000000',
  },
};

const parse = (input: Record<string, unknown>) => {
  const parsed = CandidateTransaction.safeParse(input);
  if (!parsed.success) throw new Error(`candidate rejected: ${parsed.error.message}`);
  return parsed.data;
};

/** A `transfer` candidate. `.strict()` means the variants cannot be mixed by override — see contractCallFor. */
const candidateFor = (over: Record<string, unknown> = {}) => parse({
  kind: 'transfer',
  chain: 'ethereum',
    asset: { kind: 'erc20', chain: 'ethereum', contract: TOKEN, symbol: 'USDC', decimals: 6 },
    amount: { raw: '2000000000', unit: 'usdc-6dp' },
    recipient: { chain: 'ethereum', address: RECIPIENT },
    ...commonFields,
    ...over,
  });

/** A `contract_call` candidate, built as its own variant rather than by overriding a transfer. */
const contractCallFor = (over: Record<string, unknown> = {}) => parse({
  kind: 'contract_call',
  chain: 'ethereum',
  contract: TOKEN,
  selector: '0x095ea7b3',
  calldata: '0x',
  value: '0',
  ...commonFields,
  ...over,
});

/** The `unknown` variant has no asset, recipient or replay protection, so it cannot be built by override. */
const unknownFor = (reason: string, reportedChain: string) => parse({
  kind: 'unknown',
  reason,
  reportedChain,
  requestId: commonFields.requestId,
  agentId: commonFields.agentId,
  walletId: commonFields.walletId,
  deadline: commonFields.deadline,
  idempotencyKey: commonFields.idempotencyKey,
  usdEstimate: null,
});

const subject = (candidate: CandidateTransaction, walletAddress: string | null = WALLET): SimulationSubject =>
  ({ candidate, walletAddress, policyVersionId: 'ppv_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b' });

describe('the selectors, against cast', () => {
  // cast sig 'transfer(address,uint256)'  /  cast sig 'approve(address,uint256)'  — foundry 1.8.1.
  it('are what cast says they are', () => {
    expect(ERC20_TRANSFER_SELECTOR).toBe('0xa9059cbb');
    expect(ERC20_APPROVE_SELECTOR).toBe('0x095ea7b3');
  });

  it('are not each other, because a swap pays nothing and grants an allowance', () => {
    expect(ERC20_TRANSFER_SELECTOR).not.toBe(ERC20_APPROVE_SELECTOR);
  });
});

describe('encodeTransfer, against cast', () => {
  // cast calldata 'transfer(address,uint256)' 0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c 2000000000
  it('byte-matches cast for an ordinary amount', () => {
    expect(encodeTransfer(RECIPIENT, 2_000_000_000n)).toBe(
      '0xa9059cbb0000000000000000000000003f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c'
      + '0000000000000000000000000000000000000000000000000000000077359400',
    );
  });

  // cast calldata 'transfer(address,uint256)' 0x3f2a… 115792089237316195423570985008687907853269984665640564039457584007913129639935
  it('byte-matches cast at type(uint256).max, the largest legal word', () => {
    expect(encodeTransfer(RECIPIENT, UINT256_MAX)).toBe(
      '0xa9059cbb0000000000000000000000003f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c' + 'f'.repeat(64),
    );
  });

  it('is always 68 bytes when it succeeds, which is what an ERC-20 transfer is', () => {
    for (const amount of [0n, 1n, 2_000_000_000n, UINT256_MAX]) {
      expect((encodeTransfer(RECIPIENT, amount).length - 2) / 2).toBe(68);
    }
  });
});

describe('the uint256 boundary, and why it is a refusal rather than a longer word', () => {
  it('refuses an amount above the word instead of emitting malformed calldata', () => {
    // pad32 pads and never truncates, so the unguarded version of this produced a 68.5-byte string for
    // 2^256 — odd-length hex, not a call — and the node's answer about it was indistinguishable from a
    // real revert. `amount.raw` is an unbounded non-negative bigint, so an agent could reach this.
    expect(() => uint256Hex(1n << 256n)).toThrow(/does not fit a uint256/);
    expect(() => encodeTransfer(RECIPIENT, 1n << 256n)).toThrow(/does not fit a uint256/);
    expect(() => uint256Hex(-1n)).toThrow(/negative/);
  });

  it('surfaces as a named refusal at the call boundary, not a thrown error on the request path', () => {
    const answer = encodeCall(subject(candidateFor({ amount: { raw: (1n << 256n).toString(), unit: 'usdc-6dp' } })));
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('an unencodable amount was simulated anyway');
    expect(answer.reason).toBe('VALUE_NOT_UINT256');
    expect(answer.detail).toMatch(/uint256/);
  });

  it('documents that pad32 itself does not truncate — the guard is upstream', () => {
    expect(pad32('a'.repeat(70)).length).toBe(70);
  });

  it('refuses an address that is not exactly a lowercase 20-byte one', () => {
    expect(() => addressWord('0x3F2A1B0C4D5E6F708192A3B4C5D6E7F8091A2B3C')).toThrow(/EVM address/);
    expect(() => addressWord('0xdeadbeef')).toThrow(/EVM address/);
    expect(addressWord(RECIPIENT)).toBe(`${'0'.repeat(24)}${RECIPIENT.slice(2)}`);
  });
});

describe('encodable — the shape question, answered before any row is read', () => {
  it('is true for an ERC-20 transfer and a contract call', () => {
    expect(encodable(candidateFor())).toBe(true);
    expect(encodable(contractCallFor())).toBe(true);
  });

  it('is false for a native transfer, an unknown chain and a bitcoin request', () => {
    expect(encodable(candidateFor({
      asset: { kind: 'native', chain: 'ethereum' }, amount: { raw: '1', unit: 'eth-wei' },
    }))).toBe(false);
    // `chain` is a closed enum, so an unsupported chain arrives as the `unknown` variant — which is
    // exactly the shape Principle 16 says must be deniable with a reason rather than refused by a parser.
    const bitcoin = candidateFor({
      chain: 'bitcoin',
      asset: { kind: 'native', chain: 'bitcoin' },
      amount: { raw: '1', unit: 'sat' },
      recipient: { chain: 'bitcoin', address: 'bc1qexampleaddress' },
    });
    // Narrowed before reading `chain`: `unknown` has no chain field, which is the point of that variant.
    if (bitcoin.kind !== 'transfer') throw new Error('expected the transfer variant');
    expect(bitcoin.chain).toBe('bitcoin');
    expect(encodable(bitcoin)).toBe(false);
    expect(encodable(unknownFor('chain not supported: sui', 'sui'))).toBe(false);
  });
});

describe('encodeCall refusals and the two call shapes', () => {
  it('refuses when the wallet has no chain address, naming that reason', () => {
    const answer = encodeCall(subject(candidateFor(), null));
    expect(answer.ok).toBe(false);
    if (answer.ok) throw new Error('a wallet with no address produced a call');
    expect(answer.reason).toBe('WALLET_ADDRESS_UNKNOWN');
  });

  it('carries the candidate value as hex for a contract call, and zero for a token transfer', () => {
    const call = encodeCall(subject(candidateFor()));
    expect(call.ok).toBe(true);
    if (!call.ok) throw new Error('expected a call');
    expect(call.call).toMatchObject({ to: TOKEN, from: WALLET, value: '0x0', what: 'erc20-transfer' });

    const rawCall = encodeCall(subject(contractCallFor({ value: '255' })));
    if (!rawCall.ok) throw new Error(`expected a call: ${JSON.stringify(rawCall)}`);
    expect(rawCall.call.value).toBe('0xff');
    expect(rawCall.call.what).toBe('contract-call');
    expect(rawCall.call.data).toBe('0x095ea7b3');
  });
});

describe('interpretReturn — what a token actually said', () => {
  it('reads a zero-length return as success with a warning, because USDT returns nothing', () => {
    expect(interpretReturn('0x')).toEqual({
      succeeded: true,
      warning: 'the token returned no value, which the ERC-20 ABI permits and the standard does not require',
    });
    expect(interpretReturn('').succeeded).toBe(true);
  });

  it('reads false as a failure, which is the one answer that must not be optimistic', () => {
    expect(interpretReturn(`0x${pad32('0')}`)).toEqual({ succeeded: false, warning: null });
    expect(interpretReturn(`0x${pad32('1')}`)).toEqual({ succeeded: true, warning: null });
  });

  it('does not silently accept an unrecognised encoding', () => {
    const odd = interpretReturn(`0x${pad32('2')}`);
    expect(odd.succeeded).toBe(true);
    expect(odd.warning).toMatch(/unrecognised return encoding/);
  });
});

describe('the two ERC-20 encoders in this repository agree byte for byte', () => {
  const amounts = [0n, 1n, 2_000_000_000n, 10n ** 18n, UINT256_MAX];

  it('encode the same bytes as @ari/chain-evm, which is what gets signed', () => {
    for (const amount of amounts) {
      expect(encodeTransfer(RECIPIENT, amount)).toBe(encodeErc20TransferCalldata(RECIPIENT, amount));
    }
  });

  it('refuse the same amounts, so neither can build what the other rejects', () => {
    const tooBig = 1n << 256n;
    let simulationThrew = false;
    let evmThrew = false;
    try { encodeTransfer(RECIPIENT, tooBig); } catch { simulationThrew = true; }
    try { encodeErc20TransferCalldata(RECIPIENT, tooBig); } catch { evmThrew = true; }
    expect([simulationThrew, evmThrew]).toEqual([true, true]);
  });
});
