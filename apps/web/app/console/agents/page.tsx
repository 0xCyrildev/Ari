'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { MetricBand, Panel, Reveal, State, Tag, DataTable, type Column } from '@/components/console/ui'
import * as sampleData from '@/lib/ari/sample'
import { useConsole, type AgentRow } from '@/lib/ari/console'
import { UnwiredScreen } from '@/components/console/ui'
import { deriveAgentState, type RiskLevel } from '@/lib/ari/types'
import { money, relativeTime } from '@/lib/ari/format'

const ORDER: readonly RiskLevel[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

type Row = AgentRow

export default function Agents() {
  const { view } = useConsole()

  const router = useRouter()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('ALL')
  const all = view.agentRows
  const shown = all.filter(
    (row) =>
      (filter === 'ALL' || row.state === filter || row.status === filter) &&
      (query.trim().length === 0 || `${row.name} ${row.detail} ${row.policyName}`.toLowerCase().includes(query.trim().toLowerCase())),
  )

  const columns: readonly Column<Row>[] = [
    {
      key: 'agent',
      header: 'AGENT',
      cell: (row) => (
        <>
          {row.name}
          <span className="sub">{row.detail}</span>
        </>
      ),
    },
    { key: 'state', header: 'STATE', cell: (row) => <State value={row.state} /> },
    {
      key: 'policy',
      header: 'POLICY',
      hideBelow: 'md',
      cell: (row) => <span className="num">{`${row.policyName} v${row.policyVersionNumber}`}</span>,
    },
    { key: 'wallet', header: 'WALLET', hideBelow: 'md', cell: (row) => <span className="num">{row.walletName}</span> },
    {
      key: 'usage',
      header: 'TODAY / CEILING',
      align: 'right',
      hideBelow: 'sm',
      cell: (row) => (
        <span className="num">
          {money(row.usedRaw.toString(), view.unit, true)}
          <span className="muted">
            {' / '}
            {row.limitRaw === null ? 'no daily ceiling in the governed document' : money(row.limitRaw.toString(), view.unit, true)}
          </span>
        </span>
      ),
    },
    {
      key: 'risk',
      header: 'RISK',
      hideBelow: 'md',
      cell: (row) => (row.risk === null ? <span className="muted">not assessed</span> : <Tag>{row.risk}</Tag>),
    },
    { key: 'last', header: 'LAST ACTIVITY', align: 'right', hideBelow: 'sm', cell: (row) => <time dateTime={row.lastAt ?? undefined}>{(row.lastAt === null ? 'never' : relativeTime(row.lastAt)).toUpperCase()}</time> },
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
            { label: 'ACTIVE', value: all.filter((row) => row.status === 'ACTIVE').length, note: 'stored status at the engine' },
            { label: 'PAUSED', value: all.filter((row) => row.status === 'PAUSED').length, tone: 'wait', note: 'refuses new requests, outstanding tickets still redeem' },
            { label: 'REVOKED', value: all.filter((row) => row.status === 'REVOKED').length, tone: 'none', note: 'terminal, credentials stop parsing' },
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
          rowKey={(row) => row.id}
          onRow={(row) => router.push(`/console/agents/${row.name}`)}
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
