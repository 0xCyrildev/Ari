import { useMemo, useState } from 'react';
import { Badge, Button, DataTable, EmptyState, FilterBar, Input, Modal, PageHeader, Panel, Select, Status, Tabs, toast, type Column } from '../components/ui';
import { AgentCard, Amount, DecisionMark, PolicyRules, VersionStrip } from '../components/product';
import { sampleData } from '../api/client';
import { deriveAgentState, type PolicyVersion, type RiskLevel } from '../domain/types';
import { cx, money, relativeTime, shortHash, sentenceFromCode } from '../lib/util';
import { Link, useRouter } from '../app/router';

function agentRows() {
  return sampleData.agents.map((agent) => {
    const usage = sampleData.usageFor(agent.name);
    const txs = sampleData.transactions.filter((t) => t.agentId === agent.id);
    const pending = txs.filter((t) => t.outcome === 'REQUIRE_HUMAN_APPROVAL').length;
    const highest = txs.reduce<RiskLevel | null>((acc, t) => {
      const level = t.risk?.level ?? null;
      if (level === null) return acc;
      const order: readonly RiskLevel[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
      return acc === null || order.indexOf(level) > order.indexOf(acc) ? level : acc;
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
      walletName: sampleData.walletById(sampleData.wallets[agent.wallet]?.id ?? '')?.name ?? '—',
      usageRaw: usage.settledRaw,
      limitRaw: limit,
      lastAt: usage.lastAt ?? new Date(Date.now() - agent.lastActivity).toISOString(),
      count: txs.length,
    };
  });
}

/* ==========================================================================
   Agents
   ========================================================================== */

export function Agents() {
  const { navigate } = useRouter();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const rows = useMemo(() => agentRows(), []);
  const filtered = rows.filter(
    (row) =>
      (status === 'ALL' || row.state === status) &&
      (query.trim().length === 0 || `${row.agent.name} ${row.agent.purpose}`.toLowerCase().includes(query.trim().toLowerCase())),
  );

  const columns: readonly Column<(typeof rows)[number]>[] = [
    {
      key: 'agent',
      header: 'Agent',
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate text-[13px] text-ink">{row.agent.name}</div>
          <div className="truncate text-2xs text-ink-faint">{row.agent.purpose}</div>
        </div>
      ),
      sortValue: (row) => row.agent.name,
    },
    { key: 'state', header: 'State', cell: (row) => <Status value={row.state} label={sentenceFromCode(row.state)} />, sortValue: (row) => row.state },
    { key: 'policy', header: 'Policy', hideBelow: 'md', cell: (row) => <span className="mono text-2xs text-ink-dim">{row.policyName} v{row.policyNumber}</span> },
    { key: 'wallet', header: 'Wallet', hideBelow: 'lg', cell: (row) => <span className="mono text-2xs text-ink-dim">{row.walletName}</span> },
    {
      key: 'usage',
      header: 'Today / ceiling',
      align: 'right',
      cell: (row) => (
        <span className="num text-xs text-ink">
          {money(row.usageRaw.toString(), 'usdc-6dp', true)}
          <span className="text-ink-faint"> / {money(row.limitRaw.toString(), 'usdc-6dp', true)}</span>
        </span>
      ),
      sortValue: (row) => Number(row.usageRaw),
    },
    { key: 'risk', header: 'Risk', hideBelow: 'md', cell: (row) => (row.highest === null ? <span className="text-2xs text-ink-faint">—</span> : <Badge tone={row.highest === 'HIGH' || row.highest === 'CRITICAL' ? 'deny' : row.highest === 'MEDIUM' ? 'caution' : 'allow'}>{row.highest}</Badge>) },
    { key: 'last', header: 'Last activity', align: 'right', hideBelow: 'sm', cell: (row) => <span className="num text-2xs text-ink-mute">{relativeTime(row.lastAt)}</span>, sortValue: (row) => row.lastAt },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Principals"
        title="Agents"
        lead="An agent is a subject, not a session. It can propose a payment and it cannot approve one — those are different rows, different credential prefixes, and a CHECK in the schema that refuses the overlap."
        actions={
          <Button variant="primary" onClick={() => toast('caution', 'Agents are created by an operator credential (`agent:manage`), never from a browser session.')}>
            Create agent
          </Button>
        }
        meta={<>{[...new Set(rows.map((row) => row.state))].map((state) => <span key={state}>{sentenceFromCode(state)} {countBy(rows, state)}</span>)}</>}
      />

      <FilterBar>
        <Input className="max-w-xs" placeholder="Filter agents…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by state">
          {['ALL', 'ACTIVE', 'PAUSED', 'REVOKED', 'AWAITING_APPROVAL', 'ANOMALOUS'].map((option) => (
            <option key={option} value={option}>{option === 'ALL' ? 'Any state' : option}</option>
          ))}
        </Select>
      </FilterBar>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.slice(0, 3).map((row) => (
          <AgentCard
            key={row.agent.id}
            agent={row.agent.name}
            state={row.state}
            pending={row.pending}
            policy={`${row.policyName} v${row.policyNumber}`}
            wallet={row.walletName}
            usage={row.usageRaw}
            limit={row.limitRaw}
            lastAt={row.lastAt}
            riskLevel={row.highest}
          />
        ))}
      </div>

      <Panel pad={false} title="All agents" action={<span className="text-2xs text-ink-faint">click a row for its control page</span>}>
        <DataTable
          rows={filtered}
          columns={columns}
          rowKey={(row) => row.agent.id}
          onRowClick={(row) => navigate(`/app/agents/${row.agent.name}`)}
          empty={
            <EmptyState
              title="No agents yet"
              body="Create your first autonomous agent and give it scoped financial permissions. It will be able to propose a payment and nothing else — the credential that approves is held by a person."
              action={<Button variant="primary" onClick={() => toast('caution', 'Use an operator credential: `ari agent create --name …`.')}>Create agent</Button>}
            />
          }
        />
      </Panel>
    </>
  );
}

const countBy = (rows: readonly { state: string }[], state: string): number => rows.filter((r) => r.state === state).length;

/* ==========================================================================
   Agent detail
   ========================================================================== */

export function AgentDetail({ name }: { readonly name: string }) {
  const [tab, setTab] = useState('overview');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const row = agentRows().find((r) => r.agent.name === name);

  if (row === undefined) {
    return (
      <Panel className="mt-10">
        <EmptyState title={`No agent named ${name}`} body="Agent names are unique inside an organisation. Check the spelling, or create it." action={<Link to="/app/agents"><Button>Back to agents</Button></Link>} />
      </Panel>
    );
  }

  const { agent } = row;
  const txs = sampleData.transactions.filter((t) => t.agentId === agent.id);
  const policy = sampleData.policies.find((p) => p.key === agent.policy);
  const active = policy === undefined ? undefined : sampleData.activeVersion(policy.key);

  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-2xs text-ink-faint">
        <Link to="/app/agents" className="hover:text-ink-dim">Agents</Link><span>/</span><span className="mono">{agent.name}</span>
      </div>

      <PageHeader
        eyebrow="Agent"
        title={agent.name}
        lead={agent.purpose}
        actions={
          <>
            <Button onClick={() => toast('caution', 'Pausing stops new requests; outstanding tickets still redeem until their TTL. That is by design — a ticket is a capability already granted.')}>Pause</Button>
            <Button variant="danger" onClick={() => setConfirmRevoke(true)}>Revoke agent</Button>
          </>
        }
        meta={
          <>
            <Status value={row.state} label={sentenceFromCode(row.state)} />
            <span className="mono">{agent.id}</span>
            <span>owner {agent.owner}</span>
            <span>created {relativeTime(new Date(Date.now() - agent.created).toISOString())}</span>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div>
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
              <Panel title="What it may do">
                <ul className="space-y-2 text-xs">
                  <Yes no={false}>Propose a payment inside its policy</Yes>
                  <Yes no={false}>Read its own request status</Yes>
                  <Yes no>Approve any payment, including its own</Yes>
                  <Yes no>Change its policy, limits or approvers</Yes>
                  <Yes no>Hold a signing key or call a signer</Yes>
                  <Yes no>Withdraw to an address not on the allowlist</Yes>
                </ul>
              </Panel>
              <Panel title="Envelope in numbers">
                <dl className="space-y-2 text-xs">
                  <KV k="per transaction" v={money(active?.document.permissions.transfers.perTransaction.maxRaw ?? '0', 'usdc-6dp')} />
                  <KV k="per day" v={`${money(row.usageRaw.toString(), 'usdc-6dp')} of ${money(row.limitRaw.toString(), 'usdc-6dp')}`} />
                  <KV k="per month" v={active?.document.permissions.transfers.perMonth === null ? 'no monthly window' : money(active?.document.permissions.transfers.perMonth?.maxRaw ?? '0', 'usdc-6dp')} />
                  <KV k="hourly rate" v={`${active?.document.permissions.transfers.maxTransactionsPerHour ?? 0} requests`} />
                  <KV k="recipients" v={`${active?.document.permissions.transfers.recipients.addresses.length ?? 0} allowlisted`} />
                  <KV k="escalation" v={active?.document.escalation.humanApproval.requiredWhen.map((c) => sentenceFromCode(c.op)).join(' · ') ?? 'never'} />
                </dl>
              </Panel>
            </div>
          )}

          {tab === 'permissions' && active !== undefined && <PolicyRules document={active.document} />}

          {tab === 'policies' && (
            <Panel title="Governing policy" action={<Link to={`/app/policies/${policy?.key ?? ''}`} className="text-2xs text-brand hover:text-brand-strong">open policy</Link>}>
              <VersionStrip versions={policy?.versions ?? []} />
              <p className="mt-3 text-2xs leading-relaxed text-ink-mute">
                The grant binds this agent to <span className="mono">one version</span>, not to “the current policy”. When a new
                version is activated, an existing grant keeps pointing at the version it was issued under until an operator with
                <span className="mono"> wallet:manage</span> re-points it — which is why a policy change is visible here.
              </p>
            </Panel>
          )}

          {tab === 'activity' && (
            <Panel pad={false}>
              <DataTable
                rows={txs}
                rowKey={(tx) => tx.id}
                onRowClick={(tx) => window.location.assign(`/app/transactions/${tx.id}`)}
                columns={[
                  { key: 'intent', header: 'Intent', cell: (tx) => <span className="text-[13px]">{tx.intent}</span> },
                  { key: 'amount', header: 'Amount', align: 'right', cell: (tx) => <Amount raw={tx.amountRaw} unit={tx.unit} /> },
                  { key: 'decision', header: 'Decision', cell: (tx) => <DecisionMark outcome={tx.outcome} codes={tx.codes} /> },
                  { key: 'when', header: 'When', align: 'right', cell: (tx) => <span className="num text-2xs text-ink-mute">{relativeTime(tx.submittedAt)}</span> },
                ]}
              />
            </Panel>
          )}

          {tab === 'risk' && (
            <Panel title="Recent assessments">
              {txs.filter((t) => t.risk !== null).length === 0 ? (
                <p className="text-xs text-ink-mute">No assessment has run for this agent yet. A tenant with no history scores MEDIUM by design — the first payment an agent makes is “unknown”, not “clean”.</p>
              ) : (
                <ul className="space-y-2.5">
                  {txs.filter((t) => t.risk !== null).map((t) => (
                    <li key={t.id} className="rounded-[var(--radius-sm)] border border-hair bg-raised/40 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-xs text-ink">{t.intent}</span>
                        <Badge tone={t.risk!.level === 'HIGH' || t.risk!.level === 'CRITICAL' ? 'deny' : t.risk!.level === 'MEDIUM' ? 'caution' : 'allow'}>{t.risk!.level}</Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5 text-2xs text-ink-mute">
                        {t.risk!.signals.length === 0 ? <span>no signals</span> : t.risk!.signals.map((s) => <span key={s} className="rounded border border-hair px-1">{sentenceFromCode(s)}</span>)}
                        <span className="num ml-auto">{t.risk!.score.toFixed(2)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}

          {tab === 'credentials' && (
            <Panel title="Bearer credentials" action={<Button size="sm" onClick={() => toast('caution', 'A credential is issued by `POST /v1/agents/:id/credentials` and printed once. It cannot be read back — the row holds an Argon2id digest over a pepper that is not in the database.')}>Issue new</Button>}>
              <ul className="divide-y divide-hair-faint">
                {sampleData.apiKeys.filter((k) => k.name.startsWith(agent.name)).map((key) => (
                  <li key={key.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                    <span className="mono text-ink-dim">{key.prefix}…</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      {key.scopes.map((scope) => <Badge key={scope} tone="neutral" mono>{scope}</Badge>)}
                      <Status value={key.status} />
                    </span>
                  </li>
                ))}
                {sampleData.apiKeys.filter((k) => k.name.startsWith(agent.name)).length === 0 && (
                  <li className="py-3 text-xs text-ink-mute">No credential is currently issued to this agent.</li>
                )}
              </ul>
              <p className="mt-3 border-t border-hair-faint pt-3 text-2xs leading-relaxed text-ink-mute">
                An agent secret (<span className="mono">crd_</span>) does not parse at a human route and a user secret
                (<span className="mono">ucrd_</span>) does not parse at an agent route, so both refusals look exactly like a wrong
                secret. Revoking the agent revokes every credential with it, in the same transaction.
              </p>
            </Panel>
          )}

          {tab === 'audit' && (
            <Panel pad={false}>
              <DataTable
                rows={sampleData.auditEvents.filter((event) => event.actor === agent.id || txs.some((t) => t.id === event.resourceId)).slice(0, 14)}
                rowKey={(event) => event.id}
                columns={[
                  { key: 'type', header: 'Event', cell: (e) => <span className="mono text-xs">{e.type}</span> },
                  { key: 'actor', header: 'Actor', cell: (e) => <Badge tone="neutral">{e.actorType}</Badge> },
                  { key: 'when', header: 'When', align: 'right', cell: (e) => <span className="num text-2xs text-ink-mute">{relativeTime(e.at)}</span> },
                ]}
              />
            </Panel>
          )}
        </div>

        <div className="space-y-4">
          <Panel title="Identity">
            <dl className="space-y-2 text-xs">
              <KV k="status" v={<Status value={agent.status} />} />
              <KV k="wallet" v={row.walletName} />
              <KV k="policy" v={`${row.policyName} v${row.policyNumber}`} />
              <KV k="scopes" v={agent.scopes.join(', ')} />
              <KV k="requests" v={`${row.count} lifetime`} />
              <KV k="last seen" v={relativeTime(row.lastAt)} />
            </dl>
          </Panel>
          <Panel title="What revoking does">
            <p className="text-2xs leading-relaxed text-ink-mute">
              Terminal and absorbing: a revoked agent cannot change status again, and every credential it held stops working at
              the boundary on the next request. Outstanding tickets are not revoked — a capability already granted is honoured
              until its 60 second TTL, and pretending otherwise would be a lie about a signature.
            </p>
          </Panel>
        </div>
      </div>

      <Modal
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        title="Revoke this agent"
        subtitle="Terminal. There is no un-revoke; create a new agent instead."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRevoke(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => { setConfirmRevoke(false); toast('caution', 'No deployment is connected, so nothing was revoked. The real call is POST /v1/agents/:id/revoke.'); }}>
              Revoke {agent.name}
            </Button>
          </>
        }
      >
        <ul className="space-y-2 text-xs">
          <li className="rounded-[var(--radius-sm)] border border-deny-line bg-deny-wash px-3 py-2 text-ink">
            {sampleData.apiKeys.filter((k) => k.name.startsWith(agent.name)).length} credential(s) stop working immediately, and the
            agent’s status check refuses on the next request.
          </li>
          <li className="text-ink-mute">{row.pending} request(s) currently awaiting approval will not be paid: the approval token is sealed against the agent row.</li>
          <li className="text-ink-mute">The audit trail records <span className="mono">agent.revoked</span> with your user id as the actor, and the reason is yours to write.</li>
        </ul>
      </Modal>
    </>
  );
}

const Yes = ({ no, children }: { readonly no: boolean; readonly children: React.ReactNode }) => (
  <li className="flex items-start gap-2">
    <span className={cx('mt-[1px] grid h-4 w-4 shrink-0 place-items-center rounded-[3px] border text-[10px]', no ? 'border-hair bg-[#0d1116] text-ink-faint' : 'border-allow-line bg-allow-wash text-allow')}>
      {no ? '✕' : '✓'}
    </span>
    <span className={no ? 'text-ink-mute' : 'text-ink'}>{children}</span>
  </li>
);

function KV({ k, v }: { readonly k: string; readonly v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ink-mute">{k}</dt>
      <dd className="min-w-0 truncate text-right text-ink">{v}</dd>
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
    const users = sampleData.agents.filter((a) => a.policy === policy.key);
    return { policy, active, agents: users.map((u) => u.name), wallets: [sampleData.walletById(active.document.target.walletId)?.name ?? '—'] };
  });

  return (
    <>
      <PageHeader
        eyebrow="Controls"
        title="Policies"
        lead="A policy is a compiled document bound to one wallet and one authority mode. Its content is frozen the moment it is published, and a version can never be walked back into a draft."
        actions={<Button variant="primary" onClick={() => toast('caution', 'Draft a document and activate it with a `policy:activate` credential — `ari policy apply --file policy.json --activate`.')}>New policy</Button>}
        meta={<>{rows.map((r) => <span key={r.policy.key}>{r.policy.name}: v{r.active.number} active</span>)}</>}
      />

      <div className="grid gap-3 lg:grid-cols-3">
        {rows.map((row) => (
          <button
            key={row.policy.key}
            onClick={() => navigate(`/app/policies/${row.policy.key}`)}
            className="group flex flex-col gap-3 rounded-[var(--radius-md)] border border-hair bg-surface p-4 text-left transition-colors hover:border-brand-dim"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-ink">{row.policy.name}</div>
                <div className="mt-0.5 text-2xs text-ink-faint">
                  <span className="mono">{row.wallets.join(', ')}</span> · {row.active.document.target.authorityMode}
                </div>
              </div>
              <Badge tone="allow">v{row.active.number}</Badge>
            </div>
            <p className="text-xs leading-relaxed text-ink-mute">{row.active.summary}</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-hair-faint pt-2.5 text-2xs">
              <span className="text-ink-mute">per tx</span>
              <span className="num text-right text-ink-dim">{money(row.active.document.permissions.transfers.perTransaction.maxRaw, 'usdc-6dp', true)}</span>
              <span className="text-ink-mute">per day</span>
              <span className="num text-right text-ink-dim">{money(row.active.document.permissions.transfers.perDay.maxRaw, 'usdc-6dp', true)}</span>
              <span className="text-ink-mute">escalates</span>
              <span className="text-right text-ink-dim">{row.active.document.escalation.humanApproval.requiredWhen.length} conditions</span>
              <span className="text-ink-mute">agents</span>
              <span className="text-right text-ink-dim">{row.agents.length}</span>
            </div>
            {row.policy.versions.some((v) => v.status === 'DRAFT') && (
              <span className="inline-flex items-center gap-1.5 self-start rounded-[var(--radius-xs)] border border-caution-line bg-caution-wash px-1.5 py-0.5 text-2xs text-caution">
                draft v{row.policy.versions.find((v) => v.status === 'DRAFT')?.number} pending review
              </span>
            )}
          </button>
        ))}
      </div>
    </>
  );
}

export function PolicyDetail({ keyName }: { readonly keyName: string }) {
  const [versionId, setVersionId] = useState<string | null>(null);
  const policy = sampleData.policies.find((p) => p.key === keyName);
  if (policy === undefined) {
    return (
      <Panel className="mt-10">
        <EmptyState title={`No policy named ${keyName}`} body="Policies are keyed by their organisation and name. The one that authorized a transaction is always named on that transaction." action={<Link to="/app/policies"><Button>Back to policies</Button></Link>} />
      </Panel>
    );
  }
  const active = sampleData.activeVersion(policy.key);
  const selected: PolicyVersion = policy.versions.find((v) => v.id === versionId) ?? active;
  const draft = policy.versions.find((v) => v.status === 'DRAFT');
  const affected = sampleData.agents.filter((a) => a.policy === policy.key);

  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-2xs text-ink-faint">
        <Link to="/app/policies" className="hover:text-ink-dim">Policies</Link><span>/</span><span>{policy.name}</span>
      </div>

      <PageHeader
        eyebrow="Policy"
        title={policy.name}
        lead={active.summary}
        actions={
          <>
            <Select value={selected.id} onChange={(event) => setVersionId(event.target.value)} aria-label="Version">
              {[...policy.versions].sort((a, b) => b.number - a.number).map((v) => (
                <option key={v.id} value={v.id}>v{v.number} · {v.status}</option>
              ))}
            </Select>
            <Button variant={selected.status === 'ACTIVE' ? 'default' : 'primary'} onClick={() => toast('caution', `Activating v${selected.number} requires a credential holding policy:activate, and a written justification if it widens the previous version.`)}>
              {selected.status === 'ACTIVE' ? 'Currently active' : `Activate v${selected.number}`}
            </Button>
          </>
        }
        meta={
          <>
            <span>wallet {sampleData.walletById(active.document.target.walletId)?.name ?? '—'}</span>
            <span>{affected.length} agent(s) granted under it</span>
            <span className="mono">version {shortHash(selected.id, 8)}</span>
          </>
        }
      />

      {draft !== undefined && (
        <Panel className="mb-4 border-caution-line" title="A widening is waiting" action={<Badge tone="caution">draft v{draft.number}</Badge>}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Diff k="per transaction" from={active.document.permissions.transfers.perTransaction.maxRaw} to={draft.document.permissions.transfers.perTransaction.maxRaw} />
            <Diff k="per day" from={active.document.permissions.transfers.perDay.maxRaw} to={draft.document.permissions.transfers.perDay.maxRaw} />
            <Diff k="escalation threshold" from={active.document.escalation.humanApproval.requiredWhen.find((c) => c.op === 'amount_gt')?.raw ?? '0'} to={draft.document.escalation.humanApproval.requiredWhen.find((c) => c.op === 'amount_gt')?.raw ?? '0'} />
          </div>
          <p className="mt-3 text-2xs leading-relaxed text-ink-mute">
            Activating a broader version is refused unless the actor holds the owner role, and a rollback out of order requires a
            written justification. {affected.length} agent(s) currently granted under v{active.number} keep that version until an
            operator re-points the grant — activating does not silently move anyone’s envelope.
          </p>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <PolicyRules document={selected.document} />
        <div className="space-y-4">
          <Panel title="Version history" action={<span className="text-2xs text-ink-faint">never hide which one authorized</span>}>
            <VersionStrip versions={policy.versions} />
          </Panel>
          <Panel title="Agents granted under this policy">
            {affected.length === 0 ? (
              <p className="text-xs text-ink-mute">None. A policy that governs nothing is a document, not a control.</p>
            ) : (
              <ul className="space-y-1.5">
                {affected.map((agent) => (
                  <li key={agent.id} className="flex items-center justify-between gap-2 text-xs">
                    <Link to={`/app/agents/${agent.name}`} className="mono truncate text-ink hover:text-brand-strong">{agent.name}</Link>
                    <Status value={agent.status} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="What the compiler refuses">
            <p className="text-2xs leading-relaxed text-ink-mute">
              Two limits that disagree about units, transfers enabled with no permitted chains, an allowlist entry that is not a
              valid address of either grammar, a contract call carrying native value, and a caller-supplied USD estimate when a
              <span className="mono"> usd_gte</span> rule exists to read it. All of them are parse errors at authoring time, not
              runtime surprises.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Diff({ k, from, to }: { readonly k: string; readonly from: string; readonly to: string }) {
  const bigger = BigInt(to) > BigInt(from);
  return (
    <div className="rounded-[var(--radius-sm)] border border-hair bg-raised/40 px-3 py-2">
      <div className="text-2xs uppercase tracking-[0.06em] text-ink-mute">{k}</div>
      <div className="mt-1 flex items-baseline gap-2 text-xs">
        <span className="num text-ink-faint line-through">{money(from, 'usdc-6dp')}</span>
        <span className="text-ink-faint">→</span>
        <span className={cx('num font-medium', bigger ? 'text-caution' : 'text-allow')}>{money(to, 'usdc-6dp')}</span>
      </div>
      <div className="mt-1 text-2xs text-ink-faint">{bigger ? 'widening' : 'narrowing'}</div>
    </div>
  );
}
