import { useMemo, useState } from 'react';
import { Badge, Button, CodeBlock, DataTable, EmptyState, FilterBar, Input, MetricCard, PageHeader, Panel, RiskPip, SectionTitle, Select, Status , Tooltip, toast } from '../components/ui';
import { Amount, AuditRow, DecisionMark, PipelineRail } from '../components/product';
import { sampleData } from '../api/client';
import type { AuditEvent } from '../domain/types';
import { cx, money, relativeTime, shortAddress, shortHash, sentenceFromCode, clockTime } from '../lib/util';
import { useRouter } from '../app/router';
import { Link } from '../app/router';

const agentName = (id: string): string => sampleData.agents.find((a) => a.id === id)?.name ?? id;

/* ==========================================================================
   Overview
   ========================================================================== */

export function Overview() {
  const totals = sampleData.todayTotals();
  const txs = sampleData.transactions;
  const recent = [...txs].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).slice(0, 7);
  const risk = sampleData.riskEvents();
  const pending = sampleData.approvals;

  return (
    <>
      <PageHeader
        eyebrow="Northwind Treasury · production"
        title="What the agents are doing"
        lead="Every number here is a decision Ari made and can show its reasoning for. Refusals are counted as carefully as payments."
        actions={
          <>
            <Button onClick={() => toast('brand', 'The audit chain can be exported and verified offline: `ari audit export --out chain.json && ari verify chain --in chain.json --head <hash>`.')}>Verify the trail</Button>
            <Link to="/app/approvals"><Button variant="primary">{pending.length} awaiting approval</Button></Link>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard label="Active agents" value={sampleData.agents.filter((a) => a.status === 'ACTIVE').length} hint={`${sampleData.agents.length} total principals`} />
        <MetricCard label="Transactions today" value={totals.count} hint="requests Ari answered" />
        <MetricCard label="Authorized volume" value={money(totals.authorizedRaw.toString(), 'usdc-6dp', true)} hint="settled holds, 24h" tone="allow" />
        <MetricCard label="Pending approvals" value={totals.pending} hint="waiting on a human" tone={totals.pending > 0 ? 'caution' : 'neutral'} />
        <MetricCard label="Risk events" value={risk.length} hint="signals above weight" tone={risk.some((r) => r.level === 'HIGH') ? 'caution' : 'neutral'} />
        <MetricCard label="Refused" value={totals.denied} hint="denied by policy" tone={totals.denied > 0 ? 'deny' : 'neutral'} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          <Panel title="Recent activity" action={<Link to="/app/transactions" className="text-2xs text-brand hover:text-brand-strong">all transactions</Link>} pad={false}>
            <ul className="divide-y divide-hair-faint">
              {recent.map((tx) => (
                <li key={tx.id}>
                  <Link to={`/app/transactions/${tx.id}`} className="flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-hover">
                    <span className="hidden w-6 shrink-0 text-right num text-2xs text-ink-faint sm:block">{clockTime(tx.submittedAt).slice(0, 5)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{tx.intent}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-ink-faint">
                        <span className="mono">{agentName(tx.agentId)}</span>
                        <span className="mono">{tx.policyName} v{tx.policyVersionNumber}</span>
                        <span>{shortAddress(tx.recipient ?? tx.contract)}</span>
                      </span>
                    </span>
                    <span className="shrink-0 text-right"><Amount raw={tx.amountRaw} unit={tx.unit} size="sm" /></span>
                    <span className="hidden w-[7.5rem] shrink-0 text-right sm:block"><DecisionMark outcome={tx.outcome} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="The path every request takes" action={<span className="text-2xs text-ink-faint">same rail, every screen</span>}>
            <div className="overflow-x-auto pb-1"><PipelineRail size="md" /></div>
            <div className="mt-3 grid gap-x-6 gap-y-1 text-2xs leading-relaxed text-ink-mute sm:grid-cols-2">
              <p><span className="text-ink-dim">Policy</span> is a compiled document bound to one wallet version; it can refuse and escalate, and nothing else.</p>
              <p><span className="text-ink-dim">Risk</span> is advisory and structurally cannot grant — it reads Ari’s own history, not a model.</p>
              <p><span className="text-ink-dim">Approval</span> is a vote recorded in the database; the token is sealed from that row.</p>
              <p><span className="text-ink-dim">Signing</span> happens in a second process on a single-use ticket with a 60 second TTL.</p>
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Waiting on a person" action={<Link to="/app/approvals" className="text-2xs text-brand hover:text-brand-strong">queue</Link>}>
            {pending.length === 0 ? (
              <p className="text-xs text-ink-mute">Nothing is blocked on a human right now.</p>
            ) : (
              <ul className="space-y-2.5">
                {pending.map((approval) => (
                  <li key={approval.id} className="rounded-[var(--radius-sm)] border border-hair bg-raised/40 px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <Amount raw={approval.amountRaw} unit={approval.unit} size="sm" />
                      <span className="num text-2xs text-caution">{relativeTime(approval.expiresAt)}</span>
                    </div>
                    <div className="mt-1 truncate text-2xs text-ink-mute">{agentName(approval.agentId)} · {approval.reason}</div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <RiskPip level={approval.riskLevel} />
                      <span className="text-2xs text-ink-faint">needs {approval.quorum} vote(s)</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Risk, last 24h" action={<Link to="/app/risk" className="text-2xs text-brand hover:text-brand-strong">risk center</Link>}>
            {risk.length === 0 ? (
              <p className="text-xs text-ink-mute">No signal crossed its weight.</p>
            ) : (
              <ul className="space-y-2">
                {risk.slice(0, 5).map(({ level, signals, tx }) => (
                  <li key={tx.id} className="flex items-start gap-2.5">
                    <span className="mt-1"><RiskPip level={level} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-ink">{tx.intent}</span>
                      <span className="block truncate text-2xs text-ink-mute">{signals.map((s) => sentenceFromCode(s)).join(' · ')}</span>
                    </span>
                    <span className="num shrink-0 text-2xs text-ink-faint">{tx.risk?.score.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 border-t border-hair-faint pt-2.5 text-2xs leading-relaxed text-ink-faint">
              A tenant with no history scores MEDIUM by design: the first payment an agent ever makes is “unknown”, not “clean”.
            </p>
          </Panel>

          <Panel title="Execution is not the same as confirmed">
            <p className="text-2xs leading-relaxed text-ink-mute">
              {txs.filter((t) => t.state === 'SIGNING_COMPLETE').length} request(s) show a signature returned and no chain
              confirmation. That is the honest state, not a stale one: settlement belongs to a provider callback or a
              reconciliation pass, and a mock’s <span className="mono">COMPLETE</span> is not a chain fact.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}

/* ==========================================================================
   Risk center
   ========================================================================== */

export function RiskCenter() {
  const { navigate } = useRouter();
  const events = sampleData.riskEvents();
  const bySignal = new Map<string, number>();
  for (const event of events) for (const signal of event.signals) bySignal.set(signal, (bySignal.get(signal) ?? 0) + 1);

  return (
    <>
      <PageHeader
        eyebrow="Advisory"
        title="Risk"
        lead="Deterministic statistics over Ari’s own history. This plane can escalate and it can refuse; it cannot grant, and no screen here should ever read as permission."
        meta={<><span>{events.length} assessed requests</span><span>{bySignal.size} distinct signals</span><span className="mono">model behavioural-v3 · 30-day window</span></>}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Panel pad={false} title="Signals raised" action={<span className="text-2xs text-ink-faint">newest first</span>}>
          <DataTable
            rows={events.map((e) => e.tx)}
            rowKey={(tx) => tx.id}
            columns={[
              { key: 'intent', header: 'Request', cell: (tx) => <span className="text-[13px] text-ink">{tx.intent}</span> },
              { key: 'level', header: 'Level', cell: (tx) => <span className="flex items-center gap-2"><RiskPip level={tx.risk?.level ?? 'NONE'} /><span className="text-2xs text-ink-dim">{tx.risk?.level}</span></span> },
              { key: 'signals', header: 'Signals', hideBelow: 'md', cell: (tx) => <span className="text-2xs text-ink-mute">{tx.risk?.signals.map((s) => sentenceFromCode(s)).join(' · ') || '—'}</span> },
              { key: 'score', header: 'Score', align: 'right', cell: (tx) => <span className="num text-xs text-ink-dim">{tx.risk?.score.toFixed(2)}</span>, sortValue: (tx) => tx.risk?.score ?? 0 },
              { key: 'decision', header: 'Outcome', cell: (tx) => <DecisionMark outcome={tx.outcome} codes={tx.codes} /> },
            ]}
            onRowClick={(tx) => navigate(`/app/transactions/${tx.id}`)}
            empty={<EmptyState title="No signals" body="Nothing in the window crossed a weight. That is a calm day, not a broken plane — the same code path produced the assessments above." />}
          />
        </Panel>

        <div className="space-y-4">
          <Panel title="What the engine can actually compute">
            <ul className="space-y-1.5 text-2xs">
              {[...bySignal.entries()].map(([signal, count]) => (
                <li key={signal} className="flex items-baseline justify-between gap-2">
                  <span className="text-ink-dim">{sentenceFromCode(signal)}</span>
                  <span className="num text-ink-faint">{count}×</span>
                </li>
              ))}
              {['new asset', 'new chain', 'new contract', 'unusual approval pattern'].map((unavailable) => (
                <li key={unavailable} className="flex items-baseline justify-between gap-2 text-ink-faint">
                  <span className="line-through">{unavailable}</span>
                  <Tooltip content="Not emitted: there is no column to compute it from and no weight for it, so the policy language cannot name it either. A policy option that silently evaluates to false is worse than one that does not exist.">
                    <span className="cursor-help">no data</span>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Boundary proximity">
            <p className="text-2xs leading-relaxed text-ink-mute">
              Requests that came within 10% of a limit without crossing it. This is where a policy is about to become a
              constraint rather than a control, and it is the number an operator should look at before widening anything.
            </p>
            <ul className="mt-2 space-y-1.5">
              {sampleData.transactions.filter((t) => t.risk?.signals.includes('POLICY_BOUNDARY_PROXIMITY')).map((t) => (
                <li key={t.id} className="flex items-baseline justify-between gap-2 text-xs">
                  <Link to={`/app/transactions/${t.id}`} className="truncate text-ink hover:text-brand-strong">{t.intent}</Link>
                  <span className="num shrink-0 text-caution">{money(t.amountRaw, t.unit, true)}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}

/* ==========================================================================
   Wallets
   ========================================================================== */

export function Wallets() {
  return (
    <>
      <PageHeader
        eyebrow="Execution resources"
        title="Wallets"
        lead="A wallet is what an agent may move money from, and the mode is the guarantee it offers. This screen is about what autonomous agents can do with it, not about how much is in it."
      />
      <div className="grid gap-3 lg:grid-cols-3">
        {sampleData.wallets.map((wallet) => (
          <Panel key={wallet.id} title={<span className="mono normal-case tracking-normal">{wallet.name}</span>} action={<Badge tone={wallet.mode === 'delegated' ? 'caution' : 'allow'}>{wallet.mode}</Badge>}>
            <dl className="space-y-1.5 text-xs">
              <KV k="chain" v={wallet.chain} />
              <KV k="provider" v={<span className="mono">{wallet.provider}</span>} />
              <KV k="address" v={wallet.address === null ? <span className="text-caution">not recorded</span> : <span className="mono">{shortAddress(wallet.address)}</span>} />
              <KV k="agents" v={wallet.agents.join(', ') || 'none'} />
              <KV k="policies" v={wallet.policies.join(', ') || 'none'} />
              <KV k="balance" v={wallet.balances[0] === undefined ? '—' : money(wallet.balances[0].raw, wallet.balances[0].unit)} />
            </dl>
            <p className="mt-3 border-t border-hair-faint pt-2.5 text-2xs leading-relaxed text-ink-mute">
              {wallet.mode === 'delegated'
                ? 'The signer holds everything needed to sign. A human approval here is an application-layer control enforced by Ari’s database: if Ari is fully compromised, this wallet offers no cryptographic protection, and no screen may imply otherwise.'
                : wallet.address === null
                  ? 'No chain address is recorded, so the simulation plane cannot ask anything about this wallet — it answers “no address on file”, which is a different thing from “the chain said no”.'
                  : 'Completing a ceremony requires the user’s secret share, decryptable only on a device a person holds. A forged approval, a compromised API and a stolen database do not add up to a signature.'}
            </p>
          </Panel>
        ))}
      </div>
    </>
  );
}

function KV({ k, v }: { readonly k: string; readonly v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ink-mute">{k}</dt>
      <dd className="min-w-0 truncate text-right text-ink">{v}</dd>
    </div>
  );
}

/* ==========================================================================
   Audit log
   ========================================================================== */

export function AuditLog() {
  const [events] = useState<readonly AuditEvent[]>(sampleData.auditEvents);
  const [type, setType] = useState('ALL');
  const [severity, setSeverity] = useState('ALL');
  const [query, setQuery] = useState('');
  const head = events.at(-1)?.hash ?? 'genesis';

  const types = useMemo(() => ['ALL', ...new Set(events.map((event) => event.type))], [events]);
  const filtered = events.filter(
    (event) =>
      (type === 'ALL' || event.type === type) &&
      (severity === 'ALL' || event.severity === severity) &&
      (query.trim().length === 0 || `${event.type} ${event.actor} ${event.resourceId ?? ''} ${event.reasons.join(' ')}`.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <>
      <PageHeader
        eyebrow="Evidence"
        title="Audit log"
        lead="An append-only hash chain per organisation. Every row’s hash is recomputed from its content when it is read, so an edit, a deletion or a reordering shows up as a break rather than as a plausible history."
        meta={
          <>
            <span>{events.length} events</span>
            <span className="mono">head {shortHash(head, 10)}</span>
            <span>chain lock: one advisory lock per org, taken by every writer and by the trigger</span>
          </>
        }
        actions={
          <Button onClick={() => toast('brand', 'Export it and verify it somewhere else: `ari audit export --out chain.json`, then `ari verify chain --in chain.json --head <the hash above>`.')}>Export & verify</Button>
        }
      />

      <FilterBar>
        <Input className="max-w-xs" placeholder="Filter by event, actor or resource…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <Select value={type} onChange={(event) => setType(event.target.value)} aria-label="Event type">
          {types.map((option) => <option key={option} value={option}>{option === 'ALL' ? 'Any event type' : option}</option>)}
        </Select>
        <Select value={severity} onChange={(event) => setSeverity(event.target.value)} aria-label="Severity">
          {['ALL', 'info', 'notice', 'warning', 'critical'].map((option) => <option key={option} value={option}>{option === 'ALL' ? 'Any severity' : option}</option>)}
        </Select>
        <span className="ml-auto text-2xs text-ink-faint">{filtered.length} of {events.length}</span>
      </FilterBar>

      <Panel pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-hair bg-[#0c1015]">
                {['seq', 'time', 'event', 'actor', 'decision', 'reasons', 'link'].map((label) => (
                  <th key={label} className={cx('eyebrow px-3 py-2', label === 'time' || label === 'seq' ? '' : '')}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((event) => <AuditRow key={event.id} event={event} />)}
            </tbody>
          </table>
        </div>
      </Panel>

      <p className="mt-3 text-2xs leading-relaxed text-ink-faint">
        Actor types are recorded per event: <span className="mono">agent</span> for a proposal, <span className="mono">human</span> for
        a vote, <span className="mono">system</span> for everything the pipeline advanced. A mislabelled trail reads as evidence and
        is not — an auditor chasing “who advanced this” must not be pointed at a person for a step taken by software.
      </p>
    </>
  );
}

/* ==========================================================================
   Developers
   ========================================================================== */

const AUTHORIZE_SNIPPET = `import { createClient, CandidateTransaction } from '@ari/client';

const ari = createClient({
  baseUrl: 'https://ari.northwind.test',
  credential: process.env.ARI_AGENT_CREDENTIAL, // crd_… — printed once, never recoverable
});

const candidate = CandidateTransaction.parse({
  kind: 'transfer',
  chain: 'ethereum',
  requestId,                       // uuidv7, minted by the caller
  agentId, walletId,
  deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
  idempotencyKey: 'invoice-INV-2291',
  asset: { kind: 'erc20', chain: 'ethereum', contract, symbol: 'USDC', decimals: '6' },
  amount: { raw: '4200000000', unit: 'usdc-6dp' },   // decimal string, never a number
  recipient: { chain: 'ethereum', address },
  replayProtection: { scheme: 'account_sequence', nonce: '1', chainId: '1' },
});

const result = await ari.authorize({ candidate, idempotencyKey: 'invoice-INV-2291' });

switch (result.state) {
  case 'COMPLETE':            /* ticket redeemed by the signer */ break;
  case 'APPROVAL_PENDING':    /* a human has to say yes */ break;
  case 'DENIED':              console.log(result.reasonCodes); break;
}`;

const ALLOW_RESPONSE = `{
  "state": "COMPLETE",
  "requestId": "txr_01a0de9b-ea6b-7c3f-9a21-4c2f8b1d0e77",
  "ticketId": "tkt_01a0de9b-ea94-7f11-8b0c-2f6a1c9d4b8e"
}`;

const APPROVAL_RESPONSE = `{
  "state": "APPROVAL_PENDING",
  "requestId": "txr_01a0de9b-ea6b-7c3f-9a21-4c2f8b1d0e77",
  "approvalId": "apr_01a0de9b-ea80-7a55-9d2e-1b0c4d5e6f70",
  "expiresAt": "2026-09-26T17:00:55.160Z"
}`;

const DENY_RESPONSE = `{
  "state": "DENIED",
  "requestId": "txr_01a0de9b-ea6b-7c3f-9a21-4c2f8b1d0e77",
  "reasonCodes": ["AMOUNT_EXCEEDS_DAILY_LIMIT", "LIMIT_RESERVATION_FAILED"]
}`;

export function Developers() {
  const [tab, setTab] = useState('sdk');
  return (
    <>
      <PageHeader
        eyebrow="Infrastructure"
        title="Developers"
        lead="One call asks Ari to authorize a transaction. There is no call that signs one: reaching the signer requires having gone through authorize, and the ticket proves it."
        actions={<Button onClick={() => toast('caution', 'Credential issuance is an operator action behind `agent:manage`. A key shown here would be a key that already exists nowhere else.')}>Create API key</Button>}
      />

      <TabsLike tabs={[['sdk', 'SDK'], ['keys', 'API keys'], ['ref', 'API reference'], ['hooks', 'Webhooks'], ['env', 'Environments'], ['logs', 'Request logs']]} value={tab} onChange={setTab} />

      {tab === 'sdk' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-4">
            <CodeBlock caption="authorize" code={AUTHORIZE_SNIPPET} />
            <SectionTitle hint="the three answers, in full">Outcomes</SectionTitle>
            <div className="grid gap-3 md:grid-cols-3">
              <CodeBlock caption="ALLOW" language="json" code={ALLOW_RESPONSE} />
              <CodeBlock caption="REQUIRE_HUMAN_APPROVAL" language="json" code={APPROVAL_RESPONSE} />
              <CodeBlock caption="DENY" language="json" code={DENY_RESPONSE} />
            </div>
          </div>
          <div className="space-y-4">
            <Panel title="What the client will not do">
              <ul className="space-y-1.5 text-2xs text-ink-mute">
                <li>There is no <span className="mono text-ink-dim">sign()</span> on the client, and a type test fails the build the day someone adds one.</li>
                <li>Every response is parsed against a strict schema: a 200 carrying a field the contract does not describe is a refusal, not an ignored key.</li>
                <li>Amounts go out as decimal strings and come back as decimal strings. A float is refused rather than rounded.</li>
                <li>No answer ever contains a ticket, a signature or a provider reference.</li>
              </ul>
            </Panel>
            <Panel title="Install">
              <CodeBlock language="bash" code={`pnpm add @ari/client\n# or drive it from a shell:\nari tx authorize --file ask.json --agent-token "$ARI_AGENT_CREDENTIAL"`} />
            </Panel>
          </div>
        </div>
      )}

      {tab === 'keys' && (
        <Panel pad={false}>
          <DataTable
            rows={sampleData.apiKeys}
            rowKey={(key) => key.id}
            columns={[
              { key: 'name', header: 'Credential', cell: (key) => <span className="text-[13px] text-ink">{key.name}</span> },
              { key: 'prefix', header: 'Secret', cell: (key) => <span className="mono text-2xs text-ink-dim">{key.prefix}…<span className="text-ink-faint"> · shown once at issue</span></span> },
              { key: 'scopes', header: 'Scopes', hideBelow: 'md', cell: (key) => <span className="flex flex-wrap gap-1">{key.scopes.map((s) => <Badge key={s} tone="neutral" mono>{s}</Badge>)}</span> },
              { key: 'used', header: 'Last used', align: 'right', cell: (key) => <span className="num text-2xs text-ink-mute">{relativeTime(key.lastUsed)}</span> },
              { key: 'status', header: 'Status', cell: (key) => <Status value={key.status} /> },
            ]}
          />
        </Panel>
      )}

      {tab === 'ref' && (
        <Panel pad={false}>
          <DataTable
            rows={ROUTES}
            rowKey={(route) => `${route.method} ${route.path}`}
            columns={[
              { key: 'method', header: 'Method', cell: (route) => <Badge tone={route.method === 'GET' ? 'neutral' : 'brand'} mono>{route.method}</Badge> },
              { key: 'path', header: 'Path', cell: (route) => <span className="mono text-xs text-ink">{route.path}</span> },
              { key: 'auth', header: 'Requires', hideBelow: 'md', cell: (route) => <span className="mono text-2xs text-ink-dim">{route.scope}</span> },
              { key: 'note', header: 'Notes', hideBelow: 'lg', cell: (route) => <span className="text-2xs text-ink-mute">{route.note}</span> },
            ]}
            density="compact"
          />
        </Panel>
      )}

      {tab === 'hooks' && (
        <div className="grid gap-3 lg:grid-cols-2">
          {sampleData.webhooks.map((hook) => (
            <Panel key={hook.id} title={<span className="mono normal-case tracking-normal text-[12px]">{hook.url}</span>} action={<Status value={hook.status} />}>
              <div className="flex flex-wrap gap-1">{hook.events.map((event) => <Badge key={event} tone="neutral" mono>{event}</Badge>)}</div>
              <dl className="mt-2.5 space-y-1 text-xs">
                <KV k="last delivery" v={relativeTime(hook.lastDelivery)} />
                <KV k="failures" v={hook.failures === 0 ? 'none' : `${hook.failures} · retrying with backoff`} />
              </dl>
              <p className="mt-2.5 text-2xs leading-relaxed text-ink-faint">
                A webhook is a notification, never an authorization. Nothing a receiver is told can widen what a policy permits.
              </p>
            </Panel>
          ))}
        </div>
      )}

      {tab === 'env' && (
        <div className="grid gap-3 sm:grid-cols-3">
          {sampleData.environments.map((env) => (
            <Panel key={env.key} title={env.label} action={<Status value={env.status} />}>
              <dl className="space-y-1 text-xs">
                <KV k="base url" v={<span className="mono">{env.base}</span>} />
                <KV k="agents" v={String(env.agents)} />
                <KV k="wallets" v={String(env.wallets)} />
              </dl>
            </Panel>
          ))}
        </div>
      )}

      {tab === 'logs' && (
        <Panel pad={false}>
          <DataTable
            rows={sampleData.auditEvents.filter((e) => e.type.startsWith('transaction') || e.type.startsWith('policy')).slice(0, 12)}
            rowKey={(event) => event.id}
            columns={[
              { key: 'at', header: 'Time', cell: (e) => <span className="num text-2xs text-ink-mute">{relativeTime(e.at)}</span> },
              { key: 'type', header: 'Event', cell: (e) => <span className="mono text-xs">{e.type}</span> },
              { key: 'decision', header: 'Decision', cell: (e) => (e.decision === null ? <span className="text-2xs text-ink-faint">—</span> : <DecisionMark outcome={e.decision as 'ALLOW'} />) },
              { key: 'req', header: 'Request', hideBelow: 'md', cell: (e) => <span className="mono text-2xs text-ink-dim">{shortHash(e.resourceId ?? '', 8)}</span> },
            ]}
            density="compact"
          />
        </Panel>
      )}
    </>
  );
}

const ROUTES = [
  { method: 'POST', path: '/v1/transactions/authorize', scope: 'crd_ + transaction:request', note: 'the only path to a signature' },
  { method: 'POST', path: '/v1/transactions/evaluate', scope: 'crd_ + transaction:request', note: 'preview: reserves nothing, writes nothing' },
  { method: 'GET', path: '/v1/transactions/:id', scope: 'crd_ or ucrd_', note: 'lifecycle stops at TICKET_MINTED and says so' },
  { method: 'GET', path: '/v1/approvals', scope: 'ucrd_ + approval:decide', note: 'only what your role may see' },
  { method: 'POST', path: '/v1/approvals/:id/decisions', scope: 'ucrd_ + approval:decide', note: 'the seal is returned to the human who voted' },
  { method: 'POST', path: '/v1/agents', scope: 'ucrd_ + agent:manage', note: 'operator' },
  { method: 'POST', path: '/v1/agents/:id/credentials', scope: 'ucrd_ + agent:manage', note: 'bearer secret printed once' },
  { method: 'POST', path: '/v1/agents/:id/revoke', scope: 'ucrd_ + agent:manage', note: 'terminal; takes its credentials with it' },
  { method: 'POST', path: '/v1/wallets', scope: 'ucrd_ + wallet:manage', note: 'mode is immutable after this row exists' },
  { method: 'POST', path: '/v1/policies', scope: 'ucrd_ + policy:activate', note: 'compile or refuse; activation checks breadth' },
  { method: 'GET', path: '/v1/audit/events', scope: 'ucrd_ + audit:read', note: 'the whole chain, plus its recomputed head' },
];

function TabsLike({ tabs, value, onChange }: { readonly tabs: readonly (readonly [string, string])[]; readonly value: string; readonly onChange: (id: string) => void }) {
  return (
    <div className="mb-4 flex gap-0.5 overflow-x-auto border-b border-hair">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={cx(
            'whitespace-nowrap border-b-2 px-3 py-1.5 text-xs transition-colors',
            value === id ? 'border-brand text-ink' : 'border-transparent text-ink-mute hover:text-ink',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/* ==========================================================================
   Settings
   ========================================================================== */

export function Settings() {
  return (
    <>
      <PageHeader eyebrow="Organisation" title="Settings" lead="Tenancy, roles and the boundaries between them. Everything here is enforced by a role grant or a trigger, so a setting that reads as a control but is not one is a defect." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="People" pad={false}>
          <DataTable
            rows={sampleData.users}
            rowKey={(user) => user.id}
            columns={[
              { key: 'name', header: 'Person', cell: (user) => <span className="text-[13px] text-ink">{user.name}</span> },
              { key: 'role', header: 'Role', cell: (user) => <Badge tone={user.role === 'owner' ? 'brand' : 'neutral'}>{user.role}</Badge> },
              { key: 'status', header: 'Status', cell: (user) => <Status value={user.status} /> },
            ]}
            density="compact"
          />
          <p className="px-3.5 pb-3 pt-1 text-2xs leading-relaxed text-ink-mute">
            Suspending a person removes their right to decide on the next request — the credential lookup joins on it, and a test
            proves both halves. A status nobody reads is a write that lies to the operator.
          </p>
        </Panel>
        <Panel title="Scopes">
          <ul className="space-y-2 text-xs">
            {[
              ['transaction:request', 'held by an agent. Proposes a payment; cannot approve one.'],
              ['approval:decide', 'held by a person. Cannot be granted to an agent — a CHECK refuses the row.'],
              ['agent:manage', 'create, list and revoke agents; issue their credentials.'],
              ['wallet:manage', 'register a wallet and grant it to an agent under one version.'],
              ['policy:activate', 'publish a version; widening beyond the current one needs the owner role.'],
              ['audit:read', 'read the chain and export it.'],
            ].map(([scope, note]) => (
              <li key={scope} className="flex gap-3">
                <span className="mono w-[10.5rem] shrink-0 text-ink-dim">{scope}</span>
                <span className="text-ink-mute">{note}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Environment">
          <dl className="space-y-1.5 text-xs">
            <KV k="organisation" v={<span className="mono">{shortHash(sampleData.organization.id, 8)}</span>} />
            <KV k="created" v={relativeTime(sampleData.organization.createdAt)} />
            <KV k="database role" v={<span className="mono">ari_app</span>} />
            <KV k="row security" v="on every tenant-bearing table" />
            <KV k="signer" v="separate process, separate pool" />
          </dl>
        </Panel>
        <Panel title="What this deployment does not do yet">
          <ul className="space-y-1.5 text-2xs text-ink-mute">
            <li>· No user-session model: an approver is a bearer credential, not a cookie.</li>
            <li>· No settlement: the lifecycle stops where Ari’s evidence stops.</li>
            <li>· No real chain provider: simulation answers about the node it is pointed at.</li>
            <li>· No price feed: a <span className="mono">usd_gte</span> rule drops a caller-supplied estimate rather than trusting it.</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
