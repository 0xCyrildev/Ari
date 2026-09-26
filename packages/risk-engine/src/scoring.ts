/**
 * The scoring half of the risk plane: no database, no clock, no I/O.
 *
 * Split from the queries for one reason — this is the part with a claim to test.
 * "Advisory by construction" (A6) is a statement about arithmetic: given any set of
 * signals, the level must move in one direction, and nothing computed here can reach a
 * decision value. `RiskAssessment` has no `outcome` field to write, which is the
 * structural half of that; the monotonicity tests are the behavioural half.
 *
 * The weights are ASSUMED — a choice, not a measurement, and deliberately visible as
 * one. What is not a choice is which signals may be named here at all: the keys of
 * `WEIGHTS` are the signals this module can actually compute, so emitting
 * `SIMULATION_WARNING` from a behavioural baseline is a type error rather than a
 * plausible-looking line of code.
 */

import { RiskAssessment, type RiskSignalName } from '@ari/schemas';

/**
 * The signals Phase 5 computes. Anything else has no weight here and so cannot be
 * named by this module at all — the type is the list of what the code can actually
 * support, which is the only kind of list that stays true.
 *
 * What is excluded, and why:
 * - `NEW_ASSET`, `NEW_CHAIN`, `NEW_CONTRACT` — `transaction_requests` stores recipient,
 *   amount and unit, not chain or asset. They live inside `canonical`, which is a digest
 *   input rather than something to aggregate over, so "what has this agent done on other
 *   chains" has no source until a migration adds the columns. A policy that asks for the
 *   signal would otherwise get a constant `false`, which is the option shape §7.2 refuses.
 * - `UNUSUAL_APPROVAL_PATTERN` — needs approval outcomes joined to requests; Phase 6
 *   stores them, nothing reads them behaviourally yet.
 * - `SIMULATION_WARNING` (Phase 7) and `MODEL_OUTPUT_INCONSISTENCY` (Phase 4) belong to
 *   engines that do not exist. Emitting either from a behavioural baseline would be the
 *   risk plane inventing a fact it did not observe.
 */
export type ComputedSignal = Exclude<
  RiskSignalName,
  'NEW_ASSET' | 'NEW_CHAIN' | 'NEW_CONTRACT' | 'UNUSUAL_APPROVAL_PATTERN' | 'SIMULATION_WARNING' | 'MODEL_OUTPUT_INCONSISTENCY'
>;

export const WEIGHTS: Readonly<Record<ComputedSignal, number>> = {
  NEW_RECIPIENT: 0.18,
  RECIPIENT_VELOCITY_CHANGE: 0.2,
  AMOUNT_ABOVE_BASELINE: 0.2,
  AMOUNT_8X_BASELINE: 0.35,
  OUT_OF_HOURS: 0.12,
  POLICY_BOUNDARY_PROXIMITY: 0.1,
  BEHAVIOUR_PROFILE_DRIFT: 0.25,
  DORMANT_AGENT_RESUMED: 0.15,
  NO_BEHAVIOUR_BASELINE: 0.3,
};

/**
 * Level bands, on the score rather than on the signals.
 *
 * `NONE` means "computed, found nothing", which is a different statement from
 * "nothing was computed" — that case is the `NO_BEHAVIOUR_BASELINE` signal, and it
 * lands at MEDIUM so an unknown agent is never read as a clean one.
 */
const BANDS: ReadonlyArray<readonly [number, RiskAssessment['level']]> = [
  [0.05, 'NONE'],
  [0.25, 'LOW'],
  [0.5, 'MEDIUM'],
  [0.75, 'HIGH'],
  [1.01, 'CRITICAL'],
];

export function scoreOf(signals: readonly ComputedSignal[]): number {
  let total = 0;
  // A set, before the sum: a signal is a fact about one request, and the same fact
  // reported twice by two code paths must not weigh twice. Without this the score and
  // the emitted list disagree, because the list is deduplicated below.
  for (const signal of new Set(signals)) {
    // A value outside `ComputedSignal` cannot reach here through the type, and an
    // unweighted name inside it would mean a signal that contributes nothing to the
    // score while appearing in the explanation an approver reads. Both are refused.
    const weight = WEIGHTS[signal];
    if (weight === undefined) throw new RangeError(`no weight is defined for ${signal}`);
    total += weight;
  }
  // Clamped, not normalised: three mild signals genuinely are more concerning than
  // one, and dividing by the count would make a request with more warnings quieter.
  return Math.min(1, Math.round(total * 1000) / 1000);
}

export function levelOf(score: number): RiskAssessment['level'] {
  for (const [ceiling, level] of BANDS) {
    if (score < ceiling) return level;
  }
  return 'CRITICAL';
}

/** Monotone by construction, and asserted as a property rather than by review. */
export function assess(input: {
  readonly requestId: string;
  readonly signals: readonly ComputedSignal[];
  readonly explanation: string;
  readonly baselineWindowDays: number;
  readonly computedAtMs: bigint;
}): { readonly assessment: RiskAssessment; readonly score: number; readonly level: RiskAssessment['level'] } {
  const score = scoreOf(input.signals);
  const level = levelOf(score);
  return {
    score,
    level,
    assessment: RiskAssessment.parse({
      requestId: input.requestId,
      score,
      level,
      // Sorted so the same facts produce the same bytes. The audit trail records the
      // list, and a comparison between two assessments that disagreed only because of
      // insertion order is a wasted afternoon.
      signals: [...new Set(input.signals)].sort(),
      explanation: input.explanation.slice(0, 4000),
      baselineWindowDays: input.baselineWindowDays,
      modelVersion: FEATURES_VERSION,
      computedAtMs: input.computedAtMs,
    }),
  };
}

/**
 * Not a model and not a version number pretending to be one: this string names the
 * feature set and the weights, so an assessment recorded in September can be re-derived
 * from the same rules, or shown to have come from different ones.
 */
export const FEATURES_VERSION = 'risk-baselines/v1';

/** Where an amount sits against what this agent has done before, in whole bigints. */
export type AmountComparison = 'NO_BASELINE' | 'AT_OR_BELOW_MEDIAN' | 'ABOVE_MEDIAN' | 'ABOVE_P95' | 'EIGHT_TIMES_MEDIAN';

export function compareAmount(amount: bigint, median: bigint | null, p95: bigint | null): AmountComparison {
  if (median === null) return 'NO_BASELINE';
  if (median > 0n && amount >= median * 8n) return 'EIGHT_TIMES_MEDIAN';
  if (p95 !== null && amount > p95) return 'ABOVE_P95';
  if (amount > median) return 'ABOVE_MEDIAN';
  return 'AT_OR_BELOW_MEDIAN';
}
