'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ButtonLink, DataTable, MetricBand, Panel, Reveal, State, Tag, type Column } from '@/components/console/ui'
import * as sampleData from '@/lib/ari/sample'
import { clockTime, money, relativeTime, shortAddress } from '@/lib/ari/format'
import type { TransactionRecord } from '@/lib/ari/types'

/**
 * Overview. Every figure is computed from the same rows the tables below render, in this file, so
 * a number on the band and the list it describes cannot disagree. A hand-typed count is how a
 * console becomes untrustworthy.
 */
export default function Overview() {
  const router = useRouter()
  const totals = sampleData.todayTotals()
  const pending = sampleData.approvals.filter((approval) => approval.status === 'PENDING')
  const recent = [...sampleData.transactions].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).slice(0, 8)
  const riskToday = sampleData.riskEvents().filter((event) => Date.now() - Date.parse(event.tx.submittedAt) < 24 * 60 * 60 * 1000)
  const unsettled = sampleData.transactions.filter((tx) => tx.state === 'SIGNING_COMPLETE' || tx.state === 'TICKET_MINTED')

  const columns: readonly Column<TransactionRecord>[] = [
    {
      key: 'request',
      header: 'REQUEST',
      cell: (tx) => (
        <>
          {tx.intent}
          <span className="sub">
            {tx.agentId.replace(/^agt_/, '')} · {tx.policyName} v{tx.policyVersionNumber}
            {tx.recipient !== null && <> · {shortAddress(tx.recipient)}</>}
          </span>
        </>
      ),
    },
    { key: 'amount', header: 'AMOUNT', align: 'right', hideBelow: 'md', cell: (tx) => <span className="num">{money(tx.amountRaw, tx.unit, true)}</span> },
    { key: 'decision', header: 'DECISION', cell: (tx) => <State value={tx.outcome} /> },
    { key: 'state', header: 'LIFECYCLE', hideBelow: 'sm', cell: (tx) => <State value={tx.state} /> },
    { key: 'when', header: 'WHEN', align: 'right', cell: (tx) => <time dateTime={tx.submittedAt}>{clockTime(tx.submittedAt)}</time> },
  ]

  return (
    <div className="console-body">
      <Reveal>
        <h1>
          WHAT THE AGENTS
          <br />
          ARE DOING.
        </h1>
        <p className="lede">
          Every number here is a decision Ari made and can show its reasoning for. Refusals are
          counted as carefully as payments.
        </p>
      </Reveal>

      <div style={{ margin: '38px 0 46px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <ButtonLink href="/console/audit" small>
          VERIFY THE TRAIL
        </ButtonLink>
        <ButtonLink href="/console/approvals" variant="light" small>
          {pending.length} AWAITING A HUMAN
        </ButtonLink>
      </div>

      <MetricBand
        items={[
          { label: 'ACTIVE AGENTS', value: sampleData.agents.filter((agent) => agent.status === 'ACTIVE').length, note: `${sampleData.agents.length} principals in this tenant` },
          { label: 'REQUESTS TODAY', value: totals.count, note: 'answered by the engine, last 24h' },
          { label: 'AUTHORISED', value: money(totals.authorizedRaw.toString(), sampleData.UNIT, true), note: 'settled holds · sample figures' },
          { label: 'WAITING ON A HUMAN', value: pending.length, tone: 'wait', note: 'approval requests open now' },
          { label: 'REFUSED', value: totals.denied, tone: 'stop', note: 'denied by policy, last 24h' },
        ]}
      />

      <Panel title="WAITING ON A PERSON" note={`${pending.length} IN THE QUEUE`}>
        <div className="stack-list">
          {pending.map((approval) => {
            const agent = sampleData.agents.find((item) => item.id === approval.agentId)
            const needed = approval.quorum - approval.votes.filter((vote) => vote.decision === 'APPROVED').length
            return (
              <div key={approval.id}>
                <time dateTime={approval.requestedAt}>{relativeTime(approval.requestedAt).toUpperCase()}</time>
                <div style={{ minWidth: 0 }}>
                  <span className="num" style={{ fontSize: 15 }}>
                    {money(approval.amountRaw, approval.unit)}
                  </span>{' '}
                  <span className="muted">{approval.asset.toUpperCase()}</span>
                  <span className="sub">
                    {agent?.name ?? approval.agentId} · {needed} {needed === 1 ? 'vote' : 'votes'} to go · risk {approval.riskLevel.toLowerCase()}
                  </span>
                </div>
                <Link href="/console/approvals" className="tag">
                  REVIEW ↗
                </Link>
              </div>
            )
          })}
        </div>
      </Panel>

      <div className="split">
        <Panel title="RECENT DECISIONS" note="LAST 8 REQUESTS">
          <DataTable rows={recent} columns={columns} rowKey={(tx) => tx.id} onRow={(tx) => router.push(`/console/transactions/${tx.id}`)} />
        </Panel>

        <div>
          <Panel title="THE PATH EVERY REQUEST TAKES" pad>
            <p style={{ margin: 0, fontSize: 10, letterSpacing: '.15em', color: 'var(--muted)', lineHeight: 2.4 }}>
              INTENT <span style={{ color: 'var(--accent)' }}>→</span> POLICY <span style={{ color: 'var(--accent)' }}>→</span> RISK{' '}
              <span style={{ color: 'var(--accent)' }}>→</span> APPROVAL <span style={{ color: 'var(--accent)' }}>→</span> SIGN{' '}
              <span style={{ color: 'var(--accent)' }}>→</span> EXECUTE
            </p>
            <p style={{ margin: '18px 0 0', fontSize: 13, lineHeight: 1.5, color: 'var(--muted)' }}>
              Policy is a compiled document bound to one wallet version; it can refuse and escalate,
              and nothing else. Risk is advisory and structurally cannot grant.
            </p>
          </Panel>

          <Panel title="RISK, LAST 24 HOURS" note={`${riskToday.length} ASSESSED`}>
            <div className="stack-list">
              {riskToday.slice(0, 4).map((event) => (
                <div key={event.tx.id} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                  <div style={{ minWidth: 0 }}>
                    {event.tx.intent}
                    <span className="sub">{event.signals.join(' · ') || 'no signal crossed its weight'}</span>
                  </div>
                  <Tag>{event.level}</Tag>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="EXECUTION IS NOT THE SAME AS CONFIRMED" pad>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--muted)' }}>
              {unsettled.length} request{unsettled.length === 1 ? '' : 's'} show a signature returned
              and no chain confirmation. That is the honest state, not a stale one: settlement
              belongs to a provider callback or a reconciliation pass, and a mock&apos;s{' '}
              <code style={{ fontFamily: 'monospace' }}>COMPLETE</code> is not a chain fact.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  )
}
