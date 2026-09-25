import { describe, expect, it } from 'vitest';
import {
  AuthorizationTicket,
  CandidateTransaction,
  Decision,
  Money,
  PolicyDocument,
  ReasonCode,
  isSubstitutionCritical,
  money,
  type CanonicalDigest,
} from '../src/index.js';

/** A minimal, complete, *legal* policy. Also the fixture every other test edits. */
function policyFixture(overrides: Record<string, unknown> = {}) {
  return {
    meta: { name: 'accounts-payable', description: null },
    target: {
      walletId: 'wal_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
      authorityMode: 'user_gated',
      signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
    },
    permissions: {
      transfers: {
        enabled: true,
        chains: ['ethereum'],
        assets: [
          {
            kind: 'erc20',
            chain: 'ethereum',
            contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
            symbol: 'USDC',
            decimals: 6,
          },
        ],
        recipients: { mode: 'allowlist', addresses: ['0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c'] },
        perTransaction: { maxRaw: '2000000000', unit: 'usdc-6dp' },
        perDay: { maxRaw: '25000000000', unit: 'usdc-6dp' },
        perMonth: null,
        maxTransactionsPerHour: 20,
      },
      contractCalls: { enabled: false, contracts: [] },
      newRecipients: { allowed: false, requireApproval: true },
    },
    escalation: {
      humanApproval: {
        requiredWhen: [{ op: 'recipient_not_in_allowlist' }],
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
    ...overrides,
  };
}

describe('PolicyDocument — what it accepts', () => {
  it('accepts a complete minimal policy', () => {
    expect(PolicyDocument.safeParse(policyFixture()).success).toBe(true);
  });

  it('parses amounts as bigint, never float', () => {
    const parsed = Money.safeParse({ raw: '2000000000', unit: 'usdc-6dp' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(typeof parsed.data.raw).toBe('bigint');
    expect(parsed.data.raw).toBe(2000000000n);
  });

  it('refuses a decimal amount string rather than rounding it', () => {
    // 1.5 USDC is not an integer count of 6dp units; silently truncating would
    // be an authorization decision made by a float.
    expect(Money.safeParse({ raw: '1.5', unit: 'usdc-6dp' }).success).toBe(false);
  });

  it('money() refuses negatives', () => {
    expect(() => money(-1n, 'usdc-6dp')).toThrow(RangeError);
  });
});

describe('PolicyDocument — what it cannot express (invariant S1)', () => {
  it('refuses an empty allowlist instead of treating it as unrestricted', () => {
    const doc = policyFixture();
    const recipients = (doc.permissions as Record<string, Record<string, unknown>>).transfers
      ?.recipients as Record<string, unknown>;
    recipients.addresses = [];
    expect(PolicyDocument.safeParse(doc).success).toBe(false);
  });

  it("refuses recipients.mode: 'any' — there is no wildcard in the vocabulary", () => {
    const doc = structuredClone(policyFixture()) as {
      permissions: { transfers: { recipients: { mode: string } } };
    };
    doc.permissions.transfers.recipients.mode = 'any';
    expect(PolicyDocument.safeParse(doc).success).toBe(false);
  });

  it('refuses a fallback that allows unknown transactions', () => {
    const doc = structuredClone(policyFixture()) as {
      fallback: { onUnknownTransaction: string };
    };
    doc.fallback.onUnknownTransaction = 'allow';
    expect(PolicyDocument.safeParse(doc).success).toBe(false);
  });

  it('refuses a policy with no fallback block at all', () => {
    const doc = structuredClone(policyFixture()) as Record<string, unknown>;
    delete doc.fallback;
    expect(PolicyDocument.safeParse(doc).success).toBe(false);
  });

  it('refuses chain-enforced quorum while the implementation is application-layer (S12)', () => {
    const doc = structuredClone(policyFixture()) as {
      escalation: { humanApproval: { quorumEnforcement: string } };
    };
    doc.escalation.humanApproval.quorumEnforcement = 'on_chain';
    expect(PolicyDocument.safeParse(doc).success).toBe(false);
  });

  it('refuses unsupported chains and pre-alpha chains alike', () => {
    const doc = policyFixture() as { permissions: { transfers: { chains: string[] } } };
    for (const chain of ['sui', 'solana', 'cardano']) {
      const probe = structuredClone(doc);
      probe.permissions.transfers.chains = [chain];
      expect(PolicyDocument.safeParse(probe).success).toBe(false);
    }
  });

  it('refuses unknown extra fields (mass-assignment surface)', () => {
    const doc = structuredClone(policyFixture()) as Record<string, unknown> & {
      meta: Record<string, unknown>;
    };
    doc.unrestricted = true;
    expect(PolicyDocument.safeParse(doc).success).toBe(false);
    doc.meta.role = 'superadmin';
    expect(PolicyDocument.safeParse(doc).success).toBe(false);
  });
});

describe('CandidateTransaction', () => {
  const base = {
    requestId: 'req_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    agentId: 'agt_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    walletId: 'wal_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    deadline: '2026-09-25T12:00:00.000Z',
    idempotencyKey: 'inv-8842',
    usdEstimate: null,
  };

  it('accepts a normalised EVM transfer', () => {
    const parsed = CandidateTransaction.safeParse({
      ...base,
      kind: 'transfer',
      chain: 'ethereum',
      asset: { kind: 'native', chain: 'ethereum' },
      amount: { raw: '2000000000', unit: 'usdc-6dp' },
      recipient: {
        chain: 'ethereum',
        address: '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c',
      },
      replayProtection: {
        scheme: 'account_sequence',
        nonce: '12',
        chainId: '1',
        gasLimit: null,
        maxFeePerUnit: null,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a mixed-case address: normalisation happens before parsing', () => {
    const parsed = CandidateTransaction.safeParse({
      ...base,
      kind: 'transfer',
      chain: 'ethereum',
      asset: { kind: 'native', chain: 'ethereum' },
      amount: { raw: '1', unit: 'wei' },
      recipient: {
        chain: 'ethereum',
        address: '0x3F2A1B0C4D5E6F708192A3B4C5D6E7F8091A2B3C',
      },
      replayProtection: { scheme: 'account_sequence', nonce: '1', chainId: '1', gasLimit: null, maxFeePerUnit: null },
    });
    expect(parsed.success).toBe(false);
  });

  it("parses an unsupported chain as kind:'unknown' so it can be DENIED with a reason", () => {
    const parsed = CandidateTransaction.safeParse({
      ...base,
      kind: 'unknown',
      reason: 'chain not supported: sui',
      reportedChain: 'sui',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.kind).toBe('unknown');
  });

  it('nonce accepts a decimal string, because JSON numbers cannot hold 2^64', () => {
    const parsed = CandidateTransaction.safeParse({
      ...base,
      kind: 'transfer',
      chain: 'ethereum',
      asset: { kind: 'native', chain: 'ethereum' },
      amount: { raw: '1', unit: 'wei' },
      recipient: { chain: 'ethereum', address: '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c' },
      replayProtection: {
        scheme: 'account_sequence',
        nonce: '18446744073709551615',
        chainId: '1',
        gasLimit: null,
        maxFeePerUnit: null,
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('Decision', () => {
  const base = {
    requestId: 'req_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    policyId: 'pol_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    policyVersionId: 'ppv_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    evaluatedAtMs: '1761465600000',
    matchedRules: [],
    riskLevel: null,
  };

  it('refuses a DENY with no reason codes', () => {
    expect(
      Decision.safeParse({ ...base, outcome: 'DENY', reasonCodes: [] }).success,
    ).toBe(false);
  });

  it('refuses an unrecognised outcome (S1: there is no fourth value)', () => {
    expect(Decision.safeParse({ ...base, outcome: 'PROCEED', reasonCodes: [] }).success).toBe(false);
  });

  it('refuses a fabricated reason code, keeping the vocabulary closed', () => {
    expect(
      Decision.safeParse({ ...base, outcome: 'DENY', reasonCodes: ['BECAUSE_WE_FEEL_LIKE_IT'] })
        .success,
    ).toBe(false);
  });

  it('REQUIRE_HUMAN_APPROVAL must carry the digest the human will be shown', () => {
    const withoutDigest = Decision.safeParse({
      ...base,
      outcome: 'REQUIRE_HUMAN_APPROVAL',
      reasonCodes: ['HUMAN_APPROVAL_REQUIRED'],
      expiresAt: '2026-09-25T12:00:00.000Z',
    });
    expect(withoutDigest.success).toBe(false);
  });
});

describe('substitution-critical fields', () => {
  it('names recipient and amount, and does not name memo', () => {
    expect(isSubstitutionCritical('recipient')).toBe(true);
    expect(isSubstitutionCritical('amount')).toBe(true);
    expect(isSubstitutionCritical('memo')).toBe(false);
  });
});

describe('type-level invariants (verified by tsc, not at runtime)', () => {
  it('an AuthorizationTicket cannot be forged from a string', () => {
    // If this line ever compiles, invariant S4 is decorative.
    const forged: string = 'not-a-ticket';
    // @ts-expect-error — a plain string is not assignable to a branded ticket
    const ticket: AuthorizationTicket = forged;
    expect(typeof ticket).toBe('string');
  });

  it('a digest is not interchangeable with arbitrary text', () => {
    // @ts-expect-error — CanonicalDigest is a distinct string type
    const digest: CanonicalDigest = 'anything';
    expect(digest).toBe('anything');
  });

  it('ReasonCode is a union of known codes, so typos do not compile', () => {
    const ok: ReasonCode = 'RECIPIENT_NOT_ALLOWED';
    // @ts-expect-error — not a member of the closed vocabulary
    const typo: ReasonCode = 'RECIPIENT_NOT_ALOWED';
    expect([ok, typo]).toHaveLength(2);
  });
});
