import { useMemo, useState } from 'react';
import { Badge, Button, DataTable, FilterBar, Input, Modal, PageHeader, Panel, Select, Status, Tooltip, toast, type Column, type Tone } from '../components/ui';
import { Amount, ApprovalCard, DecisionMark, PipelineRail, TransactionTrace } from '../components/product';
import { sampleData } from '../api/client';
import type { TransactionRecord } from '../domain/types';
import { cx, money, relativeTime, shortAddress, shortHash, sentenceFromCode } from '../lib/util';
import { useRouter } from '../app/router';
import { Link } from '../app/router';

const agentName = (agentId: string): string => sampleData.agents.find((a) => a.id === agentId)?.name ?? agentId;

/* ==========================================================================
   Transactions
   ========================================================================== */

export function Transactions() {
  const { navigate } = useRouter();
  const rows = sampleData.transactions;
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState('ALL');
  const [agent, setAgent] = useState('ALL');

  const filtered = useMemo(
    () =>
      rows.filter((tx) => {
        if (outcome !== 'ALL' && tx.outcome !== outcome) return false;
        if (agent !== 'ALL' && tx.agentId !== agent) return false;
        if (query.trim().length > 0) {
          const hay = `${tx.intent} ${agentName(tx.agentId)} ${tx.id} ${tx.requestId} ${tx.recipient ?? ''} ${tx.contract ?? ''} ${tx.codes.join(' ')}`.toLowerCase();
          if (!hay.includes(query.trim().toLowerCase())) return false;
        }
        return true;
      }),
    [rows, query, outcome, agent],
  );

  const columns: readonly Column<TransactionRecord>[] = [
    {
      key: 'intent',
      header: 'Intent',
      cell: (tx) => (
        <div className="min-w-0">
          <div className="truncate text-[13px] text-ink">{tx.intent}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-2xs text-ink-faint">
            <span className="mono">{agentName(tx.agentId)}</span>
            <span>·</span>
            <span className="mono">{tx.policyName} v{tx.policyVersionNumber}</span>
          </div>
        </div>
      ),
      sortValue: (tx) => tx.intent,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (tx) => <Amount raw={tx.amountRaw} unit={tx.unit} />,
      sortValue: (tx) => Number(BigInt(tx.amountRaw ?? '0')),
    },
    { key: 'to', header: 'Destination', hideBelow: 'md', cell: (tx) => <span className="mono text-2xs text-ink-dim">{shortAddress(tx.recipient ?? tx.contract)}</span> },
    {
      key: 'decision',
      header: 'Decision',
      cell: (tx) => <DecisionMark outcome={tx.outcome} codes={tx.codes} />,
      sortValue: (tx) => tx.outcome,
    },
    {
      key: 'state',
      header: 'Lifecycle',
      hideBelow: 'lg',
      cell: (tx) => (
        <Tooltip content={<LifecycleCopy tx={tx} />}>
          <span><Status value={tx.state} label={sentenceFromCode(tx.state)} /></span>
        </Tooltip>
      ),
      sortValue: (tx) => tx.submittedAt,
    },
    { key: 'when', header: 'When', align: 'right', hideBelow: 'sm', cell: (tx) => <span className="num text-2xs text-ink-mute">{relativeTime(tx.submittedAt)}</span> },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Ledger"
        title="Transactions"
        lead="Every request Ari has answered, with the decision and the reason beside it. A refusal is a row here, not a log line."
        actions={
          <Button variant="primary" icon={<PlusGlyph />} onClick={() => toast('caution', 'Agent credentials are issued by an operator, not created from a browser.')}>
            New request
          </Button>
        }
        meta={
          <>
            <span>{rows.length} requests</span>
            <span>{rows.filter((t) => t.outcome === 'DENY').length} refused</span>
            <span>{rows.filter((t) => t.outcome === 'REQUIRE_HUMAN_APPROVAL').length} awaiting a human</span>
            <span className="mono">policy versions: {new Set(rows.map((t) => t.policyVersionId)).size}</span>
          </>
        }
      />

      <FilterBar>
        <div className="relative min-w-[14rem] flex-1 sm:max-w-xs">
          <Input placeholder="Filter by intent, agent, address, reason…" value={query} onChange={(event) => setQuery(event.target.value)} className="pr-8" />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint">/</span>
        </div>
        <Select value={outcome} onChange={(event) => setOutcome(event.target.value)} aria-label="Filter by decision">
          <option value="ALL">Any decision</option>
          <option value="ALLOW">ALLOW</option>
          <option value="REQUIRE_HUMAN_APPROVAL">REQUIRE_HUMAN_APPROVAL</option>
          <option value="DENY">DENY</option>
        </Select>
        <Select value={agent} onChange={(event) => setAgent(event.target.value)} aria-label="Filter by agent">
          <option value="ALL">Any agent</option>
          {sampleData.agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </Select>
        <span className="ml-auto text-2xs text-ink-faint">{filtered.length} of {rows.length}</span>
      </FilterBar>

      <Panel pad={false}>
        <DataTable
          rows={filtered}
          columns={columns}
          rowKey={(tx) => tx.id}
          initialSort={{ key: 'state', dir: 'desc' }}
          onRowClick={(tx) => navigate(`/app/transactions/${tx.id}`)}
          empty={
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-ink">No transaction matches those filters.</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-ink-mute">
                Ari keeps refusals. If a request is not here, it never reached Ari — check the agent’s credential, not the log.
              </p>
            </div>
          }
        />
      </Panel>
    </>
  );
}

function LifecycleCopy({ tx }: { readonly tx: TransactionRecord }) {
  return (
    <span className="block space-y-1">
      <span className="block text-ink">{sentenceFromCode(tx.state)}</span>
      <span className="block text-ink-mute">
        {tx.state === 'SIGNING_COMPLETE' || tx.state === 'TICKET_MINTED'
          ? 'Ari stopped here on purpose: the signature was returned, and nothing has confirmed it on-chain. Settlement belongs to a provider callback or a reconciliation pass.'
          : tx.state === 'BROADCAST_CONFIRMED'
            ? 'Confirmed by the provider after finality.'
            : 'The lifecycle walked to this state and no further.'}
      </span>
    </span>
  );
}

const PlusGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
  </svg>
);

/* ==========================================================================
   Transaction detail — the signature screen
   ========================================================================== */

export function TransactionDetail({ id }: { readonly id: string }) {
  // `latest` is a stable link to the most recent decision, which is what a sidebar or a
  // notification wants without guessing a UUIDv7 it cannot enumerate.
  const tx =
    id === 'latest'
      ? [...sampleData.transactions].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0]
      : sampleData.transactionById(id);
  if (tx === undefined) {
    return (
      <Panel className="mt-10">
        <div className="px-4 py-10 text-center">
          <p className="text-sm text-ink">No transaction with id <span className="mono">{id}</span>.</p>
          <p className="mt-1 text-xs text-ink-mute">Ids are UUIDv7 and never sequential; a mistyped one is not a hidden one.</p>
          <Link to="/app/transactions"><Button className="mt-4">Back to transactions</Button></Link>
        </div>
      </Panel>
    );
  }

  const blockedIndex = tx.trace.findIndex((s) => s.state === 'BLOCKED');
  const tone: Tone = tx.outcome === 'ALLOW' ? 'allow' : tx.outcome === 'DENY' ? 'deny' : 'caution';
  const wallet = sampleData.walletById(tx.walletId);

  return (
    <>
      <div className="mb-3 flex items-center gap-2 text-2xs text-ink-faint">
        <Link to="/app/transactions" className="hover:text-ink-dim">Transactions</Link>
        <span>/</span>
        <span className="mono">{shortHash(tx.id, 8)}</span>
      </div>

      <PageHeader
        eyebrow={tx.kind === 'contract_call' ? 'Contract call' : 'Token transfer'}
        title={tx.intent}
        meta={
          <>
            <span>submitted {relativeTime(tx.submittedAt)}</span>
            <span className="mono">{tx.id}</span>
            <span className="mono">idempotency {tx.idempotencyKey}</span>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="space-y-4">
          <Panel
            title="Authorization pipeline"
            action={<span className="text-2xs text-ink-faint">reconstructed from {tx.trace.reduce((n, s) => n + s.events.length, 0)} audit events</span>}
          >
            <div className="mb-4 overflow-x-auto pb-1">
              <PipelineRail active={blockedIndex >= 0 ? blockedIndex + 1 : tx.trace.length} size="sm" />
            </div>
            <TransactionTrace tx={tx} />
          </Panel>

          <Panel title="What was authorized" action={<Badge tone={tone}>{tx.outcome}</Badge>}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Amount">
                <Amount raw={tx.amountRaw} unit={tx.unit} size="lg" />
                {tx.kind === 'contract_call' && (
                  <p className="mt-1 text-2xs leading-relaxed text-ink-mute">
                    A contract call moves no token amount. Native <span className="mono">value</span> is refused outright by the
                    engine — <span className="mono text-ink-dim">CONTRACT_VALUE_NOT_PERMITTED</span> — because every limit in the
                    policy language is denominated in a token unit it cannot bound.
                  </p>
                )}
              </Field>
              <Field label="Destination">
                <div className="mono break-all text-xs text-ink">{tx.recipient ?? tx.contract}</div>
                <div className="mt-1 text-2xs text-ink-faint">chain {tx.chain} · asset {tx.asset}</div>
              </Field>
              <Field label="Governing policy">
                <Link to={`/app/policies/${tx.policyName.toLowerCase().replaceAll(' ', '-')}`} className="text-xs text-brand hover:text-brand-strong">
                  {tx.policyName} v{tx.policyVersionNumber}
                </Link>
                <div className="mt-1 text-2xs text-ink-faint">version id <span className="mono">{shortHash(tx.policyVersionId, 8)}</span></div>
              </Field>
              <Field label="Wallet">
                <div className="text-xs text-ink">{wallet?.name ?? tx.walletId}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-ink-faint">
                  <Badge tone={wallet?.mode === 'delegated' ? 'caution' : 'allow'}>{wallet?.mode ?? 'unknown'}</Badge>
                  <span>{wallet?.provider}</span>
                </div>
              </Field>
            </div>

            <div className="mt-4 rounded-[var(--radius-sm)] border border-hair bg-[#080b0e] p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="eyebrow">Canonical digest</span>
                <span className="mono text-2xs text-ink-faint">canon/v1</span>
              </div>
              <p className="mono mt-1 break-all text-[11px] leading-relaxed text-ink-dim">{tx.digest}</p>
              <p className="mt-2 text-2xs leading-relaxed text-ink-mute">
                Derived inside the policy engine and never accepted from a caller. The same bytes are re-hashed at approval
                redemption, at ticket minting and at signing — three independent comparisons, because every substitution threat
                in this system is a way of getting signed something other than what was looked at.
              </p>
            </div>
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Decision">
            <div className="flex items-baseline gap-2">
              <span className={cx('text-2xl font-semibold tracking-tight', tone === 'allow' ? 'text-allow' : tone === 'deny' ? 'text-deny' : 'text-caution')}>
                {tx.outcome === 'REQUIRE_HUMAN_APPROVAL' ? 'Approval required' : tx.outcome}
              </span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-mute">
              {tx.outcome === 'ALLOW'
                ? 'Every stage that had to pass did. The advisory plane could only have refused, never granted.'
                : tx.outcome === 'DENY'
                  ? `Refused at ${tx.trace.find((s) => s.state === 'BLOCKED')?.name ?? 'policy'} — reason codes below are the engine’s own.`
                  : 'Within limits, but a condition this policy wrote down sends it to a named human.'}
            </p>
            {tx.codes.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {tx.codes.map((code) => (
                  <Badge key={code} tone={tone} mono>{code}</Badge>
                ))}
              </div>
            )}
          </Panel>

          {tx.risk !== null && (
            <Panel title="Risk" action={<span className="text-2xs text-ink-faint">advisory</span>}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm capitalize text-ink">{tx.risk.level.toLowerCase()}</span>
                <span className="num text-2xs text-ink-mute">score {tx.risk.score.toFixed(2)}</span>
              </div>
              <ul className="mt-2 space-y-1">
                {tx.risk.signals.length === 0 ? (
                  <li className="text-2xs text-ink-faint">No signal crossed its weight.</li>
                ) : (
                  tx.risk.signals.map((signal) => (
                    <li key={signal} className="flex items-center gap-1.5 text-2xs text-ink-dim">
                      <span className="h-1 w-1 rounded-full bg-caution" />
                      {sentenceFromCode(signal)}
                    </li>
                  ))
                )}
              </ul>
              <p className="mt-2 border-t border-hair-faint pt-2 text-2xs leading-relaxed text-ink-faint">
                {tx.risk.baselineWindowDays}-day behavioural baseline · model <span className="mono">{tx.risk.modelVersion}</span>.
                Risk can escalate or refuse; it structurally cannot grant.
              </p>
            </Panel>
          )}

          {tx.ticket !== null && (
            <Panel title="Ticket">
              <dl className="space-y-1.5 text-xs">
                <Row k="id" v={<span className="mono">{shortHash(tx.ticket.id, 8)}</span>} />
                <Row k="minted" v={relativeTime(tx.ticket.mintedAt)} />
                <Row k="expires" v={relativeTime(tx.ticket.expiresAt)} />
                <Row k="redeemed" v={tx.ticket.redeemedAt === null ? 'not redeemed' : <span className="text-allow">once · {relativeTime(tx.ticket.redeemedAt)}</span>} />
              </dl>
              <p className="mt-2 text-2xs leading-relaxed text-ink-mute">
                Single use, 60 second TTL, sealed to this digest. The columns that define what was authorized cannot be edited
                after minting — a trigger refuses it, and editing one would not amend an authorization but forge a different one.
              </p>
            </Panel>
          )}

          <Panel title="What Ari does not know">
            <p className="text-2xs leading-relaxed text-ink-mute">
              This record ends where Ari's evidence ends. Nothing here claims a chain confirmation that a provider has not
              reported, and a signature returned by a mock is labelled as such rather than drawn as a tick.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow mb-1">{label}</div>
      {children}
    </div>
  );
}

function Row({ k, v }: { readonly k: string; readonly v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-mute">{k}</dt>
      <dd className="min-w-0 truncate text-right text-ink">{v}</dd>
    </div>
  );
}

/* ==========================================================================
   Approvals
   ========================================================================== */

export function Approvals() {
  const [open, setOpen] = useState<string | null>(null);
  const [decision, setDecision] = useState<{ id: string; kind: 'APPROVED' | 'REJECTED' } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pending = sampleData.approvals;
  const target = pending.find((a) => a.id === open) ?? null;

  const submit = (): void => {
    setSubmitting(true);
    const result = { ok: false, detail: 'No deployment is connected. A decision here would be a screenshot, not a vote.' };
    window.setTimeout(() => {
      setSubmitting(false);
      setOpen(null);
      setDecision(null);
      toast(result.ok ? 'allow' : 'caution', result.detail);
    }, 420);
  };

  return (
    <>
      <PageHeader
        eyebrow="Human control"
        title="Approvals"
        lead="What a policy decided it should not decide alone. A vote is recorded against the row, and the token that releases a signature is minted from that row — not from this browser."
        meta={
          <>
            <span>{pending.length} waiting</span>
            <span>quorum enforced in Postgres</span>
            <span className="mono">approval_reuse_attempted is a first-class event</span>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {pending.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            agentName={agentName(approval.agentId)}
            onOpen={() => setOpen(approval.id)}
          />
        ))}
        {pending.length === 0 && (
          <Panel className="lg:col-span-2">
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-ink">Nothing is waiting on a human.</p>
              <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-mute">
                That is not the same as nothing needing one: an empty queue means every request today stayed inside a policy
                someone wrote down. The queue is where Ari’s limits stop being numbers.
              </p>
            </div>
          </Panel>
        )}
      </div>

      <Modal
        open={open !== null && target !== null}
        onClose={() => { setOpen(null); setDecision(null); }}
        title={decision === null ? 'Authorize this transaction' : decision.kind === 'APPROVED' ? 'Approve and seal' : 'Refuse this request'}
        subtitle={target === null ? undefined : `${target.reason} · ${agentName(target.agentId)}`}
        footer={
          decision === null ? (
            <div className="flex w-full items-center justify-between gap-2">
              <span className="text-2xs text-ink-faint">Choose what you are recording, not whether to continue.</span>
              <div className="flex gap-2">
                <Button variant="danger" onClick={() => setDecision({ id: target!.id, kind: 'REJECTED' })}>Refuse this payment</Button>
                <Button variant="primary" onClick={() => setDecision({ id: target!.id, kind: 'APPROVED' })}>Approve this payment</Button>
              </div>
            </div>
          ) : (
            <div className="flex w-full items-center justify-between gap-2">
              <Button variant="ghost" onClick={() => setDecision(null)}>Back</Button>
              <Button variant={decision.kind === 'APPROVED' ? 'primary' : 'danger'} disabled={submitting} onClick={submit}>
                {submitting ? 'Recording…' : decision.kind === 'APPROVED' ? 'Approve and seal the token' : 'Refuse and end the request'}
              </Button>
            </div>
          )
        }
      >
        {target !== null && (
          <div className="space-y-3">
            <div className="rounded-[var(--radius-md)] border border-hair-strong bg-raised p-3">
              <div className="eyebrow">You are authorizing exactly this</div>
              <div className="mt-2 space-y-1.5 text-xs">
                <Line2 k="amount" v={<Amount raw={target.amountRaw} unit={target.unit} />} />
                <Line2 k="asset" v={target.asset} />
                <Line2 k="recipient" v={<span className="mono break-all">{target.recipient}</span>} />
                <Line2 k="wallet" v={sampleData.walletById(target.walletId)?.name ?? target.walletId} />
                <Line2 k="policy" v={`${target.policyName} v${target.policyVersionNumber}`} />
                <Line2 k="digest" v={<span className="mono">{shortHash(target.digest, 10)}</span>} />
              </div>
            </div>
            <p className="text-xs leading-relaxed text-ink-mute">
              The token returned on approval binds the digest, the policy version, the agent, the wallet, the amount and an
              expiry. It is read from the row that recorded the vote, so this screen cannot state a different amount than the
              one being approved — and once a payment is approved, changing what was approved is the one substitution that
              would survive every check afterwards. That is why these fields are frozen in the schema while humans are voting.
            </p>
            <div className="rounded-[var(--radius-sm)] border border-hair bg-surface p-2.5 text-2xs leading-relaxed text-ink-mute">
              <span className="font-medium text-ink-dim">Expires {relativeTime(target.expiresAt)}.</span> An expired approval is
              not a soft failure: the request stops, and a retry has to be decided again by a person.
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function Line2({ k, v }: { readonly k: string; readonly v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-2xs uppercase tracking-[0.06em] text-ink-mute">{k}</span>
      <span className="min-w-0 text-right text-ink">{v}</span>
    </div>
  );
}

export function TransactionSummaryStrip({ tx }: { readonly tx: TransactionRecord }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-2xs text-ink-mute">
      <span>{money(tx.amountRaw, tx.unit)}</span>
      <span className="mono">{agentName(tx.agentId)}</span>
      <span>{relativeTime(tx.submittedAt)}</span>
      <Status value={tx.state} label={sentenceFromCode(tx.state)} dot={false} />
    </div>
  );
}
