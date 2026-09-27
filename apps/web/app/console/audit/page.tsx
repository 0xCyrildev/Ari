'use client'

import { useState, type CSSProperties } from 'react'
import { DataTable, MetricBand, Panel, Reveal, State, type Column } from '@/components/console/ui'
import { useConsole } from '@/lib/ari/console'
import { clockTime, relativeTime } from '@/lib/ari/format'
import type { AuditEvent } from '@/lib/ari/types'

/**
 * Audit log. The rows are `view.auditEvents`, newest first, and the reason the screen
 * shows two hash columns rather than one is that a row here is not a separate claim: it names
 * the row before it, so the whole list is one object that either hangs together or does not.
 *
 * The head is taken from the row with the *highest* `seq`, not from the last element of the
 * array. The array is ordered newest first for reading while the chain is linked oldest first,
 * so the tail of the display order is the genesis link, and reporting it as the head would be
 * a wrong answer in a place where a wrong answer is the whole point of the screen.
 *
 * Every figure on the band, in the filter note and in the tables is computed here, from these
 * rows, in the expression that renders it. The screen does not verify anything, and says so.
 */

/** The engine's severity vocabulary, in its own order. */
const SEVERITIES = ['info', 'notice', 'warning', 'critical'] as const

const FIELD: CSSProperties = {
  background: 'transparent',
  border: 0,
  borderBottom: '1px solid var(--line)',
  borderRadius: 0,
  color: 'inherit',
  font: '11px monospace',
  letterSpacing: '.1em',
  padding: '10px 0',
  width: '100%',
  minWidth: 0,
}

const LABEL: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  flex: '1 1 190px',
  minWidth: 0,
  color: 'var(--muted)',
  font: '10px monospace',
  letterSpacing: '.14em',
}

export default function AuditLog() {
  const { view } = useConsole()

  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('ALL')
  const [severityFilter, setSeverityFilter] = useState('ALL')

  const head = view.auditEvents.reduce((best, row) => (BigInt(row.seq) > BigInt(best.seq) ? row : best))
  const needle = query.trim().toLowerCase()

  const rows = view.auditEvents.filter(
    (event) =>
      (typeFilter === 'ALL' || event.type === typeFilter) &&
      (severityFilter === 'ALL' || event.severity === severityFilter) &&
      (needle === '' ||
        [
          event.type,
          event.actor,
          event.actorType,
          event.resource ?? '',
          event.resourceId ?? '',
          event.request ?? '',
          event.decision ?? '',
          event.reasons.join(' '),
          event.hash,
          event.prev,
        ]
          .join(' ')
          .toLowerCase()
          .includes(needle)),
  )

  const columns: readonly Column<AuditEvent>[] = [
    {
      key: 'seq',
      header: 'SEQ',
      cell: (event) => <span className="num">{event.seq}</span>,
    },
    {
      key: 'time',
      header: 'TIME',
      hideBelow: 'sm',
      cell: (event) => (
        <>
          <time dateTime={event.at}>{clockTime(event.at)}</time>
          <span className="sub">{relativeTime(event.at).toUpperCase()}</span>
        </>
      ),
    },
    {
      key: 'event',
      header: 'EVENT',
      cell: (event) => (
        <>
          {event.type}
          <span className="sub">
            {event.actorType} · {event.severity} · {event.resource ?? 'no resource'}
          </span>
          <span className="sub">{event.resourceId ?? 'no resource id'}</span>
        </>
      ),
    },
    {
      key: 'decision',
      header: 'DECISION',
      cell: (event) => (event.decision === null ? <span className="muted">not a decision</span> : <State value={event.decision} />),
    },
    {
      key: 'reason',
      header: 'FIRST REASON',
      hideBelow: 'md',
      cell: (event) =>
        event.reasons.length === 0 ? (
          <span className="muted">none</span>
        ) : (
          <>
            <span className="num">{event.reasons[0]}</span>
            {event.reasons.length > 1 && <span className="sub">{event.reasons.length - 1} more</span>}
          </>
        ),
    },
    {
      key: 'hash',
      header: 'ROW HASH',
      cell: (event) => (
        <span className="num" title={`this row links from ${event.prev}`}>
          {event.hash}
          <span className="sub">prev {event.prev}</span>
        </span>
      ),
    },
  ]

  return (
    <div className="console-body">
      <Reveal>
        <h1>
          EVERY DECISION,
          <br />
          IN ONE PIECE.
        </h1>
        <p className="lede">
          {view.auditEvents.length} rows, each naming the row before it. A trail you cannot
          check is a list; this one is exported and verified by someone who does not have to trust
          the server that wrote it.
        </p>
      </Reveal>

      <div style={{ height: 38 }} />

      <MetricBand
        items={[
          {
            label: 'EVENTS',
            value: view.auditEvents.length,
            note: "rows in this organisation's chain",
          },
          {
            label: 'DISTINCT EVENT TYPES',
            value: new Set(view.auditEvents.map((event) => event.type)).size,
            note: 'named in the rows above, not in a manual',
          },
          {
            label: 'REFUSALS RECORDED',
            value: view.auditEvents.filter((event) => event.decision === 'DENY').length,
            tone: 'stop',
            note: 'rows whose recorded decision is DENY',
          },
          {
            label: 'CHAIN HEAD',
            value: <span style={{ font: '13px monospace', letterSpacing: 0 }}>{head.hash}</span>,
            note: `the row with the highest seq, which is ${head.seq}`,
          },
        ]}
      />

      <Panel title="HOW THIS TRAIL IS CHECKED" note="READ THIS BEFORE READING THE ROWS" pad>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
          Verification does not read a row&apos;s <code style={{ fontFamily: 'monospace' }}>hash</code> column and
          believe it. It recomputes the digest from the row&apos;s own content and compares that with
          what the row claims, then checks that each row&apos;s{' '}
          <code style={{ fontFamily: 'monospace' }}>prev</code> is the recomputed digest of the row before it. The
          check that a tampered row has to survive is therefore against bytes the row itself carries,
          not against a value the same row was allowed to write.
        </p>
        <p style={{ margin: '16px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--muted)' }}>
          <code style={{ fontFamily: 'monospace' }}>seq</code> and <code style={{ fontFamily: 'monospace' }}>made_at</code> are
          deliberately outside the digest, because Postgres assigns them and a timestamp that
          round-trips through a different string than it went in would make every recomputed hash a
          false alarm. They are protected another way: reaching either one takes an UPDATE or a
          DELETE on <code style={{ fontFamily: 'monospace' }}>ari.audit_events</code>, and both are refused by trigger
          and by grant. The table is append-only per organisation, and appending is serialised by one
          advisory lock per organisation, keyed on <code style={{ fontFamily: 'monospace' }}>hashtextextended(org_id, 0)</code> and
          taken as the first statement of the tenant transaction, so two writers cannot each believe
          they hold the chain alone.
        </p>
        <p style={{ margin: '16px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--muted)' }}>
          This screen verifies none of that, and could not: it renders rows for the sample tenant
          the console is seeded with, and those rows carry {head.hash.length}-character fixture digests where a real
          link is 64 hexadecimal characters. They are the shape of a chain, not a chain. To check a
          real one, take it out of the server&apos;s hands: run{' '}
          <code style={{ fontFamily: 'monospace' }}>ari audit export --out ari-chain.json</code> and then{' '}
          <code style={{ fontFamily: 'monospace' }}>ari verify chain --in ari-chain.json</code>, optionally with{' '}
          <code style={{ fontFamily: 'monospace' }}>--head</code> set to a hash you wrote down when the payment happened.
          The verification command reads a file and needs no database, which is the point: whoever
          checks the history does not have to trust the system that wrote it.
        </p>
      </Panel>

      <Panel title="FILTER THESE ROWS" note={`${rows.length} OF ${view.auditEvents.length} SHOWN`}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, padding: '20px 24px' }}>
          <label style={LABEL}>
            QUERY
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="type, actor, resource, decision, reason, hash"
              style={FIELD}
            />
          </label>
          <label style={LABEL}>
            EVENT TYPE
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} style={FIELD}>
              <option value="ALL">ALL</option>
              {Array.from(new Set(view.auditEvents.map((event) => event.type)))
                .sort()
                .map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
            </select>
          </label>
          <label style={LABEL}>
            SEVERITY
            <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)} style={FIELD}>
              <option value="ALL">ALL</option>
              {SEVERITIES.filter((severity) => view.auditEvents.some((event) => event.severity === severity)).map((severity) => (
                <option key={severity} value={severity}>
                  {severity}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      <Panel title="THE TRAIL" note="NEWEST FIRST">
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(event) => `${event.seq}-${event.id}`}
          empty={
            <div className="empty">
              <b>No row matches all three</b>
              {rows.length === 0 && view.auditEvents.length > 0
                ? 'Clear one filter. The chain itself has not got shorter: it still holds every row this tenant wrote.'
                : 'The chain is empty.'}
            </div>
          }
        />
      </Panel>
    </div>
  )
}
