/**
 * The risk plane (Phase 5): deterministic behavioural baselines over Ari's own record.
 *
 * Explicitly statistics and not a model, per the brief's own warning. Every number here
 * is derived from rows Ari wrote when it authorised something, which means two things:
 * the baseline is auditable to the row it came from, and it is only as good as Ari's
 * history — a first payment by a new agent has no baseline to be compared against, and
 * that is reported as `NO_BEHAVIOUR_BASELINE` rather than as a clean bill of health.
 *
 * What "observed" means, stated because the choice is load-bearing: a request counts as
 * behaviour once Ari minted its ticket. A denied or still-pending request is not
 * behaviour, and counting one would let an agent that was refused fifty times build a
 * profile out of the refusals. This is deliberately *not* the same population as
 * `recipientHistory` in `@ari/identity`, which answers the policy's different question —
 * "has this payment landed" — and waits for the settled states. Two questions, two
 * populations, both named; collapsing them would make one of them wrong.
 */

import type { RiskAssessment } from '@ari/schemas';
import type { TenantTx } from '@ari/identity';
import { assess, compareAmount, FEATURES_VERSION, scoreOf, type ComputedSignal } from './scoring.js';

/** Ari authorised it and it left the decision plane. */
export const OBSERVED_STATES = ['TICKET_MINTED', 'SIGNING_COMPLETE', 'BROADCAST', 'BROADCAST_CONFIRMED'] as const;

/**
 * What is being assessed. `requestId` is the *caller's* id (`req_`), the same one the
 * decision carries, because an assessment is a statement about a submitted request
 * rather than about a row in Ari's database. The thing that keeps a retry from
 * comparing a payment against its own earlier attempts is `idempotencyKey`, which is
 * what the two attempts of one request actually share.
 */
export interface RiskSubject {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly nowMs: bigint;
  readonly amountRaw: bigint;
  readonly currencyUnit: string;
  /**
   * Null for anything with no recipient, which is why the recipient signals are guarded.
   * `isTransfer` is a separate field rather than an inference from that one: a contract
   * call carries a `recipient` in the candidate schema — the contract it calls — and a
   * contract never appears in `transaction_requests.recipient_address`, which is written
   * only for transfers. Deriving novelty from an address that can only ever be absent
   * would flag every contract call as a first-time recipient, for the same reason a
   * `false` that can never fire is worse than no option at all.
   */
  readonly isTransfer: boolean;
  readonly recipientAddress: string | null;
  readonly perTransactionCapRaw: bigint;
}

export type RiskFailure = 'RISK_QUERY_FAILED' | 'RISK_NOT_APPLICABLE';

/**
 * A failure is a value, not an exception.
 *
 * The caller has to do something specific with it — pass `null` to the kernel and let
 * the policy's own `fallback.onRiskUnavailable` decide — and an exception on the way
 * past that would roll back the transaction that is recording the refusal.
 */
export type RiskOutcome =
  | { readonly ok: true; readonly assessment: RiskAssessment }
  | { readonly ok: false; readonly code: RiskFailure; readonly detail: string };

export interface RiskProvider {
  assess(tx: TenantTx, subject: RiskSubject): Promise<RiskOutcome>;
}

export interface BaselineOptions {
  /** ASSUMED windows, not measured ones: 30 days of history, 14 days of silence. */
  readonly windowDays: number;
  readonly dormantAfterDays: number;
  /** A request this close to the per-transaction ceiling is worth a look even if it is routine. */
  readonly proximityFraction: number;
}

const DEFAULTS: BaselineOptions = { windowDays: 30, dormantAfterDays: 14, proximityFraction: 0.9 };

/**
 * Validate rather than coerce.
 *
 * `{ ...DEFAULTS, ...options }` is the tempting form and it has two holes: an object
 * reaching here from a config file carries inherited enumerable properties (`toString`
 * and friends) that the spread happily copies into numeric fields, and an explicit
 * `null` or `0` sails through to the query as a window of "everything, ever" or a
 * fraction that makes every payment look like it is sitting on the ceiling.
 */
function configured(input: Partial<BaselineOptions>): BaselineOptions {
  const source: Record<string, unknown> = { ...DEFAULTS };
  for (const key of ['windowDays', 'dormantAfterDays', 'proximityFraction'] as const) {
    const value = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined;
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(`risk baseline ${key} must be a positive finite number`);
    }
    source[key] = value;
  }
  return {
    windowDays: source.windowDays as number,
    dormantAfterDays: source.dormantAfterDays as number,
    proximityFraction: source.proximityFraction as number,
  };
}

interface BaselineRow {
  observations: number;
  amount_observations: number;
  median_raw: string | null;
  p95_raw: string | null;
  last_seen: Date | null;
  distinct_recipients: number;
  recipients_24h: number;
  // Every count is cast to `int` in the SQL, and that is not cosmetic: `count(*)`
  // returns `bigint`, which the driver hands over as a *string*, and a comparison like
  // `row.recipient_observations === 0` against a string is false for the one case it
  // exists to catch. TypeScript cannot see it, because the generic parameter on
  // `query<T>` is an assertion rather than a check.
  recipient_observations: number;
  requests_at_this_hour: number;
  requests_last_hour: number;
}

const BASELINE_SQL = `
WITH observed AS (
  SELECT r.created_at, r.recipient_address, r.amount_raw,
         extract(hour from r.created_at at time zone 'UTC')::int AS utc_hour
    FROM ari.transaction_requests r
   WHERE r.org_id = $1 AND r.wallet_id = $2 AND r.agent_id = $3
     AND r.idempotency_key <> $4
     AND r.lifecycle_state IN ('TICKET_MINTED', 'SIGNING_COMPLETE', 'BROADCAST', 'BROADCAST_CONFIRMED')
     AND r.created_at > to_timestamp($5 / 1000.0)
)
SELECT
  count(*)::int                                             AS observations,
  count(*) FILTER (WHERE amount_raw IS NOT NULL)::int       AS amount_observations,
  -- FILTER on the aggregates, not just the counts. Percentiles ignore NULLs in the
  -- ordering but count them in the denominator, so a wallet with a page of contract
  -- calls (no amount) and four payments would have had its "median" picked from a
  -- population of eight — a median that drifts *upward* as unrelated traffic arrives,
  -- which is the direction that makes an unusually large payment look normal.
  percentile_disc(0.5)  WITHIN GROUP (ORDER BY amount_raw)
    FILTER (WHERE amount_raw IS NOT NULL)::text             AS median_raw,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY amount_raw)
    FILTER (WHERE amount_raw IS NOT NULL)::text             AS p95_raw,
  max(created_at)                                           AS last_seen,
  count(DISTINCT recipient_address)::int                    AS distinct_recipients,
  -- One clock. Everything else in this query is windowed against the subject's own
  -- nowMs, supplied by the caller; the database's now() here would have measured the
  -- last day according to a different machine and compared it to a subject possibly
  -- minutes away from it — the split this repository has now been bitten by twice.
  count(DISTINCT recipient_address)
    FILTER (WHERE created_at > to_timestamp($9 / 1000.0))::int
                                                            AS recipients_24h,
  count(*) FILTER (WHERE recipient_address = $6)::int       AS recipient_observations,
  count(*) FILTER (WHERE utc_hour = $7)::int                AS requests_at_this_hour,
  count(*) FILTER (WHERE created_at > to_timestamp($8 / 1000.0))::int AS requests_last_hour
FROM observed
`;

export function behaviouralProvider(options: Partial<BaselineOptions> = {}): RiskProvider {
  const config = configured(options);

  return {
    async assess(tx, subject) {
      const utcHour = new Date(Number(subject.nowMs)).getUTCHours();
      // Milliseconds in, divided by 1000.0 in the SQL: `to_timestamp` takes seconds, and
      // passing an epoch in milliseconds is not an error — it is a timestamp in the
      // fifty-seventh millennium, which silently excludes every real row. The first
      // version of this query did exactly that and reported "no history" for an agent
      // with a page of authorised payments.
      const windowStart = Number(subject.nowMs) - config.windowDays * 86_400_000;
      const lastHourStart = Number(subject.nowMs) - 3_600_000;
      const dayStart = Number(subject.nowMs) - 86_400_000;
      let rows: readonly BaselineRow[];
      try {
        const result = await tx.client.query<BaselineRow>(BASELINE_SQL, [
          tx.orgId,
          subject.walletId,
          subject.agentId,
          subject.idempotencyKey,
          windowStart,
          subject.recipientAddress,
          utcHour,
          lastHourStart,
          dayStart,
        ]);
        rows = result.rows;
      } catch (error) {
        // The message is kept out of the outcome: it can name a column or a constraint,
        // and what the caller needs is the code, not the schema.
        return { ok: false, code: 'RISK_QUERY_FAILED', detail: (error as Error).name };
      }

      const row = rows[0];
      if (row === undefined) return { ok: false, code: 'RISK_NOT_APPLICABLE', detail: 'the baseline read returned no row' };
      return { ok: true, assessment: build(subject, row, config) };
    },
  };
}

/**
 * The facts, then the signals, then the score — in that order, and the explanation is
 * written from the same numbers that produced them.
 *
 * An approver reading `HIGH` is entitled to see what `HIGH` meant arithmetically, and a
 * sentence generated afterwards from the score alone would be a story about a number
 * rather than the reason for it.
 */
function build(subject: RiskSubject, row: BaselineRow, config: BaselineOptions): RiskAssessment {
  const signals: ComputedSignal[] = [];
  const facts: string[] = [];
  const utcHour = new Date(Number(subject.nowMs)).getUTCHours();

  const median = row.median_raw === null ? null : BigInt(row.median_raw);
  const p95 = row.p95_raw === null ? null : BigInt(row.p95_raw);
  const hasHistory = row.observations > 0;

  if (!hasHistory) {
    signals.push('NO_BEHAVIOUR_BASELINE');
    facts.push(`no authorised request by this agent in the last ${config.windowDays} days`);
  } else {
    facts.push(`${row.observations} authorised request(s) in ${config.windowDays}d`);

    if (subject.isTransfer && row.amount_observations > 0 && subject.amountRaw > 0n) {
      const comparison = compareAmount(subject.amountRaw, median, p95);
      if (comparison === 'EIGHT_TIMES_MEDIAN') {
        signals.push('AMOUNT_8X_BASELINE');
        facts.push(`${ratio(subject.amountRaw, median)}× this agent's median (${subject.amountRaw} vs ${median} ${subject.currencyUnit})`);
      } else if (comparison === 'ABOVE_P95' || comparison === 'ABOVE_MEDIAN') {
        signals.push('AMOUNT_ABOVE_BASELINE');
        facts.push(
          comparison === 'ABOVE_P95'
            ? `${subject.amountRaw} is above the ${config.windowDays}d p95 of ${p95 ?? median} ${subject.currencyUnit}`
            : `${subject.amountRaw} is above this agent's median of ${median} ${subject.currencyUnit}`,
        );
      }
    }

    if (subject.isTransfer && subject.recipientAddress !== null && row.recipient_observations === 0) {
      signals.push('NEW_RECIPIENT');
      facts.push('recipient not in the observed set for this wallet');
    }

    // Velocity is a rate comparison, so it needs enough history for the rate to mean
    // anything: one recipient in the whole window against two today is a change of
    // habit, and it is not worth waking anyone for on three days of data.
    if (row.observations >= 5 && row.recipients_24h >= 3 && row.distinct_recipients > 0) {
      const dailyAverage = row.distinct_recipients / config.windowDays;
      if (row.recipients_24h >= Math.max(2, dailyAverage * 3)) {
        signals.push('RECIPIENT_VELOCITY_CHANGE');
        facts.push(`${row.recipients_24h} recipient(s) in 24h against ${dailyAverage.toFixed(2)}/day over ${config.windowDays}d`);
      }
    }

    if (row.last_seen !== null) {
      const silentDays = Math.floor((Number(subject.nowMs) - row.last_seen.getTime()) / 86_400_000);
      if (silentDays >= config.dormantAfterDays) {
        signals.push('DORMANT_AGENT_RESUMED');
        facts.push(`silent for ${silentDays}d`);
      }
    }

    if (row.observations >= 8 && row.requests_at_this_hour === 0) {
      signals.push('OUT_OF_HOURS');
      facts.push(`no request in the ${String(utcHour).padStart(2, '0')}:00 UTC hour in ${config.windowDays}d of history`);
    }
  }

  // Proximity is not a baseline comparison — the cap is the policy's own number, and a
  // payment that sits under it by one unit is inside the rule in the way that most often
  // means the cap was set around the payment rather than the other way round.
  // Transfers only, on the same reasoning as the amount baseline: the cap is denominated
  // in the policy's token unit, and a contract call's `value` is native currency. A
  // ratio across the two is a number that looks comparable and is not.
  if (subject.isTransfer && subject.amountRaw > 0n && subject.perTransactionCapRaw > 0n) {
    if (subject.amountRaw * 100n >= subject.perTransactionCapRaw * BigInt(Math.round(config.proximityFraction * 100))) {
      signals.push('POLICY_BOUNDARY_PROXIMITY');
      facts.push(`within ${Math.round((1 - config.proximityFraction) * 100)}% of the per-transaction ceiling`);
    }
  }

  // Drift is deliberately composite: two mild oddities in the same request is the
  // pattern a single threshold cannot see, and naming it here rather than hiding it
  // inside a weight is what lets the property test check that adding a signal never
  // lowers the score.
  if (signals.filter((s) => s !== 'BEHAVIOUR_PROFILE_DRIFT').length >= 2 && !signals.includes('NO_BEHAVIOUR_BASELINE')) {
    signals.push('BEHAVIOUR_PROFILE_DRIFT');
  }

  const explanation = `${FEATURES_VERSION}: ${facts.join('; ') || 'nothing unusual measured'}`;
  return assess({
    requestId: subject.requestId,
    signals,
    explanation,
    baselineWindowDays: config.windowDays,
    computedAtMs: subject.nowMs,
  }).assessment;
}

/** `amount / median` as a one-decimal string, without a float touching either side. */
function ratio(amount: bigint, median: bigint | null): string {
  if (median === null || median === 0n) return '0.0';
  const tenths = (amount * 10n) / median;
  const whole = tenths / 10n;
  const fraction = tenths % 10n;
  return `${whole}.${fraction}`;
}

/** The score of a signal set, exported so the audit writer and the tests agree on one definition. */
export { scoreOf };
export type { ComputedSignal };
export { WEIGHTS, levelOf, FEATURES_VERSION } from './scoring.js';
