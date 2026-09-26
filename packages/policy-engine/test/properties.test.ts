import * as fc from 'fast-check';
import { Decision, type CandidateTransaction, type ReasonCode, type RiskAssessment } from '@ari/schemas';
import { describe, expect, it } from 'vitest';
import { compilePolicy, evaluate, type EvaluationState } from '../src/index.js';
import {
  CAP,
  DAY_CAP,
  ESCALATE_ABOVE,
  MONTH_CAP,
  NOVEL,
  NOW_MS,
  POLICY_ID,
  RECIPIENT,
  UNIT,
  USDC,
  VERSION_ID,
  candidate,
  compiled,
  contractCand,
  doc,
  risk,
  state,
  unknownCand,
  withCondition,
} from './fixtures.js';

const RUNS = { numRuns: 200 } as const;
const NEVER_ESCALATE = withCondition(null);
const RISK_LEVELS: RiskAssessment['level'][] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** bigint-safe JSON, so "byte-for-byte" covers the amounts as well as the codes. */
function bytes(value: unknown): string {
  return JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? `b${val}` : val));
}

const arbInput = fc.record({
  amount: fc.bigInt({ min: 0n, max: DAY_CAP * 2n }),
  unit: fc.constantFrom(UNIT, 'wei'),
  chain: fc.constantFrom('ethereum' as const, 'bitcoin' as const),
  recipient: fc.constantFrom(RECIPIENT, NOVEL, `0x${'d'.repeat(40)}`),
  kind: fc.constantFrom('transfer' as const, 'contract_call' as const, 'unknown' as const),
  reservedDay: fc.bigInt({ min: 0n, max: DAY_CAP * 2n }),
  reservedMonth: fc.bigInt({ min: 0n, max: MONTH_CAP * 2n }),
  hourCount: fc.integer({ min: 0, max: 40 }),
  ikaSpent: fc.bigInt({ min: 0n, max: 8000000n }),
  status: fc.constantFrom('ACTIVE' as const, 'PAUSED' as const, 'REVOKED' as const),
  scopes: fc.constantFrom(['transaction:request'] as string[], [], ['policy:read'] as string[]),
  riskLevel: fc.constantFrom< RiskAssessment['level'] | null>(null, ...RISK_LEVELS),
  now: fc.bigInt({ min: NOW_MS - 86400000n * 30n, max: NOW_MS + 86400000n * 30n }),
});

type Input = {
  amount: bigint;
  unit: string;
  chain: 'ethereum' | 'bitcoin';
  recipient: string;
  kind: 'transfer' | 'contract_call' | 'unknown';
  reservedDay: bigint;
  reservedMonth: bigint;
  hourCount: number;
  ikaSpent: bigint;
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
  scopes: string[];
  riskLevel: RiskAssessment['level'] | null;
  now: bigint;
};

function toCandidate(input: Input): CandidateTransaction {
  if (input.kind === 'unknown') return unknownCand();
  if (input.kind === 'contract_call') return contractCand();
  return candidate({
    chain: input.chain,
    recipient: { chain: 'ethereum', address: input.recipient },
    amount: { raw: input.amount.toString(), unit: input.unit },
    asset:
      input.unit === UNIT
        ? { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 }
        : { kind: 'native', chain: 'ethereum' },
  });
}

function toState(input: Input, over: Partial<EvaluationState> = {}): EvaluationState {
  return state({
    nowMs: input.now,
    agentStatus: input.status,
    scopes: input.scopes,
    usage: {
      reservedDayRaw: input.reservedDay,
      reservedMonthRaw: input.reservedMonth,
      transactionsLastHour: input.hourCount,
      ikaSpentTodayRaw: input.ikaSpent,
    },
    risk: input.riskLevel === null ? null : risk(input.riskLevel),
    ...over,
  });
}

describe('property: the engine is total, pure and replayable', () => {
  it('never throws, and always returns a schema-valid Decision', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const decision = evaluate({ policy: compiled(), candidate: toCandidate(input), state: toState(input) });
        expect(['ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL']).toContain(decision.outcome);
        expect(Decision.safeParse(decision).success).toBe(true);
      }),
      RUNS,
    );
  });

  it('replays to identical bytes from equal inputs, rebuilt fresh', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const once = bytes(evaluate({ policy: compiled(), candidate: toCandidate(input), state: toState(input) }));
        const twice = bytes(evaluate({ policy: compiled(), candidate: toCandidate(input), state: toState(input) }));
        // A decision that only reproduces when the caller passes the *same object
        // graph* is not auditable in September about something decided in March.
        expect(twice).toBe(once);
      }),
      RUNS,
    );
  });

  it('compiles the same document to the same form every time', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100000 }), (versionNumber) => {
        const ids = { policyId: POLICY_ID, versionId: VERSION_ID, versionNumber };
        expect(bytes(compilePolicy(doc(), ids))).toBe(bytes(compilePolicy(doc(), ids)));
      }),
      { numRuns: 25 },
    );
  });
});

describe('property: no ALLOW unless every enabled constraint holds', () => {
  it('implies identity, kind, chain, asset, recipient and every limit were satisfied', () => {
    // Written as ALLOW ⇒ constraint throughout, because a false ALLOW is the only
    // interesting failure mode; a skipped check is a paid-for surprise.
    fc.assert(
      fc.property(arbInput, (input) => {
        const cand = toCandidate(input);
        const decision = evaluate({ policy: NEVER_ESCALATE, candidate: cand, state: toState(input) });
        if (decision.outcome !== 'ALLOW') return;

        expect(input.status).toBe('ACTIVE');
        expect(input.scopes).toContain('transaction:request');
        expect(cand.kind).toBe('transfer');

        expect(input.chain).toBe('ethereum');
        expect(input.unit).toBe(UNIT);
        if (cand.kind === 'transfer') {
          expect(cand.amount.raw > 0n).toBe(true);
          expect(cand.amount.raw <= CAP).toBe(true);
          expect(input.reservedDay + cand.amount.raw <= DAY_CAP).toBe(true);
          expect(input.reservedMonth + cand.amount.raw <= MONTH_CAP).toBe(true);
          expect(input.recipient).toBe(RECIPIENT);
        }

        expect(input.hourCount + 1 <= 20).toBe(true);
        expect(input.ikaSpent < 5000000n).toBe(true);
        expect(input.now < BigInt(Date.parse(cand.deadline))).toBe(true);
        expect(input.now <= BigInt(Date.parse('2026-12-31T00:00:00.000Z'))).toBe(true);
      }),
      RUNS,
    );
  });

  it('never allows an unknown kind, an unsupported chain, a foreign unit or a novel recipient', () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const decision = evaluate({ policy: NEVER_ESCALATE, candidate: toCandidate(input), state: toState(input) });
        const disqualifier =
          input.kind === 'unknown' ||
          (input.kind === 'transfer' && (input.chain !== 'ethereum' || input.unit !== UNIT || input.recipient !== RECIPIENT));
        if (disqualifier) expect(decision.outcome).not.toBe('ALLOW');
      }),
      RUNS,
    );
  });

  it('agrees with the arithmetic for every amount and every reserved total', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: DAY_CAP * 2n }),
        fc.bigInt({ min: 0n, max: DAY_CAP * 2n }),
        (amount, reservedDay) => {
          const cand = candidate({ amount: { raw: amount.toString(), unit: UNIT } });
          const st = state({
            usage: { reservedDayRaw: reservedDay, reservedMonthRaw: 0n, transactionsLastHour: 0, ikaSpentTodayRaw: 0n },
          });
          const decision = evaluate({ policy: NEVER_ESCALATE, candidate: cand, state: st });
          expect(decision.outcome === 'ALLOW').toBe(amount > 0n && amount <= CAP && reservedDay + amount <= DAY_CAP);
        },
      ),
      RUNS,
    );
  });
});

describe('property: risk escalates and never grants', () => {
  it('a DENY under one risk assessment is never an ALLOW under another', () => {
    fc.assert(
      fc.property(arbInput, fc.constantFrom(...RISK_LEVELS), fc.constantFrom(...RISK_LEVELS), (input, a, b) => {
        const cand = toCandidate(input);
        const first = evaluate({ policy: compiled(), candidate: cand, state: toState(input, { risk: risk(a) }) });
        const second = evaluate({ policy: compiled(), candidate: cand, state: toState(input, { risk: risk(b) }) });
        if (first.outcome === 'DENY') expect(second.outcome).not.toBe('ALLOW');
      }),
      RUNS,
    );
  });

  it('assessing a request can only narrow what is allowed, never open it', () => {
    fc.assert(
      fc.property(arbInput, fc.constantFrom(...RISK_LEVELS), (input, level) => {
        const cand = toCandidate(input);
        const policy = withCondition({ op: 'risk_gte', level: level === 'NONE' || level === 'LOW' ? 'MEDIUM' : level });
        const unassessed = evaluate({ policy, candidate: cand, state: toState(input, { risk: null }) });
        const assessed = evaluate({ policy, candidate: cand, state: toState(input, { risk: risk(level) }) });
        if (unassessed.outcome === 'DENY') expect(assessed.outcome).not.toBe('ALLOW');
      }),
      RUNS,
    );
  });

  it('a HIGH threshold is never looser than a CRITICAL one', () => {
    fc.assert(
      fc.property(arbInput, fc.constantFrom(...RISK_LEVELS), (input, level) => {
        const cand = toCandidate(input);
        const strict = evaluate({
          policy: withCondition({ op: 'risk_gte', level: 'HIGH' }),
          candidate: cand,
          state: toState(input, { risk: risk(level) }),
        });
        const loose = evaluate({
          policy: withCondition({ op: 'risk_gte', level: 'CRITICAL' }),
          candidate: cand,
          state: toState(input, { risk: risk(level) }),
        });
        // "Never looser" is a subset relation, so it reads as an implication: anything
        // the stricter threshold admits, the looser one admits too.
        if (strict.outcome === 'ALLOW') expect(loose.outcome).toBe('ALLOW');
        // The single level where the two thresholds disagree is the one the stricter
        // name has to bite at. Demanding that it bite everywhere is not monotonicity —
        // a policy that asks for a human at CRITICAL has no opinion about NONE, and an
        // earlier draft of this assertion asked for exactly that, which a randomised
        // input at a low level duly contradicted.
        if (level === 'HIGH' && loose.outcome === 'ALLOW') expect(strict.outcome).not.toBe('ALLOW');
      }),
      RUNS,
    );
  });
});

describe('property: the money comparisons are monotone', () => {
  it('a smaller amount is allowed whenever a larger one is, all else equal', () => {
    // An off-by-one in a limit check breaks monotonicity before it breaks an
    // individual boundary, and a non-monotone limit is an agent shopping for the
    // amount that slips through. The reserved totals are pinned at zero here so
    // that the per-transaction rule is the only one that can fire: the engine
    // reports the first failure it finds, so reasoning about one code's
    // propagation across two interacting limits is not a property of this system.
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: CAP * 2n }), fc.bigInt({ min: 0n, max: CAP * 2n }), (a, b) => {
        const small = a < b ? a : b;
        const large = a < b ? b : a;
        // Zero is not "a smaller amount", it is a different refusal — an
        // out-of-range count rather than an over-limit one — so the ordering claim
        // is only about positive amounts.
        fc.pre(small > 0n);
        const decide = (raw: bigint) =>
          evaluate({
            policy: NEVER_ESCALATE,
            candidate: candidate({ amount: { raw: raw.toString(), unit: UNIT } }),
            state: state({
              usage: { reservedDayRaw: 0n, reservedMonthRaw: 0n, transactionsLastHour: 0, ikaSpentTodayRaw: 0n },
            }),
          });
        const big = decide(large);
        const little = decide(small);
        if (big.outcome === 'ALLOW') expect(little.outcome).toBe('ALLOW');
        const bigCodes: ReasonCode[] = big.outcome === 'DENY' ? big.reasonCodes : [];
        const littleCodes: ReasonCode[] = little.outcome === 'DENY' ? little.reasonCodes : [];
        if (littleCodes.includes('AMOUNT_EXCEEDS_PER_TRANSACTION')) {
          expect(bigCodes).toContain('AMOUNT_EXCEEDS_PER_TRANSACTION');
        }
      }),
      RUNS,
    );
  });

  it('the daily window is monotone in what is already reserved', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: DAY_CAP * 2n }), fc.bigInt({ min: 0n, max: DAY_CAP * 2n }), (a, b) => {
        const less = a < b ? a : b;
        const more = a < b ? b : a;
        const decide = (reservedDayRaw: bigint) =>
          evaluate({
            policy: NEVER_ESCALATE,
            candidate: candidate({ amount: { raw: '1', unit: UNIT } }),
            state: state({
              usage: { reservedDayRaw, reservedMonthRaw: 0n, transactionsLastHour: 0, ikaSpentTodayRaw: 0n },
            }),
          });
        if (decide(more).outcome === 'ALLOW') expect(decide(less).outcome).toBe('ALLOW');
        if (decide(less).outcome === 'DENY') expect(decide(more).outcome).toBe('DENY');
      }),
      RUNS,
    );
  });

  it('an amount at the cap and one unit above never share an outcome', () => {
    const st = state();
    const atCap = evaluate({
      policy: NEVER_ESCALATE,
      candidate: candidate({ amount: { raw: CAP.toString(), unit: UNIT } }),
      state: st,
    });
    const above = evaluate({
      policy: NEVER_ESCALATE,
      candidate: candidate({ amount: { raw: (CAP + 1n).toString(), unit: UNIT } }),
      state: st,
    });
    expect(atCap.outcome).toBe('ALLOW');
    expect(above.outcome).toBe('DENY');
  });

  it('never allows a zero amount, under any generated context', () => {
    // The claim is only "never ALLOW": identity, kind and window are checked
    // before the amount, so a paused agent is refused for a reason that has
    // nothing to do with the number. Which code it *is* refused with is asserted in
    // evaluate.test.ts, against a context that reaches the money checks.
    fc.assert(
      fc.property(arbInput, (input) => {
        const decision = evaluate({
          policy: NEVER_ESCALATE,
          candidate: candidate({ amount: { raw: '0', unit: UNIT } }),
          state: toState(input),
        });
        expect(decision.outcome).not.toBe('ALLOW');
      }),
      RUNS,
    );
  });
});

describe('property: a caller cannot steer the digest', () => {
  it('two distinct allowed amounts never share an ALLOW digest', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: ESCALATE_ABOVE }),
        fc.bigInt({ min: 1n, max: ESCALATE_ABOVE }),
        (a, b) => {
          fc.pre(a !== b);
          const one = evaluate({ policy: NEVER_ESCALATE, candidate: candidate({ amount: { raw: a.toString(), unit: UNIT } }), state: state() });
          const two = evaluate({ policy: NEVER_ESCALATE, candidate: candidate({ amount: { raw: b.toString(), unit: UNIT } }), state: state() });
          if (one.outcome === 'ALLOW' && two.outcome === 'ALLOW') expect(one.digest).not.toBe(two.digest);
        },
      ),
      RUNS,
    );
  });
});
