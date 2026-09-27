'use client'

import { ButtonLink, DataTable, Empty, KeyValue, Meter, MetricBand, Panel, PageHead, Reveal, State, Tag, type Column } from '@/components/console/ui'
import * as sampleData from '@/lib/ari/sample'
import { useConsole } from '@/lib/ari/console'
import { UnwiredScreen } from '@/components/console/ui'
import { money, pct, relativeTime } from '@/lib/ari/format'
import { riskAtLeast, type RiskAssessment, type RiskSignalName, type TransactionRecord } from '@/lib/ari/types'

/**
 * Risk. The advisory plane, on a screen of its own.
 *
 * Two rules shape this file.
 *
 * One: nothing here may read as a permission. A level is what a measurement said, and the column
 * that carries what actually happened is a different column, so the table keeps the two apart, the
 * panel between them states the boundary in plain words, and no score is ever drawn as a bar
 * against a ceiling. The only meters on this screen hold policy limits, because those are the
 * numbers that genuinely run out.
 *
 * Two: an absence is drawn as an absence. A request with no assessment shows the reason its own
 * row carries instead of an empty cell, and every signal name with nothing behind it in this
 * tenant is listed and tagged, because "the check did not run" and "the check passed" look
 * identical in an interface that only draws what happened.
 *
 * Every figure is computed from the fixture rows inside the expression that renders it, the way
 * the overview does it. The one list written out by hand is `RISK_SIGNAL_VOCABULARY`, and it is
 * written as a `Record<RiskSignalName, true>` on purpose: add or rename a member in
 * `lib/ari/types.ts` and this file stops compiling, so the gap this screen exists to show cannot
 * quietly shrink.
 */

/** Every member of the signal union, exhaustiveness checked by the annotation. */
const RISK_SIGNAL_VOCABULARY: Record<RiskSignalName, true> = {
  NEW_RECIPIENT: true,
  RECIPIENT_VELOCITY_CHANGE: true,
  AMOUNT_ABOVE_BASELINE: true,
  AMOUNT_8X_BASELINE: true,
  NEW_ASSET: true,
  NEW_CHAIN: true,
  NEW_CONTRACT: true,
  OUT_OF_HOURS: true,
  UNUSUAL_APPROVAL_PATTERN: true,
  POLICY_BOUNDARY_PROXIMITY: true,
  BEHAVIOUR_PROFILE_DRIFT: true,
  DORMANT_AGENT_RESUMED: true,
  NO_BEHAVIOUR_BASELINE: true,
  SIMULATION_WARNING: true,
  MODEL_OUTPUT_INCONSISTENCY: true,
}

const HOUR = 3_600_000
const DAY = 86_400_000
/** A month is a rolling thirty days here. The documents name a monthly ceiling, not a boundary. */
const MONTH = 30 * DAY

/**
 * The states whose row had a signature returned or confirmed, which is the population the fixture
 * itself sums in `usageFor`. A refusal reserved nothing, and a request still waiting on a person
 * has reserved nothing yet, so neither consumes a ceiling.
 */
const SIGNED: readonly string[] = ['SIGNING_COMPLETE', 'BROADCAST', 'BROADCAST_CONFIRMED']

/** Basis points, from a decimal string, without ever putting money through a JavaScript number. */
const basisOf = (used: bigint, limitRaw: string): number => {
  const limit = BigInt(limitRaw)
  return limit <= 0n ? 0 : Number((used * 10_000n) / limit)
}

/** A figure and the noun that fits it, so a count of one and a count of three both read correctly. */
const count = (value: number, one: string, many: string): string => `${value} ${value === 1 ? one : many}`

const mono = (children: string) => <span style={{ fontFamily: 'monospace' }}>{children}</span>

type AssessmentRow = {
  readonly tx: TransactionRecord
  readonly assessment: RiskAssessment | null
  /** The level when there is one, and the state of the RISK stage when there is not. */
  readonly level: string
  readonly reason: string | null
}

/** A ceiling, how much of it is gone, and the sentence for when the document has no such ceiling. */
const Limit = ({ label, meter, text, absent }: { readonly label: string; readonly meter: number; readonly text: string; readonly absent?: string }) => (
  <div style={{ minWidth: 0 }}>
    <span className="sub" style={{ marginTop: 0 }}>{label}</span>
    {absent !== undefined ? (
      <span className="muted" style={{ display: 'block', fontSize: 12, lineHeight: 1.45 }}>{absent}</span>
    ) : (
      <>
        <Meter used={meter} limit={10_000} />
        <span className="num" style={{ fontSize: 12 }}>{text}</span>
      </>
    )}
  </div>
)

export default function Risk() {
  const { view } = useConsole()
  if (view.source === 'live') {
    return <UnwiredScreen screen='risk' need='the band and signal columns can come from the assessments on the live rows; this screen is built on the fixture’s own history' />
  }
  const now = Date.now()
  const agentNames = new Map(sampleData.agents.map((agent) => [agent.id, agent.name] as const))

  const rows: AssessmentRow[] = [...sampleData.transactions]
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    .map((tx) => {
      const stage = tx.trace.find((item) => item.name === 'RISK')
      return {
        tx,
        assessment: tx.risk,
        level: tx.risk === null ? stage?.state ?? 'UNAVAILABLE' : tx.risk.level,
        reason: tx.risk === null ? stage?.detail[0] ?? stage?.headline ?? 'nothing was recorded at this stage' : null,
      }
    })

  const assessed = rows.filter((row) => row.assessment !== null)
  const unassessed = rows.filter((row) => row.assessment === null)
  const raised = new Set<RiskSignalName>(assessed.flatMap((row) => row.assessment?.signals ?? []))
  const uncomputable = (Object.keys(RISK_SIGNAL_VOCABULARY) as readonly RiskSignalName[]).filter((name) => !raised.has(name))
  const withSignal = sampleData.riskEvents().length
  const escalated = sampleData.transactions.filter((tx) => tx.outcome === 'REQUIRE_HUMAN_APPROVAL')

  /** The two columns answer different questions, and these counts are the proof of it from the rows. */
  const quiet = (row: AssessmentRow) => !riskAtLeast(row.assessment?.level ?? 'NONE', 'MEDIUM')
  const quietRefused = assessed.filter((row) => quiet(row) && row.tx.outcome === 'DENY').length
  const quietEscalated = assessed.filter((row) => quiet(row) && row.tx.outcome === 'REQUIRE_HUMAN_APPROVAL').length
  const loudGranted = assessed.filter((row) => !quiet(row) && row.tx.outcome === 'ALLOW').length
  const liveVersions = sampleData.policies.map((policy) => ({ policy, version: sampleData.activeVersion(policy.key) }))
  const escalateOnRisk = liveVersions.filter(({ version }) => version.document.escalation.humanApproval.requiredWhen.some((rule) => rule.op === 'risk_gte')).length
  const riskConditionNote = `${escalateOnRisk} of the ${liveVersions.length} active policy versions name a risk level in their escalation conditions, so a granted MEDIUM or worse would mean a document that stopped asking, not advice that agreed`

  const boundary = liveVersions.map(({ policy, version }) => {
    const bound = sampleData.transactions.filter((tx) => tx.policyVersionId === version.id)
    const spentSince = (window: number): bigint =>
      bound.reduce((sum, tx) => (tx.amountRaw !== null && SIGNED.includes(tx.state) && now - Date.parse(tx.submittedAt) < window ? sum + BigInt(tx.amountRaw) : sum), 0n)
    const limits = version.document.permissions.transfers
    const dailySpent = spentSince(DAY)
    const monthlySpent = spentSince(MONTH)
    const hourlyUsed = bound.filter((tx) => now - Date.parse(tx.submittedAt) < HOUR).length
    const dailyBp = basisOf(dailySpent, limits.perDay.maxRaw)
    const monthlyBp = limits.perMonth === null ? 0 : basisOf(monthlySpent, limits.perMonth.maxRaw)
    const hourlyBp = limits.maxTransactionsPerHour <= 0 ? 0 : Math.round((hourlyUsed / limits.maxTransactionsPerHour) * 10_000)
    return { policy, version, bound, limits, dailySpent, monthlySpent, hourlyUsed, dailyBp, monthlyBp, hourlyBp }
  })
  const liveIds = new Set(liveVersions.map(({ version }) => version.id))
  const offLive = sampleData.transactions.filter((tx) => !liveIds.has(tx.policyVersionId)).length
  const boundarySignals = sampleData.riskEvents().filter((event) => event.signals.includes('POLICY_BOUNDARY_PROXIMITY'))
  const noBaselineRows = sampleData.riskEvents().filter((event) => event.signals.includes('NO_BEHAVIOUR_BASELINE')).length

  const freshAgents = sampleData.agents.filter((agent) => sampleData.usageFor(agent.name).settledRaw === 0n)
  const windows = [...new Set(assessed.map((row) => row.assessment?.baselineWindowDays ?? 0))].sort((a, b) => a - b)
  const models = [...new Set(assessed.map((row) => row.assessment?.modelVersion ?? 'unlabelled'))]

  const columns: readonly Column<AssessmentRow>[] = [
    {
      key: 'request',
      header: 'REQUEST INTENT',
      cell: (row) => (
        <>
          {row.tx.intent}
          <span className="sub">
            {agentNames.get(row.tx.agentId) ?? row.tx.agentId} · {row.tx.policyName} v{row.tx.policyVersionNumber} · {relativeTime(row.tx.submittedAt)}
          </span>
        </>
      ),
    },
    {
      key: 'level',
      header: 'ADVISORY LEVEL',
      cell: (row) => (
        <>
          <State value={row.level} />
          {row.reason !== null && <span className="sub">{row.reason}</span>}
        </>
      ),
    },
    {
      key: 'signals',
      header: 'SIGNALS RAISED',
      hideBelow: 'md',
      cell: (row) =>
        row.assessment === null ? (
          <span className="muted">nothing was computed</span>
        ) : row.assessment.signals.length === 0 ? (
          <span className="muted">no signal crossed its weight</span>
        ) : (
          <span style={{ fontSize: 12 }}>{row.assessment.signals.join(', ')}</span>
        ),
    },
    {
      key: 'score',
      header: 'SCORE',
      align: 'right',
      hideBelow: 'sm',
      cell: (row) =>
        row.assessment === null ? (
          <span className="muted">not computed</span>
        ) : (
          <>
            <span className="num">{row.assessment.score.toFixed(2)}</span>
            <span className="sub">
              {row.assessment.baselineWindowDays}d · {row.assessment.modelVersion}
            </span>
          </>
        ),
    },
    {
      key: 'outcome',
      header: 'POLICY OUTCOME',
      cell: (row) => (
        <>
          <State value={row.tx.outcome} />
          <span className="sub">{row.tx.codes.length === 0 ? 'no reason code on the row' : row.tx.codes.join(' · ')}</span>
        </>
      ),
    },
  ]

  return (
    <div className="console-body">
      <Reveal>
        <PageHead
          title="ADVICE, NOT AUTHORISATION."
          lede="Everything below is what the advisory plane measured, and what it could not measure. None of it can authorise a payment. Where a level and a decision disagree, the decision is the one Ari acted on, and the refusal stands whether or not the score agreed with it."
          actions={
            <>
              <ButtonLink href="/console/transactions" small>
                ALL REQUESTS
              </ButtonLink>
              <ButtonLink href="/console/approvals" variant="light" small>
                {escalated.length} WITH A PERSON
              </ButtonLink>
            </>
          }
        />
      </Reveal>

      <MetricBand
        items={[
          {
            label: 'ASSESSED REQUESTS',
            value: assessed.length,
            note: `${rows.length} requests on this screen · ${unassessed.length} with no assessment at all`,
          },
          {
            label: 'SIGNALS RAISED',
            value: raised.size,
            note: `distinct names, raised across ${count(withSignal, 'request', 'requests')} · ${assessed.length - withSignal} assessed with nothing unusual`,
          },
          {
            label: 'SIGNALS NOT COMPUTED',
            value: uncomputable.length,
            tone: 'wait',
            note: `of ${Object.keys(RISK_SIGNAL_VOCABULARY).length} names in the vocabulary. No row in this tenant raised them, which is not the same sentence as a clean check`,
          },
          {
            label: 'ESCALATED TO A HUMAN',
            value: escalated.length,
            tone: 'wait',
            note: 'a person has to act. A policy document is what asks for that, and it may ask on a risk level, but a level on its own decides nothing',
          },
        ]}
      />

      <Panel title="THE ADVICE AND THE DECISION" note="RISK MAY ESCALATE, OR ADD A REFUSAL. IT MAY NEVER GRANT." pad>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, maxWidth: '72ch' }}>
          Risk reads what Ari has already recorded and says how odd a request looks against it. It
          can ask for a human, and where a live policy document says so, it can be a reason to
          refuse. It cannot let through anything policy refused, and the kernel rejects a plan that
          encodes the opposite: the object carrying a score has no field for a decision at all. A
          policy may read a level as one condition among many, and it may escalate or deny on it,
          but no level turns a refusal into an authorisation. Read the level column and the outcome
          column as two different speakers. When they disagree, the outcome is the one that already
          happened.
        </p>
        <div style={{ height: 24 }} />
        <KeyValue
          items={[
            { k: 'QUIET, REFUSED', v: `${count(quietRefused, 'request', 'requests')} scored below MEDIUM and policy refused ${quietRefused === 1 ? 'it' : 'them'} anyway` },
            { k: 'QUIET, ASKED', v: `${quietEscalated} scored below MEDIUM and a person was asked regardless. An escalation is a condition in the document, not a verdict from the score` },
            { k: 'LOUD, GRANTED', v: `${loudGranted} scored MEDIUM or worse and was granted by policy. ${riskConditionNote}` },
            {
              k: 'HOW IT DECIDES',
              v: (
                <>
                  A level is read by one condition, {mono('risk_gte')}, and by nothing else. A missing assessment is also a decision rather than a pass: {mono('RISK_ENGINE_UNAVAILABLE')} ends
                  as a refusal or as an escalation according to the document, and no request carries on as though an assessment had arrived.
                </>
              ),
            },
          ]}
        />
        <span className="sub" style={{ marginTop: 24 }}>WHAT EACH LIVE DOCUMENT DOES WHEN NO ASSESSMENT ARRIVES</span>
        {liveVersions.map(({ policy, version }) => (
          <span key={version.id} className="sub" style={{ marginTop: 4 }}>
            {policy.name} v{version.number}: {version.document.fallback.onRiskUnavailable}
          </span>
        ))}
      </Panel>

      <Panel title="ASSESSED REQUESTS" note={`${assessed.length} COMPUTED · ${unassessed.length} NOT`}>
        <DataTable rows={rows} columns={columns} rowKey={(row) => row.tx.id} />
      </Panel>

      <div className="split">
        <Panel title="THE ASSESSMENT THAT DID NOT HAPPEN" note={`${unassessed.length} REQUESTS · NO LEVEL, NO SCORE`}>
          {unassessed.length === 0 ? (
            <Empty
              title="Every request here was assessed"
              body="That is a fact about this fixture, not about a deployment. A request the advisory plane never ran on still has to appear, and it still has to say why it is blank."
            />
          ) : (
            <div className="stack-list">
              {unassessed.map((row) => (
                <div key={row.tx.id} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                  <div style={{ minWidth: 0 }}>
                    {row.tx.intent}
                    <span className="sub">
                      {agentNames.get(row.tx.agentId) ?? row.tx.agentId} · {relativeTime(row.tx.submittedAt)}
                    </span>
                    <span className="sub">
                      {row.reason} · codes {row.tx.codes.join(', ') || 'not recorded'}
                    </span>
                    <span className="sub" style={{ color: 'var(--ink)' }}>
                      An absent assessment is not a passed one. The marker above is the state of the RISK stage as this trace recorded it, and policy decided below it with no advice at all.
                    </span>
                  </div>
                  <State value={row.tx.outcome} />
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="SIGNALS THE ENGINE CANNOT COMPUTE" note={`${uncomputable.length} NAMES · NO DATA BEHIND THEM`}>
          <div className="stack-list">
            {uncomputable.map((name) => (
              <div key={name} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <div style={{ minWidth: 0 }}>
                  <span className="muted" style={{ fontFamily: 'monospace', fontSize: 11, textDecoration: 'line-through' }}>
                    {name}
                  </span>
                </div>
                <Tag>no data</Tag>
              </div>
            ))}
          </div>
          <p style={{ margin: '20px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--muted)' }}>
            Struck, not hidden. A name in the schema is a question the plane is allowed to ask; this
            tenant has no row that answers it, and the behavioural engine can only measure what Ari
            stored when it authorised something. Listing the gap is honest rather than empty,
            because the alternative is a list where an operator cannot tell the checked from the
            unasked. No request above scored quieter because a signal is missing here.
          </p>
        </Panel>
      </div>

      <Panel title="BOUNDARY PROXIMITY" note="SUMMED FROM THIS TENANT'S OWN ROWS" pad>
        <p style={{ margin: '0 0 8px', fontSize: 14, lineHeight: 1.55, maxWidth: '72ch' }}>
          This is where a policy stops being a control and starts being a constraint: a ceiling the
          tenant is approaching, in numbers the tenant itself produced. Every consumed figure below
          is summed from the rows that carry this version id, and it counts only the states where a
          signature came back or was confirmed, which is the narrower population the fixture itself
          sums in its usage figures. Nothing is counted from a refusal or from a request still
          waiting on a person, and nothing is averaged in from another tenant or fetched from a
          chain. A hold taken before a signature would be a larger number than this one, and Ari
          owns that accounting, not this screen.
        </p>
        <p style={{ margin: '0 0 20px', fontSize: 12, lineHeight: 1.5, color: 'var(--muted)', maxWidth: '72ch' }}>
          A monthly figure is a rolling thirty days, because these documents name a monthly ceiling
          and no calendar boundary. {count(offLive, 'request', 'requests')} here {offLive === 1 ? 'carries' : 'carry'} a version
          id that is no longer live, so its limits are not counted against a ceiling that was never
          in force for it.
        </p>
        <div className="stack-list">
          {boundary.map((item) => {
            const worst = Math.max(item.dailyBp, item.monthlyBp, item.hourlyBp)
            const wallet = sampleData.walletById(item.version.document.target.walletId)
            return (
              <div key={item.version.id}>
                <time dateTime={item.version.activatedAt ?? item.version.createdAt}>
                  {relativeTime(item.version.activatedAt ?? item.version.createdAt).toUpperCase()}
                </time>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 15 }}>
                    {item.policy.name} v{item.version.number}
                  </span>{' '}
                  <span className="muted" style={{ fontSize: 11 }}>
                    {wallet?.name ?? 'no target wallet on the document'} · {item.version.document.target.authorityMode}
                  </span>
                  <span className="sub">
                    {count(item.bound.length, 'request row', 'request rows')} carry this version id
                  </span>
                  <div style={{ display: 'grid', gap: '18px 26px', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', marginTop: 16 }}>
                    <Limit
                      label="DAILY"
                      meter={item.dailyBp}
                      text={`${money(item.dailySpent.toString(), item.limits.perDay.unit, true)} of ${money(item.limits.perDay.maxRaw, item.limits.perDay.unit, true)} · ${pct(item.dailyBp / 10_000)}`}
                    />
                    <Limit
                      label="MONTHLY"
                      meter={item.monthlyBp}
                      text={
                        item.limits.perMonth === null
                          ? ''
                          : `${money(item.monthlySpent.toString(), item.limits.perMonth.unit, true)} of ${money(item.limits.perMonth.maxRaw, item.limits.perMonth.unit, true)} · ${pct(item.monthlyBp / 10_000)}`
                      }
                      absent={
                        item.limits.perMonth === null
                          ? 'this document sets no monthly ceiling, so a month of small payments is unbounded by it. An absent ceiling is a property of the policy, not a limit somebody kept'
                          : undefined
                      }
                    />
                    <Limit label="REQUESTS THIS HOUR" meter={item.hourlyBp} text={`${item.hourlyUsed} of ${item.limits.maxTransactionsPerHour} · ${pct(item.hourlyBp / 10_000)}`} />
                  </div>
                </div>
                <Tag stop={worst >= 8_000}>{pct(worst / 10_000)}</Tag>
              </div>
            )
          })}
        </div>
        <p style={{ margin: '22px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--muted)', maxWidth: '72ch' }}>
          The advisory plane reads the same arithmetic and calls it {mono('POLICY_BOUNDARY_PROXIMITY')}, which{' '}
          {boundarySignals.length === 0
            ? 'no row in this tenant raised'
            : `${count(boundarySignals.length, 'row', 'rows')} here raised, on a request policy refused anyway for reasons of its own`}
          . The ceiling is not enforced by that signal: it is enforced by the reservation the engine
          makes against the ledger, which is why a quiet score and a hard stop can sit in one row.
        </p>
      </Panel>

      <Panel title="A TENANT WITH NO HISTORY SCORES MEDIUM" note="BY DESIGN" pad>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, maxWidth: '72ch' }}>
          The first payment an agent makes is unknown, not clean. The plane names that case{' '}
          {mono('NO_BEHAVIOUR_BASELINE')} rather than returning an empty signal list, and a request
          carrying only that one does not land in the quiet band: an unmeasured agent reads as a
          MEDIUM, which is where {escalateOnRisk === 0 ? 'no live document here' : `${escalateOnRisk} live document${escalateOnRisk === 1 ? '' : 's'}`} will send it to a person. That is the point of the
          asymmetry. {mono('NONE')} means this was measured and nothing stood out, and it is only an
          honest answer when something was measured.
        </p>
        <p style={{ margin: '18px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--muted)', maxWidth: '72ch' }}>
          {freshAgents.length} of {sampleData.agents.length} agents in this fixture have no request
          that ever reached a signature ({freshAgents.map((agent) => agent.name).join(', ') || 'none'}), so the next thing any of them
          proposes is measured against an empty window.{' '}
          {noBaselineRows === 0
            ? 'No row in the table above raised the signal, because nothing here was that agent’s first payment, and a screen that cannot show a case should say so out loud rather than leave the space where a tick would have gone.'
            : `${count(noBaselineRows, 'row', 'rows')} in the table above carried it, and the level on ${noBaselineRows === 1 ? 'it' : 'them'} is a statement about an absence of history rather than about anything unusual in the request.`}
        </p>
        <p style={{ margin: '18px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--muted)', maxWidth: '72ch' }}>
          The window and the model label are read back off the assessments, not typed onto the
          page: {windows.join(' / ')} days · {models.join(', ')}. That is the label this fixture
          carries, and it is not a version this screen can check against a deployment.
        </p>
      </Panel>
    </div>
  )
}
