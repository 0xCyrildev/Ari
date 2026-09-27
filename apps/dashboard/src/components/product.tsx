import {
  ArrowRight,
  Robot,
  Check,
  CheckCircle,
  Circle,
  Eye,
  Hourglass,
  MagnifyingGlass,
  XCircle,
  CaretRight,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApprovalRequest, AuditEvent, PolicyDocumentShape, TraceStage, TransactionRecord } from '../domain/types';
import { Link } from '../app/router';
import { Button, KeyValue, Surface, Tag, toneFor, type Tone } from './ui';
import { cx, money, relativeTime, shortAddress, shortHash, sentenceFromCode, clockTime } from '../lib/util';

/* ==========================================================================
   The mark
   ========================================================================== */

/**
 * The supplied SVG, painted from a token through a CSS mask (see `.ari-mark` in
 * `styles/tokens.css`). Geometry untouched at every size, only the colour is ours, and there is
 * no second version of it anywhere in this app.
 */
export function Mark({ size = 22, className }: { readonly size?: number; readonly className?: string }) {
  return <span aria-hidden="true" className={cx('ari-mark shrink-0', className)} style={{ width: size, height: size }} />;
}

export function Wordmark({ size = 22, href = '/', showLabel = true }: { readonly size?: number; readonly href?: string; readonly showLabel?: boolean }) {
  return (
    <Link to={href} className="flex items-center gap-2" aria-label="ARI home">
      <Mark size={size} className="text-ink" />
      {showLabel && <span className="text-[13px] font-semibold tracking-[0.18em] text-ink">ARI</span>}
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
 * The landing hero and the transaction page render the same seven steps from the same array,
 * which is what stops the marketing diagram and the engineering diagram from disagreeing about
 * what the system does. `active` marks how far a real request got; the rest stay dim rather than
 * disappearing, because "it never reached signing" is information.
 */
export function PipelineRail({ active = -1, size = 'md' }: { readonly active?: number; readonly size?: 'sm' | 'md' | 'lg' }) {
  const pad = size === 'lg' ? 'px-2.5 py-1.5 text-[13px]' : size === 'md' ? 'px-2 py-1 text-xs' : 'px-1.5 py-0.5 text-[11px]';
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1" role="img" aria-label={`ARI pipeline: ${PIPELINE.join(', ')}`}>
      {PIPELINE.map((step, index) => {
        const reached = active < 0 || index <= active;
        return (
          <li key={step} className="flex items-center gap-1">
            <span
              className={cx(
                'rounded-control border font-mono transition-colors duration-[var(--dur)]',
                pad,
                !reached && 'border-line text-ink-4',
                reached && index < 5 && 'border-accent-line bg-accent-wash text-accent',
                reached && index >= 5 && 'border-ok-line bg-ok-wash text-ok',
              )}
            >
              {step}
            </span>
            {index < PIPELINE.length - 1 && <CaretRight size={10} weight="bold" className={reached ? 'text-ink-3' : 'text-ink-4'} />}
          </li>
        );
      })}
    </ol>
  );
}

/* ==========================================================================
   Transaction trace: the signature view
   ========================================================================== */

const STAGE_COPY: Record<TraceStage['name'], string> = {
  INTENT: 'What the agent asked for, before any decision was made.',
  POLICY: 'The compiled policy that governs this wallet and agent.',
  RISK: 'Advisory only. Risk can escalate or refuse, it can never grant.',
  APPROVAL: 'A named human, a quorum enforced in the database, a sealed token.',
  SIGNING: 'A single-use ticket with a 60 second TTL, redeemed in another process.',
  EXECUTION: 'What the chain did, and whether Ari has been told it is final.',
};

const STATE_TONE: Record<TraceStage['state'], Tone> = {
  PASSED: 'ok',
  ESCALATED: 'wait',
  BLOCKED: 'stop',
  NOT_REACHED: 'neutral',
  ADVISORY: 'accent',
  UNSETTLED: 'wait',
};

const STATE_ICON: Record<TraceStage['state'], typeof Check> = {
  PASSED: CheckCircle,
  ESCALATED: ArrowRight,
  BLOCKED: XCircle,
  NOT_REACHED: Circle,
  ADVISORY: Eye,
  UNSETTLED: Hourglass,
};

/**
 * One column, one rail, no nested boxes.
 *
 * The first pass wrapped every stage in its own card inside a card. The stages are a sequence,
 * so the sequence is drawn as a rule with the stage content hanging off it; the only thing that
 * gets a border is the request that was refused, because that is the one row an operator needs
 * to find without reading.
 */
export function TransactionTrace({ tx }: { readonly tx: TransactionRecord }) {
  const blockedAt = tx.trace.findIndex((s) => s.state === 'BLOCKED');
  return (
    <ol className="relative">
      {tx.trace.map((step, index) => {
        const tone = STATE_TONE[step.state];
        const Glyph = STATE_ICON[step.state];
        const last = index === tx.trace.length - 1;
        const dimmed = blockedAt >= 0 && index > blockedAt;
        const text = { ok: 'text-ok', wait: 'text-wait', stop: 'text-stop', accent: 'text-accent', neutral: 'text-ink-4' }[tone];
        return (
          <li key={step.name} className={cx('relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2', !last && 'pb-4')}>
            <div className="flex flex-col items-center">
              <Glyph size={15} weight={step.state === 'NOT_REACHED' ? 'light' : 'regular'} className={cx('mt-[1px]', text)} />
              {!last && <span className={cx('mt-1 w-px flex-1', dimmed ? 'bg-line' : 'bg-line-strong')} aria-hidden="true" />}
            </div>

            <div className={cx('min-w-0 pb-0.5', blockedAt === index && 'border-l-2 border-stop-line pl-2.5')}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="font-mono text-[11px] tracking-[0.02em] text-ink-2">{step.name}</span>
                <span className="flex items-center gap-2">
                  <Tag tone={tone} mono>{step.state}</Tag>
                  <span className="font-mono text-[11px] text-ink-4">{step.at === null ? (step.state === 'NOT_REACHED' ? 'not reached' : 'no time recorded') : clockTime(step.at)}</span>
                </span>
              </div>
              <p className={cx('mt-1 text-[13px] leading-snug', dimmed ? 'text-ink-3' : 'text-ink')}>{step.headline}</p>
              <p className="sr-only">{STAGE_COPY[step.name]}</p>
              {step.detail.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {step.detail.map((line) => (
                    <li key={line} className="text-xs leading-snug text-ink-3">{line}</li>
                  ))}
                </ul>
              )}
              {step.codes.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {step.codes.map((code) => (
                    <Tag key={code} tone="stop" mono>{code}</Tag>
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

/** Money and its unit, from the decimal string the wire carries. Never a rounded number. */
export function Amount({ raw, unit, compact = false, size = 'md', className }: { readonly raw: string | null; readonly unit: string; readonly compact?: boolean; readonly size?: 'sm' | 'md' | 'lg'; readonly className?: string }) {
  return (
    <span className={cx('font-mono tabular-nums', size === 'lg' ? 'text-[17px]' : size === 'sm' ? 'text-xs' : 'text-[13px]', raw === null ? 'text-ink-3' : 'text-ink', className)}>
      {raw === null ? 'no amount' : money(raw, unit, compact)}
      {raw !== null && <span className="ml-1 text-[11px] text-ink-3">{unit.replace('-6dp', '').toUpperCase()}</span>}
    </span>
  );
}

export function DecisionMark({ outcome, codes }: { readonly outcome: 'ALLOW' | 'REQUIRE_HUMAN_APPROVAL' | 'DENY'; readonly codes?: readonly string[] }) {
  const label = { ALLOW: 'ALLOW', REQUIRE_HUMAN_APPROVAL: 'APPROVAL', DENY: 'DENY' }[outcome];
  return (
    <span className="inline-flex items-center gap-1.5">
      <Tag tone={toneFor(outcome)} mono>{label}</Tag>
      {codes !== undefined && codes.length > 0 && (
        <span className="inline-block max-w-[11rem] truncate align-middle font-mono text-[11px] text-ink-3" title={codes.join(', ')}>{codes[0]}</span>
      )}
    </span>
  );
}

/**
 * Agent identity. Agent ids in this system are machine handles like `treasury-relayer-a`, so the
 * handle is the thing shown; an initials tile would be a fake avatar over a name nobody chose.
 */
export function AgentIdentity({ name, to }: { readonly name: string; readonly to?: string }) {
  const inner = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Robot size={14} weight="regular" className="shrink-0 text-ink-3" />
      <span className="truncate font-mono text-xs text-ink">{name}</span>
    </span>
  );
  return to === undefined ? inner : <Link to={to} className="inline-flex min-w-0 hover:underline">{inner}</Link>;
}

/* ==========================================================================
   Policy rendering
   ========================================================================== */

/**
 * The four groups a policy is made of, rendered as `KeyValue` runs inside surfaces rather than
 * as four identical boxes with coloured dots. The groups are real (permissions, escalation,
 * validity, fallback); the decoration on top of them was not.
 */
export function PolicyRules({ document: doc }: { readonly document: PolicyDocumentShape }) {
  const groups: readonly { readonly title: string; readonly note: ReactNode; readonly items: readonly { readonly k: string; readonly v: ReactNode }[] }[] = [
    {
      title: 'Transfers allowed',
      note: `${doc.permissions.transfers.recipients.addresses.length} allowlisted recipients`,
      items: [
        { k: 'assets', v: doc.permissions.transfers.assets.map((a) => a.symbol ?? a.kind).join(', ') || 'none' },
        { k: 'chains', v: doc.permissions.transfers.chains.join(', ') || 'transfers disabled' },
        { k: 'per transaction', v: money(doc.permissions.transfers.perTransaction.maxRaw, doc.permissions.transfers.perTransaction.unit) },
        { k: 'per day', v: money(doc.permissions.transfers.perDay.maxRaw, doc.permissions.transfers.perDay.unit) },
        { k: 'per month', v: doc.permissions.transfers.perMonth === null ? 'no monthly window' : money(doc.permissions.transfers.perMonth.maxRaw, doc.permissions.transfers.perMonth.unit) },
        { k: 'hourly rate', v: `${doc.permissions.transfers.maxTransactionsPerHour} requests` },
      ],
    },
    {
      title: 'Held back',
      note: 'these need a human, or are refused outright',
      items: [
        { k: 'contract calls', v: doc.permissions.contractCalls.enabled ? `${doc.permissions.contractCalls.contracts.length} allowlisted, native value refused` : 'disabled entirely' },
        { k: 'new recipients', v: doc.permissions.newRecipients.allowed ? (doc.permissions.newRecipients.requireApproval ? 'permitted with approval' : 'permitted autonomously') : 'not permitted' },
        { k: 'unknown transactions', v: doc.fallback.onUnknownTransaction },
        { k: 'evaluation error', v: doc.fallback.onEvaluationError },
      ],
    },
    {
      title: 'Escalation',
      note: `quorum ${doc.escalation.humanApproval.quorum} of ${doc.escalation.humanApproval.approverRoles.join(' / ')}`,
      items: [
        ...(doc.escalation.humanApproval.requiredWhen.length === 0
          ? [{ k: 'conditions', v: 'none, this policy never escalates' }]
          : doc.escalation.humanApproval.requiredWhen.map((condition, index) => ({
              k: sentenceFromCode(condition.op),
              v: conditionDetail(condition),
              key: index,
            }))),
        { k: 'risk unavailable', v: doc.fallback.onRiskUnavailable },
        { k: 'simulation unavailable', v: sentenceFromCode(doc.fallback.onSimulationUnavailable) },
      ],
    },
    {
      title: 'Validity',
      note: 'when a decision stops being good for it',
      items: [
        { k: 'transaction TTL', v: `${doc.validity.transactionTtlSeconds}s after authorization` },
        { k: 'not before', v: doc.validity.notBefore ?? 'immediately' },
        { k: 'not after', v: doc.validity.notAfter ?? 'no expiry' },
        { k: 'signing budget', v: `${doc.validity.signingBudget.maxIkaRawPerDay} IKA per day` },
        { k: 'price staleness', v: `${doc.limits.maxUsdEstimateAgeSeconds}s max` },
      ],
    },
  ];

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {groups.map((group) => (
        <Surface key={group.title} title={group.title} action={<span className="text-[11px] text-ink-4">{group.note}</span>} bodyClassName="p-0">
          <KeyValue dense items={group.items.map(({ k, v }) => ({ k, v }))} />
        </Surface>
      ))}
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
    <ol className="divide-y divide-line">
      {ordered.map((version) => (
        <li key={version.number} className="flex items-start gap-3 py-2">
          <span className="w-9 shrink-0 pt-0.5 font-mono text-[11px] text-ink-3">v{version.number}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-ink">{version.summary}</span>
            <span className="mt-0.5 block text-[11px] text-ink-4">
              {version.activatedAt === null ? 'never activated' : `active since ${relativeTime(version.activatedAt)}`}
              {version.justification !== null && <span className="text-wait"> · reactivation justified: {version.justification}</span>}
            </span>
          </span>
          <Tag tone={toneFor(version.status)} mono>{version.status}</Tag>
        </li>
      ))}
    </ol>
  );
}

/* ==========================================================================
   Approvals and audit
   ========================================================================== */

/**
 * What an approver needs in one row: the amount, the reason a human is in the loop, the digest
 * that will be signed, and two buttons that say what they do. The token is sealed from the row
 * by Ari, so nothing here has to be trusted by the browser.
 */
export function ApprovalRow({ approval, agentName, onReview }: { readonly approval: ApprovalRequest; readonly agentName: string; readonly onReview: () => void }) {
  const needed = approval.quorum - approval.votes.filter((v) => v.decision === 'APPROVED').length;
  const expiresIn = Date.parse(approval.expiresAt) - Date.now();
  return (
    <article className="border border-line bg-panel">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <AgentIdentity name={agentName} />
            <Amount raw={approval.amountRaw} unit={approval.unit} />
            <span className="font-mono text-[11px] text-ink-3">to {shortAddress(approval.recipient)}</span>
          </div>
          <p className="mt-1.5 text-[13px] leading-snug text-ink-2">{approval.why}</p>
          <p className="mt-1 text-[11px] text-ink-4">
            {approval.policyName} v{approval.policyVersionNumber} · risk {approval.riskLevel.toLowerCase()} ·
            <span className="font-mono"> {shortHash(approval.digest, 8)}</span>
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          <span className="flex items-center gap-2">
            <Tag tone={needed > 0 ? 'wait' : 'ok'}>{needed === 0 ? 'quorum reached' : `${needed} more ${needed === 1 ? 'vote' : 'votes'} needed`}</Tag>
            <span className={cx('font-mono text-[11px]', expiresIn < 5 * 60_000 ? 'text-stop' : 'text-ink-4')}>{relativeTime(approval.expiresAt)}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Button size="sm" onClick={onReview}>Review this request</Button>
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2">
        <span className="text-[11px] text-ink-4">
          Your vote is sealed against the digest above. Ari re-checks it before the ticket is minted.
        </span>
        <span className="flex items-center gap-2">
          <Button size="sm" variant="danger" onClick={() => onReview()}>Reject this transfer</Button>
          <Button size="sm" variant="primary" onClick={() => onReview()}>Approve this transfer</Button>
        </span>
      </div>
    </article>
  );
}

export function AuditRow({ event }: { readonly event: AuditEvent }) {
  const tone: Tone = event.severity === 'critical' ? 'stop' : event.severity === 'warning' ? 'wait' : event.decision === 'DENY' ? 'stop' : 'neutral';
  return (
    <tr className="border-b border-line/70 align-top last:border-0 hover:bg-raised">
      <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-ink-4">{event.seq}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-ink-3" title={new Date(event.at).toISOString()}>
        {clockTime(event.at)}
      </td>
      <td className="px-3 py-2">
        <span className="font-mono text-xs text-ink">{event.type}</span>
        <span className="mt-0.5 block text-[11px] text-ink-4">
          {event.actorType}
          {event.resource !== null && <> · {event.resource}{event.resourceId !== null && <span className="font-mono"> {shortHash(event.resourceId, 5)}</span>}</>}
        </span>
      </td>
      <td className="hidden px-3 py-2 lg:table-cell">
        <Tag tone={tone} mono>{event.decision ?? 'recorded'}</Tag>
      </td>
      <td className="hidden px-3 py-2 font-mono text-[11px] text-ink-3 md:table-cell">
        {event.reasons.length > 0 ? <span title={event.reasons.join(', ')}>{event.reasons[0]}</span> : <span className="text-ink-4">none</span>}
      </td>
      <td className="px-3 py-2 font-mono text-[11px] text-ink-4" title={`prev ${event.prev}\nhash ${event.hash}`}>
        {event.hash.slice(0, 10)}
      </td>
    </tr>
  );
}

/* ==========================================================================
   Command palette
   ========================================================================== */

export interface Command {
  readonly group: string;
  readonly label: string;
  readonly hint?: string;
  readonly run: () => void;
}

export function CommandPalette({ open, onClose, commands }: { readonly open: boolean; readonly onClose: () => void; readonly commands: readonly Command[] }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return commands;
    return commands.filter((command) => `${command.group} ${command.label} ${command.hint ?? ''}`.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] bg-[#040608b3] px-4 pt-[14vh]" onMouseDown={onClose} role="presentation">
      <div
        className="anim-rise mx-auto w-full max-w-lg overflow-hidden border border-line-strong bg-panel"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-label="Jump to"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <MagnifyingGlass size={15} weight="regular" className="shrink-0 text-ink-4" />
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
            placeholder="Jump to an agent, policy, transaction or screen"
            aria-label="Search the console"
            className="h-11 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
          />
          <kbd className="rounded-control border border-line px-1.5 py-0.5 font-mono text-[10px] text-ink-4">esc</kbd>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && <li className="px-3 py-6 text-xs text-ink-3">Nothing matches {query}.</li>}
          {filtered.map((command, index) => (
            <li key={`${command.group}-${command.label}`}>
              <button
                onMouseEnter={() => setCursor(index)}
                onClick={() => { command.run(); onClose(); }}
                className={cx('flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left', index === cursor && 'bg-raised')}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs text-ink">{command.label}</span>
                  {command.hint !== undefined && <span className="block truncate text-[11px] text-ink-4">{command.hint}</span>}
                </span>
                <span className="label shrink-0">{command.group}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
