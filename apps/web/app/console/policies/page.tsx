'use client'

import { useRouter } from 'next/navigation'
import { MetricBand, Panel, Reveal, State, Tag, type Column, DataTable } from '@/components/console/ui'
import * as sampleData from '@/lib/ari/sample'
import { useConsole } from '@/lib/ari/console'
import { UnwiredScreen } from '@/components/console/ui'
import { money } from '@/lib/ari/format'

/**
 * Policy list. A policy is a compiled document bound to one wallet and one authority mode, so the
 * row shows what it governs and how wide it is, not a description of it.
 */
export default function Policies() {
  const { view } = useConsole()
  if (view.source === 'live') return <UnwiredScreen screen={'policies'} need={'GET /v1/policies is live and proxyable; this table is being pointed at it'} />

  const router = useRouter()
  const rows = sampleData.policies.map((policy) => {
    const active = sampleData.activeVersion(policy.key)
    const granted = sampleData.agents.filter((agent) => agent.policy === policy.key)
    const draft = policy.versions.find((version) => version.status === 'DRAFT')
    return {
      policy,
      active,
      draft,
      granted: granted.map((agent) => agent.name),
      wallet: sampleData.walletById(active.document.target.walletId)?.name ?? 'no wallet',
      columns: [
        { k: 'PER TX', v: money(active.document.permissions.transfers.perTransaction.maxRaw, active.document.permissions.transfers.perDay.unit, true) },
        { k: 'PER DAY', v: money(active.document.permissions.transfers.perDay.maxRaw, active.document.permissions.transfers.perDay.unit, true) },
        { k: 'ESCALATES', v: `${active.document.escalation.humanApproval.requiredWhen.length} CONDITIONS` },
        { k: 'AGENTS', v: String(granted.length) },
      ],
    }
  })

  const columns: readonly Column<(typeof rows)[number]>[] = [
    {
      key: 'policy',
      header: 'POLICY',
      cell: (row) => (
        <>
          {row.policy.name} <Tag>v{row.active.number}</Tag>
          {row.draft !== undefined && <Tag stop>DRAFT v{row.draft.number} PENDING</Tag>}
          <span className="sub">{row.active.summary}</span>
        </>
      ),
    },
    {
      key: 'target',
      header: 'TARGET',
      hideBelow: 'md',
      cell: (row) => (
        <>
          {row.wallet}
          <span className="sub">{row.active.document.target.authorityMode.toUpperCase()}</span>
        </>
      ),
    },
    {
      key: 'width',
      header: 'WIDTH',
      hideBelow: 'sm',
      cell: (row) => (
        <span className="num">
          {row.columns.map((column) => `${column.k} ${column.v}`).join('  ·  ')}
        </span>
      ),
    },
    { key: 'status', header: 'STATUS', align: 'right', cell: (row) => <State value={row.active.status} /> },
  ]

  return (
    <div className="console-body">
      <Reveal>
        <h1>
          DOCUMENTS,
          <br />
          NOT SETTINGS.
        </h1>
        <p className="lede">
          A policy is frozen the moment it is published and a version can never be walked back into
          a draft. What governs a request is the version the grant names, not whatever is current
          when someone looks.
        </p>
      </Reveal>

      <div style={{ margin: '38px 0 46px' }}>
        <MetricBand
          items={[
            { label: 'POLICY DOCUMENTS', value: rows.length },
            { label: 'ACTIVE VERSIONS', value: rows.filter((row) => row.active.status === 'ACTIVE').length, tone: 'ok', note: 'one per document, by construction' },
            { label: 'DRAFTS AWAITING REVIEW', value: rows.filter((row) => row.draft !== undefined).length, tone: 'wait' },
            { label: 'AGENTS GRANTED UNDER A POLICY', value: rows.reduce((total, row) => total + row.granted.length, 0), note: 'a document that governs nothing is a document, not a control' },
          ]}
        />
      </div>

      <Panel title="POLICY DOCUMENTS" note="CLICK A ROW FOR THE DOCUMENT">
        <DataTable rows={rows} columns={columns} rowKey={(row) => row.policy.key} onRow={(row) => router.push(`/console/policies/${row.policy.key}`)} />
      </Panel>
    </div>
  )
}
