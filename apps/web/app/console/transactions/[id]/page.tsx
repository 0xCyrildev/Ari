'use client'

import { useParams } from 'next/navigation'
import { useEffect, useState, type CSSProperties } from 'react'
import { Copy } from 'lucide-react'
import { ButtonLink, Empty, KeyValue, Panel, PageHead, Reveal, State, Tag } from '@/components/console/ui'
import { useConsole } from '@/lib/ari/console'
import { buildTrace } from '@/lib/ari/trace'
import type { ConsoleTransaction } from '@/lib/ari/console'
import { clockTime, money, relativeTime, shortHash } from '@/lib/ari/format'
import { EXECUTION_UNSETTLED, type TraceStage } from '@/lib/ari/types'

/**
 * One request, and the authorization trace that produced its decision.
 *
 * The `id` in the path matches either `tx.id` or `tx.requestId` because that is what
 * `transactionById` accepts, and those are the two strings an operator or a CLI has. The trace is the
 * screen: six stages, in the order the record says they ran, each with the state the engine recorded and
 * the audit event it was reconstructed from. Everything in the right column is what an auditor asks for
 * without being prompted, and every one of those figures is read off this row, never typed in.
 *
 * The honesty rule that shapes the whole page: the lifecycle stops at signing. Where
 * `EXECUTION_UNSETTLED` names the state, the EXECUTION stage is drawn as unsettled and says what is
 * missing. No block number, no transaction hash, no gas figure and no confirmation count appears anywhere
 * here, because none of them exists in the record.
 */

const agentName = (tx: ConsoleTransaction): string => tx.agentLabel

/** A contract call has no recipient: the contract it calls is the destination. */
const destination = (tx: ConsoleTransaction): string | null => tx.recipient ?? tx.contract

/**
 * A stage that never ran, and a stage downstream of the refusal that stopped the request, stay on the
 * page: "the pipeline never reached signing" is the information an operator needs. They are dimmed rather
 * than hidden, and hidden is the one thing that would turn an honest trace into a shorter lie.
 */
const isDimmed = (step: TraceStage, index: number, firstBlocked: number): boolean =>
  step.state === 'NOT_REACHED' || (step.state === 'BLOCKED' && firstBlocked >= 0 && index > firstBlocked)

/**
 * What the EXECUTION stage has to say out loud when it is the unsettled kind. The fixture supplies the
 * headline and its own detail line; this is the half that names the missing mechanism.
 */
const missingFromRecord = (step: TraceStage): string | null =>
  step.name === 'EXECUTION' && step.state === 'UNSETTLED'
    ? 'Settlement needs a provider callback or a reconciliation pass. Neither exists in this build, so the record stops here.'
    : step.name === 'EXECUTION' && step.state === 'NOT_REACHED'
      ? 'Nothing was broadcast, so there is nothing to confirm.'
      : null

const LABEL: CSSProperties = { color: 'var(--muted)', fontFamily: 'monospace', fontSize: 10, letterSpacing: '.13em' }

/**
 * A horizontal line inside a trace row. `.trace-row div` in globals.css carries a left rule from the
 * marketing pipeline diagram, so every nested block inside a trace row cancels it: the only vertical
 * rule on this screen is the one on the stage block itself.
 */
const LINE: CSSProperties = { alignItems: 'baseline', borderLeft: 'none', display: 'flex', flexWrap: 'wrap', gap: 14, paddingLeft: 0 }

const COLUMN: CSSProperties = { display: 'grid', gap: 18 }

/**
 * `.num` only carries a font inside `.data-table`, so outside a table the class is a label and this is
 * the face. Figures and identifiers stay monospaced so a digest does not look like prose.
 */
const NUM: CSSProperties = { fontFamily: 'monospace', whiteSpace: 'nowrap' }

/** A `.sub` line that has to survive an address or a UUID at 390px without widening the page. */
const SUB: CSSProperties = { wordBreak: 'break-word' }

const MONO_BLOCK: CSSProperties = { color: 'var(--ink)', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6, margin: 0, wordBreak: 'break-all' }

/**
 * Copy, which is the one action on this page that genuinely works: it writes text to the clipboard and
 * nothing else. If the browser refuses, the button says it refused rather than showing a tick.
 */
function CopyField({ label, value }: { readonly label: string; readonly value: string }) {
  const [result, setResult] = useState<'idle' | 'ok' | 'no'>('idle')

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setResult('ok')
    } catch {
      setResult('no')
    }
  }

  return (
    <div>
      <div style={{ ...LINE, justifyContent: 'space-between' }}>
        <span style={LABEL}>{label}</span>
        <button
          type="button"
          className="tag"
          onClick={() => void copy()}
          style={{ background: 'transparent', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Copy size={10} aria-hidden="true" />
          {result === 'ok' ? 'COPIED' : result === 'no' ? 'NOT COPIED' : 'COPY'}
        </button>
      </div>
      <p style={{ ...MONO_BLOCK, marginTop: 8 }}>{value}</p>
    </div>
  )
}

export default function TransactionDetail() {
  // Next 16 hands server `params` over as a Promise; `useParams` keeps this a plain client read.
  const raw = useParams()?.id
  const id = Array.isArray(raw) ? raw[0] ?? '' : raw ?? ''
  const api = useConsole()
  const base = api.view.transactions.find((row) => row.id === id || row.requestId === id)
  const [trail, setTrail] = useState<readonly TraceStage[]>([])
  const [errorText, setErrorText] = useState<string | null>(null)

  /**
   * The list read carries the row; only the record read carries its trail.
   *
   * So the trace is fetched for the one screen that shows it rather than seven trails on every
   * page load, and while it is arriving the stages are empty — the page says so in its own
   * panel instead of drawing six stages out of nothing.
   */
  useEffect(() => {
    if (base === undefined) return
    let active = true
    if (api.view.source === 'sample') {
      setTrail(base.trace)
      return
    }
    void api.record(base.id).then((answer) => {
      if (!active) return
      if (typeof answer === 'string') {
        setErrorText(answer)
        return
      }
      setTrail(buildTrace(answer))
    })
    return () => {
      active = false
    }
  }, [base, api])

  const tx = base === undefined ? undefined : { ...base, trace: trail }

  if (tx === undefined) {
    return (
      <div className="console-body">
        <Reveal>
          <PageHead
            title="NO RECORD WITH THAT ID"
            lede="The path is read against both the transaction id and the request id, because those are the two strings an operator or a CLI has."
            actions={
              <ButtonLink href="/console/transactions" small>
                BACK TO THE LEDGER
              </ButtonLink>
            }
          />
        </Reveal>
        <Panel title="LOOKED UP" note="NO MATCH">
          <div style={{ padding: '20px 22px' }}>
            <KeyValue
              items={[
                {
                  k: 'ID FROM THE PATH',
                  v: <span style={MONO_BLOCK}>{id === '' ? 'nothing after the last slash' : id}</span>,
                },
              ]}
            />
          </div>
          <Empty
            title="No request in this tenant carries that id"
            body="Ids are UUIDv7 shaped and never sequential, so a mistyped one is a missing row rather than a hidden one. A request that never reached the engine has no row at all: check the agent credential, then the idempotency key the caller sent."
          />
        </Panel>
      </div>
    )
  }

  // Both lookups go through the view rather than the fixture, so the same page reads a live
  // tenant and the sample one. A miss renders as "no wallet this read can name", which is the
  // truth for a row whose grant has since been revoked, not a crash.
  const wallet = api.view.wallets.find((row) => row.id === tx.walletId)
  const governed = api.view.policies.find((row) => row.versionIds.includes(tx.policyVersionId))
  const to = destination(tx)
  const firstBlocked = tx.trace.findIndex((step) => step.state === 'BLOCKED')
  const blockedStage = firstBlocked >= 0 ? tx.trace[firstBlocked]!.name : 'policy'
  const events = tx.trace.reduce((total, step) => total + step.events.length, 0)
  const unsettled = EXECUTION_UNSETTLED.includes(tx.state)

  const decisionCopy =
    tx.outcome === 'ALLOW'
      ? 'Every stage that had to pass did. The advisory plane could only have refused, never granted, and a ticket was minted for exactly the bytes this row digests.'
      : tx.outcome === 'DENY'
        ? `Refused at the ${blockedStage} stage. The reason codes below are the ones the engine recorded, copied without change.`
        : 'Within the limits this version wrote down, but an escalation condition in that same version sends the request to a named human first.'

  return (
    <div className="console-body">
      <Reveal>
        <PageHead
          title={tx.intent}
          lede={
            tx.kind === 'contract_call'
              ? 'A contract call, evaluated by the same policy language as a transfer, with native value refused outright because no token limit can bound it.'
              : 'A transfer, with the decision that governed it and the digest every later step is checked against.'
          }
          actions={
            <>
              <ButtonLink href="/console/transactions" variant="light" small>
                BACK TO THE LEDGER
              </ButtonLink>
              {tx.approval !== null && (
                <ButtonLink href="/console/approvals" small>
                  THE HUMAN QUEUE
                </ButtonLink>
              )}
            </>
          }
        />
      </Reveal>

      <div className="split">
        {/* ------------------------------------------------ trace first -- */}
        <div style={{ minWidth: 0 }}>
          <Panel title="THE REQUEST AS IT ARRIVED" note={tx.kind.toUpperCase()}>
            <div style={{ padding: '20px 22px' }}>
              <KeyValue
                items={[
                  { k: 'AGENT', v: agentName(tx) },
                  {
                    k: 'AMOUNT',
                    v: (
                      <>
                        <span className="num">{money(tx.amountRaw, tx.unit)}</span>
                        <span className="sub">{tx.amountRaw === null ? 'no token amount, a contract call' : tx.unit}</span>
                      </>
                    ),
                  },
                  {
                    k: 'DESTINATION',
                    v: to === null ? <span className="muted">no destination recorded</span> : <span style={MONO_BLOCK}>{to}</span>,
                  },
                  { k: 'CHAIN', v: tx.chain },
                  { k: 'ASSET', v: tx.kind === 'contract_call' ? 'not applicable, a contract call' : tx.asset },
                  {
                    k: 'WALLET',
                    v: (
                      <>
                        {wallet?.name ?? tx.walletId}
                        <span className="sub">
                          {wallet?.mode ?? 'no wallet row for this id'} · {wallet?.provider ?? 'no provider recorded'}
                        </span>
                      </>
                    ),
                  },
                  {
                    k: 'SUBMITTED',
                    v: (
                      <>
                        {relativeTime(tx.submittedAt)}
                        <span className="sub">
                          {clockTime(tx.submittedAt)} · decided {relativeTime(tx.decidedAt)}
                        </span>
                      </>
                    ),
                  },
                ]}
              />
            </div>
          </Panel>

          <Panel title="AUTHORIZATION TRACE" note={`${events} AUDIT EVENTS`}>
            <div style={{ padding: '0 22px 18px' }}>
              {tx.trace.map((step, index) => {
                const dimmed = isDimmed(step, index, firstBlocked)
                const missing = missingFromRecord(step)
                return (
                  <article className="trace-row" key={step.name} style={dimmed ? { opacity: 0.42 } : undefined}>
                    <time dateTime={step.at ?? undefined}>
                      {step.at === null ? (step.state === 'NOT_REACHED' ? 'not reached' : 'no time') : clockTime(step.at)}
                    </time>
                    <div>
                      <div style={LINE}>
                        <span>{step.name}</span>
                        <State value={step.state} />
                      </div>
                      <strong style={{ letterSpacing: '-.02em' }}>{step.headline}</strong>
                      {step.detail.map((line) => (
                        <span className="sub" key={line}>
                          {line}
                        </span>
                      ))}
                      {missing !== null && <span className="sub">{missing}</span>}
                      {step.codes.length > 0 && (
                        <div style={{ ...LINE, gap: 6 }}>
                          {step.codes.map((code) => (
                            <Tag stop key={code}>
                              {code}
                            </Tag>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          </Panel>
        </div>

        {/* ------------------------------------ what an auditor would ask -- */}
        <div style={{ minWidth: 0 }}>
          <Panel title="THE DECISION" note={`LEFT THE LIFECYCLE AT ${tx.state}`}>
            <div style={{ ...COLUMN, padding: '20px 22px' }}>
              <div style={LINE}>
                <State value={tx.outcome ?? 'UNDECIDED'} />
                <State value={tx.state} />
              </div>
              <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.55, margin: 0 }}>{decisionCopy}</p>
              {unsettled && (
                <p style={{ color: 'var(--ink)', fontSize: 13, lineHeight: 1.55, margin: 0 }}>
                  This record stops at signing. A signature exists and nothing has confirmed it on-chain: settlement
                  belongs to a provider callback or a reconciliation pass, and this build has neither.
                </p>
              )}
              {tx.codes.length > 0 ? (
                <div style={{ ...COLUMN, gap: 10 }}>
                  <span style={LABEL}>REASON CODES</span>
                  <div style={{ ...LINE, gap: 6 }}>
                    {tx.codes.map((code) => (
                      <Tag stop key={code}>
                        {code}
                      </Tag>
                    ))}
                  </div>
                </div>
              ) : (
                <span style={LABEL}>NO REASON CODE RECORDED</span>
              )}
            </div>
          </Panel>

          <Panel title="RISK" note={tx.risk === null ? 'NOT ASSESSED' : 'ADVISORY'}>
            <div style={{ ...COLUMN, gap: 14, padding: '20px 22px' }}>
              {tx.risk === null ? (
                <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.55, margin: 0 }}>
                  No assessment on this row. The request was refused before the advisory plane ran, and the absence is
                  recorded rather than defaulted to zero.
                </p>
              ) : (
                <>
                  <div style={LINE}>
                    <State value={tx.risk.level} />
                    <span className="num">score {tx.risk.score}</span>
                  </div>
                  {tx.risk.signals.length > 0 ? (
                    <div style={{ ...LINE, gap: 6 }}>
                      {tx.risk.signals.map((signal) => (
                        <Tag key={signal}>{signal}</Tag>
                      ))}
                    </div>
                  ) : (
                    <span style={LABEL}>NO SIGNAL CROSSED ITS WEIGHT</span>
                  )}
                  {/* The assessment's window length and model version are not on the event the
                      engine appends, so they are not on this page. A row that printed either would
                      be the screen's invention, not the risk plane's answer. */}
                  <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.55, margin: 0 }}>
                    Risk is advisory. It can raise a signal and it can escalate; structurally it cannot grant. Nothing
                    on this row got closer to a signature because of a number in this panel.
                  </p>
                </>
              )}
            </div>
          </Panel>

          <Panel title="WHAT THE RECORD BINDS">
            <div style={{ ...COLUMN, padding: '20px 22px' }}>
              <CopyField label="CANONICAL DIGEST" value={tx.digest} />
              <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, margin: 0 }}>
                Derived inside the engine and never accepted from the caller. The same bytes are compared again at
                approval redemption, at ticket minting and at signing, because every substitution threat in this system is
                a way of getting signed something other than what was looked at.
              </p>

              <div style={{ ...COLUMN, gap: 10 }}>
                <span style={LABEL}>GOVERNING POLICY VERSION</span>
                <div style={LINE}>
                  <span style={{ fontSize: 15 }}>
                    {tx.policyName} v{tx.policyVersionNumber}
                  </span>
                  {governed !== undefined ? <State value={governed.status} /> : <State value="UNAVAILABLE" />}
                </div>
                <span className="sub" style={{ marginTop: 0 }}>
                  resolved by version id, not by name · {shortHash(tx.policyVersionId, 8)}
                </span>
                {governed !== undefined ? (
                  <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.5, margin: 0 }}>{`${governed.name} · ${governed.versions} version${governed.versions === 1 ? '' : 's'} published`}</p>
                ) : (
                  <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.5, margin: 0 }}>
                    No version row with that id in this tenant. The decision still names the version it ran against; this
                    screen simply cannot read its document.
                  </p>
                )}
              </div>

              {tx.ticket !== null && (
                <div style={{ ...COLUMN, gap: 10 }}>
                  <span style={LABEL}>SINGLE USE TICKET</span>
                  <KeyValue
                    items={[
                      { k: 'ID', v: <span className="num">{shortHash(tx.ticket.id, 8)}</span> },
                      { k: 'MINTED', v: relativeTime(tx.ticket.mintedAt) },
                      { k: 'EXPIRES', v: relativeTime(tx.ticket.expiresAt) },
                      { k: 'REDEEMED', v: tx.ticket.redeemedAt === null ? 'not redeemed' : `${relativeTime(tx.ticket.redeemedAt)}, once` },
                    ]}
                  />
                  <p style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, margin: 0 }}>
                    Minted and redeemed in a second process, sealed to the digest above. The three stamps are printed as
                    this fixture holds them, and on this row they run backwards: the expiry sits before the minting. That is
                    the sample generator, not a ticket Ari would issue.
                  </p>
                </div>
              )}
            </div>
          </Panel>

          <Panel title="REFERENCES" note="PASTE THESE INTO THE CLI">
            <div style={{ padding: '20px 22px' }}>
              <div style={COLUMN}>
                <CopyField label="REQUEST ID" value={tx.requestId} />
                <CopyField label="TRANSACTION ID" value={tx.id} />
                <CopyField label="IDEMPOTENCY KEY" value={tx.idempotencyKey} />
              </div>
            </div>
          </Panel>
        </div>
      </div>

      <Panel title="WHAT ARI DOES NOT KNOW" pad>
        <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.55, margin: 0 }}>
          This record ends where its evidence ends. Nothing on this screen claims a chain confirmation that a provider
          has reported: there is no block number, no transaction hash, no gas figure and no count of confirmations here,
          because none of them is a field the row carries. {unsettled ? 'This row is the general case: a signature was returned, and settlement has not been earned.' : 'Where a row does claim settlement, the claim is the provider word recorded in the row, not a fact this build checked.'} A refusal
          leaves no capability behind, and a row that never reached a stage is shown as never having reached it rather
          than left out.
        </p>
      </Panel>
    </div>
  )
}
