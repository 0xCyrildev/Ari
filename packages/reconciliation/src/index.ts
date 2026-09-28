/**
 * `@ari/reconciliation` — the pass that looks for payments nobody finished, and reports.
 *
 * It is read-only by construction rather than by convention. The functions here take a
 * transaction handle, issue SELECTs, and return a value; the one write in the package is
 * `recordReport`, which appends a single audit event and is a separate call a caller has to
 * make on purpose. That shape is the whole answer to the question this package exists to
 * raise: a sweep that could release a hold is a sweep that will, one day, release the wrong
 * one — and the rule this repository already holds is that a *non-terminal* refusal keeps
 * capacity parked, because only the agent knows whether it intends to retry.
 *
 * What it does not do:
 * - release, settle, re-deliver, prune or delete anything;
 * - call a signing provider, or ask one for a status (`SigningProvider.getStatus` exists for
 *   a handoff that is still waiting, and calling it from here would be this process
 *   inventing a chain fact it was not told — S12);
 * - claim that `SIGNING_COMPLETE` means a transaction landed on a chain. It does not, and
 *   today nothing in this build could make it mean that.
 */

import { appendEvent, type AuditEventInput, type AuditSeverity, type AuditTx } from '@ari/audit';
import type { PoolClient } from 'pg';
import {
  DEFAULT_PARKED_THRESHOLD_SECONDS,
  FINDING_CODES,
  FINDING_QUERIES,
  type FindingCode,
} from './findings.js';

export { FINDING_CODES, DEFAULT_PARKED_THRESHOLD_SECONDS };
export type { FindingCode };

interface FindingRow {
  readonly count: number | null;
  readonly oldest_id: string | null;
  readonly oldest_at: Date | null;
}

export interface Finding {
  readonly code: FindingCode;
  readonly count: number;
  /** Where an operator should start looking. In the report only — never in the audit event. */
  readonly oldestId: string | null;
  readonly oldestAt: string | null;
}

export interface ReconciliationReport {
  readonly organizationId: string;
  readonly generatedAt: string;
  readonly thresholdSeconds: number;
  readonly findings: readonly Finding[];
  /** Sum of every finding's count. Zero means the tenant is not stuck anywhere. */
  readonly total: number;
  readonly severity: AuditSeverity;
}

/**
 * One pass over one tenant.
 *
 * `now` is supplied rather than read for the same reason `TenantTx.startedAtMs` is: two
 * expiry checks inside one pass that disagree is a bug nobody can reproduce afterwards, and
 * the caller already has a clock it decided to trust.
 */
export async function runReconciliation(
  client: PoolClient,
  organizationId: string,
  now: Date,
  options: { readonly thresholdSeconds?: number } = {},
): Promise<ReconciliationReport> {
  const thresholdSeconds = Math.max(0, Math.trunc(options.thresholdSeconds ?? DEFAULT_PARKED_THRESHOLD_SECONDS));
  const cutoff = new Date(now.getTime() - thresholdSeconds * 1000);
  const nowMs = now.getTime();

  const findings: Finding[] = [];
  for (const query of FINDING_QUERIES) {
    // Sequential on purpose: this runs inside `asTenant`, which is one pooled client, so a
    // `Promise.all` here would not be parallel — it would interleave six statements on one
    // connection that is holding a transaction open.
    const rows = await client.query<FindingRow>(query.sql, query.params({ orgId: organizationId, cutoff, nowMs }));
    const row = rows.rows[0];
    findings.push({
      code: query.code,
      count: row?.count ?? 0,
      oldestId: row?.oldest_id ?? null,
      oldestAt: row?.oldest_at instanceof Date ? row.oldest_at.toISOString() : null,
    });
  }

  const total = findings.reduce((sum, finding) => sum + finding.count, 0);
  return {
    organizationId,
    generatedAt: now.toISOString(),
    thresholdSeconds,
    findings,
    total,
    severity: severityOf(findings),
  };
}

/**
 * The one judgement the pass makes rather than reports.
 *
 * A redeemed ticket whose request never moved is `critical` because a signature exists that
 * the ledger does not acknowledge and the capacity is still held — it is the only finding
 * here where money may already have left the wallet while Ari believes it has not.
 * Everything else is a `warning` when non-zero, and `info` when the tenant is clean, which
 * is what makes the clean case legible as a run rather than as an absence of evidence.
 */
export function severityOf(findings: readonly Finding[]): AuditSeverity {
  const critical = findings.some(
    (finding) => finding.count > 0 && finding.code === 'TICKET_REDEEMED_NOT_RECORDED',
  );
  if (critical) return 'critical';
  return findings.some((finding) => finding.count > 0) ? 'warning' : 'info';
}

/**
 * The report as one audit event.
 *
 * The metadata carries the finding codes that were non-zero and the total, not the per-code
 * numbers: `SafeLogFields` is a closed set of bounded strings precisely so that a hashed,
 * exported trail cannot carry a blob somebody forgot to think about, and six integers under
 * one nested key would be the first field whose shape nothing checks. Anyone who needs the
 * numbers re-runs the pass — which is also the only way to get numbers that are true *now*.
 */
export function reportToAudit(report: ReconciliationReport): AuditEventInput {
  return {
    orgId: report.organizationId,
    actor: 'reconciliation',
    actorType: 'system',
    eventType: 'reconciliation.reported',
    severity: report.severity,
    metadata: {
      reconFindings: report.findings.filter((finding) => finding.count > 0).map((finding) => finding.code),
      reconTotal: String(report.total),
    },
  };
}

/** The only write in the package, and it is a call a caller has to decide to make. */
export async function recordReport(tx: AuditTx, report: ReconciliationReport): Promise<void> {
  await appendEvent(tx, reportToAudit(report));
}
