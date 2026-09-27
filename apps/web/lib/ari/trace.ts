/**
 * The trace, rebuilt from the trail rather than remembered.
 *
 * The fixture draws six stages because a demo can carry a narrative. A live request has no
 * narrative field anywhere: it has `audit_events`, which the pipeline appends to at each step —
 * `transaction.proposed`, `risk.assessed`, `policy.evaluated`, `approval.*`, `ticket.minted`,
 * `transaction.state_changed` — and that is exactly the sequence the screen wants, in the order
 * the chain recorded it. So each stage below names the events it was reconstructed from, and a
 * stage with no event says it was not reached.
 *
 * Two rules that keep this from becoming a story:
 *
 * - **A stage never claims a step it has no event for.** `NOT_REACHED` is drawn, dimmed, on the
 *   page — hiding it would make a refusal at policy look like a pipeline that got as far as it
 *   could and stopped, rather than one that stopped at stage two.
 * - **EXECUTION is unsettled unless a settled state is on the row.** The lifecycle stops at
 *   signing in this build, and a mock signer's `COMPLETE` is not a chain fact, so the last stage
 *   reports what is missing instead of drawing a checkmark. `EXECUTION_UNSETTLED` names the
 *   states where that is true.
 */

import type { ReasonCode, TraceStage } from './types'
import { EXECUTION_UNSETTLED } from './types'
import type { WireTrailEvent, WireTransactionRecord } from './wire'

const codesOf = (events: readonly WireTrailEvent[]): readonly string[] =>
  [...new Set(events.flatMap((event) => event.reasonCodes))]

const newest = (events: readonly WireTrailEvent[]): WireTrailEvent | undefined => events.at(-1)

/** One stage's line, with the detail bullets the events actually carry and nothing else. */
function stage(
  name: TraceStage['name'],
  state: TraceStage['state'],
  events: readonly WireTrailEvent[],
  headline: string,
  detail: readonly string[] = [],
): TraceStage {
  return {
    name,
    state,
    at: newest(events)?.madeAt ?? null,
    headline,
    detail,
    codes: codesOf(events) as readonly ReasonCode[],
    events: events.map((event) => event.id),
  }
}

export function buildTrace(record: WireTransactionRecord): readonly TraceStage[] {
  const byType = (types: readonly string[]): WireTrailEvent[] =>
    record.trail.filter((event) => types.includes(event.eventType))

  const proposed = byType(['transaction.proposed'])
  const riskEvents = byType(['risk.assessed', 'risk.unavailable'])
  const evaluated = byType(['policy.evaluated'])
  const approvalEvents = byType(['approval.requested', 'approval.granted', 'approval.rejected', 'approval.expired', 'approval.claim_refused'])
  const ticketEvents = byType(['ticket.minted', 'ticket.claimed', 'signing.succeeded', 'signing.failed'])
  const settled = !EXECUTION_UNSETTLED.includes(record.lifecycleState)
  const simulationEvents = byType(['simulation.evaluated'])

  const intent = stage(
    'INTENT',
    proposed.length > 0 ? 'PASSED' : 'NOT_REACHED',
    proposed,
    proposed.length > 0
      ? 'A proposal was written as its own audit event, not inferred from the row.'
      : 'No proposal event on this chain.',
    [`canonical ${record.canonical.length} characters, digested as ${record.digest.slice(0, 24)}…`],
  )

  const assessed = riskEvents.filter((event) => event.eventType === 'risk.assessed')
  const risk = stage(
    'RISK',
    assessed.length > 0 ? 'PASSED' : riskEvents.length > 0 ? 'ADVISORY' : 'NOT_REACHED',
    riskEvents,
    assessed.length > 0
      ? `Assessed as ${(newest(assessed)?.meta as { riskLevel?: string } | undefined)?.riskLevel ?? 'a level the event does not name'}.`
      : 'No assessment recorded, which the kernel treats as a decision rather than a pass.',
    assessed.map((event) => {
      const meta = event.meta as { riskLevel?: string; riskScore?: string; riskSignals?: string[] }
      return `${meta.riskLevel ?? '?'} · score ${meta.riskScore ?? '?'} · ${(meta.riskSignals ?? []).join(' · ') || 'no signals'}`
    }),
  )

  const outcome = newest(evaluated)?.decision
  const policy = stage(
    'POLICY',
    evaluated.length === 0
      ? 'NOT_REACHED'
      : outcome === 'DENY'
        ? 'BLOCKED'
        : outcome === 'REQUIRE_HUMAN_APPROVAL'
          ? 'ESCALATED'
          : 'PASSED',
    evaluated,
    evaluated.length === 0
      ? 'Nothing evaluated this row.'
      : `The newest evaluation decided ${outcome ?? 'no outcome'}, and the reason codes are that event's, not the decision row's: a refusal writes no decision row at all.`,
    evaluated.map((event) => `${event.decision ?? '?'} · ${event.reasonCodes.join(' · ') || 'no codes'}`),
  )

  const granted = approvalEvents.some((event) => event.eventType === 'approval.granted')
  const approval = stage(
    'APPROVAL',
    approvalEvents.length === 0
      ? 'NOT_REACHED'
      : !granted && approvalEvents.every((event) => event.eventType === 'approval.requested')
        ? 'ESCALATED'
        : granted
          ? 'PASSED'
          : 'BLOCKED',
    approvalEvents,
    approvalEvents.length === 0
      ? 'No policy asked a human about this one.'
      : 'A vote is witnessed as a person’s act, in the transaction that recorded it.',
    approvalEvents.map((event) => `${event.eventType} by ${event.actorType} ${event.actor}`),
  )

  const signing = stage(
    'SIGNING',
    ticketEvents.length > 0 ? (settled || record.lifecycleState === 'SIGNING_FAILED' ? 'PASSED' : 'UNSETTLED') : 'NOT_REACHED',
    ticketEvents,
    ticketEvents.length === 0
      ? 'No ticket was minted, so no signing process was ever handed anything.'
      : 'A sealed single-use ticket crossed a process boundary; its bytes are not this surface’s to show.',
    ticketEvents.map((event) => `${event.eventType} · ${event.severity}`),
  )

  const execution = stage(
    'EXECUTION',
    record.lifecycleState === 'DENIED' || policy.state === 'BLOCKED' ? 'NOT_REACHED' : settled ? 'PASSED' : 'UNSETTLED',
    byType(['broadcast.submitted', 'broadcast.confirmed']),
    settled
      ? 'The row is past the unsettled states.'
      : 'The lifecycle stops where the ledger stops, and the API does not settle a request on a mock’s word.',
    [
      ...(simulationEvents.length > 0
        ? [`simulation was consulted: ${(newest(simulationEvents)?.meta as { simStatus?: string } | undefined)?.simStatus ?? 'status not recorded'}`]
        : []),
      `lifecycle ${record.lifecycleState}`,
    ],
  )

  return [intent, risk, policy, approval, signing, execution]
}
