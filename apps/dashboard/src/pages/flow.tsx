import { CaretRight, Eye, Hourglass, MagnifyingGlass, ShieldCheck, Warning } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import {
  Block,
  Button,
  CopyButton,
  DataTable,
  EmptyState,
  FilterBar,
  Input,
  KeyValue,
  MetricBand,
  Modal,
  PageHead,
  RiskPip,
  Select,
  StateCell,
  StateTag,
  Surface,
  Tag,
  Tooltip,
  toast,
  type Column,
} from '../components/ui';
import { Amount, ApprovalRow, AgentIdentity, DecisionMark, PipelineRail, TransactionTrace } from '../components/product';
import { api, sampleData } from '../api/client';
import { EXECUTION_UNSETTLED } from '../domain/types';
import type { ApprovalRequest, TransactionRecord } from '../domain/types';
import { cx, relativeTime, shortAddress, shortHash, sentenceFromCode } from '../lib/util';
import { Link, useRouter } from '../app/router';

/* ==========================================================================
   The three screens over the money path
   --------------------------------------------------------------------------
   Transactions is the ledger of decisions, TransactionDetail is the evidence for
   one of them, Approvals is where a policy hands the problem to a person. Nothing
   on these three screens invents a chain fact: the lifecycle stops where Ari's
   evidence stops, and the primitives here say so in words rather than with a tick.
   ========================================================================== */

const agentName = (agentId: string): string => sampleData.agents.find((a) => a.id === agentId)?.name ?? agentId;

/** A contract call has no recipient; the contract it calls is the destination. */
const destinationOf = (tx: TransactionRecord): string | null => tx.recipient ?? tx.contract;

/**
 * How far the request actually got, expressed in `PIPELINE` steps.
 *
 * `AGENT` is step zero and is not a trace stage, so a trace index maps to the rail one later.
 * A stage that was never reached, and one left `UNSETTLED`, do not light their step: the rail
 * then ends at signing for a request whose settlement nobody has reported, which is the claim
 * the record can actually support.
 */
const stageReached = (tx: TransactionRecord): number =>
  tx.trace.reduce((last, step, index) => (step.state === 'NOT_REACHED' || step.state === 'UNSETTLED' ? last : index + 1), 0);

/** The sample tenant stores a placeholder where a contract call has no asset. */
const assetLabel = (approval: ApprovalRequest): string =>
  sampleData.transactionById(approval.requestId)?.kind === 'contract_call' ? 'not applicable, a contract call' : approval.asset;

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

  const allowed = filtered.filter((tx) => tx.outcome === 'ALLOW').length;
  const refused = filtered.filter((tx) => tx.outcome === 'DENY').length;
  const escalated = filtered.filter((tx) => tx.outcome === 'REQUIRE_HUMAN_APPROVAL').length;
  const unsettled = filtered.filter((tx) => EXECUTION_UNSETTLED.includes(tx.state)).length;

  const columns: readonly Column<TransactionRecord>[] = [
    {
      key: 'intent',
      header: 'Intent',
      cell: (tx) => (
        <div className="min-w-0">
          <div className="truncate text-[13px] text-ink">{tx.intent}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-4">
            <span className="font-mono">{agentName(tx.agentId)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{tx.policyName} v{tx.policyVersionNumber}</span>
          </div>
        </div>
      ),
      sortValue: (tx) => tx.intent,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (tx) => <Amount raw={tx.amountRaw} unit={tx.unit} size="sm" />,
      sortValue: (tx) => Number(BigInt(tx.amountRaw ?? '0')),
    },
    {
      key: 'to',
      header: 'Destination',
      hideBelow: 'md',
      cell: (tx) => {
        const to = destinationOf(tx);
        return to === null ? (
          <span className="text-[11px] text-ink-4">no destination</span>
        ) : (
          <span className="font-mono text-[11px] text-ink-2">{shortAddress(to)}</span>
        );
      },
    },
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
          <span className="inline-flex"><StateCell value={tx.state} /></span>
        </Tooltip>
      ),
      sortValue: (tx) => tx.submittedAt,
    },
    {
      key: 'when',
      header: 'When',
      align: 'right',
      hideBelow: 'sm',
      cell: (tx) => (
        <time className="font-mono text-[11px] text-ink-3" dateTime={tx.submittedAt} title={new Date(tx.submittedAt).toISOString()}>
          {relativeTime(tx.submittedAt)}
        </time>
      ),
      sortValue: (tx) => tx.submittedAt,
    },
  ];

  return (
    <>
      <PageHead
        title="Transactions"
        lead="Every request Ari has answered, with the decision and the reason beside it. A refusal is a row here, not a log line."
        actions={
          <Button
            variant="primary"
            onClick={() => toast('wait', 'Agent credentials are issued by an operator, not created from a browser.')}
          >
            New transfer request
          </Button>
        }
        meta={
          <>
            <span>{rows.length} requests</span>
            <span>{rows.filter((tx) => tx.outcome === 'DENY').length} refused</span>
            <span>{rows.filter((tx) => tx.outcome === 'REQUIRE_HUMAN_APPROVAL').length} awaiting a human</span>
            <span className="font-mono">policy versions: {new Set(rows.map((tx) => tx.policyVersionId)).size}</span>
          </>
        }
      />

      <MetricBand
        items={[
          { label: 'Decisions allowed', value: allowed, tone: 'ok', hint: 'the policy let these through without a person' },
          { label: 'Refused', value: refused, tone: 'stop', hint: 'each one keeps a row and its own reason codes' },
          { label: 'Awaiting a human', value: escalated, tone: 'wait', hint: 'quorum and roles are enforced by Ari’s database' },
          {
            label: 'Unsettled after signing',
            value: unsettled,
            tone: 'wait',
            hint: 'signed or ticketed, with no settlement reported back',
          },
        ]}
      />

      <div className="mt-4">
        <FilterBar>
          <div className="relative min-w-[14rem] flex-1 sm:max-w-xs">
            <MagnifyingGlass size={15} weight="regular" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4" />
            <Input
              placeholder="Filter by intent, agent, address or reason code"
              aria-label="Filter transactions"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-8"
            />
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
          <span className="ml-auto font-mono text-[11px] text-ink-4">{filtered.length} of {rows.length} in view</span>
        </FilterBar>

        <Surface title="Requests" bodyClassName="p-0">
          <DataTable
            rows={filtered}
            columns={columns}
            rowKey={(tx) => tx.id}
            onRowClick={(tx) => navigate(`/app/transactions/${tx.id}`)}
            empty={
              <EmptyState
                title="No transaction matches those filters"
                body="Ari keeps refusals, so a denied request is still a row here. If a request is not in this list, it never reached Ari: check the agent’s credential, not the log."
              />
            }
          />
        </Surface>
      </div>
    </>
  );
}

function LifecycleCopy({ tx }: { readonly tx: TransactionRecord }) {
  return (
    <span className="block space-y-1">
      <span className="block font-mono text-ink">{tx.state}</span>
      <span className="block text-ink-3">
        {EXECUTION_UNSETTLED.includes(tx.state)
          ? 'Ari stopped here on purpose: the signature was returned, and nothing has confirmed it on-chain. Settlement belongs to a provider callback or a reconciliation pass.'
          : tx.state === 'BROADCAST_CONFIRMED'
            ? 'Confirmed by the provider after finality.'
            : 'The lifecycle walked to this state and no further.'}
      </span>
    </span>
  );
}

/* ==========================================================================
   Transaction detail, the signature screen
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
      <Surface className="mx-auto mt-10 max-w-md" bodyClassName="p-0">
        <EmptyState
          title={`No transaction with id ${id}`}
          body="Ids are UUIDv7 and never sequential, so a mistyped one is not a hidden one."
          action={
            <Link to="/app/transactions">
              <Button>Back to transactions</Button>
            </Link>
          }
        />
      </Surface>
    );
  }

  const wallet = sampleData.walletById(tx.walletId);
  const governed = sampleData.policyVersionById(tx.policyVersionId);
  const destination = destinationOf(tx);
  const blockedStage = tx.trace.find((step) => step.state === 'BLOCKED')?.name ?? 'policy';
  const ticketExpired = tx.ticket !== null && Date.parse(tx.ticket.expiresAt) < Date.now();

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2.5 flex items-center gap-1 text-[11px] text-ink-4">
        <Link to="/app/transactions" className="transition-colors hover:text-ink-2">Transactions</Link>
        <CaretRight size={10} weight="bold" aria-hidden="true" />
        <span className="font-mono text-ink-3">{shortHash(tx.id, 8)}</span>
      </nav>

      <PageHead
        title={tx.intent}
        lead={
          tx.kind === 'contract_call'
            ? 'A contract call, evaluated by the same policy language as a transfer, with native value refused outright.'
            : 'A token transfer, with the decision that governed it and the digest every later step is sealed against.'
        }
        meta={
          <>
            <span className="font-mono">{tx.kind}</span>
            <span>submitted {relativeTime(tx.submittedAt)}</span>
            <span className="font-mono">{tx.id}</span>
            <span className="font-mono">idempotency {tx.idempotencyKey}</span>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* ---- The trace is the screen ------------------------------------ */}
        <div className="min-w-0 space-y-4">
          <Surface
            title="Authorization pipeline"
            action={
              <span className="text-[11px] text-ink-4">
                reconstructed from {tx.trace.reduce((n, step) => n + step.events.length, 0)} audit events
              </span>
            }
          >
            <div className="mb-4 overflow-x-auto pb-1">
              <PipelineRail active={stageReached(tx)} size="sm" />
            </div>
            <TransactionTrace tx={tx} />
          </Surface>

          <Surface title="What the agent asked for" action={<DecisionMark outcome={tx.outcome} />}>
            <Amount raw={tx.amountRaw} unit={tx.unit} size="lg" />
            {tx.kind === 'contract_call' && (
              <p className="mt-2 max-w-2xl text-[11px] leading-relaxed text-ink-3">
                A contract call moves no token amount. Native <span className="font-mono">value</span> is refused outright by the
                engine, <span className="font-mono text-ink-2">CONTRACT_VALUE_NOT_PERMITTED</span>, because every limit in the
                policy language is denominated in a token unit it cannot bound.
              </p>
            )}
            <div className="mt-3 border-t border-line pt-3">
              <KeyValue
                dense
                items={[
                  {
                    k: 'Destination',
                    v: destination === null ? (
                      <span className="text-ink-3">no destination</span>
                    ) : (
                      <span className="font-mono break-all">{destination}</span>
                    ),
                  },
                  { k: 'Chain', v: tx.chain },
                  ...(tx.kind === 'contract_call' ? [] : [{ k: 'Asset', v: tx.asset }]),
                  {
                    k: 'Requested by',
                    v: <AgentIdentity name={agentName(tx.agentId)} to={`/app/agents/${agentName(tx.agentId)}`} />,
                  },
                  {
                    k: 'Wallet',
                    v: (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <span>{wallet?.name ?? tx.walletId}</span>
                        <Tag tone={wallet?.mode === 'delegated' ? 'wait' : 'ok'}>{wallet?.mode ?? 'unknown'}</Tag>
                        <span className="text-ink-4">{wallet?.provider}</span>
                      </span>
                    ),
                  },
                ]}
              />
            </div>
          </Surface>
        </div>

        {/* ---- What an auditor would ask for ----------------------------- */}
        <div className="min-w-0 space-y-4">
          <Surface title="Decision">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <StateTag value={tx.outcome} />
              <span className="text-[11px] text-ink-4">left the lifecycle at</span>
              <StateCell value={tx.state} />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-3">
              {tx.outcome === 'ALLOW'
                ? 'Every stage that had to pass did. The advisory plane could only have refused, never granted.'
                : tx.outcome === 'DENY'
                  ? `Refused at the ${blockedStage} stage. The reason codes below are the engine’s own.`
                  : 'Within limits, but a condition this policy wrote down sends it to a named human.'}
            </p>
            {EXECUTION_UNSETTLED.includes(tx.state) && (
              <p className="mt-2.5 flex items-start gap-1.5 border-t border-line pt-2.5 text-[11px] leading-relaxed text-ink-3">
                <Hourglass size={14} weight="regular" className="mt-[2px] shrink-0 text-wait" />
                <span>This record stops at signing. Settlement has not been earned: no provider callback and no reconciliation pass has confirmed it.</span>
              </p>
            )}
            {tx.codes.length > 0 && (
              <div className="mt-2.5 border-t border-line pt-2.5">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Warning size={14} weight="regular" className="text-stop" />
                  <span className="label">Reason codes</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {tx.codes.map((code) => (
                    <Tag key={code} tone="stop" mono>{code}</Tag>
                  ))}
                </div>
              </div>
            )}
          </Surface>

          {tx.risk !== null && (
            <Surface
              title="Risk"
              action={
                <span className="inline-flex items-center gap-1 text-[11px] text-ink-4">
                  <Eye size={14} weight="regular" /> advisory
                </span>
              }
            >
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <RiskPip level={tx.risk.level} />
                  <span className="text-sm text-ink">{tx.risk.level.toLowerCase()}</span>
                </span>
                <span className="font-mono text-[11px] text-ink-3">score {tx.risk.score.toFixed(2)}</span>
              </div>
              <ul className="mt-2 space-y-1">
                {tx.risk.signals.length === 0 ? (
                  <li className="text-[11px] text-ink-4">No signal crossed its weight.</li>
                ) : (
                  tx.risk.signals.map((signal) => (
                    <li key={signal} className="flex items-start gap-1.5 text-[11px] text-ink-2">
                      <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-wait" aria-hidden="true" />
                      {sentenceFromCode(signal)}
                    </li>
                  ))
                )}
              </ul>
              <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-ink-4">
                {tx.risk.baselineWindowDays}-day behavioural baseline, model <span className="font-mono">{tx.risk.modelVersion}</span>.
                Risk can escalate or refuse; it structurally cannot grant.
              </p>
            </Surface>
          )}

          <Surface title="What the record binds" bodyClassName="p-0">
            <Block label="Canonical digest" hint="canon/v1">
              <div className="flex items-start justify-between gap-3">
                <code className="min-w-0 break-all text-[11px] leading-relaxed text-ink-2">{tx.digest}</code>
                <span className="shrink-0"><CopyButton value={tx.digest} label="Copy digest" /></span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-4">
                Derived inside the policy engine and never accepted from a caller. The same bytes are re-hashed at approval
                redemption, at ticket minting and at signing: three independent comparisons, because every substitution threat in
                this system is a way of getting signed something other than what was looked at.
              </p>
            </Block>

            <Block label="Governing policy version" hint={governed === undefined ? 'not in this tenant' : undefined}>
              <Link
                to={`/app/policies/${governed?.policy.key ?? ''}`}
                className="text-xs text-accent transition-colors hover:text-accent-strong"
              >
                {tx.policyName} v{tx.policyVersionNumber}
              </Link>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-4">
                {governed !== undefined && <StateTag value={governed.version.status} />}
                <span>version id <span className="font-mono">{shortHash(tx.policyVersionId, 8)}</span></span>
              </div>
              {governed !== undefined && (
                <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{governed.version.summary}</p>
              )}
            </Block>

            {tx.ticket !== null && (
              <Block label="Single-use ticket" hint="60 second TTL">
                <KeyValue
                  dense
                  items={[
                    { k: 'id', v: <span className="font-mono">{shortHash(tx.ticket.id, 8)}</span> },
                    { k: 'minted', v: relativeTime(tx.ticket.mintedAt) },
                    {
                      k: 'expires',
                      v: (
                        <span className={cx('font-mono', ticketExpired ? 'text-ink-4' : 'text-ink-2')}>
                          {relativeTime(tx.ticket.expiresAt)}
                        </span>
                      ),
                    },
                    {
                      k: 'redeemed',
                      v: tx.ticket.redeemedAt === null ? (
                        <span className="text-ink-3">not redeemed</span>
                      ) : (
                        <span className="font-mono text-ok">once · {relativeTime(tx.ticket.redeemedAt)}</span>
                      ),
                    },
                  ]}
                />
                <p className="mt-2 text-[11px] leading-relaxed text-ink-4">
                  Single use, 60 second TTL, sealed to this digest. The columns that define what was authorized cannot be edited
                  after minting: a trigger refuses it, and editing one would not amend an authorization but forge a different one.
                </p>
              </Block>
            )}

            <Block label="References">
              <KeyValue
                stacked
                items={[
                  { k: 'Request id', v: <span className="font-mono break-all">{tx.requestId}</span> },
                  { k: 'Transaction id', v: <span className="font-mono break-all">{tx.id}</span> },
                  { k: 'Idempotency key', v: <span className="font-mono break-all">{tx.idempotencyKey}</span> },
                ]}
              />
              <div className="mt-1.5 flex items-center gap-3">
                <CopyButton value={tx.requestId} label="Copy request id" />
                <CopyButton value={tx.idempotencyKey} label="Copy idempotency key" />
              </div>
            </Block>
          </Surface>

          <Surface
            title="What Ari does not know"
            action={<ShieldCheck size={15} weight="regular" className="text-ink-4" />}
          >
            <p className="text-[11px] leading-relaxed text-ink-3">
              This record ends where Ari’s evidence ends. Nothing here claims a chain confirmation that a provider has not
              reported, and a signature returned by a mock is labelled as such rather than drawn as a tick. The figures on this
              screen come from a sample tenant, not from a node.
            </p>
          </Surface>
        </div>
      </div>
    </>
  );
}

/* ==========================================================================
   Approvals
   ========================================================================== */

const decidedColumns: readonly Column<ApprovalRequest>[] = [
  {
    key: 'reason',
    header: 'Request',
    cell: (approval) => (
      <div className="min-w-0">
        <div className="truncate text-[13px] text-ink">{approval.reason}</div>
        <div className="mt-0.5 font-mono text-[11px] text-ink-4">{agentName(approval.agentId)}</div>
      </div>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    align: 'right',
    cell: (approval) => <Amount raw={approval.amountRaw} unit={approval.unit} size="sm" />,
  },
  { key: 'status', header: 'Outcome', cell: (approval) => <StateCell value={approval.status} /> },
  {
    key: 'votes',
    header: 'Votes',
    align: 'right',
    hideBelow: 'md',
    cell: (approval) => (
      <span className="font-mono text-[11px] text-ink-2">
        {approval.votes.filter((vote) => vote.decision === 'APPROVED').length} of {approval.quorum}
      </span>
    ),
  },
  {
    key: 'expires',
    header: 'Expires',
    hideBelow: 'lg',
    cell: (approval) => (
      <time className="font-mono text-[11px] text-ink-4" dateTime={approval.expiresAt}>
        {relativeTime(approval.expiresAt)}
      </time>
    ),
  },
  {
    key: 'digest',
    header: 'Digest',
    hideBelow: 'lg',
    cell: (approval) => <span className="font-mono text-[11px] text-ink-3">{shortHash(approval.digest, 8)}</span>,
  },
];

export function Approvals() {
  const [open, setOpen] = useState<string | null>(null);
  const [decision, setDecision] = useState<{ id: string; kind: 'APPROVED' | 'REJECTED' } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const approvals = sampleData.approvals;
  const pending = approvals.filter((approval) => approval.status === 'PENDING');
  const decided = approvals.filter((approval) => approval.status !== 'PENDING');
  const target = pending.find((approval) => approval.id === open) ?? null;

  const closeReview = (): void => {
    setOpen(null);
    setDecision(null);
  };

  const submit = (kind: 'APPROVED' | 'REJECTED'): void => {
    if (target === null) return;
    setSubmitting(true);
    void api.decide(target.id, kind).then((result) => {
      toast(result.ok ? 'ok' : 'wait', result.detail);
      setSubmitting(false);
      closeReview();
    });
  };

  return (
    <>
      <PageHead
        title="Approvals"
        lead="What a policy decided it should not decide alone. A vote is recorded against the row, and the token that releases a signature is minted from that row, not from this browser."
        meta={
          <>
            <span>{pending.length} waiting</span>
            <span>quorum enforced in Postgres</span>
            <span className="font-mono">approval_reuse_attempted is a first-class event</span>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="text-[13px] font-medium text-ink">Waiting on a person</h2>
            <span className="font-mono text-[11px] text-ink-4">{pending.length} in the queue</span>
          </div>

          {pending.length === 0 ? (
            <Surface bodyClassName="p-0">
              <EmptyState
                title="Nothing is waiting on a human"
                body="That is not the same as nothing needing one: an empty queue means every request today stayed inside a policy someone wrote down. The queue is where Ari’s limits stop being numbers."
              />
            </Surface>
          ) : (
            <div className="flex flex-col gap-2.5">
              {pending.map((approval) => (
                <ApprovalRow
                  key={approval.id}
                  approval={approval}
                  agentName={agentName(approval.agentId)}
                  onReview={() => setOpen(approval.id)}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="min-w-0">
          <Surface title="How a vote becomes a signature">
            <p className="text-[11px] leading-relaxed text-ink-3">
              A vote is written against the request row. The token that later releases a signature binds the digest, the policy
              version, the agent, the wallet, the amount and an expiry, and it is read back from that row, so this screen cannot
              state a different amount than the one being approved.
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
              Once a payment is approved, changing what was approved is the one substitution that would survive every check
              afterwards. That is why those columns are frozen in the schema while humans are voting.
            </p>
            <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-ink-4">
              An expired approval is not a soft failure: the request stops, and a retry has to be decided again by a person.
            </p>
          </Surface>
        </aside>
      </div>

      <Surface
        className="mt-5"
        title="Decided, and out of the queue"
        action={<span className="text-[11px] text-ink-4">granted, rejected, expired or consumed</span>}
        bodyClassName="p-0"
      >
        <DataTable
          rows={decided}
          columns={decidedColumns}
          rowKey={(approval) => approval.id}
          density="compact"
          empty={
            <EmptyState
              title="No decided approvals in this tenant"
              body="Every approval row in the sample tenant is still PENDING. Ari keeps a decided row as GRANTED, REJECTED, EXPIRED or CONSUMED, and the queue above holds only what still needs a person."
            />
          }
        />
      </Surface>

      {target !== null && (
        <Modal
          open
          onClose={closeReview}
          title={decision === null ? 'Review this request' : decision.kind === 'APPROVED' ? 'Approve and seal the token' : 'Reject and end the request'}
          subtitle={`${target.reason} · ${agentName(target.agentId)}`}
          footer={
            decision === null ? (
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-ink-4">Choose what you are recording, not whether to continue.</span>
                <div className="flex gap-2">
                  <Button variant="danger" onClick={() => setDecision({ id: target.id, kind: 'REJECTED' })}>
                    Reject this transfer
                  </Button>
                  <Button variant="primary" onClick={() => setDecision({ id: target.id, kind: 'APPROVED' })}>
                    Approve this transfer
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <Button variant="ghost" onClick={() => setDecision(null)}>Change the vote</Button>
                <Button
                  variant={decision.kind === 'APPROVED' ? 'primary' : 'danger'}
                  disabled={submitting}
                  onClick={() => submit(decision.kind)}
                >
                  {submitting ? 'Recording' : decision.kind === 'APPROVED' ? 'Approve and seal the token' : 'Reject and end the request'}
                </Button>
              </div>
            )
          }
        >
          <div className="space-y-3">
            <Surface title="You are authorizing exactly this">
              <KeyValue
                dense
                items={[
                  { k: 'amount', v: <Amount raw={target.amountRaw} unit={target.unit} /> },
                  { k: 'asset', v: assetLabel(target) },
                  {
                    k: 'destination',
                    v: <span className="font-mono break-all">{target.recipient === null ? 'no destination' : target.recipient}</span>,
                  },
                  { k: 'wallet', v: sampleData.walletById(target.walletId)?.name ?? target.walletId },
                  { k: 'policy', v: `${target.policyName} v${target.policyVersionNumber}` },
                  { k: 'digest', v: <span className="font-mono">{shortHash(target.digest, 10)}</span> },
                  { k: 'expires', v: relativeTime(target.expiresAt) },
                ]}
              />
            </Surface>
            <p className="text-xs leading-relaxed text-ink-3">
              Ari re-checks this row before it mints a ticket. Your vote is sealed against the digest above, not against what
              this screen displayed.
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}
