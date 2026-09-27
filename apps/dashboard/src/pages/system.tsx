import { useMemo, useState } from 'react';
import {
  Button,
  CodeBlock,
  DataTable,
  EmptyState,
  Field,
  FilterBar,
  Input,
  KeyValue,
  LinkButton,
  Meter,
  MetricBand,
  PageHead,
  RiskPip,
  Select,
  StateCell,
  Surface,
  Tabs,
  Tag,
  Tooltip,
  toast,
  type Tone,
} from '../components/ui';
import { Amount, AgentIdentity, AuditRow, DecisionMark, PipelineRail } from '../components/product';
import { sampleData } from '../api/client';
import type { AuditEvent, TransactionRecord } from '../domain/types';
import { clockTime, money, relativeTime, sentenceFromCode, shortAddress, shortHash } from '../lib/util';
import { Link, useRouter } from '../app/router';
import { Lock, MagnifyingGlass } from '@phosphor-icons/react';

/* ==========================================================================
   Shared derivations

   Every figure on these screens is computed from the sample tenant's rows in
   the same expression that renders it. There is no live Ari deployment behind
   this console, and the sample banner says so wherever a number appears.
   ========================================================================== */

const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

const agentName = (id: string): string => sampleData.agents.find((a) => a.id === id)?.name ?? id;


const linkAction = (to: string, text: string) => (
  <Link to={to} className="text-[11px] text-accent transition-colors hover:text-accent-strong">{text}</Link>
);

/* ==========================================================================
   Overview
   ========================================================================== */

export function Overview() {
  const { navigate } = useRouter();
  const totals = sampleData.todayTotals();
  const txs = sampleData.transactions;
  const agents = sampleData.agents;
  const recent = [...txs].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).slice(0, 7);
  const risk = sampleData.riskEvents();
  const dayAgo = Date.now() - DAY_MS;
  const riskToday = risk.filter(({ tx }) => (tx.risk === null ? 0 : Date.parse(tx.risk.computedAt)) >= dayAgo);
  const pending = sampleData.approvals.filter((a) => a.status === 'PENDING');
  const unsettled = txs.filter((t) => t.state === 'SIGNING_COMPLETE').length;

  return (
    <>
      <PageHead
        title="What the agents are doing"
        lead="Every number here is a decision Ari made and can show its reasoning for. Refusals are counted as carefully as payments."
        meta={<>
          <span>{sampleData.organization.name} · {sampleData.organization.environment}</span>
        </>}
        actions={<>
          <Button onClick={() => toast('accent', 'The audit chain can be exported and verified offline: `ari audit export --out chain.json && ari verify chain --in chain.json --head <hash>`.')}>Verify the trail</Button>
          <LinkButton to="/app/approvals" variant="primary" trailingIcon>{pending.length} awaiting approval</LinkButton>
        </>}
      />

      <MetricBand items={[
        { label: 'Active agents', value: agents.filter((a) => a.status === 'ACTIVE').length, hint: `${agents.length} total principals` },
        { label: 'Requests today', value: totals.count, hint: 'requests Ari answered, last 24h' },
        { label: 'Authorized volume', value: money(totals.authorizedRaw.toString(), sampleData.UNIT, true), hint: 'settled holds, last 24h (sample figures)' },
        { label: 'Waiting on a human', value: totals.pending, hint: 'approval requests open now', tone: totals.pending > 0 ? 'wait' : 'neutral' },
        { label: 'Risk events', value: risk.length, hint: `${riskToday.length} of them raised a signal in the last 24h`, tone: riskToday.some((r) => r.level === 'HIGH') ? 'wait' : 'neutral' },
        { label: 'Refused', value: totals.denied, hint: 'denied by policy, last 24h', tone: totals.denied > 0 ? 'stop' : 'neutral' },
      ]} />

      <Surface
        className="mt-4"
        title="Waiting on a human"
        action={linkAction('/app/approvals', 'approval queue')}
        bodyClassName="p-0"
      >
        {pending.length === 0 ? (
          <p className="px-3 py-4 text-xs text-ink-3">Nothing is blocked on a human right now.</p>
        ) : (
          <div className="divide-y divide-line">
            {pending.map((approval) => (
              <div key={approval.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <Amount raw={approval.amountRaw} unit={approval.unit} size="sm" />
                    <AgentIdentity name={agentName(approval.agentId)} />
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-ink-3">{approval.reason}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <RiskPip level={approval.riskLevel} />
                  <Tag tone="wait">{`needs ${approval.quorum} vote(s)`}</Tag>
                  <span className="font-mono text-[11px] text-wait" title="approval requests lapse on this schedule">{relativeTime(approval.expiresAt)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Surface>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Surface
          title="Recent decisions"
          action={linkAction('/app/transactions', 'all transactions')}
          bodyClassName="p-0"
        >
          <DataTable
            rows={recent}
            rowKey={(tx) => tx.id}
            columns={[
              {
                key: 'time', header: 'Time', width: '5rem',
                cell: (tx) => <span className="font-mono text-[11px] text-ink-3" title={new Date(tx.submittedAt).toISOString()}>{clockTime(tx.submittedAt).slice(0, 5)}</span>,
                sortValue: (tx) => tx.submittedAt,
              },
              {
                key: 'request', header: 'Request', width: '34%',
                cell: (tx) => (
                  <span className="block min-w-0">
                    <span className="block truncate text-[13px] text-ink">{tx.intent}</span>
                    <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-ink-3">
                      <span className="font-mono">{agentName(tx.agentId)}</span>
                      <span className="font-mono">{tx.policyName} v{tx.policyVersionNumber}</span>
                      <span className="font-mono">{shortAddress(tx.recipient ?? tx.contract)}</span>
                    </span>
                  </span>
                ),
              },
              { key: 'amount', header: 'Amount', align: 'right', width: '7rem', cell: (tx) => <Amount raw={tx.amountRaw} unit={tx.unit} size="sm" compact /> },
              { key: 'decision', header: 'Decision', width: '15rem', cell: (tx) => <DecisionMark outcome={tx.outcome} codes={tx.codes} /> },
              { key: 'state', header: 'State', hideBelow: 'md', width: '11rem', cell: (tx) => <StateCell value={tx.state} /> },
            ]}
            onRowClick={(tx) => navigate(`/app/transactions/${tx.id}`)}
          />
        </Surface>

        <div className="space-y-4">
          <Surface title="The path every request takes" action={<span className="text-[11px] text-ink-4">same rail, every screen</span>}>
            <div className="overflow-x-auto pb-1"><PipelineRail size="sm" /></div>
            <div className="mt-3 space-y-1.5 text-[11px] leading-relaxed text-ink-3">
              <p><span className="text-ink-2">Policy</span> is a compiled document bound to one wallet version; it can refuse and escalate, and nothing else.</p>
              <p><span className="text-ink-2">Risk</span> is advisory and structurally cannot grant: it reads Ari’s own history, not a model.</p>
              <p><span className="text-ink-2">Approval</span> is a vote recorded in the database; the token is sealed from that row.</p>
              <p><span className="text-ink-2">Signing</span> happens in a second process on a single-use ticket with a 60 second TTL.</p>
            </div>
          </Surface>

          <Surface title="Risk, last 24h" action={linkAction('/app/risk', 'risk center')}>
            {riskToday.length === 0 ? (
              <p className="text-xs text-ink-3">No signal crossed its weight in the last 24h.</p>
            ) : (
              <ul className="space-y-2">
                {riskToday.slice(0, 5).map(({ level, signals, tx }) => (
                  <li key={tx.id} className="flex items-start gap-2.5">
                    <span className="mt-1"><RiskPip level={level} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-ink">{tx.intent}</span>
                      <span className="block truncate text-[11px] text-ink-3">{signals.map((s) => sentenceFromCode(s)).join(' · ')}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-4">{tx.risk?.score.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 border-t border-line pt-2.5 text-[11px] leading-relaxed text-ink-4">
              A tenant with no history scores MEDIUM by design: the first payment an agent ever makes is “unknown”, not “clean”.
            </p>
          </Surface>

          <Surface title="Execution is not the same as confirmed">
            <p className="text-[11px] leading-relaxed text-ink-3">
              {unsettled} request(s) show a signature returned and no chain confirmation. That is the honest state, not a
              stale one: settlement belongs to a provider callback or a reconciliation pass, and a mock’s
              <span className="font-mono"> COMPLETE</span> is not a chain fact.
            </p>
          </Surface>
        </div>
      </div>
    </>
  );
}

/* ==========================================================================
   Risk center
   ========================================================================== */

interface LimitRow {
  readonly key: string;
  readonly label: string;
  readonly consumedLabel: string;
  readonly value: number;
  readonly max: number;
}

/** Consumed amounts come from the same transaction rows the tables render. */
function limitRows(): LimitRow[] {
  const now = Date.now();
  const rows: LimitRow[] = [];
  for (const policy of sampleData.policies) {
    const active = policy.versions.find((v) => v.status === 'ACTIVE') ?? policy.versions[0]!;
    const transfers = active.document.permissions.transfers;
    const txs = sampleData.transactions.filter((tx) => tx.policyName === policy.name && tx.state !== 'DENIED');
    const since = (cutoff: number): readonly TransactionRecord[] => txs.filter((tx) => Date.parse(tx.submittedAt) >= cutoff);
    const sum = (list: readonly TransactionRecord[]): bigint => list.reduce<bigint>((acc, tx) => acc + BigInt(tx.amountRaw ?? '0'), 0n);

    const daily = sum(since(now - DAY_MS));
    rows.push({
      key: `${policy.key}-day`,
      label: `${policy.name} v${active.number} · per day`,
      consumedLabel: `${money(daily.toString(), transfers.perDay.unit)} of ${money(transfers.perDay.maxRaw, transfers.perDay.unit)}`,
      value: Number(daily),
      max: Number(BigInt(transfers.perDay.maxRaw)),
    });

    if (transfers.perMonth !== null) {
      const monthly = sum(since(now - 30 * DAY_MS));
      rows.push({
        key: `${policy.key}-month`,
        label: `${policy.name} v${active.number} · per month`,
        consumedLabel: `${money(monthly.toString(), transfers.perMonth.unit)} of ${money(transfers.perMonth.maxRaw, transfers.perMonth.unit)}`,
        value: Number(monthly),
        max: Number(BigInt(transfers.perMonth.maxRaw)),
      });
    }

    const hourly = since(now - HOUR_MS).length;
    rows.push({
      key: `${policy.key}-hour`,
      label: `${policy.name} v${active.number} · requests this hour`,
      consumedLabel: `${hourly} of ${transfers.maxTransactionsPerHour}`,
      value: hourly,
      max: transfers.maxTransactionsPerHour,
    });
  }
  return rows;
}

const proximityTone = (value: number, max: number): Tone => {
  const ratio = max <= 0 ? 0 : value / max;
  return ratio >= 0.9 ? 'stop' : ratio >= 0.6 ? 'wait' : 'accent';
};

export function RiskCenter() {
  const { navigate } = useRouter();
  const events = sampleData.riskEvents();
  const bySignal = new Map<string, number>();
  for (const event of events) for (const signal of event.signals) bySignal.set(signal, (bySignal.get(signal) ?? 0) + 1);
  const limits = limitRows();
  const flagged = sampleData.transactions.filter((t) => t.risk?.signals.includes('POLICY_BOUNDARY_PROXIMITY') ?? false);

  return (
    <>
      <PageHead
        title="Risk"
        lead="Deterministic statistics over Ari’s own history. This plane can escalate and it can refuse; it cannot grant, and no screen here should ever read as permission."
        meta={<>
          <span>{events.length} assessed requests with at least one signal</span>
          <span>{bySignal.size} distinct signals</span>
          <span className="font-mono">model behavioural-v3 · 30-day window</span>
        </>}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Surface title="Signals raised" action={<span className="text-[11px] text-ink-4">newest first</span>} bodyClassName="p-0">
          <DataTable
            rows={events.map((e) => e.tx)}
            rowKey={(tx) => tx.id}
            columns={[
              { key: 'intent', header: 'Request', cell: (tx) => <span className="text-[13px] text-ink">{tx.intent}</span> },
              { key: 'level', header: 'Level', cell: (tx) => <span className="flex items-center gap-2"><RiskPip level={tx.risk?.level ?? 'NONE'} /><StateCell value={tx.risk?.level ?? 'NONE'} /></span> },
              { key: 'signals', header: 'Signals', hideBelow: 'md', cell: (tx) => <span className="text-[11px] text-ink-3">{tx.risk?.signals.map((s) => sentenceFromCode(s)).join(' · ') || 'none'}</span> },
              { key: 'score', header: 'Score', align: 'right', cell: (tx) => <span className="font-mono text-xs text-ink-2">{tx.risk?.score.toFixed(2)}</span>, sortValue: (tx) => tx.risk?.score ?? 0 },
              { key: 'decision', header: 'Outcome', cell: (tx) => <DecisionMark outcome={tx.outcome} codes={tx.codes} /> },
            ]}
            onRowClick={(tx) => navigate(`/app/transactions/${tx.id}`)}
            empty={<EmptyState title="No signals" body="Nothing in the window crossed a weight. That is a calm day, not a broken plane; the same code path produced the assessments above." />}
          />
        </Surface>

        <div className="space-y-4">
          <Surface title="What the engine can actually compute">
            <ul className="space-y-1.5 text-[11px]">
              {[...bySignal.entries()].map(([signal, count]) => (
                <li key={signal} className="flex items-baseline justify-between gap-2">
                  <span className="text-ink-2">{sentenceFromCode(signal)}</span>
                  <span className="font-mono text-ink-4">{count} times</span>
                </li>
              ))}
              {['new asset', 'new chain', 'new contract', 'unusual approval pattern'].map((unavailable) => (
                <li key={unavailable} className="flex items-baseline justify-between gap-2 text-ink-4">
                  <span className="line-through">{unavailable}</span>
                  <Tooltip content="Not emitted: there is no column to compute it from and no weight for it, so the policy language cannot name it either. A policy option that silently evaluates to false is worse than one that does not exist.">
                    <span className="cursor-help">no data</span>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </Surface>

          <Surface title="Boundary proximity" bodyClassName="p-0">
            <p className="px-3 py-2.5 text-[11px] leading-relaxed text-ink-3">
              How close each policy’s live limits are running. This is where a policy is about to become a constraint rather
              than a control, and it is the number an operator should look at before widening anything. Consumed figures are
              summed from the sample tenant’s requests.
            </p>
            <div className="divide-y divide-line border-t border-line">
              {limits.map((row) => (
                <div key={row.key} className="px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xs text-ink">{row.label}</span>
                    <span className="shrink-0 font-mono text-[11px] text-ink-3">{row.consumedLabel}</span>
                  </div>
                  <div className="mt-2">
                    <Meter value={row.value} max={row.max} tone={proximityTone(row.value, row.max)} />
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-line px-3 py-2.5">
              <span className="label">POLICY_BOUNDARY_PROXIMITY, raised by the engine</span>
              {flagged.length === 0 ? (
                <p className="mt-1 text-xs text-ink-3">No request carried this signal.</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {flagged.map((t) => (
                    <li key={t.id} className="flex items-baseline justify-between gap-2 text-xs">
                      <Link to={`/app/transactions/${t.id}`} className="min-w-0 truncate text-ink hover:text-accent-strong">{t.intent}</Link>
                      <span className="shrink-0 font-mono text-wait">{money(t.amountRaw, t.unit, true)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Surface>
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
      <PageHead
        title="Wallets"
        lead="A wallet is what an agent may move money from, and the mode is the guarantee it offers. This screen is about what autonomous agents can do with it, not about how much is in it."
      />

      <Surface title="Execution resources" bodyClassName="p-0">
        <DataTable
          rows={sampleData.wallets}
          rowKey={(wallet) => wallet.id}
          columns={[
            { key: 'name', header: 'Wallet', cell: (wallet) => <span className="font-mono text-[13px] text-ink">{wallet.name}</span> },
            { key: 'chain', header: 'Chain', cell: (wallet) => <span className="font-mono text-xs">{wallet.chain}</span> },
            { key: 'mode', header: 'Authority mode', cell: (wallet) => <Tag tone={wallet.mode === 'delegated' ? 'wait' : 'ok'} mono>{wallet.mode}</Tag> },
            {
              key: 'address', header: 'Address', hideBelow: 'md',
              cell: (wallet) => (wallet.address === null
                ? <span className="text-wait">not recorded</span>
                : <span className="font-mono text-xs">{shortAddress(wallet.address)}</span>),
            },
            { key: 'agents', header: 'Agents', hideBelow: 'sm', cell: (wallet) => <span className="text-xs">{wallet.agents.join(', ') || 'none'}</span> },
            { key: 'policies', header: 'Policies', hideBelow: 'lg', cell: (wallet) => <span className="font-mono text-[11px]">{wallet.policies.join(', ') || 'none'}</span> },
            {
              key: 'balance', header: 'Balance (sample)', align: 'right', hideBelow: 'sm',
              cell: (wallet) => (wallet.balances[0] === undefined
                ? <span className="text-ink-4">no balance recorded</span>
                : <Amount raw={wallet.balances[0].raw} unit={wallet.balances[0].unit} size="sm" compact />),
            },
            { key: 'status', header: 'Status', cell: (wallet) => <StateCell value={wallet.status} /> },
          ]}
        />
      </Surface>

      <Surface className="mt-4" title="What each mode guarantees">
        <BlockRow title="delegated" body="The signer holds everything needed to sign. A human approval here is an application-layer control enforced by Ari’s database: if Ari is fully compromised, this wallet offers no cryptographic protection, and no screen may imply otherwise." />
        <BlockRow title="user_gated" body="Completing a ceremony requires the user’s secret share, decryptable only on a device a person holds. A forged approval, a compromised API and a stolen database do not add up to a signature." />
        <BlockRow title="no address on file" body="No chain address is recorded, so the simulation plane cannot ask anything about this wallet: it answers “no address on file”, which is a different thing from “the chain said no”." />
      </Surface>
    </>
  );
}

function BlockRow({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="border-t border-line py-2.5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="font-mono text-xs text-ink-2">{title}</div>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{body}</p>
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
  // The head is the row with the highest seq. The list is newest-first, so `at(-1)` is the
  // genesis-side link, which is the wrong end to hand an offline verifier.
  const head = [...events].sort((a, b) => Number(b.seq) - Number(a.seq))[0]?.hash ?? 'genesis';

  const types = useMemo(() => ['ALL', ...new Set(events.map((event) => event.type))], [events]);
  const filtered = events.filter(
    (event) =>
      (type === 'ALL' || event.type === type) &&
      (severity === 'ALL' || event.severity === severity) &&
      (query.trim().length === 0 || `${event.type} ${event.actor} ${event.resourceId ?? ''} ${event.reasons.join(' ')}`.toLowerCase().includes(query.toLowerCase())),
  );

  return (
    <>
      <PageHead
        title="Audit log"
        lead="An append-only hash chain per organisation. Every row’s hash is recomputed from its content when it is read, so an edit, a deletion or a reordering shows up as a break rather than as a plausible history."
        meta={
          <>
            <span>{events.length} events</span>
            <span className="font-mono">head {shortHash(head, 10)}</span>
            <span>chain lock: one advisory lock per org, taken by every writer and by the trigger</span>
          </>
        }
        actions={
          <Button onClick={() => toast('accent', 'Export it and verify it somewhere else: `ari audit export --out chain.json`, then `ari verify chain --in chain.json --head <the hash above>`.')}>Export & verify</Button>
        }
      />

      <FilterBar>
        <span className="relative inline-flex items-center">
          <MagnifyingGlass size={14} weight="regular" className="pointer-events-none absolute left-2 text-ink-4" />
          <Input className="max-w-xs pl-7" placeholder="Filter by event, actor or resource" value={query} onChange={(event) => setQuery(event.target.value)} />
        </span>
        <Select value={type} onChange={(event) => setType(event.target.value)} aria-label="Event type">
          {types.map((option) => <option key={option} value={option}>{option === 'ALL' ? 'Any event type' : option}</option>)}
        </Select>
        <Select value={severity} onChange={(event) => setSeverity(event.target.value)} aria-label="Severity">
          {['ALL', 'info', 'notice', 'warning', 'critical'].map((option) => <option key={option} value={option}>{option === 'ALL' ? 'Any severity' : option}</option>)}
        </Select>
        <span className="ml-auto font-mono text-[11px] text-ink-4">{filtered.length} of {events.length}</span>
      </FilterBar>

      <Surface title="The chain, as written" bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-line">
                <th className="label px-3 py-2 font-normal">seq</th>
                <th className="label px-3 py-2 font-normal">time</th>
                <th className="label px-3 py-2 font-normal">event</th>
                <th className="label hidden px-3 py-2 font-normal lg:table-cell">decision</th>
                <th className="label hidden px-3 py-2 font-normal md:table-cell">reasons</th>
                <th className="label px-3 py-2 font-normal">hash</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((event) => <AuditRow key={event.id} event={event} />)}
            </tbody>
          </table>
        </div>
      </Surface>

      <p className="mt-3 text-[11px] leading-relaxed text-ink-4">
        Verification walks the chain from the first seq and recomputes every hash from the row content plus its
        <span className="font-mono"> prev</span>, rather than trusting the stored <span className="font-mono">hash</span>.
        These rows are sample events: seq and timestamps come from the fixture, not a live chain. Actor types are recorded
        per event: <span className="font-mono">agent</span> for a proposal, <span className="font-mono">human</span> for a
        vote, <span className="font-mono">system</span> for everything the pipeline advanced. A mislabelled trail reads as
        evidence and is not: an auditor chasing “who advanced this” must not be pointed at a person for a step taken by
        software.
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
  credential: process.env.ARI_AGENT_CREDENTIAL, // crd_…, printed once and never readable back
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

const TABS = [
  { id: 'sdk', label: 'SDK' },
  { id: 'keys', label: 'API keys' },
  { id: 'ref', label: 'API reference' },
  { id: 'hooks', label: 'Webhooks' },
  { id: 'env', label: 'Environments' },
  { id: 'logs', label: 'Request logs' },
] as const;

export function Developers() {
  const [tab, setTab] = useState<string>('sdk');
  return (
    <>
      <PageHead
        title="Developers"
        lead="One call asks Ari to authorize a transaction. There is no call that signs one: reaching the signer requires having gone through authorize, and the ticket proves it."
        actions={<Button onClick={() => toast('wait', 'Credential issuance is an operator action behind `agent:manage`. A key shown here would be a key that already exists nowhere else.')}>Create API key</Button>}
      />

      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'sdk' && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-4">
            <CodeBlock caption="authorize" code={AUTHORIZE_SNIPPET} />
            <Surface title="Outcomes" action={<span className="text-[11px] text-ink-4">the three answers, in full</span>}>
              <div className="grid gap-3 md:grid-cols-3">
                <CodeBlock caption="ALLOW" code={ALLOW_RESPONSE} />
                <CodeBlock caption="REQUIRE_HUMAN_APPROVAL" code={APPROVAL_RESPONSE} />
                <CodeBlock caption="DENY" code={DENY_RESPONSE} />
              </div>
            </Surface>
          </div>
          <div className="space-y-4">
            <Surface title="What the client will not do">
              <ul className="space-y-1.5 text-[11px] leading-relaxed text-ink-3">
                <li>There is no <span className="font-mono text-ink-2">sign()</span> on the client, and a type test fails the build the day someone adds one.</li>
                <li>Every response is parsed against a strict schema: a 200 carrying a field the contract does not describe is a refusal, not an ignored key.</li>
                <li>Amounts go out as decimal strings and come back as decimal strings. A float is refused rather than rounded.</li>
                <li>No answer ever contains a ticket, a signature or a provider reference.</li>
              </ul>
            </Surface>
            <Surface title="Install">
              <CodeBlock caption="bash" code={`pnpm add @ari/client\n# or drive it from a shell:\nari tx authorize --file ask.json --agent-token "$ARI_AGENT_CREDENTIAL"`} />
            </Surface>
          </div>
        </div>
      )}

      {tab === 'keys' && (
        <Surface title="Agent credentials" bodyClassName="p-0">
          <DataTable
            rows={sampleData.apiKeys}
            rowKey={(key) => key.id}
            columns={[
              { key: 'name', header: 'Credential', cell: (key) => <span className="text-[13px] text-ink">{key.name}</span> },
              { key: 'prefix', header: 'Secret', cell: (key) => <span className="font-mono text-[11px] text-ink-2">{key.prefix}<span className="text-ink-4"> · printed once at issue, never readable back</span></span> },
              { key: 'scopes', header: 'Scopes', hideBelow: 'md', cell: (key) => <span className="flex flex-wrap gap-1">{key.scopes.map((s) => <Tag key={s} tone="neutral" mono>{s}</Tag>)}</span> },
              { key: 'created', header: 'Issued', hideBelow: 'sm', cell: (key) => <span className="font-mono text-[11px] text-ink-3">{relativeTime(key.created)}</span> },
              { key: 'used', header: 'Last used', align: 'right', cell: (key) => <span className="font-mono text-[11px] text-ink-3">{relativeTime(key.lastUsed)}</span> },
              { key: 'expires', header: 'Expires', hideBelow: 'lg', cell: (key) => <span className="font-mono text-[11px] text-ink-3">{key.expires === null ? 'not set' : relativeTime(key.expires)}</span> },
              { key: 'status', header: 'Status', cell: (key) => <StateCell value={key.status} /> },
            ]}
          />
        </Surface>
      )}

      {tab === 'ref' && (
        <Surface title="Routes" bodyClassName="p-0">
          <DataTable
            rows={ROUTES}
            rowKey={(route) => `${route.method} ${route.path}`}
            columns={[
              { key: 'method', header: 'Method', cell: (route) => <Tag tone={route.method === 'GET' ? 'neutral' : 'accent'} mono>{route.method}</Tag> },
              { key: 'path', header: 'Path', cell: (route) => <span className="font-mono text-xs text-ink">{route.path}</span> },
              { key: 'auth', header: 'Requires', hideBelow: 'md', cell: (route) => <span className="font-mono text-[11px] text-ink-2">{route.scope}</span> },
              { key: 'note', header: 'Notes', hideBelow: 'lg', cell: (route) => <span className="text-[11px] text-ink-3">{route.note}</span> },
            ]}
            density="compact"
          />
        </Surface>
      )}

      {tab === 'hooks' && (
        <Surface
          title="Webhook endpoints"
          bodyClassName="p-0"
          footer={<p className="text-[11px] leading-relaxed text-ink-4">A webhook is a notification, never an authorization. Nothing a receiver is told can widen what a policy permits.</p>}
        >
          <DataTable
            rows={sampleData.webhooks}
            rowKey={(hook) => hook.id}
            columns={[
              { key: 'url', header: 'Endpoint', cell: (hook) => <span className="font-mono text-xs text-ink">{hook.url}</span> },
              { key: 'events', header: 'Events', cell: (hook) => <span className="flex flex-wrap gap-1">{hook.events.map((event) => <Tag key={event} tone="neutral" mono>{event}</Tag>)}</span> },
              { key: 'status', header: 'Status', cell: (hook) => <StateCell value={hook.status} /> },
              { key: 'delivery', header: 'Last delivery', align: 'right', hideBelow: 'sm', cell: (hook) => <span className="font-mono text-[11px] text-ink-3">{relativeTime(hook.lastDelivery)}</span> },
              { key: 'failures', header: 'Failures', align: 'right', cell: (hook) => <span className="font-mono text-[11px]">{hook.failures === 0 ? 'none' : `${hook.failures} · retrying with backoff`}</span> },
            ]}
          />
        </Surface>
      )}

      {tab === 'env' && (
        <Surface title="Environments" bodyClassName="p-0">
          <DataTable
            rows={sampleData.environments}
            rowKey={(env) => env.key}
            columns={[
              { key: 'label', header: 'Environment', cell: (env) => <span className="text-[13px] text-ink">{env.label}</span> },
              { key: 'base', header: 'Base URL', cell: (env) => <span className="font-mono text-xs">{env.base}</span> },
              { key: 'status', header: 'Status', cell: (env) => <StateCell value={env.status} /> },
              { key: 'agents', header: 'Agents', align: 'right', cell: (env) => <span className="font-mono text-xs">{env.agents}</span> },
              { key: 'wallets', header: 'Wallets', align: 'right', cell: (env) => <span className="font-mono text-xs">{env.wallets}</span> },
            ]}
          />
        </Surface>
      )}

      {tab === 'logs' && (
        <Surface title="Request logs" bodyClassName="p-0">
          <DataTable
            rows={sampleData.auditEvents.filter((e) => e.type.startsWith('transaction') || e.type.startsWith('policy')).slice(0, 12)}
            rowKey={(event) => event.id}
            columns={[
              { key: 'at', header: 'Time', cell: (e) => <span className="font-mono text-[11px] text-ink-3">{relativeTime(e.at)}</span> },
              { key: 'type', header: 'Event', cell: (e) => <span className="font-mono text-xs">{e.type}</span> },
              { key: 'decision', header: 'Decision', cell: (e) => (e.decision === null ? <span className="text-[11px] text-ink-4">no decision</span> : <StateCell value={e.decision} />) },
              { key: 'req', header: 'Request', hideBelow: 'md', cell: (e) => <span className="font-mono text-[11px] text-ink-2">{shortHash(e.resourceId ?? '', 8)}</span> },
            ]}
            density="compact"
          />
        </Surface>
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

/* ==========================================================================
   Settings
   ========================================================================== */

export function Settings() {
  return (
    <>
      <PageHead
        title="Settings"
        lead="Tenancy, roles and the boundaries between them. Everything here is enforced by a role grant or a trigger, so a setting that reads as a control but is not one is a defect."
        actions={<Button onClick={() => toast('wait', 'No deployment is connected: nothing was saved. This console reads the sample tenant only.')}>Save organisation settings</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Surface title="Organisation">
            <Field label="Organisation name" hint="displayed to every member; the id below is what the API joins on">
              <Input defaultValue={sampleData.organization.name} />
            </Field>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Environment">
                <Select defaultValue={sampleData.organization.environment}>
                  {sampleData.environments.map((env) => <option key={env.key} value={env.key}>{env.label}</option>)}
                </Select>
              </Field>
              <Field label="Region">
                <Input defaultValue={sampleData.organization.region} />
              </Field>
            </div>
            <div className="mt-3 border-t border-line pt-3">
              <KeyValue dense items={[
                { k: 'organisation', v: <span className="font-mono">{shortHash(sampleData.organization.id, 8)}</span> },
                { k: 'created', v: relativeTime(sampleData.organization.createdAt) },
                { k: 'plan', v: sampleData.organization.plan },
              ]} />
            </div>
          </Surface>

          <Surface title="Runtime" bodyClassName="p-0">
            <div className="px-3 py-2.5">
              <KeyValue dense items={[
                { k: 'database role', v: <span className="font-mono">ari_app</span> },
                { k: 'row security', v: 'on every tenant-bearing table' },
                { k: 'signer', v: 'separate process, separate pool' },
              ]} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2.5">
              <span className="flex items-baseline gap-1.5 text-xs text-ink-3">
                <Lock size={14} weight="regular" className="translate-y-0.5 text-stop" />
                Revoking every credential stops all agents mid-flight and cannot be undone from this screen.
              </span>
              <Button variant="danger" onClick={() => toast('stop', 'No deployment is connected: no credential was revoked.')}>Revoke all agent credentials</Button>
            </div>
          </Surface>
        </div>

        <div className="space-y-4">
          <Surface title="People" bodyClassName="p-0">
            <DataTable
              rows={sampleData.users}
              rowKey={(user) => user.id}
              columns={[
                { key: 'name', header: 'Person', cell: (user) => (
                  <span className="block">
                    <span className="block text-[13px] text-ink">{user.name}</span>
                    <span className="block font-mono text-[11px] text-ink-3">{user.email}</span>
                  </span>
                ) },
                { key: 'role', header: 'Role', cell: (user) => <Tag tone={user.role === 'owner' ? 'accent' : 'neutral'}>{user.role}</Tag> },
                { key: 'status', header: 'Status', cell: (user) => <StateCell value={user.status} /> },
              ]}
              density="compact"
            />
            <p className="border-t border-line px-3 py-2.5 text-[11px] leading-relaxed text-ink-3">
              Suspending a person removes their right to decide on the next request; the credential lookup joins on it, and
              a test proves both halves. A status nobody reads is a write that lies to the operator.
            </p>
          </Surface>

          <Surface title="Scopes">
            <ul className="divide-y divide-line">
              {[
                ['transaction:request', 'held by an agent. Proposes a payment; cannot approve one.'],
                ['approval:decide', 'held by a person. Cannot be granted to an agent; a CHECK refuses the row.'],
                ['agent:manage', 'create, list and revoke agents; issue their credentials.'],
                ['wallet:manage', 'register a wallet and grant it to an agent under one version.'],
                ['policy:activate', 'publish a version; widening beyond the current one needs the owner role.'],
                ['audit:read', 'read the chain and export it.'],
              ].map(([scope, note]) => (
                <li key={scope} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 first:pt-0 last:pb-0">
                  <span className="w-[10.5rem] shrink-0 font-mono text-xs text-ink-2">{scope}</span>
                  <span className="min-w-0 text-[11px] text-ink-3">{note}</span>
                </li>
              ))}
            </ul>
          </Surface>

          <Surface title="What this deployment does not do yet">
            <ul className="space-y-1.5 text-[11px] leading-relaxed text-ink-3">
              <li>No user-session model: an approver is a bearer credential, not a cookie.</li>
              <li>No settlement: the lifecycle stops where Ari’s evidence stops.</li>
              <li>No real chain provider: simulation answers about the node it is pointed at.</li>
              <li>No price feed: a <span className="font-mono">usd_gte</span> rule drops a caller-supplied estimate rather than trusting it.</li>
            </ul>
          </Surface>
        </div>
      </div>
    </>
  );
}
