/**
 * The parts of a reconciliation report that are decided in code rather than read from the
 * database: how severe a finding is, and what the audit event is allowed to say.
 *
 * The six queries themselves are asserted against a real Postgres in
 * `tests/security/reconciliation.test.ts`, because a SELECT that has never met its own
 * schema is a guess about column names.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARKED_THRESHOLD_SECONDS,
  FINDING_CODES,
  reportToAudit,
  runReconciliation,
  severityOf,
  type Finding,
  type ReconciliationReport,
} from '../src/index.js';

function finding(code: Finding['code'], count: number): Finding {
  return { code, count, oldestId: count > 0 ? 'txr_01a0e908-0000-7000-8000-000000000000' : null, oldestAt: null };
}

const report = (findings: readonly Finding[]): ReconciliationReport => ({
  organizationId: 'org_01a0e908-0000-7000-8000-000000000000',
  generatedAt: new Date('2026-09-28T12:00:00.000Z').toISOString(),
  thresholdSeconds: DEFAULT_PARKED_THRESHOLD_SECONDS,
  findings,
  total: findings.reduce((sum, entry) => sum + entry.count, 0),
  severity: severityOf(findings),
});

describe('the finding vocabulary', () => {
  it('is the closed set this package reports, in the order it is read', () => {
    // Names an operator greps for and a CLI prints. Renaming one is a contract change, and
    // this is where it has to be noticed rather than in a log viewer six weeks later.
    expect([...FINDING_CODES]).toEqual([
      'APPROVAL_EXPIRED_UNANSWERED',
      'DELIVERY_PARKED',
      'TICKET_REDEEMED_NOT_RECORDED',
      'TICKET_MINTED_NOT_REDEEMED',
      'ABANDONED_CLAIMS_ACCUMULATED',
      'STATE_MACHINE_STALLED',
    ]);
  });

  it('has a threshold that cannot be confused with normal operation', () => {
    // Measured against the two numbers that bound it: ~30 ms p50 for a payment, and the
    // 60-second deadline a candidate carries. A threshold between those would report work in
    // progress as stuck.
    expect(DEFAULT_PARKED_THRESHOLD_SECONDS).toBe(300);
  });
});

describe('severity', () => {
  it('is info when nothing was found, and warning when something was', () => {
    expect(severityOf(FINDING_CODES.map((code) => finding(code, 0)))).toBe('info');
    expect(severityOf([finding('DELIVERY_PARKED', 1), ...FINDING_CODES.slice(1).map((code) => finding(code, 0))])).toBe('warning');
  });

  it('is critical for exactly one code', async () => {
    // A redeemed ticket whose request never moved means a signature exists that the ledger
    // does not acknowledge — money may have left the wallet while Ari believes the capacity
    // is still held. Every other finding is a backlog item; that one is an incident, and a
    // report that graded them alike would be read as noise.
    expect(severityOf([finding('TICKET_REDEEMED_NOT_RECORDED', 1)])).toBe('critical');
    expect(severityOf([finding('TICKET_REDEEMED_NOT_RECORDED', 0), finding('DELIVERY_PARKED', 7)])).toBe('warning');
  });
});

describe('the audit event a report becomes', () => {
  it('carries the codes that were non-zero and the total, and nothing else', () => {
    const event = reportToAudit(report([finding('DELIVERY_PARKED', 3), finding('ABANDONED_CLAIMS_ACCUMULATED', 1), ...FINDING_CODES.slice(2, 6).map((code) => finding(code, 0))]));
    expect(event.eventType).toBe('reconciliation.reported');
    expect(event.actorType).toBe('system');
    expect(event.severity).toBe('warning');
    expect(event.metadata?.reconFindings).toEqual(['DELIVERY_PARKED', 'ABANDONED_CLAIMS_ACCUMULATED']);
    expect(event.metadata?.reconTotal).toBe('4');
  });

  it('names no row id, no digest and no amount', () => {
    // The report has `oldestId` in it on purpose — an operator needs somewhere to start
    // looking. The event is a witness that a pass ran, and a hashed, exported trail is not
    // where a pointer into somebody's payment history belongs.
    const event = reportToAudit(report([finding('DELIVERY_PARKED', 2)]));
    const text = JSON.stringify(event);
    expect(text).not.toContain('txr_');
    expect(text).not.toContain('amountRaw');
    expect(text).not.toContain('digest');
  });

  it('says so plainly when the tenant was clean', () => {
    const event = reportToAudit(report(FINDING_CODES.map((code) => finding(code, 0))));
    expect(event.metadata?.reconFindings).toEqual([]);
    expect(event.metadata?.reconTotal).toBe('0');
    expect(event.severity).toBe('info');
  });
});

describe('the clock a pass runs against', () => {
  /** Every statement the pass issues, with what it was bound with. */
  async function probe(thresholdSeconds: number | undefined): Promise<readonly { sql: string; bound: readonly unknown[] }[]> {
    const seen: { sql: string; bound: readonly unknown[] }[] = [];
    const client = {
      async query(sql: string, bound?: unknown[]) {
        seen.push({ sql, bound: bound ?? [] });
        return { rows: [{ count: 0, oldest_id: null, oldest_at: null }] };
      },
    } as unknown as Parameters<typeof runReconciliation>[0];
    const now = new Date('2026-09-28T12:00:00.000Z');
    await runReconciliation(client, 'org_under_test', now, thresholdSeconds === undefined ? {} : { thresholdSeconds });
    return seen;
  }

  /** The placeholders a statement mentions, as numbers. */
  function referenced(sql: string): number[] {
    return [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  }

  it('binds every parameter its statement references, and no parameter it does not', async () => {
    // The two ends of the pairing are both errors, and both were measured here against a
    // shared bind array: a list longer than the statement references is "bind message
    // supplies 3 parameters, but prepared statement requires 2", and a placeholder that is
    // bound but never mentioned is "could not determine data type of parameter $2" —
    // Postgres takes a parameter's type from where it is used, so an unused one has none.
    // Hence: the bind list must be exactly `$1 … $n`, dense and in order.
    const statements = await probe(undefined);
    expect(statements).toHaveLength(FINDING_CODES.length);
    for (const { sql, bound } of statements) {
      const refs = referenced(sql);
      expect(bound).toHaveLength(refs.length);
      expect([...new Set(refs)].sort()).toEqual(refs.map((_, index) => index + 1));
    }
  });

  it('scopes every statement to one tenant, and gives the millisecond column a millisecond clock', async () => {
    const statements = await probe(60);
    const nowMs = Date.parse('2026-09-28T12:00:00.000Z');
    // One tenant per pass, named in the SQL rather than left to row security — which
    // `signing_tickets` does not have, and that query is in this same set.
    expect(new Set(statements.map(({ bound }) => bound[0]))).toEqual(new Set(['org_under_test']));
    const cutoffs = statements
      .filter(({ bound }) => bound[1] instanceof Date)
      .map(({ bound }) => (bound[1] as Date).getTime());
    expect(cutoffs.length).toBeGreaterThan(0);
    expect(new Set(cutoffs)).toEqual(new Set([nowMs - 60_000]));
    // `expires_at_ms` is a bigint of milliseconds, so that one statement is bound with the
    // same instant in the unit its column is stored in. Passing a Date there is the
    // `to_timestamp` trap in the other direction, and it would compare silently.
    const msBound = statements.filter(({ sql }) => sql.includes('expires_at_ms <'));
    expect(msBound).toHaveLength(1);
    expect(msBound[0]?.bound[1]).toBe(nowMs);
  });

  it('defaults the threshold rather than reading a clock of its own', async () => {
    const defaulted = await probe(undefined);
    const explicit = await probe(DEFAULT_PARKED_THRESHOLD_SECONDS);
    expect(defaulted.map(({ bound }) => JSON.stringify(bound, dateReplacer)))
      .toEqual(explicit.map(({ bound }) => JSON.stringify(bound, dateReplacer)));
  });

  it('clamps a negative threshold to the instant it was given, not to the future', async () => {
    // A cutoff *after* now would report every live row as stuck, and the report would read
    // as an outage. Zero means "anything older than this instant", which is what an operator
    // asking for no grace period actually wants.
    const statements = await probe(-3_600);
    const cutoffs = statements.filter(({ bound }) => bound[1] instanceof Date).map(({ bound }) => (bound[1] as Date).toISOString());
    expect(new Set(cutoffs)).toEqual(new Set(['2026-09-28T12:00:00.000Z']));
  });
});

function dateReplacer(_key: string, value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}
