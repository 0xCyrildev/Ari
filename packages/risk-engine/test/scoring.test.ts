/**
 * The risk plane's arithmetic, with no database in sight.
 *
 * Two claims are tested here and both are about direction rather than values. The
 * first is monotonicity: a new signal must never make a request look safer, because the
 * alternative is an agent that can shop for the combination of facts that cancels out a
 * warning. The second is A6 — nothing computed here can reach a decision value — which
 * is checked by the compiler as much as by a test, and the check is written so that
 * making it pass requires changing the type rather than adding a cast.
 */

import { Decision, RiskAssessment, type RiskSignalName } from '@ari/schemas';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FEATURES_VERSION,
  WEIGHTS,
  assess,
  compareAmount,
  levelOf,
  scoreOf,
  type ComputedSignal,
} from '../src/scoring.js';

const ALL_SIGNALS = Object.keys(WEIGHTS) as ComputedSignal[];
const RUNS = { numRuns: 300 } as const;

const arbSignals = fc.subarray([...ALL_SIGNALS], { minLength: 0 });

describe('the score is monotone in what was observed', () => {
  it('adding a signal never lowers the score, and never lowers the level', () => {
    fc.assert(
      fc.property(arbSignals, fc.constantFrom(...ALL_SIGNALS), (base, extra) => {
        const without = scoreOf(base);
        const with_ = scoreOf([...base, extra]);
        expect(with_).toBeGreaterThanOrEqual(without);
        const order = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
        expect(order.indexOf(levelOf(with_))).toBeGreaterThanOrEqual(order.indexOf(levelOf(without)));
      }),
      RUNS,
    );
  });

  it('says the same thing about the same facts however they arrive', () => {
    fc.assert(
      fc.property(arbSignals, (signals) => {
        const shuffled = [...signals].reverse();
        expect(scoreOf(shuffled)).toBe(scoreOf(signals));
        const one = assess({ requestId: 'req_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b', signals, explanation: 'x', baselineWindowDays: 30, computedAtMs: 1n });
        const other = assess({ requestId: 'req_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b', signals: shuffled, explanation: 'x', baselineWindowDays: 30, computedAtMs: 1n });
        expect(other.assessment).toEqual(one.assessment);
        // Duplicates are the same fact twice, not two facts: without this, an engine
        // that emitted `NEW_RECIPIENT` per candidate field could inflate a score.
        expect(scoreOf([signals[0] ?? 'NEW_RECIPIENT', signals[0] ?? 'NEW_RECIPIENT'])).toBe(scoreOf([signals[0] ?? 'NEW_RECIPIENT']));
      }),
      RUNS,
    );
  });

  it('never exceeds what a number between zero and one means', () => {
    fc.assert(
      fc.property(arbSignals, (signals) => {
        const score = scoreOf(signals);
        expect(score).toBeLessThanOrEqual(1);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(levelOf(score)).toBeOneOf(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
      }),
      RUNS,
    );
  });
});

describe('the bands', () => {
  it('puts nothing unusual at NONE and an unknown agent above it', () => {
    // The ordering of these two assertions is the whole point: "computed, found
    // nothing" is the quietest answer available, and "there was nothing to compute
    // against" must not be quieter than it.
    expect(levelOf(scoreOf([]))).toBe('NONE');
    expect(['MEDIUM', 'HIGH', 'CRITICAL']).toContain(levelOf(scoreOf(['NO_BEHAVIOUR_BASELINE'])));
  });

  it('reaches CRITICAL only through several signals or the heavy ones', () => {
    expect(levelOf(scoreOf(['AMOUNT_8X_BASELINE']))).toBe('MEDIUM');
    expect(levelOf(scoreOf(['AMOUNT_8X_BASELINE', 'BEHAVIOUR_PROFILE_DRIFT', 'RECIPIENT_VELOCITY_CHANGE']))).toBe('CRITICAL');
  });
});

describe('amount comparison stays in bigints', () => {
  it('names the boundaries, including the one the escalation threshold is built on', () => {
    const median = 1_000_000_000n;
    const p95 = 3_000_000_000n;
    expect(compareAmount(median, median, p95)).toBe('AT_OR_BELOW_MEDIAN');
    expect(compareAmount(median + 1n, median, p95)).toBe('ABOVE_MEDIAN');
    expect(compareAmount(p95 + 1n, median, p95)).toBe('ABOVE_P95');
    expect(compareAmount(median * 8n, median, p95)).toBe('EIGHT_TIMES_MEDIAN');
    // No baseline at all is not "amount of zero": the null case has its own name so a
    // caller cannot read it as the quietest one.
    expect(compareAmount(1n, null, null)).toBe('NO_BASELINE');
    // A zero median — every past payment the same rounding artefact — cannot be a
    // multiple of, so the 8× rule is skipped rather than firing on everything.
    expect(compareAmount(500n, 0n, null)).toBe('ABOVE_MEDIAN');
  });
});

describe('what the risk plane cannot say', () => {
  it('has no weight for a signal it does not compute', () => {
    for (const named of ['NEW_ASSET', 'NEW_CHAIN', 'NEW_CONTRACT', 'UNUSUAL_APPROVAL_PATTERN', 'SIMULATION_WARNING', 'MODEL_OUTPUT_INCONSISTENCY'] as RiskSignalName[]) {
      expect(WEIGHTS).not.toHaveProperty(named);
    }
  });

  it('refuses a name that is not in its own vocabulary', () => {
    // The type makes this unrepresentable; this makes it loud at the boundary where a
    // JSON blob from somewhere else would have arrived as a silently zero weight.
    expect(() => scoreOf(['SIMULATION_WARNING' as ComputedSignal])).toThrow(RangeError);
  });

  it('produces an assessment, and never a decision (A6)', () => {
    const { assessment } = assess({
      requestId: 'req_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
      signals: ['NEW_RECIPIENT'],
      explanation: 'first payment to this recipient',
      baselineWindowDays: 30,
      computedAtMs: 1_790_000_000_000n,
    });
    expect(RiskAssessment.safeParse(assessment).success).toBe(true);
    expect(assessment.modelVersion).toBe(FEATURES_VERSION);
    expect(assessment.signals).toEqual(['NEW_RECIPIENT']);
    // `outcome` is the field a decision has and an assessment does not. Writing the
    // other way round does not type-check, which is the enforcement; this is the record
    // that it was ever checked.
    const asDecision = { ...assessment, outcome: 'ALLOW', reasonCodes: [], policyId: '', matchedRules: [] };
    expect(Decision.safeParse(asDecision).success).toBe(false);
    // @ts-expect-error a RiskAssessment has no outcome to read, and never will have
    void assessment.outcome;
  });

  it('sorts the signals so the same facts hash the same way', () => {
    const { assessment } = assess({
      requestId: 'req_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
      signals: ['OUT_OF_HOURS', 'NEW_RECIPIENT', 'OUT_OF_HOURS'],
      explanation: 'x',
      baselineWindowDays: 30,
      computedAtMs: 1n,
    });
    expect(assessment.signals).toEqual(['NEW_RECIPIENT', 'OUT_OF_HOURS']);
  });
});
