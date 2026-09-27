'use client'

import { useState, type CSSProperties, type ReactNode } from 'react'
import { ActionButton, DataTable, MetricBand, Notice, Panel, Reveal, State, Tag, type Column } from '@/components/console/ui'
import * as sampleData from '@/lib/ari/sample'
import { useConsole } from '@/lib/ari/console'
import { UnwiredScreen } from '@/components/console/ui'
import { relativeTime } from '@/lib/ari/format'

/**
 * Developers. This is the integration surface, and the discipline it exists to serve: a caller
 * that can tell the difference between "no such key" and "wrong secret" has been handed an
 * oracle, and a caller that can read a ticket out of a decision response has been handed a
 * capability. So the samples below are the answers the routes really give, taken from
 * `apps/api/src/routes.ts`, and where the surface has a hole it is named as a hole instead of
 * being filled with an endpoint that does not exist.
 *
 * The credential, webhook and environment figures are computed from the fixture rows in the
 * expression that renders them. The route rows come from the API source, and the count on the
 * band is the length of that list, so a route added there and not here shows up as a number
 * that no longer matches a table anyone can read.
 */

type Credential = (typeof sampleData.apiKeys)[number]
type Webhook = (typeof sampleData.webhooks)[number]
type Environment = (typeof sampleData.environments)[number]

const PRE: CSSProperties = {
  margin: '16px 0 0',
  padding: '16px 18px',
  font: '11px/1.9 monospace',
  whiteSpace: 'pre',
  overflowX: 'auto',
  background: 'color-mix(in srgb, var(--ink) 3%, transparent)',
  borderTop: '1px solid var(--line)',
  borderBottom: '1px solid var(--line)',
}

const BODY: CSSProperties = { margin: 0, padding: '20px 24px', fontSize: 13, lineHeight: 1.55 }

const PROSE: CSSProperties = { margin: '14px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }

const MONO = ({ children }: { readonly children: ReactNode }) => <code style={{ fontFamily: 'monospace', letterSpacing: 0 }}>{children}</code>

/**
 * Every route in `apps/api/src/routes.ts`, with the authority it asks for. The scope column is
 * the string the source names, verbatim: the human routes call `asUser('<scope>')`, the agent
 * routes are gated by a credential and then refused inside the decision with `SCOPE_MISSING`,
 * and the bootstrap routes are outside the tenant scope system altogether.
 */
const ROUTES: readonly { readonly method: string; readonly path: string; readonly who: string; readonly scope: string; readonly detail: string }[] = [
  { method: 'GET', path: '/healthz', who: 'nobody', scope: 'none', detail: 'answers { "status": "ok" } and authenticates nothing' },
  { method: 'POST', path: '/v1/organizations', who: 'bootstrap token', scope: 'not a tenant scope', detail: 'name, ownerEmail, ownerDisplayName; creates the owner in the same call' },
  { method: 'POST', path: '/v1/transactions/authorize', who: 'agent credential', scope: 'transaction:request', detail: 'candidate and idempotencyKey, 1 to 200 characters' },
  { method: 'POST', path: '/v1/transactions/evaluate', who: 'agent credential', scope: 'transaction:request', detail: 'the same decision against the same compiled policy, and commits nothing' },
  { method: 'GET', path: '/v1/transactions/:id', who: 'agent credential', scope: 'none named', detail: "another tenant's id and no id at all answer the same 404" },
  { method: 'GET', path: '/v1/approvals', who: 'user credential', scope: 'approval:decide', detail: 'what is waiting on the person presenting the secret' },
  { method: 'GET', path: '/v1/approvals/:id', who: 'user credential', scope: 'approval:decide', detail: 'an over-long id is a framework 404, so the route’s own 200-character ceiling binds only between about 100 and 200' },
  { method: 'GET', path: '/v1/transactions', who: 'user credential', scope: 'transaction:read', detail: 'newest first, limit capped at 200, optional agent filter; money in decimal strings and no ticket anywhere' },
  { method: 'GET', path: '/v1/transactions/:id/record', who: 'user credential', scope: 'transaction:read', detail: 'the row, its canonical bytes, the governing evaluation and its own slice of the chain' },
  { method: 'GET', path: '/v1/summary', who: 'user credential', scope: 'transaction:read', detail: 'the open daily and monthly windows keyed off the database clock, plus counts by state' },
  { method: 'GET', path: '/v1/wallets', who: 'user credential', scope: 'wallet:manage', detail: 'each wallet’s mode, provider, address and grants, revoked ones included rather than hidden' },
  { method: 'GET', path: '/v1/policies', who: 'user credential', scope: 'policy:read', detail: 'policies with every frozen version document, which is what a widening is compared against' },
  { method: 'POST', path: '/v1/approvals/:id/decisions', who: 'user credential', scope: 'approval:decide', detail: 'decision must be APPROVED or REJECTED; a refused vote answers 409' },
  { method: 'POST', path: '/v1/users', who: 'bootstrap token', scope: 'not a tenant scope', detail: 'role is one of owner, admin, approver, viewer' },
  { method: 'POST', path: '/v1/users/:userId/credentials', who: 'bootstrap token', scope: 'not a tenant scope', detail: 'scopes 1 to 8, ttlMs a decimal string between one minute and thirty days' },
  { method: 'POST', path: '/v1/agents', who: 'user credential', scope: 'agent:manage', detail: 'name, at most 120 characters' },
  { method: 'GET', path: '/v1/agents', who: 'user credential', scope: 'agent:manage', detail: 'id, name and status for this organisation only' },
  { method: 'POST', path: '/v1/agents/:agentId/revoke', who: 'user credential', scope: 'agent:manage', detail: 'terminal; revokes the credentials in the same transaction' },
  { method: 'POST', path: '/v1/agents/:agentId/credentials', who: 'user credential', scope: 'agent:manage', detail: 'approval:decide is refused here in words and by a CHECK in 013' },
  { method: 'POST', path: '/v1/wallets', who: 'user credential', scope: 'wallet:manage', detail: 'displayName, mode, signatureTriple, provider, optional address' },
  { method: 'POST', path: '/v1/agents/:agentId/wallets/:walletId', who: 'user credential', scope: 'wallet:manage', detail: 'binds one agent to one wallet under one policy version' },
  { method: 'POST', path: '/v1/policies', who: 'user credential', scope: 'policy:activate', detail: 'activate true runs the compiler and the broadening check' },
  { method: 'GET', path: '/v1/audit/events', who: 'user credential', scope: 'audit:read', detail: 'the unpaged answer carries head; a paged one names only where to resume' },
]

const MISSING: readonly { readonly label: string; readonly body: string }[] = [
  { label: 'WEBHOOKS', body: 'No route in the API registers one and no package delivers one. docs/ASSUMPTIONS.md names a webhook as one way a caller learns that a decision finished; the rows below are what a screen for it would look like, not a surface you can call.' },
  { label: 'ENVIRONMENTS', body: 'No route takes an environment, and no table has an environment column. The only separation Ari enforces is the organisation, so a staging secret and a production secret are kept apart by the tenant row each was minted into, not by a label on a screen.' },
  { label: 'SIGNING IN', body: 'There is no session and no login. Every human call presents a bearer secret. The source of these routes says the missing piece plainly: a dashboard that mints credentials for a signed-in person is a later phase, and an auth scheme invented to fill out a route table would be a security decision taken as a side effect.' },
  { label: 'READING BACK', body: 'GET exists for agents, approvals, one transaction and the audit trail. Nothing reads a wallet, a policy, a user or a credential list back.' },
  { label: 'PAUSE AND RESUME', body: 'setAgentStatus in packages/identity moves an agent between ACTIVE, PAUSED and REVOKED. Only the revoke arm has a route.' },
  { label: 'ONE CREDENTIAL', body: 'Nothing revokes or rotates a single credential over HTTP. issueCredential accepts a rotationOf value and writes a credential.rotated event, and no route passes it.' },
  { label: 'TWO SCOPES', body: 'transaction:read and policy:read are in the scope vocabulary and in a database CHECK. No route asks for either one, so today a credential holding them is granted nothing.' },
]

const SAMPLE_ALLOW = `POST /v1/transactions/evaluate
Authorization: Bearer org_<uuidv7>.crd_<uuidv7>.<43-character secret>

{
  "state": "DECIDED",
  "reserves": false,
  "decision": {
    "outcome": "ALLOW",
    "reasonCodes": [],
    "policyVersionId": "ppv_<uuidv7>",
    "matchedRules": [
      "validity.window",
      "permissions.transfers.recipients",
      "permissions.transfers.limits",
      "decision"
    ]
  }
}`

const SAMPLE_APPROVAL = `agent   POST /v1/transactions/authorize

{ "state": "APPROVAL_PENDING",
  "requestId": "txr_<uuidv7>",
  "approvalId": "apr_<uuidv7>",
  "expiresAt": "2026-09-27T16:40:00.000Z" }

human   POST /v1/approvals/apr_<uuidv7>/decisions
        Authorization: Bearer org_<uuidv7>.ucrd_<uuidv7>.<secret>

{ "decision": "APPROVED" }

{ "state": "GRANTED",
  "votes": 1,
  "approvalToken": "<sealed from the row, printed once>" }

agent   POST /v1/transactions/authorize   same candidate, same idempotencyKey,
                                          plus "approvalToken": "<the seal>"`

const SAMPLE_DENY = `POST /v1/transactions/authorize

{ "state": "DENIED",
  "requestId": "txr_<uuidv7>",
  "reasonCodes": ["AMOUNT_EXCEEDS_PER_TRANSACTION"] }

POST /v1/transactions/authorize   (no grant for this agent and wallet)

{ "state": "REFUSED",
  "requestId": "txr_<uuidv7>",
  "reason": "no unrevoked grant for this agent and wallet" }`

export default function Developers() {
  const { view } = useConsole()
  if (view.source === 'live') {
    return <UnwiredScreen screen='developer surface' need='the route table is documentation, but the sample keys and SDK snippets on this page are fixture values and would read as credentials under a live connection' />
  }
  const [notice, setNotice] = useState<string | null>(null)

  const credentialColumns: readonly Column<Credential>[] = [
    {
      key: 'prefix',
      header: 'PREFIX',
      cell: (key) => (
        <>
          <span className="num">{key.prefix}</span>
          <span className="sub">{key.name}</span>
        </>
      ),
    },
    {
      key: 'scopes',
      header: 'SCOPES',
      cell: (key) => (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {key.scopes.map((scope) => (
            <Tag key={scope}>{scope}</Tag>
          ))}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'CREATED',
      cell: (key) => <time dateTime={key.created}>{relativeTime(key.created)}</time>,
    },
    {
      key: 'lastUsed',
      header: 'LAST USED',
      hideBelow: 'sm',
      cell: (key) => <time dateTime={key.lastUsed ?? undefined}>{relativeTime(key.lastUsed)}</time>,
    },
    {
      key: 'expires',
      header: 'EXPIRES',
      hideBelow: 'md',
      cell: (key) => (key.expires === null ? <span className="muted">no expiry recorded</span> : <time dateTime={key.expires}>{relativeTime(key.expires)}</time>),
    },
    { key: 'status', header: 'STATUS', cell: (key) => <State value={key.status} /> },
  ]

  const webhookColumns: readonly Column<Webhook>[] = [
    {
      key: 'url',
      header: 'DELIVERS TO',
      cell: (hook) => (
        <>
          <span style={{ wordBreak: 'break-all' }}>{hook.url}</span>
          <span className="sub">{hook.id}</span>
        </>
      ),
    },
    {
      key: 'events',
      header: 'EVENTS',
      hideBelow: 'md',
      cell: (hook) => (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {hook.events.map((name) => (
            <Tag key={name}>{name}</Tag>
          ))}
        </span>
      ),
    },
    { key: 'status', header: 'STATUS', cell: (hook) => <State value={hook.status} /> },
    {
      key: 'last',
      header: 'LAST DELIVERY',
      hideBelow: 'sm',
      cell: (hook) => <time dateTime={hook.lastDelivery}>{relativeTime(hook.lastDelivery)}</time>,
    },
    { key: 'failures', header: 'FAILURES', align: 'right', cell: (hook) => <span className="num">{hook.failures}</span> },
  ]

  const environmentColumns: readonly Column<Environment>[] = [
    {
      key: 'label',
      header: 'ENVIRONMENT',
      cell: (env) => (
        <>
          {env.label}
          <span className="sub" style={{ wordBreak: 'break-all' }}>
            {env.base}
          </span>
        </>
      ),
    },
    { key: 'status', header: 'STATUS', cell: (env) => <State value={env.status} /> },
    { key: 'agents', header: 'AGENTS', align: 'right', cell: (env) => <span className="num">{env.agents}</span> },
    { key: 'wallets', header: 'WALLETS', align: 'right', cell: (env) => <span className="num">{env.wallets}</span> },
  ]

  return (
    <div className="console-body">
      <Reveal>
        <h1>
          THE SURFACE,
          <br />
          WITH ITS HOLES.
        </h1>
        <p className="lede">
          Three callers, none of them interchangeable: an agent proposes a payment, a human decides
          an approval, and the deployment&apos;s bootstrap token creates tenants and hands out the first
          approver credentials. Everything below is what those callers can actually do today.
        </p>
      </Reveal>

      <div style={{ height: 38 }} />

      <MetricBand
        items={[
          { label: 'ROUTES IN THE API', value: ROUTES.length, note: 'every handler registered in apps/api/src/routes.ts' },
          { label: 'CREDENTIALS HERE', value: sampleData.apiKeys.length, note: "rows in this tenant's sample fixture" },
          { label: 'MARKED ACTIVE', value: sampleData.apiKeys.filter((key) => key.status === 'ACTIVE').length, note: 'a status label, not a live check' },
          {
            label: 'WEBHOOK TARGETS FAILING',
            value: sampleData.webhooks.filter((hook) => hook.failures > 0).length,
            tone: 'stop',
            note: 'counted from rows a delivery process has not written',
          },
        ]}
      />

      <div className="split">
        <div>
          <Panel title="ALLOW" note="POST /v1/transactions/evaluate">
            <p style={BODY}>
              The preview answer, because it is the only one that shows the reasoning. The{' '}
              <MONO>matchedRules</MONO> are the engine&apos;s own paths, and which ones appear depends on the
              checks the candidate reached.
            </p>
            <pre style={PRE}>{SAMPLE_ALLOW}</pre>
            <p style={{ ...BODY, borderTop: 0 }}>
              <MONO>POST /v1/transactions/authorize</MONO> is the same evaluation with consequences: the ticket
              it mints goes to the signer and nowhere else, and the answer you get back is the
              signer&apos;s own state for that ticket. If the signer does not take it, the answer says{' '}
              <MONO>TICKET_ISSUED_NOT_DELIVERED</MONO> with the signer&apos;s code, because a minted-but-undelivered
              ticket is a state an operator has to be able to see. Nothing in any of these bodies is a
              ticket, a digest or a signature.
            </p>
          </Panel>

          <Panel title="REQUIRE_HUMAN_APPROVAL" note="AGENT ASKS, HUMAN DECIDES">
            <p style={BODY}>
              The agent&apos;s half ends with an id and a deadline. Only a person with a{' '}
              <MONO>ucrd_</MONO> credential can move it, and the seal that lets the payment finish is printed
              to that person, never to the agent that asked.
            </p>
            <pre style={PRE}>{SAMPLE_APPROVAL}</pre>
            <p style={PROSE}>
              A <MONO>crd_</MONO> secret at the approvals route does not parse, and a <MONO>ucrd_</MONO> secret at{' '}
              <MONO>/v1/transactions/authorize</MONO> does not parse either. That is not a convention in a
              handler: a human credential carrying <MONO>transaction:request</MONO> and an agent credential
              carrying <MONO>approval:decide</MONO> are both refused by CHECK constraints in{' '}
              <MONO>migrations/013</MONO>, so the subject that proposes and the subject that approves are
              different in the row.
            </p>
          </Panel>

          <Panel title="DENY" note="THE ANSWER IS THE RECORD">
            <p style={BODY}>
              A refusal names its reason from the engine&apos;s <MONO>ReasonCode</MONO> vocabulary, spelled
              exactly as the schema emits it. A second refusal shape exists for a request the kernel
              would not put to a policy at all, and it carries one sentence instead of reason codes.
            </p>
            <pre style={PRE}>{SAMPLE_DENY}</pre>
            <p style={PROSE}>
              Both are appended to the audit chain inside the transaction that decided them, before the
              answer is returned. A caller that was refused and a log that says nothing happened is the
              failure mode this ordering exists to prevent.
            </p>
          </Panel>

          <Panel title="WHAT A SECRET IS" note="AND WHAT IT CANNOT BECOME">
            <p style={BODY}>
              The bearer an agent presents is three dot-separated parts:{' '}
              <MONO>org_&lt;uuidv7&gt;.crd_&lt;uuidv7&gt;.&lt;secret&gt;</MONO>. The organisation segment says which bucket to
              look in and authorises nothing; the secret is 32 random bytes as base64url, 43 characters.
            </p>
            <p style={PROSE}>
              It is printed once, in the answer from <MONO>POST /v1/agents/:agentId/credentials</MONO> or its
              human equivalent, and it is never readable back, because the row holds{' '}
              <MONO>secret_hash</MONO>: an Argon2id digest over a pepper joined to the secret, where the pepper is
              HMAC-SHA256 of the organisation id under a master secret held in configuration and in no
              table. Someone who copies the credential table therefore cannot test it against a leaked
              password list offline.
            </p>
            <p style={PROSE}>
              Every way a credential can fail at a gate answers the same way: 401,{' '}
              <MONO>{'{"code":"UNAUTHENTICATED","detail":"the credential was not accepted"}'}</MONO>. Unknown key,
              wrong secret, expired, revoked, agent paused, wrong organisation, and a <MONO>crd_</MONO> secret at
              a human route all look identical from outside, which is the difference between an endpoint
              that can be used to enumerate tenants and one that cannot.
            </p>
          </Panel>
        </div>

        <div>
          <Panel title="WHAT IS NOT HERE YET" note={`${MISSING.length} GAPS`} pad>
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--muted)' }}>
              A list of what has no route, in preference to a list of endpoints that would round the
              table out nicely.
            </p>
            <div className="stack-list" style={{ marginTop: 18 }}>
              {MISSING.map((item) => (
                <div key={item.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8, padding: '16px 0' }}>
                  <Tag>{item.label}</Tag>
                  <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--muted)' }}>{item.body}</p>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>

      <Panel title="ROUTES" note={`${ROUTES.length} HANDLERS IN apps/api/src/routes.ts`}>
        <DataTable
          rows={ROUTES}
          rowKey={(route) => `${route.method} ${route.path}`}
          columns={[
            { key: 'method', header: 'METHOD', cell: (route) => <span className="num">{route.method}</span> },
            {
              key: 'path',
              header: 'PATH',
              cell: (route) => (
                <>
                  <span style={{ wordBreak: 'break-all' }}>{route.path}</span>
                  <span className="sub">{route.detail}</span>
                </>
              ),
            },
            { key: 'who', header: 'WHO CALLS IT', hideBelow: 'md', cell: (route) => <span className="muted">{route.who}</span> },
            {
              key: 'scope',
              header: 'SCOPE IT ASKS FOR',
              cell: (route) => (route.scope === 'none' || route.scope === 'none named' ? <span className="muted">{route.scope}</span> : <Tag>{route.scope}</Tag>),
            },
          ]}
        />
        <p style={PROSE}>
          The scope is read from the source rather than inferred: <MONO>asUser(&apos;approval:decide&apos;)</MONO> and its
          siblings name one scope per route, and a credential missing it is refused before the query
          runs. The agent routes above that say <MONO>transaction:request</MONO> are refused{' '}
          <MONO>inside</MONO> the decision, with that reason code, because the scope is re-read from the row
          inside the tenant transaction rather than carried in from authentication.
        </p>
      </Panel>

      <Panel title="CREDENTIALS" note={`${sampleData.apiKeys.length} ROWS FOR THE SAMPLE TENANT`}>
        <DataTable rows={sampleData.apiKeys} columns={credentialColumns} rowKey={(key) => key.id} />
        <p style={PROSE}>
          These rows disagree with each other once, and the screen shows both halves of it. Rows
          marked <MONO>EXPIRED</MONO> whose <MONO>expires</MONO> timestamp has not passed:{' '}
          {sampleData.apiKeys.filter((key) => key.status === 'EXPIRED' && key.expires !== null && Date.parse(key.expires) > Date.now()).length}.
          Nothing here derives a status from a date; the fixture typed both fields by hand, so a table
          that reads as a policy decision is really two unrelated strings that happen to sit in one row.
        </p>
        <p style={{ ...PROSE, marginTop: 10 }}>
          The prefix column is the public half of the pair and nothing more. Agent prefixes here:{' '}
          {sampleData.apiKeys.filter((key) => key.prefix.startsWith('crd_')).length} of{' '}
          {sampleData.apiKeys.length}; <MONO>ucrd_</MONO> rows:{' '}
          {sampleData.apiKeys.filter((key) => key.prefix.startsWith('ucrd_')).length}. So this fixture has
          no human credential row at all, which means the one caller that can decide an approval is the
          caller with nothing listed under it. No row on this screen carries a secret value, because no
          system in this build could show one back.
        </p>
      </Panel>

      <Panel title="IF A KEY LEAKS" note="NO AUTHORITY HERE" pad>
        <p style={{ ...BODY, padding: 0 }}>
          The honest answer to a rotation request from a screen with nothing behind it.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 18 }}>
          <ActionButton variant="danger" onClick={() => setNotice('Nothing is connected to this screen, and no key was rotated. The approval key is the deployment\'s own secret, read as pipeline.approvalKey in apps/api/src/routes.ts and used by sealGrantedApproval when a quorum is reached; it is configuration rather than a tenant row, and no route rotates it. Rotating a credential would be a new row with rotation_of set, which issueCredential in packages/identity/src/credentials.ts supports and no route calls.')}>
            ROTATE APPROVAL KEY
          </ActionButton>
        </div>
        {notice !== null && <div style={{ marginTop: 20 }}><Notice text={notice} /></div>}
      </Panel>

      <Panel title="WEBHOOKS" note="FIXTURE ROWS, NO DELIVERY CODE">
        <DataTable rows={sampleData.webhooks} columns={webhookColumns} rowKey={(hook) => hook.id} />
        <p style={PROSE}>
          {sampleData.webhooks.length} rows, {sampleData.webhooks.filter((hook) => hook.status === 'RETRYING').length} of them
          retrying, {sampleData.webhooks.reduce((total, hook) => total + hook.failures, 0)} failures counted across all of
          them, and {sampleData.webhooks.reduce((total, hook) => total + hook.events.length, 0)} event names subscribed
          between them. None of it was written by anything: no route registers a webhook, no package
          sends one, and nothing retries, so the URLs, event names, delivery times and failure counts are
          the shape of a screen rather than a surface you can call.
        </p>
      </Panel>

      <Panel title="ENVIRONMENTS" note={`${sampleData.environments.length} LABELS`}>
        <DataTable rows={sampleData.environments} columns={environmentColumns} rowKey={(env) => env.key} />
        <p style={PROSE}>
          The production row&apos;s counts are the same numbers the rest of this console renders from its own
          rows: {sampleData.agents.length} agents and {sampleData.wallets.length} wallets. The staging and sandbox rows have no
          agents, wallets, requests, credentials or audit events behind them anywhere in this fixture,
          and there is no environment column in the database for them to live in. Treat all three as
          one tenant wearing three labels.
        </p>
      </Panel>
    </div>
  )
}
