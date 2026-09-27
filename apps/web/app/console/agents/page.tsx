'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MetricBand, Panel, Reveal, State, Tag, DataTable, type Column } from '@/components/console/ui'
import * as sampleData from '@/lib/ari/sample'
import { useConsole } from '@/lib/ari/console'
import { UnwiredScreen } from '@/components/console/ui'
import { deriveAgentState, type RiskLevel } from '@/lib/ari/types'
import { money, relativeTime } from '@/lib/ari/format'

const ORDER: readonly RiskLevel[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

function rows() {
  return sampleData.agents.map((agent) => {
    const usage = sampleData.usageFor(agent.name)
    const txs = sampleData.transactions.filter((tx) => tx.agentId === agent.id)
    const pending = txs.filter((tx) => tx.outcome === 'REQUIRE_HUMAN_APPROVAL').length
    const highest = txs.reduce<RiskLevel | null>((acc, tx) => {
      const level = tx.risk?.level ?? null
      if (level === null) return acc
      return acc === null || ORDER.indexOf(level) > ORDER.indexOf(acc) ? level : acc
    }, null)
    const policy = sampleData.policies.find((item) => item.key === agent.policy)
    const active = policy === undefined ? undefined : sampleData.activeVersion(policy.key)
    return {
      agent,
      // Stored status and this surface's reading of the rows are two different facts, and the
      // screen says which one it is showing. Counting derived states as if they were stored
      // would make "paused" read zero while the engine has the agent paused.
      state: deriveAgentState(agent.status, pending, highest),
      pending,
      highest,
      policyName: policy?.name ?? agent.policy,
      policyNumber: active?.number ?? 0,
      walletName: sampleData.walletById(sampleData.wallets[agent.wallet]?.id ?? '')?.name ?? 'no wallet',
      usageRaw: usage.settledRaw,
      limitRaw: active === undefined ? 0n : BigInt(active.document.permissions.transfers.perDay.maxRaw),
      lastAt: usage.lastAt ?? new Date(Date.now() - agent.lastActivity).toISOString(),
    }
  })
}

type Row = ReturnType<typeof rows>[number]

export default function Agents() {
  const { view } = useConsole()
  if (view.source === 'live') return <UnwiredScreen screen={'agent management'} need={'the agent table, its limits and credential minting need live reads; POST /v1/agents, /revoke and /credentials are proxyable already'} />

  const router = useRouter()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('ALL')
  const all = useMemo(rows, [])
  const shown = all.filter(
    (row) =>
      (filter === 'ALL' || row.state === filter || row.agent.status === filter) &&
      (query.trim().length === 0 || `${row.agent.name} ${row.agent.purpose}`.toLowerCase().includes(query.trim().toLowerCase())),
  )

  const columns: readonly Column<Row>[] = [
    {
      key: 'agent',
      header: 'AGENT',
      cell: (row) => (
        <>
          {row.agent.name}
          <span className="sub">{row.agent.purpose}</span>
        </>
      ),
    },
    { key: 'state', header: 'STATE', cell: (row) => <State value={row.state} /> },
    {
      key: 'policy',
      header: 'POLICY',
      hideBelow: 'md',
      cell: (row) => <span className="num">{`${row.policyName} v${row.policyNumber}`}</span>,
    },
    { key: 'wallet', header: 'WALLET', hideBelow: 'md', cell: (row) => <span className="num">{row.walletName}</span> },
    {
      key: 'usage',
      header: 'TODAY / CEILING',
      align: 'right',
      hideBelow: 'sm',
      cell: (row) => (
        <span className="num">
          {money(row.usageRaw.toString(), sampleData.UNIT, true)}
          <span className="muted"> / {money(row.limitRaw.toString(), sampleData.UNIT, true)}</span>
        </span>
      ),
    },
    {
      key: 'risk',
      header: 'RISK',
      hideBelow: 'md',
      cell: (row) => (row.highest === null ? <span className="muted">not assessed</span> : <Tag>{row.highest}</Tag>),
    },
    { key: 'last', header: 'LAST ACTIVITY', align: 'right', hideBelow: 'sm', cell: (row) => <time dateTime={row.lastAt}>{relativeTime(row.lastAt).toUpperCase()}</time> },
  ]

  return (
    <div className="console-body">
      <Reveal>
        <h1>
          PRINCIPALS,
          <br />
          NOT SESSIONS.
        </h1>
        <p className="lede">
          An agent can propose a payment and it cannot approve one. Those are different rows,
          different credential prefixes, and a CHECK in the schema that refuses the overlap.
        </p>
      </Reveal>

      <div style={{ margin: '38px 0 46px' }}>
        <MetricBand
          items={[
            { label: 'ACTIVE', value: all.filter((row) => row.agent.status === 'ACTIVE').length, note: 'stored status at the engine' },
            { label: 'PAUSED', value: all.filter((row) => row.agent.status === 'PAUSED').length, tone: 'wait', note: 'refuses new requests, outstanding tickets still redeem' },
            { label: 'REVOKED', value: all.filter((row) => row.agent.status === 'REVOKED').length, tone: 'none', note: 'terminal, credentials stop parsing' },
            { label: 'WAITING ON A HUMAN', value: all.filter((row) => row.pending > 0).length, tone: 'wait', note: 'this surface reading of live rows' },
          ]}
        />
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 18 }}>
        <input
          className="field"
          aria-label="Filter agents"
          placeholder="FILTER AGENTS"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select className="field" aria-label="Filter by state" value={filter} onChange={(event) => setFilter(event.target.value)}>
          {['ALL', 'ACTIVE', 'PAUSED', 'REVOKED', 'AWAITING_APPROVAL', 'ANOMALOUS'].map((option) => (
            <option key={option} value={option}>
              {option === 'ALL' ? 'ANY STATE' : option}
            </option>
          ))}
        </select>
        <span className="muted num" style={{ fontSize: 10, letterSpacing: '.15em' }}>
          {shown.length} OF {all.length}
        </span>
      </div>

      <Panel title="EVERY AGENT IN THIS TENANT" note="CLICK A ROW FOR ITS CONTROL PAGE">
        <DataTable
          rows={shown}
          columns={columns}
          rowKey={(row) => row.agent.id}
          onRow={(row) => router.push(`/console/agents/${row.agent.name}`)}
          empty={
            <div className="empty">
              <b>No agents match this filter</b>
              {all.length} agents exist in this tenant. Widen the filter.
            </div>
          }
        />
      </Panel>
    </div>
  )
}
