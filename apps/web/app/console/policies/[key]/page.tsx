'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { ActionButton, Empty, KeyValue, Panel, Reveal, State, Tag } from '@/components/console/ui'
import * as sampleData from '@/lib/ari/sample'
import { money, relativeTime, shortHash } from '@/lib/ari/format'
import type { PolicyDocumentShape, PolicyVersion } from '@/lib/ari/types'

function Group({ title, note, items }: { readonly title: string; readonly note?: string; readonly items: readonly { readonly k: string; readonly v: React.ReactNode }[] }) {
  return (
    <Panel title={title} note={note}>
      <div style={{ padding: '20px 24px' }}>
        <KeyValue items={items} />
      </div>
    </Panel>
  )
}

/** Before and after, in words that say which direction the envelope moves. */
function Diff({ label, from, to, unit }: { readonly label: string; readonly from: string; readonly to: string; readonly unit: string }) {
  const wider = BigInt(to) > BigInt(from)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 16, alignItems: 'baseline', padding: '14px 0', borderTop: '1px solid var(--line)' }}>
      <span style={{ fontSize: 10, letterSpacing: '.15em', color: 'var(--muted)' }}>{label.toUpperCase()}</span>
      <span className="num" style={{ fontSize: 13 }}>
        <span style={{ textDecoration: 'line-through', color: 'var(--muted)' }}>{money(from, unit)}</span> → {money(to, unit)}{' '}
        <span style={{ color: 'var(--accent)' }}>[{wider ? 'WIDENING' : 'NARROWING'}]</span>
      </span>
    </div>
  )
}

export default function PolicyDetail() {
  const { key } = useParams<{ key: string }>()
  const policy = sampleData.policies.find((item) => item.key === key)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  if (policy === undefined) {
    return (
      <div className="console-body">
        <Empty title={`No policy named ${key}`} body="Policies are keyed by organization and name. The one that authorized a request is always named on that request." />
        <Link href="/console/policies" className="tag">
          BACK TO POLICIES ↗
        </Link>
      </div>
    )
  }

  const active = sampleData.activeVersion(policy.key)
  const selected: PolicyVersion = policy.versions.find((version) => version.id === selectedId) ?? active
  const draft = policy.versions.find((version) => version.status === 'DRAFT')
  const granted = sampleData.agents.filter((agent) => agent.policy === policy.key)
  const doc: PolicyDocumentShape = selected.document
  const wallet = sampleData.walletById(doc.target.walletId)

  return (
    <div className="console-body">
      <Reveal>
        <p className="section-kicker" style={{ marginBottom: 20 }}>
          POLICY / {policy.name.toUpperCase()}
        </p>
        <h1>
          {policy.name.toUpperCase()}
          <br />
          <span className="muted">
            V{selected.number} · {selected.status}
          </span>
        </h1>
        <p className="lede">{selected.summary}</p>
      </Reveal>

      <div style={{ margin: '38px 0 46px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="field" aria-label="Policy version" value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
          {[...policy.versions]
            .sort((a, b) => b.number - a.number)
            .map((version) => (
              <option key={version.id} value={version.id}>
                V{version.number} · {version.status}
              </option>
            ))}
        </select>
        <ActionButton
          onClick={() =>
            setNotice(
              selected.status === 'ACTIVE'
                ? 'This version is already the one that governs, so there is nothing to activate.'
                : `Activating v${selected.number} needs a credential holding policy:activate, and a written justification if it widens the version it replaces. No deployment is connected, so nothing was activated.`,
            )
          }
        >
          {selected.status === 'ACTIVE' ? 'CURRENTLY ACTIVE' : `ACTIVATE V${selected.number}`}
        </ActionButton>
      </div>

      {notice !== null && <p className="notice">{notice}</p>}

      {draft !== undefined && (
        <Panel title="A WIDENING IS WAITING" note={`DRAFT V${draft.number}`}>
          <div style={{ padding: '6px 24px 20px' }}>
            <Diff label="per transaction" from={active.document.permissions.transfers.perTransaction.maxRaw} to={draft.document.permissions.transfers.perTransaction.maxRaw} unit={draft.document.permissions.transfers.perTransaction.unit} />
            <Diff label="per day" from={active.document.permissions.transfers.perDay.maxRaw} to={draft.document.permissions.transfers.perDay.maxRaw} unit={draft.document.permissions.transfers.perDay.unit} />
            <p style={{ margin: '18px 0 0', fontSize: 12, lineHeight: 1.55, color: 'var(--muted)' }}>
              Activating a broader version is refused unless the actor holds the owner role, and a rollback out of order
              requires a written justification. {granted.length} agent{granted.length === 1 ? '' : 's'} currently granted under v
              {active.number} keep that version until an operator re-points the grant: activating does not silently move
              anyone&apos;s envelope.
            </p>
          </div>
        </Panel>
      )}

      <div className="split">
        <div>
          <Group
            title="TRANSFERS ALLOWED"
            note={`${doc.permissions.transfers.recipients.addresses.length} RECIPIENTS`}
            items={[
              { k: 'ASSETS', v: doc.permissions.transfers.assets.map((asset) => `${asset.kind}${asset.symbol === undefined ? '' : ` (${asset.symbol})`} on ${asset.chain}`).join(', ') || 'none' },
              { k: 'CHAINS', v: doc.permissions.transfers.chains.join(', ') || 'transfers disabled' },
              { k: 'PER TX', v: money(doc.permissions.transfers.perTransaction.maxRaw, doc.permissions.transfers.perTransaction.unit) },
              { k: 'PER DAY', v: money(doc.permissions.transfers.perDay.maxRaw, doc.permissions.transfers.perDay.unit) },
              { k: 'PER MONTH', v: doc.permissions.transfers.perMonth === null ? 'no monthly window' : money(doc.permissions.transfers.perMonth.maxRaw, doc.permissions.transfers.perMonth.unit) },
              { k: 'HOURLY RATE', v: `${doc.permissions.transfers.maxTransactionsPerHour} requests` },
            ]}
          />

          <Group
            title="HELD BACK"
            note="REFUSED OR ESCALATED"
            items={[
              { k: 'CONTRACT CALLS', v: doc.permissions.contractCalls.enabled ? `${doc.permissions.contractCalls.contracts.length} allowlisted, native value refused` : 'disabled entirely' },
              { k: 'NEW RECIPIENTS', v: doc.permissions.newRecipients.allowed ? (doc.permissions.newRecipients.requireApproval ? 'permitted with approval' : 'permitted autonomously') : 'not permitted' },
              { k: 'UNKNOWN TX', v: doc.fallback.onUnknownTransaction },
              { k: 'EVALUATION ERROR', v: doc.fallback.onEvaluationError },
            ]}
          />

          <Group
            title="ESCALATION"
            note={`QUORUM ${doc.escalation.humanApproval.quorum}`}
            items={[
              {
                k: 'CONDITIONS',
                v: doc.escalation.humanApproval.requiredWhen.length === 0 ? 'none, this policy never escalates' : doc.escalation.humanApproval.requiredWhen.map((rule) => rule.op).join(', '),
              },
              { k: 'APPROVER ROLES', v: doc.escalation.humanApproval.approverRoles.join(', ') },
              { k: 'QUORUM HELD BY', v: `${doc.escalation.humanApproval.quorumEnforcement}, not by this interface` },
              { k: 'RISK UNAVAILABLE', v: doc.fallback.onRiskUnavailable },
              { k: 'SIMULATION UNAVAILABLE', v: doc.fallback.onSimulationUnavailable },
            ]}
          />

          <Group
            title="VALIDITY"
            note="WHEN A DECISION STOPS BEING GOOD"
            items={[
              { k: 'TX TTL', v: `${doc.validity.transactionTtlSeconds}s after authorization` },
              { k: 'NOT BEFORE', v: doc.validity.notBefore ?? 'immediately' },
              { k: 'NOT AFTER', v: doc.validity.notAfter ?? 'no expiry' },
              { k: 'SIGNING BUDGET', v: `${doc.validity.signingBudget.maxIkaRawPerDay} IKA per day` },
              { k: 'PRICE STALENESS', v: `${doc.limits.maxUsdEstimateAgeSeconds}s maximum` },
              { k: 'DEADLINE SKEW', v: `${doc.limits.maxDeadlineSkewSeconds}s maximum` },
            ]}
          />
        </div>

        <div>
          <Panel title="TARGET" pad>
            <KeyValue
              items={[
                { k: 'WALLET', v: wallet?.name ?? 'unknown' },
                { k: 'AUTHORITY', v: <Tag>{doc.target.authorityMode.toUpperCase()}</Tag> },
                { k: 'SIGNATURE', v: <span className="num" style={{ fontSize: 10 }}>{doc.target.signatureTriple}</span> },
                { k: 'VERSION ID', v: <span className="num" style={{ fontSize: 10 }}>{shortHash(selected.id, 8)}</span> },
                { k: 'CREATED', v: relativeTime(selected.createdAt) },
                { k: 'ACTIVE SINCE', v: selected.activatedAt === null ? 'never activated' : relativeTime(selected.activatedAt) },
              ]}
            />
            {selected.justification !== null && (
              <p style={{ margin: '16px 0 0', fontSize: 11, lineHeight: 1.5, color: 'var(--accent)' }}>
                REACTIVATION JUSTIFIED: {selected.justification}
              </p>
            )}
          </Panel>

          <Panel title="VERSION HISTORY" note={`${policy.versions.length} VERSIONS`}>
            <div className="stack-list">
              {[...policy.versions]
                .sort((a, b) => b.number - a.number)
                .map((version) => (
                  <div key={version.id} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                    <div style={{ minWidth: 0 }}>
                      v{version.number} · {version.summary}
                      <span className="sub">{version.activatedAt === null ? 'never activated' : `active since ${relativeTime(version.activatedAt)}`}</span>
                    </div>
                    <State value={version.status} />
                  </div>
                ))}
            </div>
          </Panel>

          <Panel title="AGENTS GRANTED UNDER IT" note={`${granted.length}`}>
            {granted.length === 0 ? (
              <Empty title="None" body="A policy that governs nothing is a document, not a control." />
            ) : (
              <div className="stack-list">
                {granted.map((agent) => (
                  <div key={agent.id} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                    <Link href={`/console/agents/${agent.name}`}>{agent.name}</Link>
                    <State value={agent.status} />
                  </div>
                ))}
              </div>
            )}
            <p style={{ margin: '16px 24px 20px', fontSize: 11, lineHeight: 1.5, color: 'var(--muted)' }}>
              A grant binds one version, not &quot;the current policy&quot;. Until an operator holding wallet:manage
              re-points it, an agent keeps the envelope it was issued under.
            </p>
          </Panel>

          <Panel title="WHAT THE COMPILER REFUSES" pad>
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }}>
              Two limits that disagree about units. Transfers enabled with no permitted chain. An allowlist entry that is not
              a valid address in either grammar. A contract call carrying native value. A caller-supplied USD estimate where
              a <span className="num">usd_gte</span> rule exists to read one. All of them are refused at authoring time, not
              discovered at decision time.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  )
}
