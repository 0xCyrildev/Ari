'use client'

import { use } from 'react'
import { ButtonLink, Empty, Panel, PageHead, Reveal, State, UnwiredScreen } from '@/components/console/ui'
import { useConsole } from '@/lib/ari/console'
import { shortHash } from '@/lib/ari/format'
export default function PolicyDetail({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params); const { view } = useConsole(); const policy = view.policies.find((item) => item.key === key)
  if (!policy) return <div className="console-body"><UnwiredScreen
        screen={view.source === 'live' ? `POLICY ${key.toUpperCase()} IS NOT IN THIS TENANT` : 'POLICY NOT IN THE SAMPLE TENANT'}
        need={`No policy carries the key “${key}” in the ${view.source === 'live' ? 'tenant you are connected to' : 'sample tenant'}. Nothing is drawn in its place.`}
      /></div>
  return <div className="console-body"><Reveal><PageHead title={policy.name.toUpperCase()} lede="Versions are listed from the policy summary contract. The document itself is not exposed on this read, so no invented JSON is rendered." actions={<ButtonLink href="/console/policies" variant="light" small>ALL POLICIES</ButtonLink>} /></Reveal><Panel title="POLICY" note={policy.key} pad><div className="kv"><div><dt>STATUS</dt><dd><State value={policy.status} /></dd></div><div><dt>VERSION COUNT</dt><dd className="num">{policy.versions}</dd></div><div><dt>ACTIVE VERSION</dt><dd className="num">{policy.activeVersionId === null ? 'none' : shortHash(policy.activeVersionId)}</dd></div></div></Panel><Panel title="PUBLISHED VERSIONS" note="NEWEST FIRST"><div className="stack-list">{policy.versionIds.length === 0 ? <Empty title="No versions" body="This policy has no version ids in the current read." /> : policy.versionIds.map((id, index) => <div key={id}><span className="num">v{policy.versionIds.length - index}</span><div><span className="num">{shortHash(id)}</span><span className="sub">{id === policy.activeVersionId ? 'active version id' : 'published version id'}</span></div><State value={id === policy.activeVersionId ? 'ACTIVE' : 'RETIRED'} /></div>)}</div></Panel><Panel title="WHY IMMUTABILITY MATTERS" pad><p style={{ maxWidth: '72ch', lineHeight: 1.55, margin: 0 }}>A decision is re-derivable only because the document behind it cannot be rewritten. The console can point to the version carried by a grant, but it cannot turn an old document into a new one.</p></Panel></div>
}
