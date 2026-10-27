import type { ContractCallTx, TransferTx, UnknownTx } from '@ari/schemas';
import { CandidateTransaction } from '@ari/schemas';

export const UUID_A = '0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';
export const UUID_B = '0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5c';

export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
export const OTHER_RECIPIENT = '0x9bc1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9';

/**
 * A parsed candidate, so every bigint is a real bigint and every address has
 * already survived normalisation. Fixtures that skip the schema would be testing
 * a shape the system never sees.
 */
export function transfer(overrides: Record<string, unknown> = {}): TransferTx {
  const parsed = CandidateTransaction.safeParse({
    kind: 'transfer',
    chain: 'ethereum',
    requestId: `req_${UUID_A}`,
    agentId: `agt_${UUID_A}`,
    walletId: `wal_${UUID_A}`,
    deadline: '2026-09-25T12:00:00.000Z',
    idempotencyKey: 'inv-1',
    usdEstimate: null,
    asset: { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 },
    amount: { raw: '2000000000', unit: 'usdc-6dp' },
    recipient: { chain: 'ethereum', address: RECIPIENT },
    replayProtection: {
      scheme: 'account_sequence',
      nonce: '12',
      chainId: '1',
      gasLimit: '21000',
      maxFeePerUnit: '20000000000',
      maxPriorityFeePerUnit: '1000000000',
    },
    ...overrides,
  });
  if (!parsed.success) throw new Error(`fixture is not a valid candidate: ${parsed.error.message}`);
  if (parsed.data.kind !== 'transfer') throw new Error('fixture is not a transfer');
  return parsed.data;
}

export function contractCall(overrides: Record<string, unknown> = {}): ContractCallTx {
  const parsed = CandidateTransaction.safeParse({
    kind: 'contract_call',
    chain: 'ethereum',
    requestId: `req_${UUID_A}`,
    agentId: `agt_${UUID_A}`,
    walletId: `wal_${UUID_A}`,
    deadline: '2026-09-25T12:00:00.000Z',
    idempotencyKey: 'inv-2',
    usdEstimate: null,
    contract: USDC,
    selector: '0xa9059cbb',
    calldata: '0x',
    value: '0',
    replayProtection: {
      scheme: 'account_sequence',
      nonce: '7',
      chainId: '1',
      gasLimit: '21000',
      maxFeePerUnit: '20000000000',
      maxPriorityFeePerUnit: '1000000000',
    },
    ...overrides,
  });
  if (!parsed.success) throw new Error(`fixture is not a valid candidate: ${parsed.error.message}`);
  if (parsed.data.kind !== 'contract_call') throw new Error('fixture is not a contract call');
  return parsed.data;
}

export function unknownTx(overrides: Record<string, unknown> = {}): UnknownTx {
  const parsed = CandidateTransaction.safeParse({
    kind: 'unknown',
    reason: 'chain not supported: sui',
    reportedChain: 'sui',
    requestId: `req_${UUID_A}`,
    agentId: `agt_${UUID_A}`,
    walletId: `wal_${UUID_A}`,
    deadline: '2026-09-25T12:00:00.000Z',
    idempotencyKey: 'inv-3',
    usdEstimate: null,
    ...overrides,
  });
  if (!parsed.success) throw new Error(`fixture is not a valid candidate: ${parsed.error.message}`);
  if (parsed.data.kind !== 'unknown') throw new Error('fixture is not an unknown transaction');
  return parsed.data;
}

/** Deep clone that survives bigint and Uint8Array, for mutation-based tests. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

export const CTX = { policyVersionId: `ppv_${UUID_A}` } as const;

/** Set of candidate top-level keys, derived from the schemas rather than typed by hand. */
export function candidateKeys(variant: 'transfer' | 'contract_call' | 'unknown'): string[] {
  const options = CandidateTransaction.options as unknown as { shape: Record<string, unknown> }[];
  const index = variant === 'transfer' ? 0 : variant === 'contract_call' ? 1 : 2;
  return Object.keys(options[index]!.shape);
}
