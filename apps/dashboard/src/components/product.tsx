import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApprovalRequest, AuditEvent, PolicyDocumentShape, TraceStage, TransactionRecord } from '../domain/types';
import { toneFor, Badge, Icon, Meter, RiskPip, Status, Tooltip, type Tone } from './ui';
import { cx, money, relativeTime, shortAddress, shortHash, sentenceFromCode, clockTime } from '../lib/util';
import { Link } from '../app/router';

/* ==========================================================================
   The mark
   ========================================================================== */

/**
 * The supplied SVG, painted from a token through a CSS mask (see `.ari-mark` in
 * `styles/tokens.css`). Geometry untouched at every size; only the colour is ours.
 */
export function Mark({ size = 22, className }: { readonly size?: number; readonly className?: string }) {
  return <span aria-hidden="true" className={cx('ari-mark shrink-0', className)} style={{ width: size, height: size }} />;
}

export function Wordmark({ size = 22, href = '/', showLabel = true }: { readonly size?: number; readonly href?: string; readonly showLabel?: boolean }) {
  return (
    <Link to={href} className="group flex items-center gap-2.5" aria-label="ARI home">
      <span className="text-ink transition-colors group-hover:text-brand-strong">
        <Mark size={size} />
      </span>
      {showLabel && (
        <span className="flex flex-col leading-none">
          <span className="text-[13px] font-semibold tracking-[0.14em] text-ink">ARI</span>
          <span className="mt-[3px] text-[9px] uppercase tracking-[0.14em] text-ink-faint">control layer</span>
        </span>
      )}
    </Link>
  );
}

/* ==========================================================================
   The pipeline, as one object used in three places
   ========================================================================== */

export const PIPELINE = ['AGENT', 'INTENT', 'POLICY', 'RISK', 'APPROVAL', 'SIGN', 'EXECUTE'] as const;

/**
 * The authorization pipeline as a rail.
 *
 * Used on the landing hero (where it is the product explained in one line) and on the
 * transaction page (where it is the same seven steps, but with the state each one actually
 * reached). Keeping one component for both is what stops the marketing diagram and the
 * engineering diagram from disagreeing about what the system does.
 */
export function PipelineRail({ active = -1, size = 'md', animate = false }: { readonly active?: number; readonly size?: 'sm' | 'md' | 'lg'; readonly animate?: boolean }) {
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (!animate) return;
    const timer = window.setInterval(() => setPulse((current) => (current + 1) % (PIPELINE.length + 3)), 900);
    return () => window.clearInterval(timer);
  }, [animate]);

  const box = size === 'lg' ? 'h-11 px-3.5 text-[11px]' : size === 'md' ? 'h-9 px-3 text-[10px]' : 'h-7 px-2 text-[9px]';

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="img" aria-label={`ARI pipeline: ${PIPELINE.join(', ')}`}>
      {PIPELINE.map((step, index) => {
        const reached = active < 0 || index <= active;
        const isPulsing = animate && index === pulse;
        return (
          <div key={step} className="flex items-center gap-1.5">
            <div
              className={cx(
                'flex items-center rounded-[var(--radius-sm)] border font-semibold uppercase tracking-[0.1em] transition-all duration-[var(--dur)]',
                box,
                !reached && 'border-hair bg-transparent text-ink-faint',
                reached && index === 0 && 'border-hair-strong bg-raised text-ink',
                reached && index > 0 && index < 6 && 'border-brand-dim bg-brand-wash text-brand',
                reached && index === 6 && 'border-allow-line bg-allow-wash text-allow',
                isPulsing && 'ring-1 ring-brand-dim',
              )}
            >
              {step}
            </div>
            {index < PIPELINE.length - 1 && (
              <svg width="14" height="8" viewBox="0 0 14 8" className="shrink-0 text-ink-faint" aria-hidden="true">
                <path d="M0 4h11m0 0-2.6-2.6M11 4 8.4 6.6" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round" />
              </svg>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ==========================================================================
   Transaction trace — the signature view
   ========================================================================== */

const STAGE_COPY: Record<TraceStage['name'], string> = {
  INTENT: 'What the agent asked for, before any decision was made.',
  POLICY: 'The compiled policy that governs this wallet and agent.',
  RISK: 'Advisory only: risk can escalate or refuse, it can never grant.',
  APPROVAL: 'A named human, a quorum enforced in the database, a sealed token.',
  SIGNING: 'A single-use ticket with a 60 second TTL, redeemed in another process.',
  EXECUTION: 'What the chain did — and whether Ari has been told it is final.',
};

const STATE_TONE: Record<TraceStage['state'], Tone> = {
  PASSED: 'allow',
  ESCALATED: 'caution',
  BLOCKED: 'deny',
  NOT_REACHED: 'neutral',
  ADVISORY: 'brand',
  UNSETTLED: 'caution',
};

export function TransactionTrace({ tx }: { readonly tx: TransactionRecord }) {
  const blockedAt = tx.trace.findIndex((s) => s.state === 'BLOCKED');
  return (
    <ol className="relative">
      {tx.trace.map((step, index) => {
        const tone = STATE_TONE[step.state];
        const last = index === tx.trace.length - 1;
        const dimmed = blockedAt >= 0 && index > blockedAt;
        return (
          <li key={step.name} className={cx('relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3', !last && 'pb-3.5')}>
            {/* rail */}
            <div className="relative flex flex-col items-center">
              <span
                className={cx(
                  'z-10 grid h-5 w-5 place-items-center rounded-full border text-[9px] font-bold',
                  tone === 'allow' && 'border-allow-line bg-allow-wash text-allow',
                  tone === 'caution' && 'border-caution-line bg-caution-wash text-caution',
                  tone === 'deny' && 'border-deny-line bg-deny-wash text-deny',
                  tone === 'brand' && 'border-brand-dim bg-brand-wash text-brand',
                  tone === 'neutral' && 'border-hair bg-surface text-ink-faint',
                )}
              >
                {step.state === 'PASSED' ? '✓' : step.state === 'BLOCKED' ? '✕' : step.state === 'NOT_REACHED' ? '·' : '!'}
              </span>
              {!last && (
                <span
                  className={cx('absolute top-5 bottom-[-14px] w-px', dimmed ? 'bg-hair' : 'bg-hair-strong')}
                  style={{ left: '50%', transform: 'translateX(-50%)' }}
                  aria-hidden="true"
                />
              )}
            </div>

            <div className={cx('min-w-0 rounded-[var(--radius-md)] border px-3 py-2.5 transition-colors', dimmed ? 'border-transparent bg-transparent' : 'border-hair bg-surface hover:border-hair-strong')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="eyebrow text-ink-dim">{step.name}</span>
                  <Tooltip content={STAGE_COPY[step.name]}>
                    <span className="cursor-help text-ink-faint">
                      <Icon name="alert" size={11} />
                    </span>
                  </Tooltip>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={tone}>{sentenceFromCode(step.state)}</Badge>
                  <span className="num text-2xs text-ink-faint">{step.at === null ? '—' : clockTime(step.at)}</span>
                </div>
              </div>
              <p className={cx('mt-1 text-[13px] leading-snug', dimmed ? 'text-ink-mute' : 'text-ink')}>{step.headline}</p>
              {step.detail.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {step.detail.map((line) => (
                    <li key={line} className="flex gap-1.5 text-xs leading-snug text-ink-mute">
                      <span className="mt-[7px] h-px w-2 shrink-0 bg-hair-strong" aria-hidden="true" />
                      <span className="min-w-0 break-words">{line}</span>
                    </li>
                  ))}
                </ul>
              )}
              {step.codes.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {step.codes.map((code) => (
                    <Badge key={code} tone="deny" mono>
                      {code}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ==========================================================================
   Amounts, decisions, agents
   ========================================================================== */

export function Amount({ raw, unit, compact = false, className, size = 'md' }: { readonly raw: string | null; readonly unit: string; readonly compact?: boolean; readonly className?: string; readonly size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={cx('num font-medium tracking-tight', size === 'lg' ? 'text-lg' : size === 'sm' ? 'text-xs' : 'text-[13px]', raw === null && 'text-ink-mute', className)}>
      {raw === null ? 'no amount' : money(raw, unit, compact)}
      {raw !== null && <span className="ml-1 text-2xs font-normal uppercase tracking-wider text-ink-faint">{unit.replace('-6dp', '')}</span>}
    </span>
  );
}

export function DecisionMark({ outcome, codes }: { readonly outcome: 'ALLOW' | 'REQUIRE_HUMAN_APPROVAL' | 'DENY'; readonly codes?: readonly string[] }) {
  const map = { ALLOW: { tone: 'allow' as Tone, label: 'ALLOW' }, REQUIRE_HUMAN_APPROVAL: { tone: 'caution' as Tone, label: 'APPROVAL' }, DENY: { tone: 'deny' as Tone, label: 'DENY' } };
  const entry = map[outcome];
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={entry.tone}>{entry.label}</Badge>
      {codes !== undefined && codes.length > 0 && (
        <Tooltip content={codes.join(' · ')}>
          <span className="mono max-w-[13rem] truncate text-2xs text-ink-mute">{codes[0]}</span>
        </Tooltip>
      )}
    </span>
  );
}

export function AgentIdentity({ name, size = 20 }: { readonly name: string; readonly size?: number }) {
  const initials = name.split(/[-_\s]+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('');
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="grid shrink-0 place-items-center rounded-[var(--radius-sm)] border border-hair-strong bg-raised text-[9px] font-semibold tracking-wider text-ink-dim"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {initials}
      </span>
      <span className="mono truncate text-xs text-ink">{name}</span>
    </span>
  );
}

export function AgentCard({ agent, state, pending, policy, wallet, usage, limit, lastAt, riskLevel }: { readonly agent: string; readonly state: string; readonly pending: number; readonly policy: string; readonly wallet: string; readonly usage: bigint; readonly limit: bigint; readonly lastAt: string | null; readonly riskLevel: string | null }) {
  const used = limit > 0n ? Number((usage * 100n) / limit) / 100 : 0;
  const tone: Tone = used > 0.85 ? 'caution' : used > 0.98 ? 'deny' : 'brand';
  return (
    <Link
      to={`/agents/${agent}`}
      className="group flex flex-col gap-3 rounded-[var(--radius-md)] border border-hair bg-surface p-3.5 transition-colors hover:border-hair-strong"
    >
      <div className="flex items-start justify-between gap-2">
        <AgentIdentity name={agent} />
        <Status value={state} label={state === 'AWAITING_APPROVAL' ? 'awaiting approval' : state.toLowerCase()} />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
        <div className="truncate text-ink-mute">policy <span className="mono text-ink-dim">{policy}</span></div>
        <div className="truncate text-ink-mute">wallet <span className="mono text-ink-dim">{wallet}</span></div>
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between text-2xs">
          <span className="text-ink-mute">daily usage</span>
          <span className="num text-ink-dim">{money(usage.toString(), 'usdc-6dp', true)} / {money(limit.toString(), 'usdc-6dp', true)}</span>
        </div>
        <Meter value={used} max={1} tone={tone} />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-hair-faint pt-2 text-2xs text-ink-faint">
        <span className="flex items-center gap-1.5">
          {riskLevel !== null && <RiskPip level={riskLevel} />}
          {riskLevel !== null ? <span className="capitalize">{riskLevel.toLowerCase()} risk</span> : <span>no recent assessment</span>}
        </span>
        <span className="flex items-center gap-2">
          {pending > 0 && <Badge tone="caution">{pending} pending</Badge>}
          <span>{relativeTime(lastAt)}</span>
        </span>
      </div>
    </Link>
  );
}

/* ==========================================================================
   Policy rendering — allowed, restricted, escalated, expiring
   ========================================================================== */

export function PolicyRules({ document: doc }: { readonly document: PolicyDocumentShape }) {
  const groups: readonly { readonly title: string; readonly tone: Tone; readonly items: readonly ReactNode[] }[] = [
    {
      title: 'Allowed',
      tone: 'allow',
      items: [
        <Line key="a" k="assets" v={doc.permissions.transfers.assets.map((a) => a.symbol ?? a.kind).join(', ') || 'none'} />,
        <Line key="b" k="chains" v={doc.permissions.transfers.chains.join(', ') || 'transfers disabled'} />,
        <Line key="c" k="per transaction" v={money(doc.permissions.transfers.perTransaction.maxRaw, doc.permissions.transfers.perTransaction.unit)} />,
        <Line key="d" k="per day" v={money(doc.permissions.transfers.perDay.maxRaw, doc.permissions.transfers.perDay.unit)} />,
        <Line key="e" k="per month" v={doc.permissions.transfers.perMonth === null ? 'no monthly window' : money(doc.permissions.transfers.perMonth.maxRaw, doc.permissions.transfers.perMonth.unit)} />,
        <Line key="f" k="recipients" v={`${doc.permissions.transfers.recipients.addresses.length} allowlisted · no wildcard`} />,
        <Line key="g" k="hourly rate" v={`${doc.permissions.transfers.maxTransactionsPerHour} requests`} />,
      ],
    },
    {
      title: 'Restricted',
      tone: 'deny',
      items: [
        <Line key="r1" k="contract calls" v={doc.permissions.contractCalls.enabled ? `${doc.permissions.contractCalls.contracts.length} allowlisted · native value refused` : 'disabled entirely'} />,
        <Line key="r2" k="new recipients" v={doc.permissions.newRecipients.allowed ? (doc.permissions.newRecipients.requireApproval ? 'permitted, with approval' : 'permitted autonomously') : 'not permitted'} />,
        <Line key="r3" k="unknown transactions" v={doc.fallback.onUnknownTransaction} />,
        <Line key="r4" k="evaluation error" v={doc.fallback.onEvaluationError} />,
      ],
    },
    {
      title: 'Escalation',
      tone: 'caution',
      items: [
        ...(doc.escalation.humanApproval.requiredWhen.length === 0
          ? [<Line key="e0" k="conditions" v="none — this policy never escalates" />]
          : doc.escalation.humanApproval.requiredWhen.map((condition, index) => (
              <Line key={`e${index}`} k={sentenceFromCode(condition.op)} v={conditionDetail(condition)} />
            ))),
        <Line key="e-q" k="quorum" v={`${doc.escalation.humanApproval.quorum} of ${doc.escalation.humanApproval.approverRoles.join(' / ')} · enforced by Ari’s database`} />,
        <Line key="e-f" k="risk unavailable" v={doc.fallback.onRiskUnavailable} />,
        <Line key="e-s" k="simulation unavailable" v={doc.fallback.onSimulationUnavailable.replaceAll('_', ' ')} />,
      ],
    },
    {
      title: 'Expiry',
      tone: 'neutral',
      items: [
        <Line key="x1" k="transaction TTL" v={`${doc.validity.transactionTtlSeconds}s after authorization`} />,
        <Line key="x2" k="not before" v={doc.validity.notBefore ?? 'immediately'} />,
        <Line key="x3" k="not after" v={doc.validity.notAfter ?? 'no expiry'} />,
        <Line key="x4" k="signing budget" v={`${doc.validity.signingBudget.maxIkaRawPerDay} IKA/day, alert at ${doc.validity.signingBudget.alertAtIkaRawPerDay}`} />,
        <Line key="x5" k="price staleness" v={`${doc.limits.maxUsdEstimateAgeSeconds}s max`} />,
      ],
    },
  ];

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {groups.map((group) => (
        <section key={group.title} className="rounded-[var(--radius-md)] border border-hair bg-surface">
          <header className="flex items-center gap-2 border-b border-hair px-3 py-2">
            <span className={cx('h-1.5 w-1.5 rounded-full', { brand: 'bg-brand', allow: 'bg-allow', caution: 'bg-caution', deny: 'bg-deny', neutral: 'bg-ink-mute' }[group.tone])} />
            <h4 className="eyebrow">{group.title}</h4>
          </header>
          <div className="divide-y divide-hair-faint px-3 py-1">{group.items}</div>
        </section>
      ))}
    </div>
  );
}

function Line({ k, v }: { readonly k: string; readonly v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-2xs uppercase tracking-[0.06em] text-ink-mute">{k}</span>
      <span className="min-w-0 text-right text-xs text-ink">{v}</span>
    </div>
  );
}

function conditionDetail(condition: PolicyDocumentShape['escalation']['humanApproval']['requiredWhen'][number]): string {
  if (condition.op === 'amount_gt') return `above ${money(condition.raw ?? '0', condition.unit ?? 'usdc-6dp')}`;
  if (condition.op === 'risk_gte') return `risk at or above ${condition.level}`;
  if (condition.op === 'recipient_first_seen_within_days') return `recipient seen within ${condition.days} days`;
  if (condition.op === 'velocity_gt_per_hour') return `more than ${condition.count} requests an hour`;
  if (condition.op === 'usd_gte') return `worth at or above $${(Number(condition.cents ?? '0') / 100).toLocaleString('en-US')}`;
  if (condition.op === 'time_out_of_hours_window') return `outside ${condition.window}`;
  return sentenceFromCode(condition.op);
}

export function VersionStrip({ versions }: { readonly versions: readonly { number: number; status: string; createdAt: string; summary: string; activatedAt: string | null; justification: string | null }[] }) {
  const ordered = [...versions].sort((a, b) => b.number - a.number);
  return (
    <ol className="space-y-1.5">
      {ordered.map((version) => (
        <li key={version.number} className="flex items-start gap-3 rounded-[var(--radius-sm)] border border-hair bg-raised/40 px-2.5 py-2">
          <span className="mono shrink-0 pt-0.5 text-[11px] text-ink-dim">v{version.number}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs text-ink">{version.summary}</span>
            <span className="mt-0.5 block text-2xs text-ink-faint">
              {version.activatedAt === null ? 'never activated' : `active since ${relativeTime(version.activatedAt)}`}
              {version.justification !== null && <span className="text-caution"> · reactivation justified: “{version.justification}”</span>}
            </span>
          </span>
          <Badge tone={toneFor(version.status)}>{version.status}</Badge>
        </li>
      ))}
    </ol>
  );
}

/* ==========================================================================
   Approvals and audit
   ========================================================================== */

export function ApprovalCard({ approval, agentName, onOpen }: { readonly approval: ApprovalRequest; readonly agentName: string; readonly onOpen: () => void }) {
  const expiresIn = Date.parse(approval.expiresAt) - Date.now();
  const expiring = expiresIn < 5 * 60_000;
  return (
    <article className="overflow-hidden rounded-[var(--radius-md)] border border-hair bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-hair bg-[#0d1116] px-3.5 py-2">
        <div className="flex items-center gap-2">
          <AgentIdentity name={agentName} size={18} />
          <span className="text-2xs text-ink-faint">requests</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="caution">{`${approval.quorum - approval.votes.length} ${approval.quorum - approval.votes.length === 1 ? 'vote' : 'votes'} needed`}</Badge>
          <span className={cx('num text-2xs', expiring ? 'text-deny' : 'text-ink-faint')}>{relativeTime(approval.expiresAt)}</span>
        </div>
      </header>

      <div className="px-3.5 py-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="eyebrow">amount</div>
            <Amount raw={approval.amountRaw} unit={approval.unit} size="lg" />
          </div>
          <div className="text-right">
            <div className="eyebrow">risk</div>
            <div className="mt-0.5 flex items-center justify-end gap-1.5">
              <RiskPip level={approval.riskLevel} />
              <span className="text-xs capitalize text-ink-dim">{approval.riskLevel.toLowerCase()}</span>
            </div>
          </div>
        </div>

        <dl className="mt-3 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-ink-mute">reason</dt>
          <dd className="text-ink">{approval.reason}</dd>
          <dt className="text-ink-mute">to</dt>
          <dd className="mono truncate text-ink" title={approval.recipient ?? undefined}>{shortAddress(approval.recipient)}</dd>
          <dt className="text-ink-mute">policy</dt>
          <dd className="text-ink">{approval.policyName} <span className="mono text-ink-dim">v{approval.policyVersionNumber}</span></dd>
        </dl>

        <p className="mt-3 rounded-[var(--radius-sm)] border-l-2 border-caution-line bg-caution-wash/40 px-2.5 py-2 text-xs leading-relaxed text-ink-dim">
          <span className="font-medium text-caution">Why a human is needed: </span>
          {approval.why}
        </p>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-hair px-3.5 py-2.5">
        <Tooltip content="The token you are about to sign is sealed from the row that records this vote — amount, wallet and digest are read by Ari, not by the browser.">
          <span className="mono text-2xs text-ink-faint">{shortHash(approval.digest, 8)}</span>
        </Tooltip>
        <button onClick={onOpen} className="inline-flex items-center gap-1 text-xs text-brand transition-colors hover:text-brand-strong">
          Review what this authorizes <Icon name="arrow-right" size={12} />
        </button>
      </footer>
    </article>
  );
}

export function AuditRow({ event }: { readonly event: AuditEvent }) {
  const tone: Tone = event.severity === 'warning' || event.severity === 'critical' ? 'caution' : event.decision === 'DENY' ? 'deny' : event.decision === 'ALLOW' ? 'allow' : 'neutral';
  return (
    <tr className="group border-b border-hair-faint align-top transition-colors last:border-0 hover:bg-hover">
      <td className="whitespace-nowrap px-3 py-2 text-2xs num text-ink-faint">{event.seq}</td>
      <td className="whitespace-nowrap px-3 py-2 text-2xs num text-ink-mute" title={new Date(event.at).toISOString()}>
        {clockTime(event.at)}
        <span className="ml-1 text-ink-faint">{relativeTime(event.at)}</span>
      </td>
      <td className="px-3 py-2">
        <span className="mono text-xs text-ink">{event.type}</span>
        <span className="mt-0.5 block text-2xs text-ink-faint">
          {event.actorType} · {event.resource ?? '—'} {event.resourceId === null ? '' : <span className="mono">{shortHash(event.resourceId, 5)}</span>}
        </span>
      </td>
      <td className="hidden px-3 py-2 lg:table-cell">
        <span className="mono text-2xs text-ink-dim">{shortHash(event.actor, 6)}</span>
      </td>
      <td className="px-3 py-2">{event.decision !== null ? <Badge tone={toneFor(event.decision)}>{event.decision}</Badge> : <span className="text-2xs text-ink-faint">—</span>}</td>
      <td className="hidden px-3 py-2 md:table-cell">
        {event.reasons.length > 0 ? (
          <Tooltip content={event.reasons.join(' · ')}>
            <span className="mono text-2xs text-ink-mute">{event.reasons.length} code{event.reasons.length > 1 ? 's' : ''}</span>
          </Tooltip>
        ) : (
          <span className="text-2xs text-ink-faint">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        <Tooltip
          content={
            <span className="block space-y-0.5">
              <span className="block">prev {event.prev}</span>
              <span className="block">hash {event.hash}</span>
              <span className="block text-ink-mute">Recomputed from the row’s own content — never read from the stored hash.</span>
            </span>
          }
        >
          <span className={cx('mono cursor-help text-2xs', tone === 'neutral' ? 'text-ink-faint' : 'text-ink-mute')}>
            {event.hash.slice(0, 10)}
          </span>
        </Tooltip>
      </td>
    </tr>
  );
}

/* ==========================================================================
   Command palette
   ========================================================================== */

export function CommandPalette({ open, onClose, commands }: { readonly open: boolean; readonly onClose: () => void; readonly commands: readonly { readonly group: string; readonly label: string; readonly hint?: string; readonly run: () => void }[] }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return commands;
    return commands.filter((command) => `${command.group} ${command.label} ${command.hint ?? ''}`.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => setCursor(0), [query]);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-[#030507bb] px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        className="anim-rise w-full max-w-lg overflow-hidden rounded-[var(--radius-lg)] border border-hair-strong bg-surface shadow-[0_32px_80px_-28px_rgba(0,0,0,0.95)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-hair px-3">
          <Icon name="search" className="text-ink-faint" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((c) => Math.min(filtered.length - 1, c + 1)); }
              if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
              if (event.key === 'Enter') { filtered[cursor]?.run(); onClose(); }
              if (event.key === 'Escape') onClose();
            }}
            placeholder="Jump to an agent, policy, transaction or screen…"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-faint"
          />
          <kbd className="rounded border border-hair px-1.5 py-0.5 text-[10px] text-ink-faint">esc</kbd>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && <li className="px-3 py-6 text-center text-xs text-ink-mute">Nothing matches “{query}”.</li>}
          {filtered.map((command, index) => (
            <li key={`${command.group}-${command.label}`}>
              <button
                onMouseEnter={() => setCursor(index)}
                onClick={() => { command.run(); onClose(); }}
                className={cx('flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left', index === cursor && 'bg-hover')}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs text-ink">{command.label}</span>
                  {command.hint !== undefined && <span className="block truncate text-2xs text-ink-faint">{command.hint}</span>}
                </span>
                <span className="eyebrow shrink-0">{command.group}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
