'use client'

/**
 * One view model, two sources.
 *
 * A screen must not know whether it is rendering a sample tenant or a live one: the moment the
 * two are different code paths, the demo becomes the path that gets read and the live one the
 * path that gets shipped untested. So everything below is expressed as the same set of fields,
 * built twice — `fromSample`, which reads the labelled fixture, and `fromLive`, which reads
 * `ari-api` through the proxy.
 *
 * What that trade buys is the discipline it costs: **a field with no live source is dropped
 * from the view, not invented.** The fixture carries a `purpose` sentence per agent and
 * `balances` per wallet because a demo needs texture; the API has no such columns, so the agent
 * screen no longer shows them when it is live. That is the same rule `types.ts` states for
 * statuses — a screen that displays something the engine cannot produce teaches its users a
 * false model of their own controls.
 *
 * The credential is a bearer secret, and it is treated like one: `sessionStorage` only, so it
 * dies with the tab; never in a URL, never in a log line, never sent anywhere but this origin
 * (the proxy adds it back to the upstream request). Nothing here can mint one — the routes that
 * mint human authority sit behind the deployment's bootstrap token, which is deliberately not
 * proxyable, so an operator hands this screen a credential the CLI made.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AgentStatus, ApprovalRequest, AuditEvent, LifecycleState, TraceStage, TransactionRecord, Wallet } from './types'
import * as sample from './sample'
import {
  parseAgents,
  parseApprovals,
  parseAuditEvents,
  parsePolicies,
  parseRefusal,
  parseSummary,
  parseTransaction,
  parseTransactionRecord,
  parseWallets,
  str,
  isContractMismatch,
  type WireApproval,
  type WireAuditEvent,
  type WirePolicy,
  type WireSummary,
  type WireTransaction,
  type WireTransactionRecord,
  type WireWallet,
} from './wire'

const STORAGE_KEY = 'ari.console.credential'
const ORG_KEY = 'ari.console.organization'

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface AgentView {
  readonly id: string
  readonly name: string
  readonly status: AgentStatus
  /** Live only: which credential the agent acts through. Sample only: its last activity. */
  readonly detail: string
}

export interface PendingApproval {
  readonly id: string
  readonly requestId: string
  readonly agentId: string
  readonly amountRaw: string | null
  readonly unit: string
  readonly digest: string
  readonly why: string
  readonly riskLevel: string
  readonly riskSignals: readonly string[]
  /** Whom the payment is going to, from the request this approval is waiting on. */
  readonly recipient: string | null
  readonly asset: string
  readonly policyName: string
  readonly policyVersionNumber: number
  /** When the *request* was proposed; the approval row itself carries no created_at. */
  readonly requestedAt: string
  readonly expiresAt: string
  readonly quorum: number
  readonly votes: number
  readonly requiredRole: string
  readonly status: ApprovalRequest['status']
  /** Resolved in the adapter: a column list at module scope cannot call a hook to look one up. */
  readonly agentLabel: string
}

/**
 * The transaction as this surface can honestly draw it.
 *
 * Not `TransactionRecord` itself. The fixture's assessment carries `baselineWindowDays` and
 * `modelVersion`, and the engine logs neither on the request row — the `risk.assessed` event
 * holds a level, a score and the signals that produced it. Reusing the fixture's type would
 * have forced the live adapter to fill two fields with something, and a number invented to
 * satisfy an interface is exactly the thing every other note in this repo refuses.
 *
 * `trace` stays because the live trail *is* the stages: the detail screen rebuilds it from the
 * events on the record, and the list has none to rebuild from, so an empty array there means
 * "open the row", not "nothing happened".
 */
export interface ConsoleTransaction extends Omit<TransactionRecord, 'risk' | 'outcome' | 'agentId'> {
  readonly agentId: string
  readonly agentLabel: string
  readonly risk: { readonly level: string; readonly score: string; readonly signals: readonly string[] } | null
  /** Null when nothing has evaluated this row. A refusal would say `DENY`; nothing did. */
  readonly outcome: TransactionRecord['outcome'] | null
}

/**
 * One agent's authority over one wallet, and the three numbers a policy actually bounds it with.
 *
 * The wallets page and the agents page were both rebuilding this from the fixture — grants from
 * agents, the governed version from an id, the limits out of a document. Flattening it into the
 * view once is what lets a live tenant answer the same question, and the reason the *limits* are
 * pulled out rather than the document: a screen that received the whole document would eventually
 * render a field the compiler refused, and a field list is a contract.
 */
export interface GrantRow {
  readonly agentId: string
  readonly agentLabel: string
  readonly walletId: string
  readonly walletName: string
  readonly policyVersionId: string
  readonly policyName: string
  readonly policyVersionNumber: number
  readonly grantedAt: string | null
  readonly revokedAt: string | null
  /** Decimal strings straight from the document, or null where the policy names no such cap. */
  readonly perTransactionRaw: string | null
  readonly perDayRaw: string | null
  readonly escalateAboveRaw: string | null
}

export interface ConsoleView {
  readonly source: 'sample' | 'live'
  /** What the banner above every screen says. The sample must never be able to look like a tenant. */
  readonly notice: string
  readonly organizationId: string
  readonly transactions: readonly ConsoleTransaction[]
  readonly approvals: readonly PendingApproval[]
  readonly agents: readonly AgentView[]
  readonly wallets: readonly Wallet[]
  readonly policies: readonly {
    readonly key: string
    readonly name: string
    readonly status: string
    readonly versions: number
    readonly activeVersionId: string | null
    /** Every version id this policy has published, newest first — how a detail row names its governor. */
    readonly versionIds: readonly string[]
  }[]
  readonly auditEvents: readonly AuditEvent[]
  readonly grantRows: readonly GrantRow[]
  /**
   * Routes this credential could not read, with the server's own reason beside each.
   *
   * A partial credential is the normal case, not the broken one: an approver is not supposed to
   * list wallets, and somebody holding two of the seven scopes should still see a live tenant
   * rather than sample rows. So a refused read is named, rather than failing the whole refresh
   * or being drawn as an empty table, which is a different claim about the tenant.
   */
  readonly unavailable: readonly { readonly route: string; readonly reason: string }[]
  /** The money unit the figures are denominated in, for a formatter that must not guess. */
  readonly unit: string
  readonly summary: {
    readonly authorizedRaw: bigint
    readonly count: number
    readonly denied: number
    readonly pending: number
    readonly agents: number
    readonly wallets: number
    readonly unit: string
  }
}

export const EMPTY_VIEW: ConsoleView = {
  source: 'sample',
  notice: sample.DEMO_BANNER,
  organizationId: sample.organization.id,
  transactions: [],
  approvals: [],
  agents: [],
  wallets: [],
  policies: [],
  auditEvents: [],
  grantRows: [],
  unavailable: [],
  unit: sample.UNIT,
  summary: { authorizedRaw: 0n, count: 0, denied: 0, pending: 0, agents: 0, wallets: 0, unit: sample.UNIT },
}

/** The fixture side. Every figure is computed from `sample.ts` in the expression that returns it. */
function fromSample(): ConsoleView {
  const totals = sample.todayTotals()
  const transactions: readonly ConsoleTransaction[] = sample.transactions.map((transaction) => ({
    ...transaction,
    risk:
      transaction.risk === null
        ? null
        : {
            level: transaction.risk.level,
            score: String(transaction.risk.score),
            signals: transaction.risk.signals,
          },
    agentLabel: sample.agents.find((agent) => agent.id === transaction.agentId)?.name ?? transaction.agentId,
  }))
  const agents = sample.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    status: agent.status,
    detail: `${agent.purpose} Last activity ${agent.lastActivity / 60}h ago.`,
  }))
  const approvals: readonly PendingApproval[] = sample.approvals.map((approval) => ({
    id: approval.id,
    requestId: approval.requestId,
    agentId: approval.agentId,
    amountRaw: approval.amountRaw,
    unit: approval.unit,
    digest: approval.digest,
    why: approval.why,
    riskLevel: approval.riskLevel,
    riskSignals: approval.riskSignals,
    recipient: approval.recipient,
    asset: approval.asset,
    policyName: approval.policyName,
    policyVersionNumber: approval.policyVersionNumber,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    quorum: approval.quorum,
    votes: approval.votes.length,
    requiredRole: approval.requiredRole,
    status: approval.status,
    agentLabel: sample.agents.find((agent) => agent.id === approval.agentId)?.name ?? approval.agentId,
  }))
  return {
    source: 'sample',
    notice: sample.DEMO_BANNER,
    organizationId: sample.organization.id,
    transactions,
    approvals,
    agents,
    wallets: sample.wallets,
    policies: sample.policies.map((policy) => {
      const active = policy.versions.find((version) => version.status === 'ACTIVE')
      return {
        key: policy.key,
        name: policy.name,
        status: active === undefined ? 'NO ACTIVE VERSION' : 'ACTIVE',
        versions: policy.versions.length,
        activeVersionId: active?.id ?? null,
        versionIds: policy.versions.map((version) => version.id),
      }
    }),
    auditEvents: sample.auditEvents,
    // The sample tenant is complete by construction: there is no credential to be missing a
    // scope with, so nothing here is refused.
    unavailable: [],
    grantRows: sample.agents.flatMap((agent) => {
      const policy = sample.policies.find((item) => item.key === agent.policy)
      const version = policy === undefined ? undefined : sample.activeVersion(agent.policy)
      const wallet = sample.walletById(sample.wallets[agent.wallet]?.id ?? '') ?? sample.wallets[agent.wallet]
      if (version === undefined || wallet === undefined) return []
      const caps = capsOf(version.document)
      return [
        {
          agentId: agent.id,
          agentLabel: agent.name,
          walletId: wallet.id,
          walletName: wallet.name,
          policyVersionId: version.id,
          policyName: policy?.name ?? agent.policy,
          policyVersionNumber: version.number,
          grantedAt: null,
          revokedAt: null,
          perTransactionRaw: caps.perTransactionRaw,
          perDayRaw: caps.perDayRaw,
          escalateAboveRaw: caps.escalateAboveRaw,
        } satisfies GrantRow,
      ]
    }),
    unit: sample.UNIT,
    summary: { ...totals, agents: sample.agents.filter((a) => a.status === 'ACTIVE').length, wallets: sample.wallets.length, unit: sample.UNIT },
  }
}

/**
 * The three caps a policy document states, read defensively because the document is a jsonb
 * column on the wire. A path that is missing answers null — which renders as "no such cap" —
 * rather than throwing, because a screen breaking over an optional field is a worse outcome
 * than a screen showing one fewer number.
 */
function capsOf(document: unknown): {
  readonly targetWalletId: string | null
  readonly perTransactionRaw: string | null
  readonly perDayRaw: string | null
  readonly escalateAboveRaw: string | null
} {
  const doc = document as {
    target?: { walletId?: string }
    permissions?: { transfers?: { perTransaction?: { maxRaw?: string }; perDay?: { maxRaw?: string } } }
    escalation?: { humanApproval?: { requiredWhen?: readonly { op?: string; raw?: string }[] } }
  } | null
  const gt = doc?.escalation?.humanApproval?.requiredWhen?.find((rule) => rule.op === 'amount_gt')
  return {
    targetWalletId: doc?.target?.walletId ?? null,
    perTransactionRaw: doc?.permissions?.transfers?.perTransaction?.maxRaw ?? null,
    perDayRaw: doc?.permissions?.transfers?.perDay?.maxRaw ?? null,
    escalateAboveRaw: gt?.raw ?? null,
  }
}

/** `usdc-6dp` → `USDC`, for a column that has to say something an operator recognises. */
const symbolOf = (unit: string | null): string =>
  unit === null ? 'unknown asset' : unit.replace(/-\d+dp$/, '').toUpperCase()

/**
 * The live side. Money is added as `bigint` and formatted once, at the edge of a render, so no
 * float ever sits between a counter and a figure on the screen.
 */
function fromLive(input: {
  readonly organizationId: string
  readonly transactions: readonly WireTransaction[]
  readonly approvals: readonly WireApproval[]
  readonly agents: readonly { id: string; name: string; status: string }[]
  readonly wallets: readonly WireWallet[]
  readonly policies: readonly WirePolicy[]
  readonly summary: WireSummary
  readonly auditEvents: readonly WireAuditEvent[]
  readonly unavailable?: readonly { readonly route: string; readonly reason: string }[]
}): ConsoleView {
  const unit = input.summary.windows[0]?.dimension.replace(/^(daily|monthly)_/, '') ?? sample.UNIT

  const transactions: readonly ConsoleTransaction[] = input.transactions.map((row) => {
    const matched = input.policies
      .map((item) => ({ item, version: item.versions.find((version) => version.id === row.decision?.policyVersionId) }))
      .find((found) => found.version !== undefined)
    return {
      id: row.id,
      requestId: row.id,
      agentId: row.agentId,
      walletId: row.walletId,
      kind: 'transfer',
      // Derived, and labelled as derived wherever it renders: a candidate carries no
      // human-written intent, so this describes the payment rather than claiming to know what
      // the agent meant.
      intent: `transfer ${row.amountRaw ?? '0'} ${symbolOf(row.currencyUnit)} to ${row.recipientAddress ?? 'an address the candidate did not name'}`,
      asset: symbolOf(row.currencyUnit),
      unit: row.currencyUnit ?? unit,
      amountRaw: row.amountRaw,
      recipient: row.recipientAddress,
      contract: null,
      chain: 'ethereum',
      digest: row.digest,
      policyVersionId: row.decision?.policyVersionId ?? '',
      policyName: matched?.item.name ?? 'no policy version this read can name',
      policyVersionNumber: matched?.version?.versionNumber ?? 0,
      state: row.lifecycleState,
      // The outcome comes from the newest evaluation in the trail, and a request with no
      // evaluation has no outcome — which is a real state (a row written before anything
      // decided it), not a default to hide behind. `DENY` would be a false sentence about a
      // payment nobody refused.
      outcome: row.decision?.outcome ?? null,
      codes: (row.decision?.reasonCodes ?? []) as TransactionRecord['codes'],
      risk: row.risk,
      submittedAt: row.createdAt,
      decidedAt: row.decision?.madeAt ?? row.updatedAt,
      // Rebuilt on the detail screen, from the row's own trail. An empty list here means
      // "open the row", and the screen says so rather than drawing six stages from nothing.
      trace: [],
      // Null on purpose: no read in this API exposes a ticket, its expiry or its redemption —
      // a ticket is the capability, and a screen that listed them would be a place to steal one
      // from. The trail says a ticket was minted, which is the fact worth showing.
      ticket: null,
      approval: null,
      idempotencyKey: '',
      agentLabel: input.agents.find((agent) => agent.id === row.agentId)?.name ?? row.agentId,
    }
  })

  // An approval row names an agent, a wallet, an amount and a digest — not a recipient, not a
  // policy name, not a risk level. Those live on the *request* this approval is waiting on, and
  // this read already has them, so they are joined here rather than drawn as blanks on a screen
  // whose entire job is telling a human what they are about to say yes to.
  const requestById = new Map(input.transactions.map((row) => [row.id, row]))
  const policyByVersionId = new Map(
    input.policies.flatMap((policy) => policy.versions.map((version) => [version.id, { policy, version }] as const)),
  )
  const approvals: readonly PendingApproval[] = input.approvals.map((approval) => {
    const request = requestById.get(approval.subjectId)
    const governed = policyByVersionId.get(approval.policyVersionId)
    return {
    id: approval.approvalId,
    requestId: approval.subjectKind === 'transaction' ? approval.subjectId : approval.approvalId,
    agentId: approval.agentId,
    amountRaw: approval.amountRaw,
    unit: approval.currencyUnit,
    digest: approval.digest,
    why:
      approval.subjectKind === 'transaction'
        ? 'A policy escalated this payment to a human before it could move.'
        : 'A policy activation is waiting on a human, and the widening it describes is not live yet.',
    riskLevel: request?.risk?.level ?? 'no assessment recorded',
    riskSignals: request?.risk?.signals ?? [],
    recipient: request?.recipientAddress ?? null,
    asset: symbolOf(approval.currencyUnit),
    policyName: governed?.policy.name ?? 'no policy version this read can name',
    policyVersionNumber: governed?.version.versionNumber ?? 0,
    requestedAt: request?.createdAt ?? approval.expiresAt,
    expiresAt: approval.expiresAt,
    quorum: approval.quorumNeeded,
    votes: approval.approved,
    requiredRole: 'a role this tenant grants',
    status: approval.status,
    agentLabel: input.agents.find((agent) => agent.id === approval.agentId)?.name ?? approval.agentId,
    }
  })

  const totals = input.summary.requestCountsByState
  const settledRaw = input.summary.windows.reduce((sum, row) => sum + BigInt(row.settled), 0n)
  const heldRaw = input.summary.windows.reduce((sum, row) => sum + BigInt(row.currentReserved), 0n)
  const countOf = (state: LifecycleState): number =>
    input.summary.requestCountsByState.find((row) => row.state === state)?.count ?? 0

  return {
    source: 'live',
    notice: `Live tenant ${input.organizationId.slice(0, 18)}… · reads and writes go to this deployment`,
    unavailable: input.unavailable ?? [],
    organizationId: input.organizationId,
    transactions,
    approvals,
    agents: input.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status as AgentStatus,
      detail: `credential minting and revocation act on this principal`,
    })),
    wallets: input.wallets.map((wallet) => ({
      id: wallet.id,
      name: wallet.displayName,
      chain: 'ethereum',
      provider: wallet.provider,
      mode: wallet.mode,
      address: wallet.address,
      agents: wallet.grants.filter((grant) => grant.revokedAt === null).map((grant) => grant.agentId),
      policies: wallet.grants.map((grant) => grant.policyVersionId),
      balances: [],
      // `LIVE`, not `ACTIVE`: that is the word the fixture's own type uses for a wallet nobody
      // has rotated, and a live row that wrote `ACTIVE` here would be a second vocabulary for
      // the same state. `superseded_at` is the only such column the API exposes.
      status: wallet.supersededAt === null ? 'LIVE' : 'SUPERSEDED',
    } satisfies Wallet)),
    policies: input.policies.map((policy) => {
      const active = policy.versions.find((version) => version.status === 'ACTIVE')
      return {
        key: policy.name,
        name: policy.name,
        status: active === undefined ? 'NO ACTIVE VERSION' : 'ACTIVE',
        versions: policy.versions.length,
        activeVersionId: active?.id ?? null,
        versionIds: policy.versions.map((version) => version.id),
      }
    }),
    unit,
    grantRows: input.wallets.flatMap((wallet) =>
      wallet.grants.map((grant) => {
        const governed = input.policies
          .map((policy) => ({ policy, version: policy.versions.find((v) => v.id === grant.policyVersionId) }))
          .find((found) => found.version !== undefined)
        const caps = capsOf(governed?.version?.document)
        return {
          agentId: grant.agentId,
          agentLabel: input.agents.find((agent) => agent.id === grant.agentId)?.name ?? grant.agentId,
          walletId: wallet.id,
          walletName: wallet.displayName,
          policyVersionId: grant.policyVersionId,
          policyName: governed?.policy.name ?? 'a policy this read cannot name',
          policyVersionNumber: governed?.version?.versionNumber ?? 0,
          grantedAt: grant.grantedAt,
          revokedAt: grant.revokedAt,
          perTransactionRaw: caps.perTransactionRaw,
          perDayRaw: caps.perDayRaw,
          escalateAboveRaw: caps.escalateAboveRaw,
        } satisfies GrantRow
      }),
    ),
    auditEvents: input.auditEvents.map((event) => ({
      seq: event.seq,
      id: event.id,
      at: event.madeAt,
      type: event.eventType,
      actor: event.actor,
      actorType: event.actorType as AuditEvent['actorType'],
      resource: event.resource,
      resourceId: event.resourceId,
      request: event.request,
      policyVersion: event.policyVersion,
      decision: event.decision,
      reasons: event.reasons,
      severity: event.severity as AuditEvent['severity'],
      prev: event.prev,
      hash: event.storedHash,
      meta: Object.fromEntries(Object.entries(event.meta).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])),
    })),
    summary: {
      // "Authorised" here is settled plus still-held, which is what a window's cap counts. A
      // band that showed only settled money would read as headroom the tenant does not have.
      authorizedRaw: settledRaw + heldRaw,
      count: totals.reduce((sum, row) => sum + row.count, 0),
      denied: countOf('DENIED'),
      pending: input.summary.pendingApprovals,
      agents: input.summary.agentsByStatus.find((row) => row.status === 'ACTIVE')?.count ?? 0,
      wallets: input.summary.liveWallets,
      unit,
    },
  }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export class Refused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  token: string | null,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  const response = await fetch(`/api/ari${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { 'content-type': 'application/json', body: JSON.stringify(body) }),
    cache: 'no-store',
  })
  const text = await response.text()
  if (text.length === 0) throw new Refused(response.status, response.status === 404 ? 'NOT_FOUND' : 'EMPTY', `${method} ${path} answered ${response.status}`)
  const parsed: unknown = JSON.parse(text)
  if (!response.ok) {
    const refusal = parseRefusal(parsed)
    throw new Refused(response.status, refusal.code, refusal.detail.length > 0 ? refusal.detail : refusal.code)
  }
  return parsed as T
}

export interface ActionResult {
  readonly ok: boolean
  readonly message: string
  /** A minted bearer secret appears exactly once, here, and is never stored or re-read. */
  readonly bearer?: string
}

export interface ConsoleApi {
  readonly view: ConsoleView
  readonly loading: boolean
  readonly error: string | null
  readonly connected: boolean
  readonly token: string | null
  connect(token: string): Promise<void>
  forget(): void
  refresh(): Promise<void>
  decide(approvalId: string, decision: 'APPROVED' | 'REJECTED'): Promise<ActionResult>
  createAgent(name: string): Promise<ActionResult>
  revokeAgent(agentId: string): Promise<ActionResult>
  issueAgentCredential(agentId: string, scopes: readonly string[], ttlMs: string): Promise<ActionResult>
  registerWallet(input: { displayName: string; mode: 'delegated' | 'user_gated'; signatureTriple: string; provider: string; address: string | null }): Promise<ActionResult>
  grantWallet(agentId: string, walletId: string, policyVersionId: string): Promise<ActionResult>
  applyPolicy(name: string, document: unknown, activate: boolean, justification: string | null): Promise<ActionResult>
  record(id: string): Promise<WireTransactionRecord | string>
}

const READS = {
  transactions: '/v1/transactions?limit=200',
  summary: '/v1/summary',
  approvals: '/v1/approvals',
  agents: '/v1/agents',
  wallets: '/v1/wallets',
  policies: '/v1/policies?limit=200',
  audit: '/v1/audit/events?limit=500',
} as const

const Context = createContext<ConsoleApi | null>(null)

/**
 * The provider. Unconnected, it hands screens the sample tenant and the banner that says so.
 * Connected, it reads every route once and rebuilds; a read that is refused for scope is
 * reported as what it is rather than silently rendering an empty table, because an empty table
 * and a tenant with nothing in it are two different things to an operator.
 */
export function ConsoleProvider({ children }: { readonly children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null)
  const [view, setView] = useState<ConsoleView>(fromSample)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const stored = window.sessionStorage.getItem(STORAGE_KEY)
    if (stored !== null && stored.length > 0) setToken(stored)
  }, [])

  const load = useCallback(async (presented: string | null): Promise<void> => {
    if (presented === null) {
      setView(fromSample())
      setError(null)
      return
    }
    setLoading(true)
    try {
      // `allSettled`, because one refused route is a scope this credential does not hold and not
      // a reason to show somebody their tenant as sample data. The failure this replaces was
      // total: an operator without `agent:manage` got no live view at all, and no explanation
      // wider than an error line.
      const answers = await Promise.allSettled([
        call<{ organizationId: unknown; transactions: unknown }>('GET', READS.transactions, presented),
        call<{ organizationId: unknown; summary: unknown }>('GET', READS.summary, presented),
        call<{ approvals: unknown }>('GET', READS.approvals, presented),
        call<{ agents: unknown }>('GET', READS.agents, presented),
        call<{ organizationId: unknown; wallets: unknown }>('GET', READS.wallets, presented),
        call<{ organizationId: unknown; policies: unknown }>('GET', READS.policies, presented),
        call<{ organizationId: unknown; events: unknown }>('GET', READS.audit, presented),
      ])
      const names = ['transactions', 'summary', 'approvals', 'agents', 'wallets', 'policies', 'audit'] as const
      const unavailable: { route: string; reason: string }[] = []
      const value = <T,>(index: number): T | null => {
        const answer = answers[index]
        if (answer === undefined) return null
        if (answer.status === 'fulfilled') return answer.value as T
        const reason = answer.reason
        unavailable.push({
          route: names[index] ?? `read ${index}`,
          reason: reason instanceof Error ? reason.message : 'the read did not complete',
        })
        return null
      }

      const transactions = value<{ organizationId: unknown; transactions: unknown }>(0)
      const summary = value<{ organizationId: unknown; summary: unknown }>(1)
      const approvals = value<{ approvals: unknown }>(2)
      const agents = value<{ agents: unknown }>(3)
      const wallets = value<{ organizationId: unknown; wallets: unknown }>(4)
      const policies = value<{ organizationId: unknown; policies: unknown }>(5)
      const audit = value<{ organizationId: unknown; events: unknown }>(6)

      if (summary === null) {
        // `summary` is the read that names the tenant and the money windows, so without it there
        // is nothing honest to draw a header from. Stay on the sample view and say why.
        throw new Refused(403, 'NOT_READABLE', `this credential cannot read /v1/summary (${unavailable[0]?.reason ?? 'refused'}), so nothing was switched over`)
      }

      // Every envelope that came back and names a tenant has to name the same one. A refused
      // read is not a disagreement, so the check runs over what answered rather than pretending
      // the missing ones agreed.
      const envelopes = [summary, transactions, wallets, policies, audit].filter(
        (envelope) => envelope !== null,
      ) as readonly { readonly organizationId: unknown }[]
      const organizations = envelopes.map((envelope) => str(envelope.organizationId, 'envelope.organizationId'))
      const organizationId = organizations[0] ?? ''
      if (organizations.some((value2) => value2 !== organizationId)) {
        throw new Refused(500, 'ORGANIZATION_DISAGREEMENT', 'two reads in one refresh named different tenants')
      }
      setView(
        fromLive({
          organizationId,
          unavailable,
          transactions: transactions === null ? [] : parseTransactions(transactions.transactions),
          approvals: approvals === null ? [] : parseApprovals(approvals.approvals),
          agents: agents === null ? [] : parseAgents(agents.agents),
          wallets: wallets === null ? [] : parseWallets(wallets.wallets),
          policies: policies === null ? [] : parsePolicies(policies.policies),
          summary: parseSummary(summary.summary),
          auditEvents: audit === null ? [] : parseAuditEvents(audit.events),
        }),
      )
      setError(null)
    } catch (cause) {
      const message = isContractMismatch(cause)
        ? `the deployment answered something this console's contract does not describe: ${(cause as Error).message}`
        : cause instanceof Error
          ? cause.message
          : 'the request did not complete'
      setError(message)
      // The view stays what it was: a screen that flips to the sample the moment one read
      // fails would show fake rows under a banner that says live.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(token)
  }, [token, load])

  const write = useCallback(
    async (path: string, body: unknown): Promise<ActionResult> => {
      if (token === null) return { ok: false, message: 'No deployment is connected, so nothing was sent.' }
      try {
        const answer = await call<Record<string, unknown>>('POST', path, token, body)
        await load(token)
        const bearerValue = typeof answer.bearer === 'string' ? answer.bearer : undefined
        return {
          ok: true,
          message: bearerValue === undefined ? 'accepted' : 'The credential exists once, here, and cannot be read back afterwards.',
          ...(bearerValue === undefined ? {} : { bearer: bearerValue }),
        }
      } catch (cause) {
        return { ok: false, message: cause instanceof Error ? cause.message : 'refused' }
      }
    },
    [token, load],
  )

  const api = useMemo<ConsoleApi>(
    () => ({
      view,
      loading,
      error,
      connected: token !== null,
      token,
      connect: async (presented: string) => {
        window.sessionStorage.setItem(STORAGE_KEY, presented)
        setToken(presented)
      },
      forget: () => {
        window.sessionStorage.removeItem(STORAGE_KEY)
        window.sessionStorage.removeItem(ORG_KEY)
        setToken(null)
      },
      refresh: () => load(token),
      decide: (approvalId, decision) => write(`/v1/approvals/${encodeURIComponent(approvalId)}/decisions`, { decision }),
      createAgent: (name) => write('/v1/agents', { name }),
      revokeAgent: (agentId) => write(`/v1/agents/${encodeURIComponent(agentId)}/revoke`, {}),
      issueAgentCredential: (agentId, scopes, ttlMs) => write(`/v1/agents/${encodeURIComponent(agentId)}/credentials`, { scopes, ttlMs }),
      registerWallet: (input) => write('/v1/wallets', input.address === null ? { ...input } : input),
      grantWallet: (agentId, walletId, policyVersionId) =>
        write(`/v1/agents/${encodeURIComponent(agentId)}/wallets/${encodeURIComponent(walletId)}`, { policyVersionId }),
      applyPolicy: (name, document, activate, justification) =>
        write('/v1/policies', {
          name,
          document,
          activate,
          ...(typeof justification === 'string' && justification.length > 0 ? { justification } : {}),
        }),
      record: async (id) => {
        if (token === null) return 'No deployment is connected.'
        try {
          const answer = await call<{ transaction: unknown }>('GET', `/v1/transactions/${encodeURIComponent(id)}/record`, token)
          return parseTransactionRecord(answer.transaction)
        } catch (cause) {
          return cause instanceof Error ? cause.message : 'the request did not complete'
        }
      },
    }),
    [view, loading, error, token, load, write],
  )

  return <Context.Provider value={api}>{children}</Context.Provider>
}

function parseTransactions(value: unknown): readonly WireTransaction[] {
  return (Array.isArray(value) ? value : []).map((row) => parseTransaction(row))
}

export function useConsole(): ConsoleApi {
  const api = useContext(Context)
  if (api === null) throw new Error('useConsole called outside ConsoleProvider')
  return api
}
