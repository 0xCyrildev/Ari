'use client'

import { useState } from 'react'
import { ActionButton, DataTable, Panel, PageHead, Reveal, State, ButtonLink, type Column } from '@/components/console/ui'
import { useConsole } from '@/lib/ari/console'
import { shortHash } from '@/lib/ari/format'

type Policy = { key: string; name: string; status: string; versions: number; activeVersionId: string | null }
export default function Policies() {
  const { view, applyPolicy } = useConsole(); const [json, setJson] = useState('{}'); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false)
  const columns: readonly Column<Policy>[] = [{ key: 'name', header: 'POLICY', cell: (policy) => <><ButtonLink href={`/console/policies/${policy.key}`} small>{policy.name}</ButtonLink><span className="sub">{policy.key}</span></> }, { key: 'versions', header: 'VERSIONS', cell: (policy) => <span className="num">{policy.versions}</span> }, { key: 'active', header: 'ACTIVE VERSION', cell: (policy) => <span className="num">{policy.activeVersionId === null ? 'none' : shortHash(policy.activeVersionId)}</span> }, { key: 'status', header: 'STATUS', cell: (policy) => <State value={policy.status} /> }]
  const submit = async () => { try { const document = JSON.parse(json) as unknown; setBusy(true); const answer = await applyPolicy('new-policy', document, true, null); setMessage(answer.message) } catch { setMessage('Policy JSON was refused before submit.') } finally { setBusy(false) } }
  return <div className="console-body"><Reveal><PageHead title="POLICY DOCUMENTS" lede="Published versions are immutable. The table only shows policy fields exposed by the console contract, and activation goes through the API." /></Reveal><Panel title="POLICIES" note={`${view.policies.length} DOCUMENTS`}><DataTable rows={view.policies} columns={columns} rowKey={(policy) => policy.key} /></Panel><Panel title="APPLY AND ACTIVATE" note="JSON DOCUMENT" pad><textarea className="field" value={json} onChange={(event) => setJson(event.target.value)} rows={8} aria-label="Policy JSON" /><div style={{ marginTop: 12 }}><ActionButton disabled={busy} onClick={() => void submit()}>APPLY POLICY</ActionButton></div>{message && <p className="notice" role="status">{message}</p>}<p className="sub">No edit control exists. A published version can only be replaced by publishing another version.</p></Panel></div>
}
