import { CandidateTransaction, newId } from '@ari/schemas';
import { chainDigestOf } from '@ari/chain-core';
/** Built through the only constructor, not cast — that is what the brand exists to force. */
const sealedDigest = (fill: number) => chainDigestOf('evm/keccak256-signing-v1', new Uint8Array(32).fill(fill));
import { canonicalize, computeDigest } from '@ari/transaction-engine';
import { claimsFor, TICKET_TTL_MS, type TicketRequest } from '../src/index.js';

export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
export const NOVEL = '0x9bc1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9';

export const walletId = newId('wal');
export const agentId = newId('agt');
export const policyVersionId = newId('ppv');
export const ISSUED_AT = 1_761_400_000_000n;

export const GOOD_KEY = 'k'.repeat(48);
export const OTHER_KEY = 'm'.repeat(48);

export function candidate(overrides: Record<string, unknown> = {}) {
  const parsed = CandidateTransaction.safeParse({
    kind: 'transfer',
    chain: 'ethereum',
    requestId: newId('req'),
    agentId,
    walletId,
    deadline: '2026-10-25T12:00:00.000Z',
    idempotencyKey: newId('req'),
    usdEstimate: null,
    asset: { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 },
    amount: { raw: '2000000000', unit: 'usdc-6dp' },
    recipient: { chain: 'ethereum', address: RECIPIENT },
    replayProtection: { scheme: 'account_sequence', nonce: '12', chainId: '1', gasLimit: '21000', maxFeePerUnit: '20000000000', maxPriorityFeePerUnit: '1000000000' },
    ...overrides,
  });
  if (!parsed.success) throw new Error(`candidate fixture invalid: ${parsed.error.message}`);
  const canonical = canonicalize(parsed.data, { policyVersionId });
  return { candidate: parsed.data, canonical, digest: computeDigest(parsed.data, { policyVersionId }) };
}

/** The claims a legitimately authorised ticket would carry. */
export function request(overrides: Partial<TicketRequest> = {}): TicketRequest {
  const { digest } = candidate();
  return {
    ticketId: newId('tkt'),
    requestId: newId('txr'),
    agentId,
    walletId,
    policyVersionId,
    digest,
    chain: 'evm',
    signingDigest: sealedDigest(0xa1),
    // Null, as every EVM ticket is: the transaction hash covers a signature that does not exist yet.
    txDigest: null,
    bytesSha256: 'b2'.repeat(32),
    byteLength: 114n,
    amountRaw: 2000000000n,
    issuedAtMs: ISSUED_AT,
    authorityMode: 'delegated',
    nonce: newId('req'),
    ...overrides,
  };
}

export function claimsForTest(overrides: Partial<TicketRequest> = {}) {
  return claimsFor(request(overrides));
}

export const WITHIN_TTL = ISSUED_AT + TICKET_TTL_MS / 2n;
export const AFTER_TTL = ISSUED_AT + TICKET_TTL_MS + 1n;
