'use client'

import { useRouter } from 'next/navigation'
import { useState, type CSSProperties } from 'react'
import { ActionButton, ButtonLink, DataTable, Empty, KeyValue, Panel, PageHead, Reveal, State, Tag, type Column } from '@/components/console/ui'
import { useConsole, type PendingApproval } from '@/lib/ari/console'
import { money, relativeTime, shortAddress, shortHash } from '@/lib/ari/format'
import type { ApprovalRequest } from '@/lib/ari/types'

/**
 * Approvals: the human queue.
 *
 * This is where a policy stops deciding. The queue is `approvals.filter(status === 'PENDING')`, the same
 * filter the overview rail and the overview band count, so the number of items here and the number that
 * says "waiting on a human" elsewhere are the same number rather than two claims. Everything shown per
 * item is read off that row: the amount is the decimal string on the request, the digest is the digest the
 * vote would be sealed against, and the vote count is counted from `approval.votes`, which is the only
 * place a recorded vote exists.
 *
 * The two buttons at the end of each item cannot write anything, and the screen says so instead of
 * pretending: this build has no API client and no deployment behind it. Nothing in this file mutates the
 * fixture to manufacture a decision.
 */



const FIVE_MINUTES = 5 * 60_000

/** A vote only counts toward quorum when the row records it as `APPROVED`; that is the engine word. */
const approvedVotes = (approval: PendingApproval): number => approval.votes

const COLUMN: CSSProperties = { display: 'grid', gap: 18 }

const LINE: CSSProperties = { alignItems: 'baseline', display: 'flex', flexWrap: 'wrap', gap: 12 }

const BODY: CSSProperties = { ...COLUMN, padding: '20px 22px' }

const FOOTER: CSSProperties = {
  alignItems: 'center',
  borderTop: '1px solid var(--line)',
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  justifyContent: 'space-between',
  padding: '14px 22px',
}


/** The queue label, without inventing a panel that would nest a panel inside it. */
const QUEUE_HEAD: CSSProperties = {
  alignItems: 'baseline',
  display: 'flex',
  flexWrap: 'wrap',
  fontSize: 10,
  gap: 20,
  justifyContent: 'space-between',
  letterSpacing: '.15em',
  marginBottom: 16,
}

const decidedColumns: readonly Column<PendingApproval>[] = [
  {
    key: 'request',
    header: 'REQUEST',
    cell: (approval) => (
      <div style={{ minWidth: 0 }}>
        {approval.why}
        <span className="sub">{approval.agentLabel}</span>
      </div>
    ),
  },
  {
    key: 'amount',
    header: 'AMOUNT',
    align: 'right',
    hideBelow: 'md',
    cell: (approval) => <span className="num">{money(approval.amountRaw, approval.unit, true)}</span>,
  },
  { key: 'outcome', header: 'OUTCOME', cell: (approval) => <State value={approval.status} /> },
  {
    key: 'votes',
    header: 'VOTES',
    align: 'right',
    hideBelow: 'sm',
    cell: (approval) => (
      <span className="num">
        {approvedVotes(approval)} of {approval.quorum}
      </span>
    ),
  },
  {
    key: 'expires',
    header: 'WINDOW',
    hideBelow: 'md',
    cell: (approval) => (
      <time dateTime={approval.expiresAt} className="num">
        {relativeTime(approval.expiresAt)}
      </time>
    ),
  },
  {
    key: 'digest',
    header: 'DIGEST',
    hideBelow: 'md',
    cell: (approval) => <span className="num">{shortHash(approval.digest)}</span>,
  },
]

export default function Approvals() {
  const { view, decide } = useConsole()

  /**
   * A vote is a POST, and the answer is the deployment's sentence rather than this screen's.
   *
   * Until a moment ago the buttons here set local state and printed a confirmation, which is the
   * pattern the whole console exists to refuse: a button that looks like it worked is a false
   * test of a contract nobody has run. So the message below is either the API's `code` and
   * `detail`, or the fact that no deployment is connected to send it to — and the queue is
   * re-read afterwards, because a quorum that just completed is a row that should leave.
   */
  const submit = async (approvalId: string, decision: 'APPROVED' | 'REJECTED'): Promise<void> => {
    setBusy(approvalId)
    const answer = await decide(approvalId, decision)
    setVerdict({ id: approvalId, ok: answer.ok, message: answer.message })
    setBusy(null)
  }

  const router = useRouter()
  const [verdict, setVerdict] = useState<{ id: string; ok: boolean; message: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const queue = view.approvals.filter((approval) => approval.status === 'PENDING')
  const decided = view.approvals.filter((approval) => approval.status !== 'PENDING')

  return (
    <div className="console-body">
      <Reveal>
        <PageHead
          title="WHERE A POLICY HANDS IT TO A PERSON"
          lede="What an escalation condition in a compiled policy decided it should not decide alone. A vote belongs to the request row, and the token that releases a signature is minted from that row rather than from this browser."
          actions={
            <ButtonLink href="/console/transactions" variant="light" small>
              THE LEDGER
            </ButtonLink>
          }
        />
      </Reveal>

      {queue.length === 0 ? (
        <Panel title="WAITING ON A PERSON" note="0 IN THE QUEUE">
          <Empty
            title="Nothing is waiting on a human"
            body="That is not the same as nothing needing one. An empty queue means every request in view stayed inside a limit someone wrote down. The queue is where the policy stops being numbers."
          />
        </Panel>
      ) : (
        <>
          <div style={QUEUE_HEAD}>
            <span>WAITING ON A PERSON</span>
            <span style={{ color: 'var(--muted)', fontFamily: 'monospace', letterSpacing: '.1em' }}>
              {queue.length} IN THE QUEUE
            </span>
          </div>

          {queue.map((approval) => {
            const approved = approvedVotes(approval)
            const needed = approval.quorum - approved
            const expiresIn = Date.parse(approval.expiresAt) - Date.now()
            const closing = expiresIn < FIVE_MINUTES
            const closedWindow = expiresIn <= 0

            return (
              <article className="panel" key={approval.id} style={{ marginBottom: 18 }}>
                <div className="panel-head">
                  <span>{approval.agentLabel}</span>
                  <span>{approval.requiredRole}</span>
                </div>

                <div style={BODY}>
                  <div style={LINE}>
                    <span className="num" style={{ fontSize: 22 }}>
                      {money(approval.amountRaw, approval.unit)}
                    </span>
                    <span className="sub" style={{ marginTop: 0 }}>
                      {approval.amountRaw === null ? 'contract_call · no token amount' : 'to'} {shortAddress(approval.recipient)} ·{' '}
                      {approval.asset === 'none' ? 'no asset carried' : approval.asset}
                    </span>
                  </div>

                  <p style={{ fontSize: 15, lineHeight: 1.5, margin: 0 }}>{approval.why}</p>

                  <KeyValue
                    items={[
                      {
                        k: 'POLICY',
                        v: `${approval.policyName} v${approval.policyVersionNumber}`,
                      },
                      {
                        k: 'RISK',
                        v: (
                          <>
                            <State value={approval.riskLevel} />
                            {approval.riskSignals.length > 0 ? (
                              <span className="sub">
                                {approval.riskSignals.join(' · ')}
                              </span>
                            ) : (
                              <span className="sub">no signal raised</span>
                            )}
                          </>
                        ),
                      },
                      {
                        k: 'VOTES',
                        v: (
                          <>
                            <span className="num">
                              {approved} of {approval.quorum} recorded
                            </span>
                            <span className="sub">
                              {needed <= 0 ? 'quorum reached on the row' : `${needed} more ${needed === 1 ? 'vote' : 'votes'} to reach quorum`}
                            </span>
                          </>
                        ),
                      },
                      {
                        k: 'EXPIRES',
                        v: (
                          <time
                            dateTime={approval.expiresAt}
                            style={{ color: closing ? 'var(--accent)' : 'var(--ink)', fontFamily: 'monospace' }}
                          >
                            {relativeTime(approval.expiresAt)}
                          </time>
                        ),
                      },
                      {
                        k: 'DIGEST',
                        v: <span className="num">{shortHash(approval.digest)}</span>,
                      },
                    ]}
                  />

                  {closedWindow && (
                    <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.55, margin: 0 }}>
                      This row is still <State value="PENDING" /> with its window closed. Expiry is decided the moment a
                      vote is claimed, against the database clock, and not by a sweeper that rewrites the row first. A
                      queue that read that clock would have stopped returning this item, and a decision recorded against
                      it now would be refused as <code style={{ fontFamily: 'monospace' }}>APPROVAL_EXPIRED</code>.
                    </p>
                  )}
                </div>

                <div style={FOOTER}>
                  <ButtonLink href={`/console/transactions/${approval.requestId}`} variant="light" small>
                    Review this request
                  </ButtonLink>
                  <span style={{ ...LINE, gap: 8 }}>
                    <ActionButton
                      variant="danger"
                      disabled={busy === approval.id}
                      onClick={() => void submit(approval.id, 'REJECTED')}
                    >
                      {busy === approval.id ? 'SENDING' : 'Reject this transfer'}
                    </ActionButton>
                    <ActionButton disabled={busy === approval.id} onClick={() => void submit(approval.id, 'APPROVED')}>
                      {busy === approval.id ? 'SENDING' : 'Approve this transfer'}
                    </ActionButton>
                  </span>
                </div>

                {verdict?.id === approval.id && (
                  <p className="notice" style={{ borderBottom: 0, padding: '11px 22px' }} role="status">
                    <span style={{ width: 7, height: 7, background: 'var(--accent)', display: 'inline-block' }} aria-hidden="true" />
                    {verdict.message}
                  </p>
                )}
              </article>
            )
          })}
        </>
      )}

      <Panel title="HOW A VOTE BECOMES A SIGNATURE" pad>
        <div style={{ ...COLUMN, gap: 14, color: 'var(--muted)', fontSize: 13, lineHeight: 1.55 }}>
          <p style={{ margin: 0 }}>
            A vote is written against the request row. That row carries the digest, the policy version, the agent, the
            wallet, the amount and the expiry, and the token that releases a signature is minted from it and read back
            from it, so this screen cannot state a different amount than the one being approved.
          </p>
          <p style={{ margin: 0 }}>
            The columns that define what was authorized are frozen in the schema while humans are voting. Once a payment
            has been approved, changing what was approved is the one substitution that would survive every check that
            comes after it, which is why the edit is refused at the row rather than by convention.
          </p>
          <p style={{ margin: 0 }}>
            An expired approval is not a soft failure. The request stops, nothing is minted from it, and a retry has to
            be decided again by a person.
          </p>
          <p style={{ ...LINE, gap: 8, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <Tag>{queue.length} PENDING</Tag>
            <span>
              In this build there is no database behind the two buttons above, so no vote is written, no token is minted,
              and no row changes state.
            </span>
          </p>
        </div>
      </Panel>

      <Panel title="DECIDED, AND OUT OF THE QUEUE" note="GRANTED · REJECTED · EXPIRED · CONSUMED">
        <DataTable
          rows={decided}
          columns={decidedColumns}
          rowKey={(approval) => approval.id}
          onRow={(approval) => router.push(`/console/transactions/${approval.requestId}`)}
          empty={
            <Empty
              title="No decided approval in this tenant"
              body="Every approval row this screen can read is still PENDING, so nothing here has been granted, rejected, expired or consumed. A decided row would appear below this line with its own outcome, and the queue above would have stopped showing it."
            />
          }
        />
      </Panel>
    </div>
  )
}
