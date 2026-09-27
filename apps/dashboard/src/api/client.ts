/**
 * The seam between this interface and Ari.
 *
 * `AriApi` is the shape the UI is allowed to depend on; `mockApi` implements it from
 * `domain/sample.ts`. Each method names the real route it maps to in `apps/api/src/routes.ts`
 * so that swapping this file for a fetch client is a change in one place and a diff of
 * annotations, not a redesign. Where a screen needs data the API does not yet answer with,
 * the method is marked `no route yet` rather than quietly invented.
 */

import * as sample from '../domain/sample';
import type { ApprovalRequest, AuditEvent, PolicyVersion, TransactionRecord, Wallet } from '../domain/types';

export interface Overview {
  readonly activeAgents: number;
  readonly transactionsToday: number;
  readonly authorizedTodayRaw: bigint;
  readonly pendingApprovals: number;
  readonly riskEvents: number;
  readonly failedToday: number;
  readonly unit: string;
}

export interface AriApi {
  /** GET /v1/transactions/:id · plus the trace, which no single route answers today. */
  transactions(): Promise<readonly TransactionRecord[]>;
  transaction(id: string): Promise<TransactionRecord | undefined>;
  /** GET /v1/approvals · GET /v1/approvals/:id */
  approvals(): Promise<readonly ApprovalRequest[]>;
  /** POST /v1/approvals/:id/decisions, body { decision: 'APPROVED' | 'REJECTED' } */
  decide(approvalId: string, decision: 'APPROVED' | 'REJECTED'): Promise<{ ok: boolean; detail: string }>;
  /** GET /v1/audit/events: the whole chain, with the head the API reports. */
  audit(): Promise<{ events: readonly AuditEvent[]; head: string }>;
  /** no route yet: policy versions are read from the ledger by the operator's tooling. */
  policies(): Promise<readonly { key: string; name: string; versions: readonly PolicyVersion[] }[]>;
  agents(): Promise<readonly (typeof sample.agents)[number][]>;
  wallets(): Promise<readonly Wallet[]>;
  overview(): Promise<Overview>;
}

/**
 * The head of the chain is the row with the highest `seq`, not the last element of whatever
 * order the fixture happens to be in. The audit list is newest-first, so `at(-1)` was the
 * genesis-side link while being labelled "head".
 */
const head = [...sample.auditEvents].sort((a, b) => Number(b.seq) - Number(a.seq))[0]?.hash ?? 'genesis';

export const mockApi: AriApi = {
  async transactions() {
    return sample.transactions;
  },
  async transaction(id) {
    return sample.transactionById(id);
  },
  async approvals() {
    return sample.approvals;
  },
  async decide(approvalId, _decision) {
    const target = sample.approvals.find((a) => a.id === approvalId);
    if (target === undefined) return { ok: false, detail: 'APPROVAL_NOT_FOUND' };
    // The real route refuses a decision from a credential that does not hold
    // `approval:decide`, and the sealed token it returns is minted from the row that
    // recorded the vote, never from what the browser claimed. The mock cannot honour
    // that, so it says so instead of pretending the button worked.
    return {
      ok: false,
      detail: 'No deployment is connected. A decision here would be a screenshot, not a vote.',
    };
  },
  async audit() {
    return { events: sample.auditEvents, head };
  },
  async policies() {
    return sample.policies;
  },
  async agents() {
    return sample.agents;
  },
  async wallets() {
    return sample.wallets;
  },
  async overview() {
    const totals = sample.todayTotals();
    return {
      activeAgents: sample.agents.filter((a) => a.status === 'ACTIVE').length,
      transactionsToday: totals.count,
      authorizedTodayRaw: totals.authorizedRaw,
      pendingApprovals: totals.pending,
      riskEvents: sample.riskEvents().length,
      failedToday: totals.denied,
      unit: sample.UNIT,
    };
  },
};

export const api: AriApi = mockApi;
export const DEMO = true;
export const sampleData = sample;
