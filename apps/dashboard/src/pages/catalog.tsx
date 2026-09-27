import { ArrowRight, CaretRight, CheckCircle, Scroll, XCircle } from '@phosphor-icons/react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  DataTable,
  EmptyState,
  FilterBar,
  Input,
  MetricBand,
  Modal,
  PageHead,
  Select,
  StateCell,
  Surface,
  Tabs,
  Tag,
  toast,
  toneFor,
  type Column,
} from '../components/ui';
import { AgentIdentity, Amount, DecisionMark, PolicyRules, VersionStrip } from '../components/product';
import { sampleData } from '../api/client';
import { deriveAgentState, RISK_ORDER, type PolicyVersion, type RiskLevel } from '../domain/types';
import { cx, money, relativeTime, shortHash, sentenceFromCode } from '../lib/util';
import { Link, useRouter } from '../app/router';

/* ==========================================================================
   The agent rows both the list and the detail page read

   One derivation, used by the metric band, the table and the detail page, so a
   number on top of the screen is the same number the rows below it add up to.
   `AWAITING_APPROVAL` and `ANOMALOUS` come from `deriveAgentState`: they are this
   surface's reading of live rows, never a status the engine stores.
   ========================================================================== */

function agentRows() {
  return sampleData.agents.map((agent) => {
    const usage = sampleData.usageFor(agent.name);
    const txs = sampleData.transactions.filter((t) => t.agentId === agent.id);
    const pending = txs.filter((t) => t.outcome === 'REQUIRE_HUMAN_APPROVAL').length;
    const highest = txs.reduce<RiskLevel | null>((acc, t) => {
      const level = t.risk?.level ?? null;
      if (level === null) return acc;
      return acc === null || RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(acc) ? level : acc;
    }, null);
    const policy = sampleData.policies.find((p) => p.key === agent.policy);
    const active = policy === undefined ? undefined : sampleData.activeVersion(policy.key);
    const limit = active === undefined ? 0n : BigInt(active.document.permissions.transfers.perDay.maxRaw);
    return {
      agent,
      state: deriveAgentState(agent.status, pending, highest),
      pending,
      highest,
      policyName: policy?.name ?? agent.policy,
      policyNumber: active?.number ?? 0,
      walletName: sampleData.walletById(sampleData.wallets[agent.wallet]?.id ?? '')?.name ?? 'not set',
      usageRaw: usage.settledRaw,
      limitRaw: limit,
      lastAt: usage.lastAt ?? new Date(Date.now() - agent.lastActivity).toISOString(),
      count: txs.length,
    };
  });
}

/** How many rows carry this derived reading. */
const countBy = (rows: readonly { state: string }[], state: string): number => rows.filter((r) => r.state === state).length;

/** How many rows carry this engine status. Kept apart from `countBy`: `ANOMALOUS` and
   `AWAITING_APPROVAL` are readings of live rows, `ACTIVE`/`PAUSED`/`REVOKED` are what Ari stores,
   and a headline number has to say which of the two it is. */
const countByStatus = (rows: readonly { agent: { status: string } }[], status: string): number =>
  rows.filter((r) => r.agent.status === status).length;

/* ==========================================================================
   Agents
   ========================================================================== */

export function Agents() {
  const { navigate } = useRouter();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const rows = useMemo(() => agentRows(), []);
  // A row matches a status under either reading of it: the derived one the State column shows,
  // or the one Ari stores. That is what makes each number in the band above equal the rows the
  // same option returns.
  const matchesStatus = (row: (typeof rows)[number]): boolean =>
    status === 'ALL' || row.state === status || row.agent.status === status;
  const filtered = rows.filter(
    (row) =>
      matchesStatus(row) &&
      (query.trim().length === 0 || `${row.agent.name} ${row.agent.purpose}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const heldRequests = rows.reduce((total, row) => (row.state === 'AWAITING_APPROVAL' ? total + row.pending : total), 0);

  const columns: readonly Column<(typeof rows)[number]>[] = [
    {
      key: 'agent',
      header: 'Agent',
      width: '32%',
      cell: (row) => (
        <div className="min-w-0">
          <AgentIdentity name={row.agent.name} />
          <div className="mt-0.5 truncate text-[11px] text-ink-4">{row.agent.purpose}</div>
        </div>
      ),
      sortValue: (row) => row.agent.name,
    },
    { key: 'state', header: 'State', width: '12rem', cell: (row) => <StateCell value={row.state} />, sortValue: (row) => row.state },
    {
      key: 'policy',
      header: 'Policy',
      width: '9rem',
      hideBelow: 'md',
      cell: (row) => (
        <span className="block truncate font-mono text-xs text-ink-2" title={`${row.policyName} v${row.policyNumber}`}>
          {row.policyName} v{row.policyNumber}
        </span>
      ),
    },
    { key: 'wallet', header: 'Wallet', width: '8rem', hideBelow: 'lg', cell: (row) => <span className="block truncate font-mono text-xs text-ink-2">{row.walletName}</span> },
    {
      key: 'usage',
      header: 'Today / ceiling',
      width: '8.5rem',
      align: 'right',
      cell: (row) => (
        <span className="font-mono text-xs text-ink">
          {money(row.usageRaw.toString(), 'usdc-6dp', true)}
          <span className="text-ink-4"> / {money(row.limitRaw.toString(), 'usdc-6dp', true)}</span>
        </span>
      ),
      sortValue: (row) => Number(row.usageRaw),
    },
    {
      key: 'risk',
      header: 'Risk',
      hideBelow: 'md',
      cell: (row) =>
        row.highest === null ? (
          <span className="text-[11px] text-ink-4">not assessed</span>
        ) : (
          <Tag tone={toneFor(row.highest)} mono>
            {row.highest}
          </Tag>
        ),
    },
    {
      key: 'last',
      header: 'Last activity',
      align: 'right',
      hideBelow: 'sm',
      cell: (row) => <span className="font-mono text-[11px] text-ink-3">{relativeTime(row.lastAt)}</span>,
      sortValue: (row) => row.lastAt,
    },
  ];

  return (
    <>
      <PageHead
        title="Agents"
        lead="An agent is a subject, not a session. It can propose a payment and it cannot approve one: those are different rows, different credential prefixes, and a CHECK in the schema that refuses the overlap."
        actions={
          <Button
            variant="primary"
            onClick={() => toast('wait', 'Agents are created by an operator credential (`agent:manage`), never from a browser session.')}
          >
            Create agent
          </Button>
        }
        meta={
          <>
            <span>
              {rows.length} agents in {sampleData.organization.name}
            </span>
            <span>
              {sampleData.policies.length} policies · {sampleData.wallets.length} wallets
            </span>
            <span>State in the table is this surface's reading: AWAITING_APPROVAL and ANOMALOUS are derived from live rows, never stored by Ari.</span>
            <span>No live Ari deployment is connected to this screen.</span>
          </>
        }
      />

      <div className="mb-3">
        <MetricBand
          items={[
            {
              label: 'Agents active',
              value: countByStatus(rows, 'ACTIVE'),
              tone: 'ok',
              hint: 'status ACTIVE at the engine, and none of them holds an approval right',
            },
            {
              label: 'Awaiting a human',
              value: countBy(rows, 'AWAITING_APPROVAL'),
              tone: 'wait',
              hint: `${heldRequests} request(s) waiting in an approval queue`,
            },
            {
              label: 'Paused',
              value: countByStatus(rows, 'PAUSED'),
              tone: 'wait',
              hint: 'PAUSED refuses new requests, outstanding tickets still redeem to their TTL',
            },
            {
              label: 'Revoked',
              value: countByStatus(rows, 'REVOKED'),
              tone: 'neutral',
              hint: 'terminal, every credential stopped working with the agent',
            },
          ]}
        />
      </div>

      <FilterBar>
        <Input className="max-w-xs" placeholder="Filter agents…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by state">
          {['ALL', 'ACTIVE', 'PAUSED', 'REVOKED', 'AWAITING_APPROVAL', 'ANOMALOUS'].map((option) => (
            <option key={option} value={option}>
              {option === 'ALL' ? 'Any state' : option}
            </option>
          ))}
        </Select>
        <span className="font-mono text-[11px] text-ink-4">
          {filtered.length} of {rows.length} shown
        </span>
      </FilterBar>

      <Surface title="All agents" action={<span className="text-[11px] text-ink-4">click a row for its control page</span>} bodyClassName="p-0">
        <DataTable
          rows={filtered}
          columns={columns}
          rowKey={(row) => row.agent.id}
          onRowClick={(row) => navigate(`/app/agents/${row.agent.name}`)}
          empty={
            <EmptyState
              title="No agents match this view"
              body="Clear the filter, or switch tenant. An agent that is revoked still appears here: revocation is a status, not a deletion, and the audit trail has to stay readable."
              action={<Button variant="primary" onClick={() => toast('wait', 'Use an operator credential: `ari agent create --name …`.')}>Create agent</Button>}
            />
          }
        />
      </Surface>
    </>
  );
}

/* ==========================================================================
   Agent detail
   ========================================================================== */

export function AgentDetail({ name }: { readonly name: string }) {
  const { navigate } = useRouter();
  const [tab, setTab] = useState('overview');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const row = agentRows().find((r) => r.agent.name === name);

  if (row === undefined) {
    return (
      <Surface className="mt-10" bodyClassName="p-0">
        <EmptyState
          title={`No agent named ${name}`}
          body="Agent names are unique inside an organisation. Check the spelling, or create it."
          action={
            <Link to="/app/agents">
              <Button>Back to agents</Button>
            </Link>
          }
        />
      </Surface>
    );
  }

  const { agent } = row;
  const txs = sampleData.transactions.filter((t) => t.agentId === agent.id);
  const assessed = txs.filter((t) => t.risk !== null);
  const credentials = sampleData.apiKeys.filter((k) => k.name.startsWith(agent.name));
  const policy = sampleData.policies.find((p) => p.key === agent.policy);
  const active = policy === undefined ? undefined : sampleData.activeVersion(policy.key);

  return (
    <>
      <nav className="mb-2 flex items-center gap-1.5 text-[11px] text-ink-4" aria-label="Breadcrumb">
        <Link to="/app/agents" className="transition-colors hover:text-ink-2">
          Agents
        </Link>
        <CaretRight size={10} weight="bold" />
        <span className="font-mono text-ink-3">{agent.name}</span>
      </nav>

      <PageHead
        title={agent.name}
        lead={agent.purpose}
        actions={
          <>
            <Button
              onClick={() =>
                toast('wait', 'Pausing stops new requests; outstanding tickets still redeem until their TTL. That is by design: a ticket is a capability already granted.')
              }
            >
              Pause agent
            </Button>
            <Button variant="danger" onClick={() => setConfirmRevoke(true)}>
              Revoke agent
            </Button>
          </>
        }
        meta={
          <>
            <StateCell value={row.state} />
            <span className="font-mono">{agent.id}</span>
            <span>owner {agent.owner}</span>
            <span>created {relativeTime(new Date(Date.now() - agent.created).toISOString())}</span>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'permissions', label: 'Permissions' },
              { id: 'policies', label: 'Policies' },
              { id: 'activity', label: 'Activity', count: txs.length },
              { id: 'risk', label: 'Risk' },
              { id: 'credentials', label: 'Credentials' },
              { id: 'audit', label: 'Audit' },
            ]}
          />

          {tab === 'overview' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Surface title="What it may do">
                <ul className="space-y-2 text-xs">
                  <Yes no={false}>Propose a payment inside its policy</Yes>
                  <Yes no={false}>Read its own request status</Yes>
                  <Yes no>Approve any payment, including its own</Yes>
                  <Yes no>Change its policy, limits or approvers</Yes>
                  <Yes no>Hold a signing key or call a signer</Yes>
                  <Yes no>Withdraw to an address not on the allowlist</Yes>
                </ul>
              </Surface>
              <Surface title="Envelope in numbers">
                <dl className="space-y-2 text-xs">
                  <KV k="per transaction" v={money(active?.document.permissions.transfers.perTransaction.maxRaw ?? '0', 'usdc-6dp')} />
                  <KV k="per day" v={`${money(row.usageRaw.toString(), 'usdc-6dp')} of ${money(row.limitRaw.toString(), 'usdc-6dp')}`} />
                  <KV
                    k="per month"
                    v={active?.document.permissions.transfers.perMonth === null ? 'no monthly window' : money(active?.document.permissions.transfers.perMonth?.maxRaw ?? '0', 'usdc-6dp')}
                  />
                  <KV k="hourly rate" v={`${active?.document.permissions.transfers.maxTransactionsPerHour ?? 0} requests`} />
                  <KV k="recipients" v={`${active?.document.permissions.transfers.recipients.addresses.length ?? 0} allowlisted`} />
                  <KV k="escalation" v={active?.document.escalation.humanApproval.requiredWhen.map((c) => sentenceFromCode(c.op)).join(' · ') ?? 'never'} />
                </dl>
              </Surface>
            </div>
          )}

          {tab === 'permissions' && active !== undefined && <PolicyRules document={active.document} />}

          {tab === 'policies' && (
            <Surface
              title="Governing policy"
              action={
                <Link to={`/app/policies/${policy?.key ?? ''}`} className="text-[11px] text-accent transition-colors hover:text-accent-strong">
                  open policy
                </Link>
              }
            >
              <VersionStrip versions={policy?.versions ?? []} />
              <p className="mt-3 border-t border-line pt-2.5 text-xs leading-relaxed text-ink-3">
                The grant binds this agent to <span className="font-mono text-ink-2">one version</span>, not to “the current policy”. When a new
                version is activated, an existing grant keeps pointing at the version it was issued under until an operator with
                <span className="font-mono text-ink-2"> wallet:manage</span> re-points it, which is why a policy change is visible here.
              </p>
            </Surface>
          )}

          {tab === 'activity' && (
            <Surface title="Requests this agent proposed" action={<span className="font-mono text-[11px] text-ink-4">{txs.length} total</span>} bodyClassName="p-0">
              <DataTable
                rows={txs}
                rowKey={(tx) => tx.id}
                onRowClick={(tx) => navigate(`/app/transactions/${tx.id}`)}
                empty={<EmptyState title="No requests yet" body="Nothing has been proposed under this agent’s id, so there is no trace to show." />}
                columns={[
                  { key: 'intent', header: 'Intent', cell: (tx) => <span className="text-[13px] text-ink">{tx.intent}</span> },
                  { key: 'amount', header: 'Amount', align: 'right', cell: (tx) => <Amount raw={tx.amountRaw} unit={tx.unit} /> },
                  { key: 'decision', header: 'Decision', cell: (tx) => <DecisionMark outcome={tx.outcome} codes={tx.codes} /> },
                  { key: 'when', header: 'When', align: 'right', cell: (tx) => <span className="font-mono text-[11px] text-ink-3">{relativeTime(tx.submittedAt)}</span> },
                ]}
              />
            </Surface>
          )}

          {tab === 'risk' && (
            <Surface title="Recent assessments" bodyClassName="p-0">
              {assessed.length === 0 ? (
                <p className="px-3 py-3 text-xs leading-relaxed text-ink-3">
                  No assessment has run for this agent yet. A tenant with no history scores MEDIUM by design: the first payment an agent makes is
                  “unknown”, not “clean”.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {assessed.map((tx) => (
                    <li key={tx.id} className="px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-xs text-ink">{tx.intent}</span>
                        <Tag tone={toneFor(tx.risk?.level ?? 'NONE')} mono>
                          {tx.risk?.level}
                        </Tag>
                      </div>
                      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2 text-[11px] text-ink-4">
                        <span className="font-mono">
                          {(tx.risk?.signals.length ?? 0) === 0 ? 'no signals' : (tx.risk?.signals ?? []).map((signal) => sentenceFromCode(signal)).join(' · ')}
                        </span>
                        <span className="font-mono">score {(tx.risk?.score ?? 0).toFixed(2)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Surface>
          )}

          {tab === 'credentials' && (
            <Surface
              title="Bearer credentials"
              bodyClassName="p-0"
              action={
                <Button
                  size="sm"
                  onClick={() =>
                    toast('wait', 'A credential is issued by `POST /v1/agents/:id/credentials` and printed once. It cannot be read back: the row holds an Argon2id digest over a pepper that is not in the database.')
                  }
                >
                  Issue credential
                </Button>
              }
              footer={
                <p className="text-[11px] leading-relaxed text-ink-3">
                  An agent secret (<span className="font-mono text-ink-2">crd_</span>) does not parse at a human route and a user secret (
                  <span className="font-mono text-ink-2">ucrd_</span>) does not parse at an agent route, so both refusals look exactly like a wrong
                  secret. Revoking the agent revokes every credential with it, in the same transaction.
                </p>
              }
            >
              <ul className="divide-y divide-line">
                {credentials.map((key) => (
                  <li key={key.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="font-mono text-ink-2">{key.prefix}…</span>
                    <span className="flex flex-wrap items-center justify-end gap-1.5">
                      {key.scopes.map((scope) => (
                        <Tag key={scope} tone="neutral" mono>
                          {scope}
                        </Tag>
                      ))}
                      <StateCell value={key.status} />
                    </span>
                  </li>
                ))}
                {credentials.length === 0 && <li className="px-3 py-3 text-xs text-ink-3">No credential is currently issued to this agent.</li>}
              </ul>
            </Surface>
          )}

          {tab === 'audit' && (
            <Surface title="Audit events naming this agent" bodyClassName="p-0">
              <DataTable
                rows={sampleData.auditEvents.filter((event) => event.actor === agent.id || txs.some((t) => t.id === event.resourceId)).slice(0, 14)}
                rowKey={(event) => event.id}
                empty={<EmptyState title="Nothing recorded" body="No audit event in this view names this agent or one of its requests." />}
                columns={[
                  { key: 'type', header: 'Event', cell: (event) => <span className="font-mono text-xs text-ink">{event.type}</span> },
                  { key: 'actor', header: 'Actor', cell: (event) => <Tag tone="neutral">{event.actorType}</Tag> },
                  { key: 'when', header: 'When', align: 'right', cell: (event) => <span className="font-mono text-[11px] text-ink-3">{relativeTime(event.at)}</span> },
                ]}
              />
            </Surface>
          )}
        </div>

        <div className="space-y-4">
          <Surface title="Identity">
            <dl className="space-y-2 text-xs">
              <KV k="status" v={<StateCell value={agent.status} />} />
              <KV k="wallet" v={<span className="font-mono">{row.walletName}</span>} />
              <KV k="policy" v={<span className="font-mono">{row.policyName} v{row.policyNumber}</span>} />
              <KV k="scopes" v={<span className="font-mono">{agent.scopes.join(', ')}</span>} />
              <KV k="requests" v={<span className="font-mono">{row.count} lifetime</span>} />
              <KV k="last seen" v={<span className="font-mono">{relativeTime(row.lastAt)}</span>} />
            </dl>
          </Surface>
          <Surface title="What revoking does">
            <p className="text-[11px] leading-relaxed text-ink-3">
              Terminal and absorbing: a revoked agent cannot change status again, and every credential it held stops working at the boundary on the
              next request. Outstanding tickets are not revoked: a capability already granted is honoured until its 60 second TTL, and pretending
              otherwise would be a lie about a signature.
            </p>
          </Surface>
        </div>
      </div>

      <Modal
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        title="Revoke this agent"
        subtitle="Terminal. There is no un-revoke; create a new agent instead."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRevoke(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmRevoke(false);
                toast('wait', 'No deployment is connected, so nothing was revoked. The real call is POST /v1/agents/:id/revoke.');
              }}
            >
              Revoke {agent.name}
            </Button>
          </>
        }
      >
        <ul className="space-y-2.5 text-xs">
          <li className="border-l-2 border-stop-line pl-2.5 text-ink">
            {credentials.length} credential(s) stop working immediately, and the agent’s status check refuses on the next request.
          </li>
          <li className="text-ink-3">{row.pending} request(s) currently awaiting approval will not be paid: the approval token is sealed against the agent row.</li>
          <li className="text-ink-3">
            The audit trail records <span className="font-mono text-ink-2">agent.revoked</span> with your user id as the actor, and the reason is
            yours to write.
          </li>
        </ul>
      </Modal>
    </>
  );
}

const Yes = ({ no, children }: { readonly no: boolean; readonly children: ReactNode }) => (
  <li className="flex items-start gap-2">
    {no ? (
      <XCircle size={14} weight="regular" className="mt-[3px] shrink-0 text-ink-4" />
    ) : (
      <CheckCircle size={14} weight="regular" className="mt-[3px] shrink-0 text-ok" />
    )}
    <span className={no ? 'text-ink-3' : 'text-ink'}>{children}</span>
  </li>
);

function KV({ k, v }: { readonly k: string; readonly v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="label shrink-0">{k}</dt>
      <dd className="min-w-0 text-right text-ink">{v}</dd>
    </div>
  );
}

/* ==========================================================================
   Policies
   ========================================================================== */

export function Policies() {
  const { navigate } = useRouter();
  const rows = sampleData.policies.map((policy) => {
    const active = sampleData.activeVersion(policy.key);
    const granted = sampleData.agents.filter((a) => a.policy === policy.key);
    const doc = active.document;
    return {
      policy,
      active,
      draft: policy.versions.find((v) => v.status === 'DRAFT'),
      agentCount: granted.length,
      walletName: sampleData.walletById(doc.target.walletId)?.name ?? 'not set',
      facts: [
        { k: 'per tx', v: money(doc.permissions.transfers.perTransaction.maxRaw, 'usdc-6dp', true) },
        { k: 'per day', v: money(doc.permissions.transfers.perDay.maxRaw, 'usdc-6dp', true) },
        { k: 'escalates', v: `${doc.escalation.humanApproval.requiredWhen.length} conditions` },
        { k: 'agents', v: `${granted.length}` },
      ],
    };
  });
  const waiting = rows.filter((row) => row.draft !== undefined).length;
  const grantedTotal = rows.reduce((total, row) => total + row.agentCount, 0);

  return (
    <>
      <PageHead
        title="Policies"
        lead="A policy is a compiled document bound to one wallet and one authority mode. Its content is frozen the moment it is published, and a version can never be walked back into a draft."
        actions={
          <Button
            variant="primary"
            onClick={() =>
              toast('wait', 'Draft a document and activate it with a `policy:activate` credential: `ari policy apply --file policy.json --activate`.')
            }
          >
            New policy
          </Button>
        }
        meta={
          <>
            <span>{rows.length} policy documents</span>
            <span>{waiting} with a draft waiting</span>
            <span>{grantedTotal} agent(s) granted under them</span>
          </>
        }
      />

      <Surface title="Policy documents" action={<span className="text-[11px] text-ink-4">click a row for the document</span>} bodyClassName="p-0">
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.policy.key}>
              <button
                onClick={() => navigate(`/app/policies/${row.policy.key}`)}
                className="flex w-full flex-wrap items-start justify-between gap-x-6 gap-y-3 px-3 py-3 text-left transition-colors hover:bg-raised"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Scroll size={15} weight="regular" className="shrink-0 text-ink-3" />
                    <span className="truncate text-[13px] font-medium text-ink">{row.policy.name}</span>
                    <Tag tone={toneFor(row.active.status)} mono>
                      v{row.active.number}
                    </Tag>
                    {row.draft !== undefined && <Tag tone="wait">draft v{row.draft.number} pending review</Tag>}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-ink-3">{row.active.summary}</span>
                  <span className="mt-1 block font-mono text-[11px] text-ink-4">
                    {row.walletName} · {row.active.document.target.authorityMode}
                  </span>
                </span>
                <span className="grid shrink-0 grid-cols-[5rem_auto] items-baseline gap-x-4 gap-y-1">
                  {row.facts.map((fact) => (
                    <span key={fact.k} className="contents">
                      <span className="label">{fact.k}</span>
                      <span className="text-right font-mono text-xs text-ink-2">{fact.v}</span>
                    </span>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Surface>
    </>
  );
}

export function PolicyDetail({ keyName }: { readonly keyName: string }) {
  const [versionId, setVersionId] = useState<string | null>(null);
  const policy = sampleData.policies.find((p) => p.key === keyName);
  if (policy === undefined) {
    return (
      <Surface className="mt-10" bodyClassName="p-0">
        <EmptyState
          title={`No policy named ${keyName}`}
          body="Policies are keyed by their organisation and name. The one that authorized a transaction is always named on that transaction."
          action={
            <Link to="/app/policies">
              <Button>Back to policies</Button>
            </Link>
          }
        />
      </Surface>
    );
  }
  const active = sampleData.activeVersion(policy.key);
  const selected: PolicyVersion = policy.versions.find((v) => v.id === versionId) ?? active;
  const draft = policy.versions.find((v) => v.status === 'DRAFT');
  const affected = sampleData.agents.filter((a) => a.policy === policy.key);

  return (
    <>
      <nav className="mb-2 flex items-center gap-1.5 text-[11px] text-ink-4" aria-label="Breadcrumb">
        <Link to="/app/policies" className="transition-colors hover:text-ink-2">
          Policies
        </Link>
        <CaretRight size={10} weight="bold" />
        <span className="font-mono text-ink-3">{policy.name}</span>
      </nav>

      <PageHead
        title={policy.name}
        lead={active.summary}
        actions={
          <>
            <Select value={selected.id} onChange={(event) => setVersionId(event.target.value)} aria-label="Version">
              {[...policy.versions].sort((a, b) => b.number - a.number).map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.number} · {v.status}
                </option>
              ))}
            </Select>
            <Button
              variant={selected.status === 'ACTIVE' ? 'default' : 'primary'}
              onClick={() =>
                toast('wait', `Activating v${selected.number} requires a credential holding policy:activate, and a written justification if it widens the previous version.`)
              }
            >
              {selected.status === 'ACTIVE' ? 'Currently active' : `Activate v${selected.number}`}
            </Button>
          </>
        }
        meta={
          <>
            <span>wallet {sampleData.walletById(active.document.target.walletId)?.name ?? 'not set'}</span>
            <span>{affected.length} agent(s) granted under it</span>
            <span className="font-mono">version {shortHash(selected.id, 8)}</span>
          </>
        }
      />

      {draft !== undefined && (
        <Surface
          className="mb-4 border-wait-line"
          title="A widening is waiting"
          action={
            <Tag tone="wait" mono>
              draft v{draft.number}
            </Tag>
          }
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <Diff k="per transaction" from={active.document.permissions.transfers.perTransaction.maxRaw} to={draft.document.permissions.transfers.perTransaction.maxRaw} />
            <Diff k="per day" from={active.document.permissions.transfers.perDay.maxRaw} to={draft.document.permissions.transfers.perDay.maxRaw} />
            <Diff
              k="escalation threshold"
              from={active.document.escalation.humanApproval.requiredWhen.find((c) => c.op === 'amount_gt')?.raw ?? '0'}
              to={draft.document.escalation.humanApproval.requiredWhen.find((c) => c.op === 'amount_gt')?.raw ?? '0'}
            />
          </div>
          <p className="mt-3 border-t border-line pt-2.5 text-[11px] leading-relaxed text-ink-3">
            Activating a broader version is refused unless the actor holds the owner role, and a rollback out of order requires a written
            justification. {affected.length} agent(s) currently granted under v{active.number} keep that version until an operator re-points the
            grant, so activating does not silently move anyone’s envelope.
          </p>
        </Surface>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <PolicyRules document={selected.document} />
        </div>
        <div className="space-y-4">
          <Surface title="Version history" action={<span className="text-[11px] text-ink-4">never hide which one authorized</span>}>
            <VersionStrip versions={policy.versions} />
          </Surface>
          <Surface title="Agents granted under this policy" bodyClassName="p-0">
            {affected.length === 0 ? (
              <p className="px-3 py-3 text-xs text-ink-3">None. A policy that governs nothing is a document, not a control.</p>
            ) : (
              <ul className="divide-y divide-line">
                {affected.map((agent) => (
                  <li key={agent.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                    <Link to={`/app/agents/${agent.name}`} className="truncate font-mono text-ink transition-colors hover:text-accent-strong">
                      {agent.name}
                    </Link>
                    <StateCell value={agent.status} />
                  </li>
                ))}
              </ul>
            )}
          </Surface>
          <Surface title="What the compiler refuses">
            <p className="text-[11px] leading-relaxed text-ink-3">
              Two limits that disagree about units, transfers enabled with no permitted chains, an allowlist entry that is not a valid address of
              either grammar, a contract call carrying native value, and a caller-supplied USD estimate when a
              <span className="font-mono text-ink-2"> usd_gte</span> rule exists to read it. All of them are parse errors at authoring time, not
              runtime surprises.
            </p>
          </Surface>
        </div>
      </div>
    </>
  );
}

function Diff({ k, from, to }: { readonly k: string; readonly from: string; readonly to: string }) {
  const bigger = BigInt(to) > BigInt(from);
  return (
    <div className="border-t border-line pt-2">
      <div className="label">{k}</div>
      <div className="mt-1.5 flex items-baseline gap-2 font-mono text-xs">
        <span className="text-ink-4 line-through">{money(from, 'usdc-6dp')}</span>
        <ArrowRight size={14} weight="regular" className="shrink-0 text-ink-4" />
        <span className={cx('font-medium', bigger ? 'text-wait' : 'text-ok')}>{money(to, 'usdc-6dp')}</span>
      </div>
      <div className="mt-1 text-[11px] text-ink-4">{bigger ? 'widening' : 'narrowing'}</div>
    </div>
  );
}
