'use client'

import { useRouter } from 'next/navigation'
import { useState, type CSSProperties } from 'react'
import { DataTable, Empty, MetricBand, PageHead, Panel, Reveal, State, type Column } from '@/components/console/ui'
import { useConsole, type ConsoleTransaction } from '@/lib/ari/console'
import { money, relativeTime, shortAddress } from '@/lib/ari/format'
import { EXECUTION_UNSETTLED, type DecisionOutcome, type TransactionRecord } from '@/lib/ari/types'

/**
 * Transactions: the ledger.
 *
 * This is the list of every request the engine has answered in the tenant being looked at, refusals
 * included, because a refusal that leaves no row is a refusal nobody can audit. The four figures on
 * the band are counted in this file from `inView`, the very array the table below renders, so a
 * number and the list it describes cannot disagree. Money stays a decimal string until `money()`
 * formats it; a `Number()` here would round the figure on the screen whose job is to say what the
 * policy looked at.
 *
 * `ALLOW`, `REQUIRE_HUMAN_APPROVAL`, `DENY`, the reason codes and every lifecycle name are the
 * engine's own strings, printed exactly as `lib/ari/types.ts` says the backend emits them. Two of
 * those states (`EXECUTION_UNSETTLED`) mean a signature exists and no chain has confirmed anything,
 * so those rows are drawn as unsettled rather than with a tick, and nothing on this screen claims a
 * block number, a hash or a confirmation count.
 */

const agentName = (tx: ConsoleTransaction): string => tx.agentLabel

/** A contract call has no recipient: the contract it calls is the destination. */
const destination = (tx: ConsoleTransaction): string | null => tx.recipient ?? tx.contract

/**
 * What a lifecycle row owes the reader. `SIGNING_COMPLETE` and `TICKET_MINTED` are the states where
 * the pipeline stopped at signing; `BROADCAST_CONFIRMED` is the one state the fixture uses to claim
 * settlement, and the fixture labels that claim itself, so the label here repeats the label rather
 * than upgrading it.
 */
const lifecycleNote = (tx: ConsoleTransaction): string | null =>
  EXECUTION_UNSETTLED.includes(tx.state)
    ? 'UNSETTLED · no chain confirmation'
    : tx.state === 'BROADCAST_CONFIRMED'
      ? 'claims settlement · no reconciler in this build'
      : null

/** Filter controls: the shared console form class, with one inline rule for the elastic text field. */
const FIELD_ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 22 }

const OUTCOMES: readonly DecisionOutcome[] = ['ALLOW', 'REQUIRE_HUMAN_APPROVAL', 'DENY']

export default function Transactions() {
  const { view } = useConsole()

  const router = useRouter()
  const rows = view.transactions
  const [query, setQuery] = useState('')
  const [outcome, setOutcome] = useState('ALL')
  const [chain, setChain] = useState('ALL')

  const chains = Array.from(new Set(rows.map((tx) => tx.chain)))
  const trimmed = query.trim().toLowerCase()

  const inView = rows.filter((tx) => {
    if (outcome !== 'ALL' && tx.outcome !== outcome) return false
    if (chain !== 'ALL' && tx.chain !== chain) return false
    if (trimmed.length === 0) return true
    const hay = `${tx.intent} ${agentName(tx)} ${tx.id} ${tx.requestId} ${destination(tx) ?? ''} ${tx.codes.join(' ')} ${tx.idempotencyKey}`.toLowerCase()
    return hay.includes(trimmed)
  })

  const allowed = inView.filter((tx) => tx.outcome === 'ALLOW').length
  const escalated = inView.filter((tx) => tx.outcome === 'REQUIRE_HUMAN_APPROVAL').length
  const refused = inView.filter((tx) => tx.outcome === 'DENY').length
  const unsettled = inView.filter((tx) => EXECUTION_UNSETTLED.includes(tx.state)).length

  const columns: readonly Column<ConsoleTransaction>[] = [
    {
      key: 'intent',
      header: 'INTENT',
      cell: (tx) => (
        <div style={{ minWidth: 0 }}>
          {tx.intent}
          <span className="sub">
            {agentName(tx)} · {tx.policyName} v{tx.policyVersionNumber}
            {destination(tx) !== null && <> · {shortAddress(destination(tx))}</>}
            {tx.kind !== 'transfer' && <> · {tx.kind}</>}
          </span>
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'AMOUNT',
      align: 'right',
      hideBelow: 'md',
      cell: (tx) => <span className="num">{money(tx.amountRaw, tx.unit, true)}</span>,
    },
    {
      key: 'decision',
      header: 'DECISION',
      cell: (tx) => (
        <div style={{ minWidth: 0 }}>
          <State value={tx.outcome ?? 'UNDECIDED'} />
          {tx.codes.length > 0 && <span className="sub">{tx.codes[0]}</span>}
        </div>
      ),
    },
    {
      key: 'state',
      header: 'LIFECYCLE',
      hideBelow: 'sm',
      cell: (tx) => (
        <div style={{ minWidth: 0 }}>
          <State value={tx.state} />
          {lifecycleNote(tx) !== null && <span className="sub">{lifecycleNote(tx)}</span>}
        </div>
      ),
    },
    {
      key: 'when',
      header: 'SUBMITTED',
      align: 'right',
      cell: (tx) => (
        <time dateTime={tx.submittedAt} title={tx.submittedAt}>
          {relativeTime(tx.submittedAt)}
        </time>
      ),
    },
  ]

  return (
    <div className="console-body">
      <Reveal>
        <PageHead
          title="THE LEDGER OF DECISIONS"
          lede="Every request the engine has answered, with the decision it made, the reason codes it recorded and the state it stopped in. A refusal is a row here, not a log line."
        />
      </Reveal>

      <MetricBand
        items={[
          { label: 'DECISIONS ALLOWED', value: allowed, note: 'the policy let these through without a person' },
          { label: 'AWAITING A HUMAN', value: escalated, tone: 'wait', note: 'an escalation condition this policy wrote down' },
          { label: 'REFUSED', value: refused, tone: 'stop', note: 'each one keeps its own reason codes' },
          { label: 'UNSETTLED AFTER SIGNING', value: unsettled, tone: 'wait', note: 'a signature exists, no chain has confirmed it' },
        ]}
      />

      <div style={FIELD_ROW}>
        <input
          className="field"
          style={{ flex: '1 1 220px', minWidth: 0 }}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter requests by intent, agent, id, address or reason code"
          placeholder="FILTER BY INTENT, AGENT, ID, ADDRESS OR REASON CODE"
        />
        <select className="field" value={outcome} onChange={(event) => setOutcome(event.target.value)} aria-label="Filter by decision">
          <option value="ALL">ANY DECISION</option>
          {OUTCOMES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select className="field" value={chain} onChange={(event) => setChain(event.target.value)} aria-label="Filter by chain">
          <option value="ALL">ANY CHAIN</option>
          {chains.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <Panel title="REQUESTS" note={`${inView.length} OF ${rows.length} IN VIEW`}>
        <DataTable
          rows={inView}
          columns={columns}
          rowKey={(tx) => tx.id}
          onRow={(tx) => router.push(`/console/transactions/${tx.id}`)}
          empty={
            <Empty
              title="No request matches these filters"
              body="Ari keeps refusals, so a denied request is still a row here. If a request is not in this list, it never reached the engine: check the agent credential, not the log."
            />
          }
        />
      </Panel>

      <Panel title="WHAT A ROW DOES NOT CLAIM" pad>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--muted)' }}>
          {unsettled} row{unsettled === 1 ? '' : 's'} in view show a signature returned with no chain
          confirmation behind it. That is the state the record is in, not a stale one: settlement belongs to a
          provider callback or a reconciliation pass, and neither exists in this build. Open a row to read the
          stage by stage trace that produced it.
        </p>
      </Panel>
    </div>
  )
}
