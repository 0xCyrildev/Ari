/**
 * What `ari-api` answers, described once, and checked on the way in.
 *
 * `packages/client` is the agent's SDK and does the same job with the same rule: a 200 that
 * carries a field nobody described is a contract mismatch, not an ignored extra key. The reason
 * a browser needs that discipline *more* is that this surface reads a payment system, so a
 * surprise in a response means a human sees a number nobody in the chain wrote down.
 *
 * Each shape below names the file it was copied from, in the backend, for the same reason
 * `types.ts` does: an enum the console invented is a status the console will invent an answer
 * for. `zod` is not a dependency of this app — the checks are ten small functions rather than a
 * schema language, and every one of them refuses rather than coerces.
 *
 * Money arrives as a decimal string and stays one. Nothing here calls `Number()` on an amount.
 */

import type { DecisionOutcome, LifecycleState } from './types'

export class ContractMismatch extends Error {
  constructor(readonly where: string, readonly got: unknown) {
    super(`${where} is not what the contract describes (got ${describe(got)})`)
  }
}

const describe = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value

export const str = (value: unknown, where: string): string => {
  if (typeof value !== 'string') throw new ContractMismatch(where, value)
  return value
}

export const nullableStr = (value: unknown, where: string): string | null =>
  value === null || value === undefined ? null : str(value, where)

export const num = (value: unknown, where: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ContractMismatch(where, value)
  return value
}

export const bool = (value: unknown, where: string): boolean => {
  if (typeof value !== 'boolean') throw new ContractMismatch(where, value)
  return value
}

/** An array of one known thing. A response that is not an array is a mismatch, not an empty list. */
export const list = (value: unknown, where: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new ContractMismatch(where, value)
  return value
}

export const record = (value: unknown, where: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractMismatch(where, value)
  }
  return value as Record<string, unknown>
}

/** A field the contract does not describe, refused by name and nothing else — never by value. */
export const refuseExtra = (row: Record<string, unknown>, known: readonly string[], where: string): void => {
  const surprise = Object.keys(row).find((key) => !known.includes(key))
  if (surprise !== undefined) {
    throw new ContractMismatch(`${where}.${surprise} (a field this client's contract does not describe)`, true)
  }
}

// ---------------------------------------------------------------------------
// The reads. Field lists mirror `apps/api/src/reads.ts` and `apps/api/src/routes.ts`.
// ---------------------------------------------------------------------------

export interface WireDecision {
  readonly outcome: DecisionOutcome
  readonly policyVersionId: string
  readonly madeAt: string
  readonly reasonCodes: readonly string[]
  readonly committedDecisionId: string | null
}

export interface WireRisk {
  readonly level: string
  readonly score: string
  readonly signals: readonly string[]
}

export interface WireTransaction {
  readonly id: string
  readonly agentId: string
  readonly walletId: string
  readonly lifecycleState: LifecycleState
  readonly createdAt: string
  readonly updatedAt: string
  readonly digest: string
  readonly recipientAddress: string | null
  readonly amountRaw: string | null
  readonly currencyUnit: string | null
  readonly risk: WireRisk | null
  readonly decision: WireDecision | null
}

export interface WireTrailEvent {
  readonly seq: string
  readonly madeAt: string
  readonly eventType: string
  readonly actor: string
  readonly actorType: string
  readonly severity: string
  readonly decision: string | null
  readonly reasonCodes: readonly string[]
  readonly meta: unknown
}

export interface WireTransactionRecord extends WireTransaction {
  readonly canonical: string
  readonly idempotencyKey: string
  readonly trail: readonly WireTrailEvent[]
}

export interface WireWallet {
  readonly id: string
  readonly displayName: string
  readonly mode: 'delegated' | 'user_gated'
  readonly provider: string
  readonly address: string | null
  readonly createdAt: string
  readonly supersededAt: string | null
  readonly grants: readonly {
    readonly agentId: string
    readonly policyVersionId: string
    readonly grantedAt: string
    readonly revokedAt: string | null
  }[]
}

export interface WirePolicy {
  readonly id: string
  readonly name: string
  readonly createdAt: string
  readonly versions: readonly {
    readonly id: string
    readonly versionNumber: number
    readonly status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'RETIRED'
    readonly createdAt: string
    readonly activatedAt: string | null
    readonly justification: string | null
    readonly document: unknown
  }[]
}

export interface WireSummary {
  readonly windows: readonly {
    readonly agentId: string
    readonly dimension: string
    readonly windowKey: string
    readonly currentReserved: string
    readonly settled: string
    readonly settledRequests: string
    readonly reservedRequests: string
  }[]
  readonly requestCountsByState: readonly { readonly state: string; readonly count: number }[]
  readonly agentsByStatus: readonly { readonly status: string; readonly count: number }[]
  readonly pendingApprovals: number
  readonly liveWallets: number
  readonly activePolicies: readonly {
    readonly policyVersionId: string
    readonly policyName: string
    readonly versionNumber: number
  }[]
}

/** `packages/approvals/src/index.ts`'s `ApprovalDetail`, over the wire. */
export interface WireApproval {
  readonly approvalId: string
  readonly subjectKind: 'transaction' | 'policy_activation'
  readonly subjectId: string
  readonly digest: string
  readonly amountRaw: string | null
  readonly currencyUnit: string
  readonly agentId: string
  readonly walletId: string
  readonly policyVersionId: string
  readonly requestedBy: string
  readonly quorumNeeded: number
  readonly approved: number
  readonly expiresAt: string
  readonly status: 'PENDING' | 'GRANTED' | 'REJECTED' | 'EXPIRED' | 'CONSUMED'
  readonly votes: readonly { readonly approver: string; readonly role: string; readonly decision: string; readonly at: string }[]
}

/** `packages/audit/src/index.ts`'s renamed `EventLogEntry`. */
export interface WireAuditEvent {
  readonly seq: string
  readonly id: string
  readonly madeAt: string
  readonly org: string
  readonly actor: string
  readonly actorType: string
  readonly eventType: string
  readonly resource: string | null
  readonly resourceId: string | null
  readonly request: string | null
  readonly policyVersion: string | null
  readonly decision: string | null
  readonly reasons: readonly string[]
  readonly severity: string
  readonly meta: Record<string, unknown>
  readonly prev: string
  readonly storedHash: string
}

const DECISION_OUTCOMES: readonly string[] = ['ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL']
const APPROVAL_STATUSES: readonly string[] = ['PENDING', 'GRANTED', 'REJECTED', 'EXPIRED', 'CONSUMED']
const SUBJECT_KINDS: readonly string[] = ['transaction', 'policy_activation']
const WALLET_MODES: readonly string[] = ['delegated', 'user_gated']
const POLICY_STATUSES: readonly string[] = ['DRAFT', 'ACTIVE', 'SUPERSEDED', 'RETIRED']
const ACTOR_TYPES: readonly string[] = ['agent', 'human', 'system']

const oneOf = (value: unknown, allowed: readonly string[], where: string): string => {
  const text = str(value, where)
  if (!allowed.includes(text)) throw new ContractMismatch(`${where} ("${text}" is not one of ${allowed.join('|')})`, text)
  return text
}

const decisionOf = (value: unknown, where: string): WireDecision | null => {
  if (value === null || value === undefined) return null
  const row = record(value, where)
  refuseExtra(row, ['outcome', 'policyVersionId', 'madeAt', 'reasonCodes', 'committedDecisionId'], where)
  return {
    outcome: oneOf(row.outcome, DECISION_OUTCOMES, `${where}.outcome`) as DecisionOutcome,
    policyVersionId: str(row.policyVersionId, `${where}.policyVersionId`),
    madeAt: str(row.madeAt, `${where}.madeAt`),
    reasonCodes: list(row.reasonCodes, `${where}.reasonCodes`).map((code) => str(code, `${where}.reasonCodes[]`)),
    committedDecisionId: nullableStr(row.committedDecisionId, `${where}.committedDecisionId`),
  }
}

export const parseTransaction = (value: unknown, where = 'transaction'): WireTransaction => {
  const row = record(value, where)
  refuseExtra(
    row,
    ['id', 'agentId', 'walletId', 'lifecycleState', 'createdAt', 'updatedAt', 'digest', 'recipientAddress',
     'amountRaw', 'currencyUnit', 'risk', 'decision'],
    where,
  )
  const risk = row.risk === null || row.risk === undefined ? null : record(row.risk, `${where}.risk`)
  return {
    id: str(row.id, `${where}.id`),
    agentId: str(row.agentId, `${where}.agentId`),
    walletId: str(row.walletId, `${where}.walletId`),
    // The lifecycle vocabulary is `011`'s CHECK and `transaction-engine`'s table. It is checked
    // against `LIFECYCLE_STATES` by the caller that renders it, because a state this file has
    // never heard of is still a fact about a row — refusing to read it would lose the row.
    lifecycleState: str(row.lifecycleState, `${where}.lifecycleState`) as LifecycleState,
    createdAt: str(row.createdAt, `${where}.createdAt`),
    updatedAt: str(row.updatedAt, `${where}.updatedAt`),
    digest: str(row.digest, `${where}.digest`),
    recipientAddress: nullableStr(row.recipientAddress, `${where}.recipientAddress`),
    amountRaw: nullableStr(row.amountRaw, `${where}.amountRaw`),
    currencyUnit: nullableStr(row.currencyUnit, `${where}.currencyUnit`),
    risk:
      risk === null
        ? null
        : {
            level: str(risk.level, `${where}.risk.level`),
            score: str(risk.score, `${where}.risk.score`),
            signals: list(risk.signals, `${where}.risk.signals`).map((s) => str(s, `${where}.risk.signals[]`)),
          },
    decision: decisionOf(row.decision, `${where}.decision`),
  }
}

export const parseTransactionRecord = (value: unknown): WireTransactionRecord => {
  const row = record(value, 'transaction')
  const base = parseTransaction(row, 'transaction')
  const trail = list(row.trail, 'transaction.trail').map((event, i) => {
    const e = record(event, `transaction.trail[${i}]`)
    return {
      seq: str(e.seq, `transaction.trail[${i}].seq`),
      madeAt: str(e.madeAt, `transaction.trail[${i}].madeAt`),
      eventType: str(e.event_type ?? e.eventType, `transaction.trail[${i}].eventType`),
      actor: str(e.actor, `transaction.trail[${i}].actor`),
      actorType: str(e.actorType, `transaction.trail[${i}].actorType`),
      severity: str(e.severity, `transaction.trail[${i}].severity`),
      decision: nullableStr(e.decision, `transaction.trail[${i}].decision`),
      reasonCodes: list(e.reasonCodes, `transaction.trail[${i}].reasonCodes`).map((c) => str(c, 'reason')),
      meta: e.meta,
    } satisfies WireTrailEvent
  })
  return { ...base, canonical: str(row.canonical, 'transaction.canonical'), idempotencyKey: str(row.idempotencyKey, 'transaction.idempotencyKey'), trail }
}

export const parseWallets = (value: unknown): readonly WireWallet[] =>
  list(value, 'wallets').map((item, i) => {
    const row = record(item, `wallets[${i}]`)
    refuseExtra(row, ['id', 'displayName', 'mode', 'provider', 'address', 'createdAt', 'supersededAt', 'grants'], `wallets[${i}]`)
    return {
      id: str(row.id, 'wallet.id'),
      displayName: str(row.displayName, 'wallet.displayName'),
      mode: oneOf(row.mode, WALLET_MODES, `wallets[${i}].mode`) as WireWallet['mode'],
      provider: str(row.provider, 'wallet.provider'),
      address: nullableStr(row.address, 'wallet.address'),
      createdAt: str(row.createdAt, 'wallet.createdAt'),
      supersededAt: nullableStr(row.supersededAt, 'wallet.supersededAt'),
      grants: list(row.grants, 'wallet.grants').map((grant, j) => {
        const g = record(grant, `wallets[${i}].grants[${j}]`)
        return {
          agentId: str(g.agentId, 'grant.agentId'),
          policyVersionId: str(g.policyVersionId, 'grant.policyVersionId'),
          grantedAt: str(g.grantedAt, 'grant.grantedAt'),
          revokedAt: nullableStr(g.revokedAt, 'grant.revokedAt'),
        }
      }),
    }
  })

export const parsePolicies = (value: unknown): readonly WirePolicy[] =>
  list(value, 'policies').map((item, i) => {
    const row = record(item, `policies[${i}]`)
    refuseExtra(row, ['id', 'name', 'createdAt', 'versions'], `policies[${i}]`)
    return {
      id: str(row.id, 'policy.id'),
      name: str(row.name, 'policy.name'),
      createdAt: str(row.createdAt, 'policy.createdAt'),
      versions: list(row.versions, 'policy.versions').map((version, j) => {
        const v = record(version, `policies[${i}].versions[${j}]`)
        return {
          id: str(v.id, 'version.id'),
          versionNumber: num(v.versionNumber, 'version.versionNumber'),
          status: oneOf(v.status, POLICY_STATUSES, 'version.status') as WirePolicy['versions'][number]['status'],
          createdAt: str(v.createdAt, 'version.createdAt'),
          activatedAt: nullableStr(v.activatedAt, 'version.activatedAt'),
          justification: nullableStr(v.justification, 'version.justification'),
          document: v.document,
        }
      }),
    }
  })

export const parseSummary = (value: unknown): WireSummary => {
  const row = record(value, 'summary')
  refuseExtra(
    row,
    ['windows', 'requestCountsByState', 'agentsByStatus', 'pendingApprovals', 'liveWallets', 'activePolicies'],
    'summary',
  )
  return {
    windows: list(row.windows, 'summary.windows').map((item, i) => {
      const w = record(item, `summary.windows[${i}]`)
      return {
        agentId: str(w.agentId, 'window.agentId'),
        dimension: str(w.dimension, 'window.dimension'),
        windowKey: str(w.windowKey, 'window.windowKey'),
        currentReserved: str(w.currentReserved, 'window.currentReserved'),
        settled: str(w.settled, 'window.settled'),
        settledRequests: str(w.settledRequests, 'window.settledRequests'),
        reservedRequests: str(w.reservedRequests, 'window.reservedRequests'),
      }
    }),
    requestCountsByState: list(row.requestCountsByState, 'summary.requestCountsByState').map((item) => {
      const s = record(item, 'summary.requestCountsByState[]')
      return { state: str(s.state, 'count.state'), count: num(s.count, 'count.count') }
    }),
    agentsByStatus: list(row.agentsByStatus, 'summary.agentsByStatus').map((item) => {
      const s = record(item, 'summary.agentsByStatus[]')
      return { status: str(s.status, 'status.status'), count: num(s.count, 'status.count') }
    }),
    pendingApprovals: num(row.pendingApprovals, 'summary.pendingApprovals'),
    liveWallets: num(row.liveWallets, 'summary.liveWallets'),
    activePolicies: list(row.activePolicies, 'summary.activePolicies').map((item) => {
      const p = record(item, 'summary.activePolicies[]')
      return {
        policyVersionId: str(p.policyVersionId, 'active.policyVersionId'),
        policyName: str(p.policyName, 'active.policyName'),
        versionNumber: num(p.versionNumber, 'active.versionNumber'),
      }
    }),
  }
}

export const parseApprovals = (value: unknown): readonly WireApproval[] =>
  list(value, 'approvals').map((item, i) => {
    const row = record(item, `approvals[${i}]`)
    return {
      approvalId: str(row.approvalId, 'approval.approvalId'),
      subjectKind: oneOf(row.subjectKind, SUBJECT_KINDS, 'approval.subjectKind') as WireApproval['subjectKind'],
      subjectId: str(row.subjectId, 'approval.subjectId'),
      digest: str(row.digest, 'approval.digest'),
      amountRaw: nullableStr(row.amountRaw, 'approval.amountRaw'),
      currencyUnit: str(row.currencyUnit, 'approval.currencyUnit'),
      agentId: str(row.agentId, 'approval.agentId'),
      walletId: str(row.walletId, 'approval.walletId'),
      policyVersionId: str(row.policyVersionId, 'approval.policyVersionId'),
      requestedBy: str(row.requestedBy, 'approval.requestedBy'),
      quorumNeeded: num(row.quorumNeeded, 'approval.quorumNeeded'),
      approved: num(row.approved, 'approval.approved'),
      expiresAt: str(row.expiresAt, 'approval.expiresAt'),
      status: oneOf(row.status, APPROVAL_STATUSES, 'approval.status') as WireApproval['status'],
      votes: list(row.votes ?? [], 'approval.votes').map((vote) => {
        const v = record(vote, 'approval.votes[]')
        return {
          approver: str(v.approver, 'vote.approver'),
          role: str(v.role, 'vote.role'),
          decision: str(v.decision, 'vote.decision'),
          at: str(v.at, 'vote.at'),
        }
      }),
    }
  })

export const parseAgents = (value: unknown): readonly { readonly id: string; readonly name: string; readonly status: string }[] =>
  list(value, 'agents').map((item, i) => {
    const row = record(item, `agents[${i}]`)
    refuseExtra(row, ['id', 'name', 'status'], `agents[${i}]`)
    return { id: str(row.id, 'agent.id'), name: str(row.name, 'agent.name'), status: str(row.status, 'agent.status') }
  })

export const parseAuditEvents = (value: unknown): readonly WireAuditEvent[] =>
  list(value, 'events').map((item, i) => {
    const row = record(item, `events[${i}]`)
    return {
      seq: str(row.seq, 'event.seq'),
      id: str(row.id, 'event.id'),
      madeAt: str(row.madeAt, 'event.madeAt'),
      org: str(row.org, 'event.org'),
      actor: str(row.actor, 'event.actor'),
      actorType: oneOf(row.actorType, ACTOR_TYPES, `events[${i}].actorType`),
      eventType: str(row.eventType, 'event.eventType'),
      resource: nullableStr(row.resource, 'event.resource'),
      resourceId: nullableStr(row.resourceId, 'event.resourceId'),
      request: nullableStr(row.request, 'event.request'),
      policyVersion: nullableStr(row.policyVersion, 'event.policyVersion'),
      decision: nullableStr(row.decision, 'event.decision'),
      reasons: list(row.reasons, 'event.reasons').map((r) => str(r, 'event.reasons[]')),
      severity: str(row.severity, 'event.severity'),
      meta: record(row.meta, 'event.meta'),
      prev: str(row.prev, 'event.prev'),
      storedHash: str(row.storedHash, 'event.storedHash'),
    }
  })

/** The error envelope every route uses: `{code, detail?}`. Nothing else is believed. */
export const parseRefusal = (value: unknown): { readonly code: string; readonly detail: string } => {
  const row = record(value, 'refusal')
  return { code: str(row.code, 'refusal.code'), detail: typeof row.detail === 'string' ? row.detail : '' }
}

export const isContractMismatch = (error: unknown): error is ContractMismatch => error instanceof ContractMismatch
