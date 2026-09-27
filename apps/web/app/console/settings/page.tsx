'use client'

import { useState, type CSSProperties, type ReactNode } from 'react'
import { ActionButton, DataTable, MetricBand, Notice, Panel, Reveal, State, Tag, KeyValue, type Column } from '@/components/console/ui'
import * as sampleData from '@/lib/ari/sample'
import { relativeTime } from '@/lib/ari/format'
import type { Scope } from '@/lib/ari/types'

/**
 * Settings. People and tenancy: who an approval can be addressed to, which scope lets a caller
 * do what, and the three mechanisms that keep one organisation's rows inside one organisation.
 *
 * This is the screen most at risk of overclaiming, because everything it describes is a database
 * property rather than a visible one. So each statement below names the file or the constraint
 * that carries it, and the counts are computed from the fixture rows in the expression that
 * renders them. Nothing here is a permission you hold: there is no session behind this page.
 */

const PROSE: CSSProperties = { margin: '14px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }

const BODY: CSSProperties = { margin: 0, padding: '20px 24px', fontSize: 13, lineHeight: 1.55 }

const MONO = ({ children }: { readonly children: ReactNode }) => <code style={{ fontFamily: 'monospace', letterSpacing: 0 }}>{children}</code>

/**
 * What each scope in the console's vocabulary grants, keyed by the type so a member added to
 * `Scope` without a line here is a build error rather than a scope nobody explained.
 */
const GRANTS: Readonly<Record<Scope, string>> = {
  'transaction:request':
    'Propose a payment, or ask what would happen to one. Only an agent may hold it: a human credential carrying it is refused in the route handler and by a CHECK in 013.',
  'transaction:read':
    'Named in the vocabulary and allowed by the database CHECK. No route asks for it, so a credential holding it is granted nothing today.',
  'approval:decide':
    "Read the approvals waiting on the person presenting the secret, and record that person's vote. Only a human may hold it: an agent credential carrying it is refused in words and by a CHECK.",
  'agent:manage':
    "Create an agent, list this organisation's agents, issue it a credential, and revoke it together with every credential it holds.",
  'wallet:manage':
    'Register a wallet with its mode and signature triple, and grant an agent a wallet under one named policy version.',
  'policy:activate':
    'Create a policy version from a document and, when asked to activate it, run the compiler and the check that decides whether this caller may widen what was live.',
  'audit:read': "Read this organisation's event log, whole or from a cursor.",
}

const MISSING: readonly { readonly label: string; readonly body: string }[] = [
  { label: 'NO LOGIN', body: 'There is no route that signs anyone in. The people in the table above are rows an approval can be addressed to, and none of them is how this page was reached.' },
  { label: 'NO SESSION', body: 'Nothing here holds a session, so there is no expiry, no refresh and no logout to demonstrate, and a revoked credential cannot be shown dying behind a browser that never had one.' },
  { label: 'NO DEPLOYMENT', body: 'No API is attached to this build. The rail says so in the corner, and the rows on every screen come from a fixture in lib/ari/sample.ts.' },
  { label: 'NOTHING WRITES', body: 'No control on this page changes any state, including the destructive row at the bottom, which answers by refusing.' },
  { label: 'NO SEPARATE TENANTS', body: 'Staging and sandbox are labels on one sample organisation. The only boundary the database actually enforces is the one around this organisation, and there is one of it here.' },
]

export default function Settings() {
  const [notice, setNotice] = useState<string | null>(null)

  const userColumns: readonly Column<(typeof sampleData.users)[number]>[] = [
    {
      key: 'email',
      header: 'EMAIL',
      cell: (user) => (
        <>
          <span style={{ wordBreak: 'break-all' }}>{user.email}</span>
          <span className="sub">
            {user.name} · {user.id}
          </span>
        </>
      ),
    },
    { key: 'role', header: 'ROLE', hideBelow: 'sm', cell: (user) => <Tag>{user.role}</Tag> },
    { key: 'status', header: 'STATUS', cell: (user) => <State value={user.status} /> },
  ]

  return (
    <div className="console-body">
      <Reveal>
        <h1>
          WHO IS IN IT,
          <br />
          AND WHERE IT ENDS.
        </h1>
        <p className="lede">
          Tenancy in Ari is not a filter an application remembers. It is a value set inside the
          transaction, a policy on every table, and one lock per organisation, and this page is where
          those are written down next to the people they apply to.
        </p>
      </Reveal>

      <div style={{ height: 38 }} />

      <MetricBand
        items={[
          { label: 'PEOPLE', value: sampleData.users.length, note: `in ${sampleData.organization.name}` },
          { label: 'MARKED ACTIVE', value: sampleData.users.filter((user) => user.status === 'ACTIVE').length, note: 'a status column, not a live session' },
          { label: 'MARKED SUSPENDED', value: sampleData.users.filter((user) => user.status === 'SUSPENDED').length, tone: 'stop', note: 'their credential would be refused at the gate' },
          {
            label: 'SCOPES IN USE',
            value: new Set(sampleData.apiKeys.flatMap((key) => [...key.scopes])).size,
            note: `held by ${sampleData.apiKeys.filter((key) => key.scopes.length > 0).length} credential rows`,
          },
        ]}
      />

      <Panel title="PEOPLE" note={`${sampleData.users.length} IN THE ORGANISATION`}>
        <DataTable rows={sampleData.users} columns={userColumns} rowKey={(user) => user.id} />
        <p style={PROSE}>
          The roles the routes accept are owner, admin, approver and viewer. This tenant holds{' '}
          {sampleData.users.filter((user) => user.role === 'owner').length} owner,{' '}
          {sampleData.users.filter((user) => user.role === 'admin').length} admin,{' '}
          {sampleData.users.filter((user) => user.role === 'approver').length} approver and{' '}
          {sampleData.users.filter((user) => user.role === 'viewer').length} viewer. The escalation
          blocks in the active policy versions name{' '}
          {Array.from(new Set(sampleData.policies.map((policy) => sampleData.activeVersion(policy.key).document.escalation.humanApproval.approverRoles).flat())).join(
            ' and ',
          )}{' '}
          as the roles that can satisfy a quorum, and a vote from anyone else is refused with{' '}
          <MONO>APPROVER_NOT_AUTHORISED</MONO> and written to the chain as a refusal. So{' '}
          {sampleData.users.filter((user) => user.role === 'admin').length} of the people above is an admin,
          which is not a way through an approval queue.
        </p>
        <p style={{ ...PROSE, marginTop: 10 }}>
          A suspended person is not a deleted person: their credential still parses and still selects
          a row, and the verification step refuses it with its own reason,{' '}
          <MONO>USER_SUSPENDED</MONO>. From outside the API that looks identical to a wrong secret,
          which is the point: an endpoint that distinguishes them answers &quot;does this person exist&quot;
          for anyone who asks.
        </p>
      </Panel>

      <Panel title="WHAT EACH SCOPE GRANTS" note={`${Object.keys(GRANTS).length} NAMED BY THE CONSOLE`} pad>
        <div className="stack-list" style={{ borderTop: 0 }}>
          {(Object.keys(GRANTS) as readonly Scope[]).map((scope) => (
            <div key={scope} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 190px) minmax(0, 1fr)', gap: 20, padding: '16px 0' }}>
              <Tag>{scope}</Tag>
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--muted)' }}>
                {GRANTS[scope]}
                <span className="sub">
                  held by {sampleData.apiKeys.filter((key) => key.scopes.includes(scope)).length} credential rows and{' '}
                  {sampleData.agents.filter((agent) => agent.scopes.includes(scope)).length} agents here
                </span>
              </p>
            </div>
          ))}
        </div>
        <p style={PROSE}>
          The engine&apos;s own list carries one member more than this screen can draw:{' '}
          <MONO>policy:read</MONO>. It is in <MONO>SCOPES</MONO> in packages/identity/src/tenant.ts and in the
          database CHECK, no route asks for it, and no row in this fixture holds it, so it is named
          here rather than given a line that would read like a permission.
        </p>
      </Panel>

      <Panel title="TENANCY" note="THE BOUNDARY, AND HOW IT IS HELD">
        <div style={{ ...BODY, paddingBottom: 0 }}>
          <KeyValue
            items={[
              { k: 'ORGANISATION', v: sampleData.organization.name },
              { k: 'ID', v: <span className="num" style={{ wordBreak: 'break-all' }}>{sampleData.organization.id}</span> },
              { k: 'ENVIRONMENT', v: sampleData.organization.environment },
              { k: 'REGION', v: sampleData.organization.region },
              { k: 'PLAN', v: sampleData.organization.plan },
              { k: 'SINCE', v: relativeTime(sampleData.organization.createdAt) },
            ]}
          />
        </div>
        <p style={PROSE}>
          Every read runs inside one transaction that has named its tenant:{' '}
          <MONO>set_config(&apos;ari.org_id&apos;, &lt;org&gt;, true)</MONO>, local to that transaction so a pooled
          connection carries nothing forward when it returns. Row-security policies on every table
          then compare <MONO>org_id</MONO> against that setting, for reads and for inserts. The role the
          queries run as is one application role for the deployment, taken from{' '}
          <MONO>DATABASE_ROLE</MONO> and assumed when the connection opens: it is the tenant value, not the
          role, that separates organisations. There is no separate Postgres role per tenant in this
          build.
        </p>
        <p style={PROSE}>
          Alongside it, one advisory lock per organisation:{' '}
          <MONO>pg_advisory_xact_lock(hashtextextended(org_id, 0))</MONO>, taken as the first statement of the
          transaction and derived identically by the audit writer, so appending to this
          organisation&apos;s chain is serialised and two writers cannot each believe they hold it alone.
          Taking it first is also what keeps it from deadlocking against the row locks under it.
        </p>
        <p style={PROSE}>
          A missing scope is a refusal, not an empty result: the human routes answer 403{' '}
          <MONO>{'{"code":"SCOPE_REFUSED","detail":"this route requires <scope>"}'}</MONO> before the query runs,
          because a list that comes back empty when the caller simply was not allowed to ask is the
          answer that gets mistaken for &quot;there is nothing here&quot;. The one place an absence is
          deliberate is another tenant&apos;s id, which reads exactly as no id at all: a 404 that does not
          confirm the object exists somewhere else.
        </p>
      </Panel>

      <div className="split">
        <Panel title="WHAT THIS BUILD DOES NOT DO YET" note="SAID BEFORE IT IS DISCOVERED">
          <div className="stack-list" style={{ margin: '0 24px 8px' }}>
            {MISSING.map((item) => (
              <div key={item.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 150px) minmax(0, 1fr)', gap: 20 }}>
                <Tag>{item.label}</Tag>
                <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--muted)' }}>{item.body}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="IF EVERY AGENT SECRET IS HOT" note="ONE ACTION, ONE REFUSAL" pad>
          <p style={{ ...BODY, padding: 0 }}>
            The row a security run reaches for first, and the answer it gets from a screen with no
            authority behind it.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 18 }}>
            <ActionButton
              variant="danger"
              onClick={() =>
                setNotice(
                  "Nothing is connected to this screen, and no credential was revoked. The real call is POST /v1/agents/:agentId/revoke with a user credential holding agent:manage, one agent at a time: setAgentStatus moves the agent to REVOKED and revokes every credential it holds inside the same transaction, then answers with how many stopped working. There is no bulk endpoint, and REVOKED is terminal, so a retired agent's next step is a new agent.",
                )
              }
            >
              REVOKE ALL AGENT CREDENTIALS
            </ActionButton>
          </div>
          {notice !== null && (
            <div style={{ marginTop: 20 }}>
              <Notice text={notice} />
            </div>
          )}
          <p style={PROSE}>
            Counting what that would touch, from the rows above rather than from a guess:{' '}
            {sampleData.agents.filter((agent) => agent.status !== 'REVOKED').length} agents are not revoked,{' '}
            {sampleData.apiKeys.filter((key) => key.status === 'ACTIVE').length} credential rows are marked ACTIVE, and{' '}
            {sampleData.agents.filter((agent) => agent.status === 'REVOKED').length} agent is already past the point
            where a revoke changes anything.
          </p>
        </Panel>
      </div>
    </div>
  )
}
