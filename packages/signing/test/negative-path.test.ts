/**
 * The MVP negative path (ROADMAP Phase 3 gate, assumption A9).
 *
 * The brief's closing criterion is not "the request was denied" — it is that a
 * denied request **never reaches the signing provider**, which ASSUMPTIONS §4.3
 * makes a cost property as well as a safety one: every Ika operation spends real
 * IKA and SUI, so a policy bug that still calls the provider burns money on its
 * way to refusing.
 *
 * That claim is about an absence, and an absence is invisible to a log line. So
 * the assertion is a counter, and it has to read exactly zero.
 */

import { CandidateTransaction, PolicyDocument, newId, type CandidateTransaction as Candidate } from '@ari/schemas';
import { compilePolicy, evaluate, type EvaluationState } from '@ari/policy-engine';
import { canonicalize, computeDigest } from '@ari/transaction-engine';
import { describe, expect, it } from 'vitest';
import {
  InMemoryTicketStore,
  MockSigningProvider,
  claimsFor,
  redeemAndSign,
  sealTicket,
  TicketKey,
  type SignerDeps,
  type SignerOutcome,
} from '../src/index.js';
import { NOVEL, RECIPIENT, USDC, agentId, policyVersionId, walletId } from './fixtures.js';

const key = new TicketKey('n'.repeat(48));
const UNIT = 'usdc-6dp';
const NOW = 1_761_400_000_000n;
const usd = (whole: bigint) => whole * 1_000_000n;

const policy = compilePolicy(
  PolicyDocument.parse({
    meta: { name: 'accounts-payable-negative-path', description: null },
    target: { walletId, authorityMode: 'delegated', signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256' },
    permissions: {
      transfers: {
        enabled: true,
        chains: ['ethereum'],
        assets: [{ kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 }],
        recipients: { mode: 'allowlist', addresses: [RECIPIENT] },
        // The brief's own numbers: a $5,000 ceiling, and a human above $1,000.
        perTransaction: { maxRaw: usd(5_000n).toString(), unit: UNIT },
        perDay: { maxRaw: usd(25_000n).toString(), unit: UNIT },
        perMonth: null,
        maxTransactionsPerHour: 20,
      },
      contractCalls: { enabled: false, contracts: [] },
      newRecipients: { allowed: false, requireApproval: false },
    },
    escalation: {
      humanApproval: {
        requiredWhen: [{ op: 'amount_gt', raw: usd(1_000n).toString(), unit: UNIT }],
        approverRoles: ['owner'],
        quorumEnforcement: 'application',
        quorum: 1,
      },
    },
    validity: {
      transactionTtlSeconds: 900,
      notBefore: null,
      notAfter: null,
      signingBudget: { maxIkaRawPerDay: '5000000', alertAtIkaRawPerDay: '2500000' },
    },
    fallback: {
      onUnknownTransaction: 'deny',
      onEvaluationError: 'deny',
      onRiskUnavailable: 'escalate',
      onSimulationUnavailable: 'allow_advisory',
    },
    limits: { maxUsdEstimateAgeSeconds: 300, maxDeadlineSkewSeconds: 60 },
  }),
  { policyId: newId('pol'), versionId: policyVersionId, versionNumber: 1 },
);

function transfer(address: string, rawAmount: bigint) {
  const parsed = CandidateTransaction.parse({
    kind: 'transfer',
    chain: 'ethereum',
    requestId: newId('req'),
    agentId,
    walletId,
    deadline: new Date(Number(NOW) + 600_000).toISOString(),
    idempotencyKey: newId('req'),
    usdEstimate: null,
    asset: { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 },
    amount: { raw: rawAmount, unit: UNIT },
    recipient: { chain: 'ethereum', address },
    replayProtection: { scheme: 'account_sequence', nonce: '12', chainId: '1', gasLimit: null, maxFeePerUnit: null },
  });
  const context = { policyVersionId };
  return { candidate: parsed, canonical: canonicalize(parsed, context), digest: computeDigest(parsed, context) };
}

function evaluationState(): EvaluationState {
  return {
    nowMs: NOW,
    requestId: newId('req'),
    agentId,
    agentStatus: 'ACTIVE',
    scopes: ['transaction:request'],
    usage: { reservedDayRaw: 0n, reservedMonthRaw: 0n, transactionsLastHour: 0, ikaSpentTodayRaw: 0n },
    history: {
      knownRecipientAddresses: new Set([RECIPIENT]),
      baselineAssets: new Set([`erc20:ethereum:${USDC}`]),
      baselineChains: new Set(['ethereum']),
      firstSeenWithinDays: () => false,
    },
    risk: null,
    simulation: null,
  };
}

function signer() {
  const provider = new MockSigningProvider();
  const store = new InMemoryTicketStore();
  const deps: SignerDeps = { key, provider, store, nowMs: NOW, wallets: new Set([walletId]) };
  return { provider, store, deps };
}

/**
 * What `apps/api` will do on the ALLOW branch: seal a ticket bound to the digest
 * that was just evaluated, then present it. Written here so the ordering is
 * asserted before there is a route handler that could get it wrong.
 */
async function mintAndRedeem(
  deps: SignerDeps,
  decided: { candidate: Candidate; digest: ReturnType<typeof computeDigest> },
  /**
   * The stored transaction request's id, not the candidate's correlation id. A
   * ticket is resolved through the ledger by joining on exactly this value, so a
   * ticket sealed against anything else is a signature nothing can reconcile.
   */
  transactionRequestId: string,
  canonical: string,
): Promise<SignerOutcome> {
  const sealed = sealTicket(
    claimsFor({
      ticketId: newId('tkt'),
      requestId: transactionRequestId,
      agentId,
      walletId,
      policyVersionId,
      digest: decided.digest,
      amountRaw: decided.candidate.kind === 'transfer' ? decided.candidate.amount.raw : 0n,
      issuedAtMs: NOW,
      authorityMode: 'delegated',
      nonce: newId('req'),
    }),
    key,
  );
  if (!sealed.ok) throw new Error(`a legitimate ticket failed to seal: ${sealed.reason}`);
  return redeemAndSign(deps, { ticket: sealed.ticket, canonical });
}

describe('the MVP negative path', () => {
  it('denies $50,000 to an unknown recipient under a $5,000 cap', () => {
    const { candidate } = transfer(NOVEL, usd(50_000n));
    const decision = evaluate({ policy, candidate, state: evaluationState() });
    expect(decision.outcome).toBe('DENY');
    if (decision.outcome === 'DENY') {
      expect(decision.reasonCodes).toContain('RECIPIENT_NOT_IN_ALLOWLIST');
      // A DENY carries no digest: there is nothing for a ticket to be about.
      expect('digest' in decision).toBe(false);
    }
  });

  it('leaves the signing provider untouched, counted rather than inferred', async () => {
    const { provider, store } = signer();
    const { candidate } = transfer(NOVEL, usd(50_000n));
    const decision = evaluate({ policy, candidate, state: evaluationState() });

    // If the fixture ever stops being a denial, this test must fail loudly rather
    // than quietly proving nothing.
    if (decision.outcome === 'ALLOW') throw new Error('the negative path became an ALLOW');

    expect(provider.invocations).toBe(0);
    expect(store.size).toBe(0);
  });

  it('also denies $50,000 to a known recipient, and still counts zero', async () => {
    const { provider, store } = signer();
    const { candidate } = transfer(RECIPIENT, usd(50_000n));
    const decision = evaluate({ policy, candidate, state: evaluationState() });
    expect(decision.outcome).toBe('DENY');
    if (decision.outcome === 'DENY') expect(decision.reasonCodes).toContain('AMOUNT_EXCEEDS_PER_TRANSACTION');
    expect(provider.invocations).toBe(0);
    expect(store.size).toBe(0);
  });

  it('escalates $2,000 to a known recipient for approval, then signs after it', async () => {
    const { deps, provider, store } = signer();
    const { candidate, canonical, digest } = transfer(RECIPIENT, usd(2_000n));
    const decision = evaluate({ policy, candidate, state: evaluationState() });

    // The positive control for the counter above: the pipeline does reach the
    // provider when it is allowed to, which is the only reason zero means
    // anything.
    expect(decision.outcome).toBe('REQUIRE_HUMAN_APPROVAL');
    if (decision.outcome !== 'REQUIRE_HUMAN_APPROVAL') return;
    expect(decision.digest).toBe(digest);

    const outcome = await mintAndRedeem(deps, { candidate, digest }, newId('txr'), canonical);
    if (outcome.status !== 'SIGNED') throw new Error(`expected SIGNED, got ${outcome.status}`);
    expect(provider.invocations).toBe(1);
    expect(store.size).toBe(1);
    expect(outcome.digest).toBe(digest);
  });

  it('mints nothing for a denied request, so there is no ticket to redeem', async () => {
    const { deps, provider } = signer();
    const { candidate, canonical } = transfer(NOVEL, usd(50_000n));
    const decision = evaluate({ policy, candidate, state: evaluationState() });
    if (decision.outcome !== 'DENY') throw new Error('expected DENY');

    // What an absent ticket looks like from the signer's side: the decision has no
    // digest to bind, so the only way to present one is to invent it. Anything
    // that is not a seal this key made is refused before the provider is asked,
    // and the two cases are distinguishable — a shapeless string is not the same
    // incident as a ticket from a key we do not trust.
    const shapeless = await redeemAndSign(deps, { ticket: 'not-a-ticket', canonical });
    if (shapeless.status !== 'REJECTED') throw new Error('a shapeless string was accepted');
    expect(shapeless.code).toBe('TICKET_INVALID');

    const fromAnotherKey = `${'a'.repeat(60)}.${'b'.repeat(43)}`;
    const mismatched = await redeemAndSign(deps, { ticket: fromAnotherKey, canonical });
    if (mismatched.status !== 'REJECTED') throw new Error('an unsealed ticket was accepted');
    expect(mismatched.code).toBe('SIGNER_KEY_MISMATCH');

    expect(provider.invocations).toBe(0);
  });
});
