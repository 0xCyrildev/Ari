'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { ActionButton, Empty, KeyValue, Meter, Panel, Reveal, State, Tag, DataTable, type Column } from '@/components/console/ui'
import * as sampleData from '@/lib/ari/sample'
import { useConsole } from '@/lib/ari/console'
import { UnwiredScreen } from '@/components/console/ui'
import { deriveAgentState, type RiskLevel, type TransactionRecord } from '@/lib/ari/types'
import { money, relativeTime } from '@/lib/ari/format'

/**
 * One agent's control page: what it may do, what it has asked for, and what revoking it would
 * actually do. The revoke button does not pretend, because a button that fakes success on a
 * payment console teaches the operator the wrong contract.
 */
export default function AgentDetail() {
  const { view } = useConsole()
  if (view.source === 'live') {
    return (
      <UnwiredScreen
        screen="agent detail"
        need="one read is missing: nothing on this API lists an agent's credentials, so the credential panel would be invented. Its revoke and mint buttons are wired to the proxy already."
      />
    )
  }

  const { name } = useParams<{ name: string }>()
  const [refusal, setRefusal] = useState<string | null>(null)
  const agent = sampleData.agentByName(name)

  if (agent === undefined) {
    return (
      <div className="console-body">
        <Empty title={`No agent named ${name}`} body="Agent handles are unique inside an organization. Check the spelling, or open the list." />
        <Link href="/console/agents" className="tag">
          BACK TO AGENTS ↗
        </Link>
      </div>
    )
  }

  const txs = sampleData.transactions.filter((tx) => tx.agentId === agent.id)
  const pending = txs.filter((tx) => tx.outcome === 'REQUIRE_HUMAN_APPROVAL').length
  const highest = txs.reduce<RiskLevel | null>((acc, tx) => {
    const level = tx.risk?.level ?? null
    if (level === null) return acc
    const order: readonly RiskLevel[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
    return acc === null || order.indexOf(level) > order.indexOf(acc) ? level : acc
  }, null)
  const policy = sampleData.policies.find((item) => item.key === agent.policy)
  const active = policy === undefined ? undefined : sampleData.activeVersion(policy.key)
  const document = active?.document
  const usage = sampleData.usageFor(agent.name)
  const dailyLimit = document === undefined ? 0n : BigInt(document.permissions.transfers.perDay.maxRaw)
  const credentials = sampleData.apiKeys.filter((key) => key.name.startsWith(agent.name))

  const columns: readonly Column<TransactionRecord>[] = [
    { key: 'intent', header: 'REQUEST', cell: (tx) => tx.intent },
    { key: 'amount', header: 'AMOUNT', align: 'right', hideBelow: 'sm', cell: (tx) => <span className="num">{money(tx.amountRaw, tx.unit, true)}</span> },
    { key: 'decision', header: 'DECISION', cell: (tx) => <State value={tx.outcome} /> },
    { key: 'when', header: 'WHEN', align: 'right', hideBelow: 'md', cell: (tx) => <time dateTime={tx.submittedAt}>{relativeTime(tx.submittedAt).toUpperCase()}</time> },
  ]

  return (
    <div className="console-body">
      <Reveal>
        <p className="section-kicker" style={{ marginBottom: 20 }}>
          AGENT / {agent.name.toUpperCase()}
        </p>
        <h1>
          {agent.name.toUpperCase()}
          <br />
          <span className="muted">{agent.status}</span>
        </h1>
        <p className="lede">{agent.purpose}</p>
      </Reveal>

      <div style={{ margin: '38px 0 46px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <ActionButton onClick={() => setRefusal('Pausing stops new requests. Outstanding tickets still redeem until their 60 second TTL, which is by design: a ticket is a capability already granted. No deployment is connected, so nothing was paused.')}>
          PAUSE AGENT
        </ActionButton>
        <ActionButton variant="danger" onClick={() => setRefusal(`No deployment is connected, so nothing was revoked. The real call is POST /v1/agents/${agent.id}/revoke, and it needs a credential holding agent:manage.`)}>
          REVOKE {agent.name.toUpperCase()}
        </ActionButton>
      </div>

      {refusal !== null && <p className="notice">{refusal}</p>}

      <div className="split" style={{ marginTop: 40 }}>
        <div>
          <Panel title="THE ENVELOPE IN NUMBERS" note={active === undefined ? 'NO ACTIVE VERSION' : `v${active.number} · ${active.status}`}>
            {document === undefined ? (
              <Empty title="No compiled document" body="This agent names a policy that has no active version, so every request it makes is refused." />
            ) : (
              <div style={{ padding: '20px 24px' }}>
                <KeyValue
                  items={[
                    { k: 'ASSETS', v: document.permissions.transfers.assets.map((asset) => asset.symbol ?? asset.kind).join(', ') || 'none' },
                    { k: 'CHAINS', v: document.permissions.transfers.chains.join(', ') || 'transfers disabled' },
                    { k: 'PER TX', v: money(document.permissions.transfers.perTransaction.maxRaw, document.permissions.transfers.perTransaction.unit) },
                    { k: 'PER MONTH', v: document.permissions.transfers.perMonth === null ? 'no monthly window' : money(document.permissions.transfers.perMonth.maxRaw, document.permissions.transfers.perMonth.unit) },
                    { k: 'RECIPIENTS', v: `${document.permissions.transfers.recipients.addresses.length} allowlisted, no wildcard` },
                    { k: 'HOURLY RATE', v: `${document.permissions.transfers.maxTransactionsPerHour} requests` },
                    { k: 'ESCALATES WHEN', v: document.escalation.humanApproval.requiredWhen.length === 0 ? 'never, this policy does not escalate' : document.escalation.humanApproval.requiredWhen.map((rule) => rule.op).join(', ') },
                    { k: 'QUORUM', v: `${document.escalation.humanApproval.quorum} of ${document.escalation.humanApproval.approverRoles.join(' / ')}` },
                  ]}
                />
                <div style={{ marginTop: 26 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, letterSpacing: '.15em' }}>
                    <span>TODAY</span>
                    <span className="num">
                      {money(usage.settledRaw.toString(), 'usdc-6dp')} / {money(dailyLimit.toString(), 'usdc-6dp')}
                    </span>
                  </div>
                  <Meter used={Number((usage.settledRaw * 1000n) / (dailyLimit > 0n ? dailyLimit : 1n)) / 1000} limit={Number(dailyLimit) / 1000 || 0} />
                </div>
              </div>
            )}
          </Panel>

          <Panel title="WHAT IT MAY AND MAY NOT DO">
            <div className="stack-list">
              {[
                { ok: true, text: 'Propose a payment inside its policy' },
                { ok: true, text: 'Read the status of its own requests' },
                { ok: false, text: 'Approve any payment, including its own' },
                { ok: false, text: 'Change its policy, its limits or its approvers' },
                { ok: false, text: 'Hold a signing key or call a signer directly' },
                { ok: false, text: 'Withdraw to an address that is not allowlisted' },
              ].map((item) => (
                <div key={item.text} style={{ gridTemplateColumns: '20px minmax(0,1fr)' }}>
                  <span className={item.ok ? 'state ok' : 'state stop'}>
                    <i aria-hidden="true" />
                  </span>
                  <span style={{ color: item.ok ? 'var(--ink)' : 'var(--muted)' }}>{item.text}</span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="REQUESTS FROM THIS AGENT" note={`${txs.length} RECORDED`}>
            <DataTable rows={txs.slice(0, 10)} columns={columns} rowKey={(tx) => tx.id} empty={<Empty title="No requests yet" body="This agent has not asked for anything in the tenant this screen reads." />} />
          </Panel>

          <Panel title="CREDENTIALS" note={`${credentials.length} ISSUED`}>
            {credentials.length === 0 ? (
              <Empty title="No credential is currently issued to this agent" body="An agent secret is printed once at issue and cannot be read back." />
            ) : (
              <div className="stack-list">
                {credentials.map((key) => (
                  <div key={key.id} style={{ gridTemplateColumns: 'minmax(0,1fr) auto auto' }}>
                    <span className="num">
                      {key.prefix}…
                      <span className="sub">{key.scopes.join(' · ')}</span>
                    </span>
                    <span className="muted" style={{ fontSize: 10, letterSpacing: '.12em' }}>
                      {key.lastUsed === null ? 'NEVER USED' : `LAST USED ${relativeTime(key.lastUsed).toUpperCase()}`}
                    </span>
                    <State value={key.status} />
                  </div>
                ))}
              </div>
            )}
            <p style={{ margin: '18px 24px 20px', fontSize: 11, lineHeight: 1.5, color: 'var(--muted)' }}>
              An agent secret (<span className="num">crd_</span>) does not parse at a human route and a user secret (
              <span className="num">ucrd_</span>) does not parse at an agent route, so both refusals look exactly like a wrong
              secret. Revoking the agent revokes every credential with it, in the same transaction.
            </p>
          </Panel>
        </div>

        <div>
          <Panel title="IDENTITY" pad>
            <KeyValue
              items={[
                { k: 'HANDLE', v: agent.name },
                { k: 'STORED STATE', v: <State value={agent.status} /> },
                { k: 'READ AS', v: <State value={deriveAgentState(agent.status, pending, highest)} /> },
                { k: 'SCOPES', v: agent.scopes.map((scope) => <Tag key={scope}>{scope}</Tag>) },
                { k: 'OWNER', v: agent.owner },
                { k: 'POLICY', v: policy === undefined ? agent.policy : <Link href={`/console/policies/${policy.key}`}>{`${policy.name} v${active?.number ?? 0}`}</Link> },
                { k: 'REQUESTS', v: `${txs.length} recorded` },
                { k: 'LAST SEEN', v: relativeTime(usage.lastAt ?? new Date(Date.now() - agent.lastActivity).toISOString()) },
              ]}
            />
            <p style={{ margin: '18px 0 0', fontSize: 11, lineHeight: 1.5, color: 'var(--muted)' }}>
              AWAITING_APPROVAL and ANOMALOUS are this screen&apos;s reading of live rows, not stored statuses. Ari stores
              ACTIVE, PAUSED and REVOKED.
            </p>
          </Panel>

          <Panel title="WHAT REVOKING DOES" pad>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--muted)' }}>
              Terminal and absorbing. A revoked agent cannot change status again, every credential it held stops parsing at
              the boundary on the next request, and {pending} request{pending === 1 ? '' : 's'} now awaiting approval will not
              be paid because the approval token is sealed against the agent row. Outstanding tickets are{' '}
              <em>not</em> revoked: a capability already granted is honoured until its 60 second TTL, and pretending
              otherwise would be a lie about a signature.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  )
}
