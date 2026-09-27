'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'

/** The scheme's easing. One curve, used by every reveal in the app. */
export const EASE = [0.22, 1, 0.36, 1] as const

export const cx = (...values: ClassValue[]): string => clsx(values)

/* ------------------------------------------------------------------ state -- */

export type Tone = 'ok' | 'wait' | 'stop' | 'none'

/**
 * Engine vocabulary to a marker shape. The keys are the strings `packages/schemas` actually
 * emits, and they are rendered verbatim: a console that paraphrases `REQUIRE_HUMAN_APPROVAL` as
 * "needs a second signer" teaches its users a false model of their own controls.
 */
const TONE_BY_STATE: Record<string, Tone> = {
  ACTIVE: 'ok', LIVE: 'ok', ALLOW: 'ok', APPROVED: 'ok', GRANTED: 'ok', COMPLETE: 'ok',
  PASSED: 'ok', HEALTHY: 'ok', CONFIRMED: 'ok', SETTLED: 'ok', LOW: 'ok',
  PAUSED: 'wait', PENDING: 'wait', AWAITING_APPROVAL: 'wait', RETRYING: 'wait',
  REQUIRE_HUMAN_APPROVAL: 'wait', ESCALATED: 'wait', ADVISORY: 'wait', NOTICE: 'wait',
  UNSETTLED: 'wait', DRAFT: 'wait', MEDIUM: 'wait', PREVIEW: 'wait', APPROVAL_PENDING: 'wait',
  DENIED: 'stop', DENY: 'stop', REJECTED: 'stop', ANOMALOUS: 'stop', FAILED: 'stop',
  BLOCKED: 'stop', ERROR: 'stop', CRITICAL: 'stop', HIGH: 'stop', APPROVAL_REJECTED: 'stop',
  REVOKED: 'none', EXPIRED: 'none', SUPERSEDED: 'none', RETIRED: 'none', NONE: 'none',
  NOT_REACHED: 'none', UNAVAILABLE: 'none', ABANDONED: 'none',
}

export const toneFor = (value: string): Tone => TONE_BY_STATE[value.toUpperCase()] ?? 'none'

export const State = ({ value }: { readonly value: string }) => (
  <span className={cx('state', toneFor(value))}>
    <i aria-hidden="true" />
    {value}
  </span>
)

export const Tag = ({ children, stop = false }: { readonly children: ReactNode; readonly stop?: boolean }) => (
  <span className={cx('tag', stop && 'stop')}>{children}</span>
)

/* ----------------------------------------------------------------- reveal -- */

/**
 * Motion-only, deliberately without the marketing page's `.reveal` class. That class sets
 * `opacity: 0` in CSS and waits for JavaScript to lift it, so if the observer never fires the
 * headline is simply not there. In a console that is a blank screen, not a missed flourish.
 */
export function Reveal({ children, className = '', delay = 0 }: { readonly children: ReactNode; readonly className?: string; readonly delay?: number }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.12 }}
      transition={{ duration: 0.75, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

/* ------------------------------------------------------------------ chrome -- */

export const NAV: readonly { readonly href: string; readonly label: string }[] = [
  { href: '/console', label: 'OVERVIEW' },
  { href: '/console/agents', label: 'AGENTS' },
  { href: '/console/policies', label: 'POLICIES' },
  { href: '/console/transactions', label: 'TRANSACTIONS' },
  { href: '/console/approvals', label: 'APPROVALS' },
  { href: '/console/risk', label: 'RISK' },
  { href: '/console/wallets', label: 'WALLETS' },
  { href: '/console/audit', label: 'AUDIT LOG' },
  { href: '/console/developers', label: 'DEVELOPERS' },
  { href: '/console/settings', label: 'SETTINGS' },
]

export function Rail({ counts }: { readonly counts?: Readonly<Record<string, number>> }) {
  const pathname = usePathname()
  return (
    <aside className="rail">
      <Link className="brand" href="/" aria-label="ARI home">
        <img src="/ari-logo.svg" alt="ARI" />
      </Link>
      <nav aria-label="Console sections">
        {NAV.map((item) => {
          const on = item.href === '/console' ? pathname === item.href : pathname.startsWith(item.href)
          const count = counts?.[item.href]
          return (
            <Link key={item.href} href={item.href} aria-current={on ? 'page' : undefined}>
              <span>{item.label}</span>
              {count !== undefined && count > 0 && <i>{count}</i>}
            </Link>
          )
        })}
      </nav>
      <div className="rail-foot">
        HALDEN FREIGHT GROUP
        <br />
        PRODUCTION · EU-WEST-1
        <br />
        <span style={{ color: 'var(--accent)' }}>API NOT CONNECTED</span>
      </div>
    </aside>
  )
}

export function ConsoleTop({ crumb }: { readonly crumb: string }) {
  return (
    <div className="console-top">
      <span>
        ARI <b>/ {crumb}</b>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Link href="/" style={{ letterSpacing: '.15em' }}>
          MARKETING SITE ↗
        </Link>
      </span>
    </div>
  )
}

/**
 * The honesty strip. Everything under it is a fixture, and the page says so before you read a
 * single number rather than in a footnote.
 */
export const Notice = ({ text }: { readonly text: string }) => (
  <p className="notice">
    <span style={{ width: 7, height: 7, background: 'var(--accent)', display: 'inline-block' }} aria-hidden="true" />
    {text}
  </p>
)

/* ------------------------------------------------------------------- parts -- */

export function PageHead({ title, lede, actions }: { readonly title: string; readonly lede?: string; readonly actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div style={{ minWidth: 0 }}>
        <h1>{title}</h1>
        {lede !== undefined && <p className="lede">{lede}</p>}
      </div>
      {actions !== undefined && <div className="head-actions">{actions}</div>}
    </header>
  )
}

export function ButtonLink({ href, children, variant = 'solid', small = false }: { readonly href: string; readonly children: ReactNode; readonly variant?: 'solid' | 'light' | 'danger'; readonly small?: boolean }) {
  const className = cx('button-link', small && 'sm', variant === 'light' && 'button-link-light', variant === 'danger' && 'danger')
  const inner = (
    <>
      {children}
      <ArrowUpRight />
    </>
  )
  return href.startsWith('http') ? (
    <a href={href} className={className}>
      {inner}
    </a>
  ) : (
    <Link href={href} className={className}>
      {inner}
    </Link>
  )
}

export function ActionButton({
  children,
  onClick,
  variant = 'solid',
  small = true,
  disabled = false,
}: {
  readonly children: ReactNode
  readonly onClick: () => void
  readonly variant?: 'solid' | 'danger'
  readonly small?: boolean
  /** A button that is waiting on a network answer should not be pressable twice. */
  readonly disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx('button-link', small && 'sm', variant === 'danger' && 'danger')}>
      {children}
      <ArrowUpRight />
    </button>
  )
}

export type Metric = { readonly label: string; readonly value: ReactNode; readonly note?: string; readonly tone?: Tone }

export function MetricBand({ items }: { readonly items: readonly Metric[] }) {
  return (
    <div className="metric-band">
      {items.map((item) => (
        <div key={item.label}>
          <b className={item.tone === 'stop' ? 'stop' : item.tone === 'wait' ? 'wait' : undefined}>{item.value}</b>
          <small>{item.label}</small>
          {item.note !== undefined && <p>{item.note}</p>}
        </div>
      ))}
    </div>
  )
}

export function Panel({ title, note, children, pad = false }: { readonly title: string; readonly note?: string; readonly children: ReactNode; readonly pad?: boolean }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <span>{title}</span>
        {note !== undefined && <span>{note}</span>}
      </div>
      {pad ? <div className="panel pad" style={{ borderBottom: 0 }}>{children}</div> : children}
    </section>
  )
}

export type Column<Row> = {
  readonly key: string
  readonly header: string
  readonly align?: 'left' | 'right'
  readonly hideBelow?: 'sm' | 'md'
  readonly cell: (row: Row) => ReactNode
}

export function DataTable<Row>({ rows, columns, rowKey, onRow, empty }: { readonly rows: readonly Row[]; readonly columns: readonly Column<Row>[]; readonly rowKey: (row: Row) => string; readonly onRow?: (row: Row) => void; readonly empty?: ReactNode }) {
  const hide = { sm: 'hide-sm', md: 'hide-md' }
  if (rows.length === 0) return <>{empty ?? <div className="empty"><b>Nothing matches this view</b>Widen the filter. This table only shows rows for the tenant you are looking at.</div>}</>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.hideBelow !== undefined ? hide[column.hideBelow] : undefined} style={column.align === 'right' ? { textAlign: 'right' } : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRow === undefined ? undefined : () => onRow(row)}
              style={onRow === undefined ? undefined : { cursor: 'pointer' }}
            >
              {columns.map((column) => (
                <td key={column.key} className={column.hideBelow !== undefined ? hide[column.hideBelow] : undefined} style={column.align === 'right' ? { textAlign: 'right' } : undefined}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export const KeyValue = ({ items }: { readonly items: readonly { readonly k: string; readonly v: ReactNode }[] }) => (
  <dl className="kv">
    {items.map((item) => (
      <div key={item.k} style={{ display: 'contents' }}>
        <dt>{item.k}</dt>
        <dd>{item.v}</dd>
      </div>
    ))}
  </dl>
)

/** A limit and how close it is running. The fill animates in, the figure is the fact. */
export function Meter({ used, limit }: { readonly used: number; readonly limit: number }) {
  const pct = limit <= 0 ? 0 : Math.min(100, (used / limit) * 100)
  const [shown, setShown] = useState(0)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(pct))
    return () => cancelAnimationFrame(frame)
  }, [pct])
  return (
    <span className="meter" ref={ref} style={{ display: 'block' }}>
      <i style={{ width: `${shown}%` }} />
    </span>
  )
}

export const Empty = ({ title, body }: { readonly title: string; readonly body: string }) => (
  <div className="empty">
    <b>{title}</b>
    {body}
  </div>
)

/**
 * A screen that has no live read yet, drawn as itself.
 *
 * The alternative was to leave the unwired screens on the fixture and let the global banner
 * carry the difference, and that is the failure this file exists to prevent: with a connection
 * live, a page of sample rows under a banner reading "live tenant" is a page of lies with a
 * true caption. So an unbuilt screen says it is unbuilt, names what it would need, and stops.
 */
export function UnwiredScreen({ screen, need }: { readonly screen: string; readonly need: string }) {
  return (
    <section aria-label={`${screen}: not connected`} style={{ display: 'grid', gap: 12 }}>
      <p className="section-kicker">{screen.toUpperCase()} / NOT DRAWN</p>
      <p style={{ maxWidth: '62ch', lineHeight: 1.55 }}>
        Nothing here is invented to fill the space. {need}
      </p>
    </section>
  )
}
