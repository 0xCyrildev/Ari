'use client'

import { use, useState } from 'react'
import { ActionButton, ButtonLink, Empty, KeyValue, Panel, PageHead, Reveal, State, Tag, UnwiredScreen } from '@/components/console/ui'
import { useConsole } from '@/lib/ari/console'
import { money, relativeTime } from '@/lib/ari/format'

const SCOPES = ['transaction:request', 'transaction:read', 'policy:read', 'policy:activate', 'approval:decide', 'agent:manage', 'wallet:manage', 'audit:read'] as const

export default function AgentDetail({ params }: { params: Promise<{ name: string }> }) {
  const { view, revokeAgent, issueAgentCredential } = useConsole()
  const { name } = use(params)
  const [message, setMessage] = useState<string | null>(null)
  const [bearer, setBearer] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const row = view.agentRows.find((agent) => agent.name === decodeURIComponent(name) || agent.id === decodeURIComponent(name))
  if (row === undefined) return <div className="console-body"><UnwiredScreen screen="AGENT" need="No agent with this id is present in the current console view." /></div>
  const requests = view.transactions.filter((transaction) => transaction.agentId === row.id)
  const issue = async (ttl: string) => { setBusy(true); const answer = await issueAgentCredential(row.id, SCOPES, ttl); setMessage(answer.message); setBearer(answer.bearer ?? null); setBusy(false) }
  return <div className="console-body">
    <Reveal><PageHead title={row.name.toUpperCase()} lede="An agent row is the authority Ari records, not a credential inventory. The contract exposes the current grant and usage, but no read for existing credentials." actions={<ButtonLink href="/console/agents" variant="light" small>ALL AGENTS</ButtonLink>} /></Reveal>
    {bearer && <p className="notice"><span style={{ width: 7, height: 7, background: 'var(--accent)', display: 'inline-block' }} aria-hidden="true" /> Credential returned once: <code className="num">{bearer}</code>. Copy it now. It cannot be read back.</p>}
    {message && <p className="notice" role="status">{message}</p>}
    <Panel title="AUTHORITY" note={row.id} pad><KeyValue items={[{ k: 'STATE', v: <State value={row.state} /> }, { k: 'POLICY', v: `${row.policyName} v${row.policyVersionNumber}` }, { k: 'WALLET', v: row.walletName }, { k: 'LAST REQUEST', v: relativeTime(row.lastAt) }, { k: 'REQUESTS', v: row.requests }, { k: 'PENDING', v: row.pending }]} /></Panel>
    <Panel title="TODAY'S USAGE" note={row.limitRaw === null ? 'NO DAILY CAP IN GRANT' : 'DECIMAL STRING COUNTERS'} pad>
      <div style={{ display: 'grid', gap: 12 }}><div className="num">{money(row.usedRaw.toString(), view.unit)} {row.limitRaw === null ? '' : `/ ${money(row.limitRaw.toString(), view.unit)}`}</div><span className="sub">Exact decimal counters from the grant and ledger. No floating-point percentage is derived.</span></div>
    </Panel>
    <Panel title="REQUESTS" note={`${requests.length} ROWS`}><div className="stack-list">{requests.length === 0 ? <Empty title="No request rows" body="This view has no request for the agent." /> : requests.map((transaction) => <div key={transaction.id}><time>{relativeTime(transaction.submittedAt)}</time><div><span>{transaction.requestId}</span><span className="sub">{transaction.intent}</span></div><State value={transaction.state} /></div>)}</div></Panel>
    <Panel title="ACTIONS" note="WRITE THROUGH THE API" pad><div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}><ActionButton variant="danger" disabled={busy} onClick={() => { setBusy(true); void revokeAgent(row.id).then((answer) => { setMessage(answer.message); setBusy(false) }) }}>REVOKE AGENT</ActionButton>{['3600000', '86400000', '604800000'].map((ttl) => <ActionButton key={ttl} disabled={busy} onClick={() => void issue(ttl)}>{ttl === '3600000' ? 'MINT 1H' : ttl === '86400000' ? 'MINT 24H' : 'MINT 7D'}</ActionButton>)}</div><p className="sub">There is no credential-list read. A bearer is shown only in the response that minted it.</p></Panel>
  </div>
}
