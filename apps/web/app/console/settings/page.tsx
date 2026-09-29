'use client'

import { useState } from 'react'
import { ActionButton, KeyValue, Panel, PageHead, Reveal } from '@/components/console/ui'
import { useConsole } from '@/lib/ari/console'

/** A human lifetime, in the decimal strings the wire carries. The route caps this at thirty days. */
const LIFETIMES: readonly { readonly ttlMs: string; readonly label: string }[] = [
  { ttlMs: '86400000', label: 'MINT 1 DAY' },
  { ttlMs: '604800000', label: 'MINT 7 DAYS' },
  { ttlMs: '2592000000', label: 'MINT 30 DAYS' },
]

export default function Settings() {
  const { view, connected, refresh, forget, rotateOwnCredential } = useConsole()
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [minted, setMinted] = useState<{ bearer: string; expiresAt: string } | null>(null)

  const rotate = async (ttlMs: string) => {
    setBusy(true)
    const answer = await rotateOwnCredential(ttlMs)
    setMessage(answer.message)
    // Only the response ever holds the bearer, so it is kept in component state and dropped on
    // navigation. Nothing here writes it to storage: the credential the tab is using stays the one
    // in sessionStorage until a person chooses to replace it themselves.
    setMinted(answer.bearer === undefined ? null : { bearer: answer.bearer, expiresAt: answer.expiresAt ?? '' })
    setBusy(false)
  }

  return <div className="console-body">
    <Reveal><PageHead title="CONNECTION SETTINGS" lede="The connected tenant only. This screen does not manage other people, webhooks, environments or billing, because those reads and writes are not in the console contract. What it does manage is this person's own credential." /></Reveal>
    <Panel title="TENANT" note={connected ? 'CONNECTED' : 'SAMPLE'} pad><KeyValue items={[{ k: 'ORGANIZATION', v: view.organizationId }, { k: 'SOURCE', v: view.source }, { k: 'NOTICE', v: view.notice }]} /></Panel>
    <Panel title="MY CREDENTIAL" note={connected ? 'WRITE THROUGH THE API' : 'NOT CONNECTED'} pad>
      <p className="sub">Minting here restates the scopes this tab already presents. The route refuses any scope the current credential does not hold, so this cannot widen what you can do. The secret appears once, in this response, and cannot be read back afterwards.</p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>{LIFETIMES.map((option) => <ActionButton key={option.ttlMs} disabled={busy} onClick={() => void rotate(option.ttlMs)}>{option.label}</ActionButton>)}</div>
      {minted !== null && <p className="notice" role="status" style={{ marginTop: 14 }}><span style={{ width: 7, height: 7, background: 'var(--accent)', display: 'inline-block' }} aria-hidden="true" /> Returned once: <code className="num">{minted.bearer}</code>{minted.expiresAt.length > 0 && <>; expires <span className="num">{minted.expiresAt}</span></>}. Copy it now. Paste it above to make the next request use it; the tab keeps using the old one until you do.</p>}
      <p className="sub" style={{ marginTop: 12 }}>The credential you signed in with stays live. That is deliberate: revoking it mid-response would lock you out of a secret that prints once. It also means a stolen credential can extend its own life, which is why the lifetime is bounded and every rotation is written to the audit trail against the secret it replaced.</p>
    </Panel>
    <Panel title="UNAVAILABLE ROUTES" note={`${view.unavailable.length} REFUSED READS`} pad>{view.unavailable.length === 0 ? <p className="empty"><b>No refused routes in this read</b>The current credential did not report a refused route.</p> : <div className="stack-list">{view.unavailable.map((item) => <div key={item.route}><span className="num">{item.route}</span><span className="sub">{item.reason}</span></div>)}</div>}</Panel>
    <Panel title="CONTROLS" pad><div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}><ActionButton onClick={() => void refresh().then(() => setMessage('Console re-read requested.'))}>RE-READ</ActionButton><ActionButton variant="danger" onClick={() => { forget(); setMessage('Credential forgotten from this tab.') }}>FORGET</ActionButton></div>{message !== null && <p className="notice" role="status">{message}</p>}</Panel>
  </div>
}
