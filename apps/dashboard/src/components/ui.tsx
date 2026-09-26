import * as Dialog from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as Tip from '@radix-ui/react-tooltip';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from '../lib/util';

/* ==========================================================================
   Icons
   --------------------------------------------------------------------------
   Hand-drawn on a 16px grid at 1.5 stroke, because no icon package was
   installable on this box and a 1.75-stroke rounded library icon would fight the
   mark's own weight anyway. They are geometric and quiet: none of them is the
   visual focus of a screen.
   ========================================================================== */

type IconName =
  | 'overview'
  | 'agents'
  | 'policies'
  | 'transactions'
  | 'approvals'
  | 'risk'
  | 'wallets'
  | 'audit'
  | 'developers'
  | 'settings'
  | 'search'
  | 'chevron-right'
  | 'chevron-down'
  | 'arrow-right'
  | 'check'
  | 'x'
  | 'shield'
  | 'alert'
  | 'clock'
  | 'link'
  | 'copy'
  | 'menu'
  | 'lock'
  | 'key'
  | 'dot';

export function Icon({ name, className, size = 16 }: { readonly name: IconName; readonly className?: string; readonly size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    overview: <><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" /><rect x="9" y="1.5" width="5.5" height="5.5" rx="1" /><rect x="1.5" y="9" width="5.5" height="5.5" rx="1" /><rect x="9" y="9" width="5.5" height="5.5" rx="1" /></>,
    agents: <><circle cx="8" cy="5" r="2.5" /><path d="M3 14c0-2.5 2.2-4 5-4s5 1.5 5 4" /></>,
    policies: <><path d="M8 1.8 3 3.6v4.2c0 2.6 2 4.6 5 6 3-1.4 5-3.4 5-6V3.6L8 1.8Z" /><path d="M5.8 7.6 7.4 9.2l3-3.2" /></>,
    transactions: <><path d="M2 5.5h10M9.5 3 12 5.5 9.5 8" /><path d="M14 10.5H4m7.5-2.5L9 10.5l2.5 2.5" /></>,
    approvals: <><rect x="2.2" y="2" width="11.6" height="12" rx="1.5" /><path d="M5.2 8.2 7 10l4-4.4" /></>,
    risk: <><path d="M8 2 1.8 13.2h12.4L8 2Z" /><path d="M8 6.4v3M8 11.4v.2" /></>,
    wallets: <><rect x="1.8" y="4" width="12.4" height="9" rx="1.6" /><path d="M11.4 8.4h3M4 4V2.8h8" /></>,
    audit: <><path d="M3 2.5h7l3 3v9H3v-12Z" /><path d="M5.4 7.4h5.2M5.4 10h5.2" /></>,
    developers: <><path d="M5.6 4.4 2 8l3.6 3.6M10.4 4.4 14 8l-3.6 3.6M9 2.8 7 13.2" /></>,
    settings: <><circle cx="8" cy="8" r="2.2" /><path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5 4.8 4.8M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" /></>,
    search: <><circle cx="7" cy="7" r="4.4" /><path d="M10.4 10.4 14 14" /></>,
    'chevron-right': <path d="M6 3.5 10.5 8 6 12.5" />,
    'chevron-down': <path d="M3.5 6 8 10.5 12.5 6" />,
    'arrow-right': <path d="M2.5 8h11M9.8 4.5 13.5 8l-3.7 3.5" />,
    check: <path d="M2.8 8.4 6.2 11.8 13.2 4.2" />,
    x: <path d="M4 4l8 8M12 4l-8 8" />,
    shield: <path d="M8 1.8 3 3.6v4.2c0 2.6 2 4.6 5 6 3-1.4 5-3.4 5-6V3.6L8 1.8Z" />,
    alert: <><circle cx="8" cy="8" r="6.2" /><path d="M8 4.8v4M8 11v.2" /></>,
    clock: <><circle cx="8" cy="8" r="6.2" /><path d="M8 4.4V8l2.6 1.6" /></>,
    link: <path d="M6.6 9.4 9.4 6.6M5 8.6 3.6 10a2.4 2.4 0 0 0 3.4 3.4L8.4 12M11 7.4 12.4 6a2.4 2.4 0 0 0-3.4-3.4L7.6 5.6" />,
    copy: <><rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.4" /><path d="M10.6 5.4V3.8a1.4 1.4 0 0 0-1.4-1.4H3.8A1.4 1.4 0 0 0 2.4 3.8v5.4a1.4 1.4 0 0 0 1.4 1.4h1.6" /></>,
    menu: <path d="M2.4 4.4h11.2M2.4 8h11.2M2.4 11.6h11.2" />,
    lock: <><rect x="3.2" y="7" width="9.6" height="7" rx="1.4" /><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" /></>,
    key: <><circle cx="5.4" cy="8" r="2.8" /><path d="M8.2 8H14M11.6 8v2.4M13.6 8v1.6" /></>,
    dot: <circle cx="8" cy="8" r="2.6" />,
  };
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cx('shrink-0', className)}
    >
      {paths[name]}
    </svg>
  );
}

/* ==========================================================================
   Buttons
   ========================================================================== */

type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger' | 'quiet';

export function Button({
  variant = 'default',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: ButtonVariant;
  readonly size?: 'sm' | 'md';
  readonly icon?: ReactNode;
}) {
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-brand text-[#05090e] border-brand-dim hover:bg-brand-strong hover:border-brand font-semibold',
    default: 'bg-raised text-ink border-hair-strong hover:bg-hover hover:border-[#333c48]',
    ghost: 'bg-transparent text-ink-dim border-transparent hover:bg-hover hover:text-ink',
    danger: 'bg-deny-wash text-deny border-deny-line hover:bg-[#311718] hover:border-[#6b2f2f]',
    quiet: 'bg-transparent text-ink-mute border-hair hover:text-ink hover:bg-hover',
  };
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border transition-colors duration-[var(--dur-fast)] disabled:opacity-45 disabled:pointer-events-none whitespace-nowrap',
        size === 'sm' ? 'h-6 px-2 text-2xs' : 'h-7.5 px-3 text-xs',
        variants[variant],
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ label, name, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly label: string; readonly name: IconName }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        'grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] border border-transparent text-ink-mute transition-colors hover:border-hair hover:bg-hover hover:text-ink',
        className,
      )}
    >
      <Icon name={name} />
    </button>
  );
}

/* ==========================================================================
   Badges and status
   ========================================================================== */

export type Tone = 'brand' | 'allow' | 'caution' | 'deny' | 'neutral';

const toneClasses: Record<Tone, string> = {
  brand: 'text-brand border-brand-dim bg-brand-wash',
  allow: 'text-allow border-allow-line bg-allow-wash',
  caution: 'text-caution border-caution-line bg-caution-wash',
  deny: 'text-deny border-deny-line bg-deny-wash',
  neutral: 'text-ink-dim border-neutral-line bg-neutral-wash',
};

export function Badge({ tone = 'neutral', children, mono = false, className }: { readonly tone?: Tone; readonly children: ReactNode; readonly mono?: boolean; readonly className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-[var(--radius-xs)] border px-1.5 py-[1px] text-2xs font-medium uppercase tracking-[0.06em]', mono && 'font-mono normal-case tracking-normal', toneClasses[tone], className)}>
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  ACTIVE: 'allow', LIVE: 'allow', ALLOW: 'allow', APPROVED: 'allow', GRANTED: 'allow', COMPLETE: 'allow', PASSED: 'allow', HEALTHY: 'allow', CONFIRMED: 'allow',
  PAUSED: 'caution', PENDING: 'caution', AWAITING_APPROVAL: 'caution', RETRYING: 'caution', REQUIRE_HUMAN_APPROVAL: 'caution', ADVISORY: 'caution', NOTICE: 'caution', UNSETTLED: 'caution', DRAFT: 'caution',
  DENIED: 'deny', REJECTED: 'deny', ANOMALOUS: 'deny', FAILED: 'deny', CRITICAL: 'deny', HIGH: 'deny', BLOCKED: 'deny', ERROR: 'deny',
  REVOKED: 'neutral', EXPIRED: 'neutral', SUPERSEDED: 'neutral', RETIRED: 'neutral', NONE: 'neutral', LOW: 'allow', MEDIUM: 'caution',
};

export const toneFor = (value: string): Tone => STATUS_TONES[value.toUpperCase()] ?? 'neutral';

export function Status({ value, label, dot = true, className }: { readonly value: string; readonly label?: string; readonly dot?: boolean; readonly className?: string }) {
  const tone = toneFor(value);
  const dotColor = { brand: 'bg-brand', allow: 'bg-allow', caution: 'bg-caution', deny: 'bg-deny', neutral: 'bg-ink-mute' }[tone];
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-xs', tone === 'neutral' ? 'text-ink-dim' : `text-${tone}` === 'text-allow' ? 'text-allow' : '', className)}>
      {dot && <span className={cx('h-1.5 w-1.5 rounded-full', dotColor, value === 'PENDING' && 'anim-live')} />}
      <span className="font-medium tracking-[0.02em]">{label ?? value}</span>
    </span>
  );
}

export function RiskPip({ level }: { readonly level: string }) {
  const filled = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[level.toUpperCase()] ?? 0;
  const tone = toneFor(level);
  const bar = { brand: 'bg-brand', allow: 'bg-allow', caution: 'bg-caution', deny: 'bg-deny', neutral: 'bg-ink-faint' }[tone];
  return (
    <span className="inline-flex items-end gap-[2px]" aria-label={`risk ${level}`}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={cx('w-[3px] rounded-[1px]', i < filled ? bar : 'bg-hair-strong')} style={{ height: `${5 + i * 2.5}px` }} />
      ))}
    </span>
  );
}

/* ==========================================================================
   Surfaces
   ========================================================================== */

export function Panel({ title, action, children, className, pad = true }: { readonly title?: ReactNode; readonly action?: ReactNode; readonly children: ReactNode; readonly className?: string; readonly pad?: boolean }) {
  return (
    <section className={cx('rounded-[var(--radius-md)] border border-hair bg-surface', className)}>
      {(title !== undefined || action !== undefined) && (
        <header className="flex items-center justify-between gap-3 border-b border-hair px-3.5 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-[0.07em] text-ink-dim">{title}</h3>
          {action}
        </header>
      )}
      <div className={pad ? 'p-3.5' : ''}>{children}</div>
    </section>
  );
}

export function SectionTitle({ children, hint, className }: { readonly children: ReactNode; readonly hint?: ReactNode; readonly className?: string }) {
  return (
    <div className={cx('mb-2 flex items-baseline justify-between gap-4', className)}>
      <h2 className="text-2xs font-semibold uppercase tracking-[0.09em] text-ink-mute">{children}</h2>
      {hint !== undefined && <span className="text-2xs text-ink-faint">{hint}</span>}
    </div>
  );
}

export function KeyValue({ items, dense = false }: { readonly items: readonly { readonly k: string; readonly v: ReactNode }[]; readonly dense?: boolean }) {
  return (
    <dl className={cx('grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4', dense ? 'gap-y-1' : 'gap-y-1.5')}>
      {items.map((item) => (
        <div key={item.k} className="contents">
          <dt className="truncate text-xs text-ink-mute">{item.k}</dt>
          <dd className="min-w-0 text-xs text-ink">{item.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Meter({ value, max, tone = 'brand', label }: { readonly value: number; readonly max: number; readonly tone?: Tone; readonly label?: string }) {
  const pct = max <= 0 ? 0 : Math.min(100, (value / max) * 100);
  const fill = { brand: 'bg-brand', allow: 'bg-allow', caution: 'bg-caution', deny: 'bg-deny', neutral: 'bg-ink-mute' }[tone];
  return (
    <div className="w-full">
      <div className="h-1 w-full overflow-hidden rounded-full bg-[#151a20]">
        <div className={cx('h-full rounded-full transition-[width] duration-[var(--dur-slow)]', fill)} style={{ width: `${pct}%` }} />
      </div>
      {label !== undefined && <div className="mt-1 text-2xs num text-ink-mute">{label}</div>}
    </div>
  );
}

export function EmptyState({ title, body, action, mark = true }: { readonly title: string; readonly body: string; readonly action?: ReactNode; readonly mark?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {mark && <span className="ari-mark h-9 w-9 text-ink-faint" role="img" aria-label="ARI" />}
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-ink-mute">{body}</p>
      </div>
      {action}
    </div>
  );
}

/* ==========================================================================
   Overlays
   ========================================================================== */

/** One provider for the whole tree — see `main.tsx`. */
export function TooltipProvider({ children }: { readonly children: ReactNode }) {
  return <Tip.Provider delayDuration={200} skipDelayDuration={400}>{children}</Tip.Provider>;
}

export function Tooltip({ content, children }: { readonly content: ReactNode; readonly children: ReactNode }) {
  return (
    <Tip.Root delayDuration={220}>
      <Tip.Trigger asChild>{children}</Tip.Trigger>
      <Tip.Portal>
        <Tip.Content
          sideOffset={6}
          className="z-50 max-w-xs rounded-[var(--radius-sm)] border border-hair-strong bg-raised px-2.5 py-1.5 text-2xs leading-relaxed text-ink shadow-[0_10px_28px_-14px_rgba(0,0,0,0.9)] data-[state=delayed-open]:anim-fade"
        >
          {content}
          <Tip.Arrow width={8} height={4} className="fill-raised" />
        </Tip.Content>
      </Tip.Portal>
    </Tip.Root>
  );
}

export function Modal({ open, onClose, title, subtitle, children, footer, width = 'max-w-lg' }: { readonly open: boolean; readonly onClose: () => void; readonly title: string; readonly subtitle?: ReactNode; readonly children: ReactNode; readonly footer?: ReactNode; readonly width?: string }) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[#03050799] backdrop-blur-[1px] data-[state=open]:anim-fade" />
        <Dialog.Content
          className={cx(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-lg)] border border-hair-strong bg-surface shadow-[0_28px_80px_-24px_rgba(0,0,0,0.95)] data-[state=open]:anim-rise',
            width,
          )}
        >
          <header className="border-b border-hair px-4 py-3">
            <Dialog.Title className="text-sm font-semibold text-ink">{title}</Dialog.Title>
            {subtitle !== undefined && <div className="mt-0.5 text-xs text-ink-mute">{subtitle}</div>}
          </header>
          <div className="max-h-[70vh] overflow-y-auto px-4 py-3.5">{children}</div>
          {footer !== undefined && <footer className="flex items-center justify-end gap-2 border-t border-hair px-4 py-3">{footer}</footer>}
          <Dialog.Close asChild>
            <IconButton name="x" label="Close" className="absolute right-2 top-2" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Drawer({ open, onClose, title, children, footer }: { readonly open: boolean; readonly onClose: () => void; readonly title: ReactNode; readonly children: ReactNode; readonly footer?: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[#030507aa]" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[34rem] flex-col border-l border-hair-strong bg-surface shadow-[-24px_0_64px_-32px_rgba(0,0,0,0.95)] data-[state=open]:animate-in">
          <header className="flex items-center justify-between gap-3 border-b border-hair px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild><IconButton name="x" label="Close panel" /></Dialog.Close>
          </header>
          <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
          {footer !== undefined && <footer className="border-t border-hair px-4 py-3">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Tabs({ tabs, value, onChange }: { readonly tabs: readonly { readonly id: string; readonly label: string; readonly count?: number }[]; readonly value: string; readonly onChange: (id: string) => void }) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onChange} className="mb-3 border-b border-hair">
      <TabsPrimitive.List className="flex gap-0.5 overflow-x-auto">
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.id}
            value={tab.id}
            className={cx(
              'relative whitespace-nowrap border-b-2 border-transparent px-2.5 py-1.5 text-xs text-ink-mute transition-colors hover:text-ink',
              'data-[state=active]:border-brand data-[state=active]:text-ink',
            )}
          >
            {tab.label}
            {tab.count !== undefined && <span className="ml-1.5 num text-2xs text-ink-faint">{tab.count}</span>}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

/* ==========================================================================
   Data
   ========================================================================== */

export interface Column<Row> {
  readonly key: string;
  readonly header: string;
  readonly width?: string;
  readonly align?: 'left' | 'right';
  readonly hideBelow?: 'sm' | 'md' | 'lg';
  readonly cell: (row: Row) => ReactNode;
  readonly sortValue?: (row: Row) => string | number;
}

export function DataTable<Row>({
  rows,
  columns,
  rowKey,
  onRowClick,
  empty,
  initialSort,
  density = 'normal',
}: {
  readonly rows: readonly Row[];
  readonly columns: readonly Column<Row>[];
  readonly rowKey: (row: Row) => string;
  readonly onRowClick?: (row: Row) => void;
  readonly empty?: ReactNode;
  readonly initialSort?: { readonly key: string; readonly dir: 'asc' | 'desc' };
  readonly density?: 'normal' | 'compact';
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const ordered = useMemo(() => {
    if (sort === null) return rows;
    const column = columns.find((c) => c.key === sort.key);
    if (column?.sortValue === undefined) return rows;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = column.sortValue!(a);
      const y = column.sortValue!(b);
      if (x === y) return 0;
      return (x > y ? 1 : -1) * factor;
    });
  }, [rows, sort, columns]);

  const hide = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-hair bg-[#0c1015]">
            {columns.map((column) => (
              <th
                key={column.key}
                style={column.width !== undefined ? { width: column.width } : undefined}
                className={cx(
                  'eyebrow px-3 py-2 font-semibold',
                  column.align === 'right' && 'text-right',
                  column.hideBelow !== undefined && hide[column.hideBelow],
                )}
              >
                {column.sortValue === undefined ? (
                  column.header
                ) : (
                  <button
                    className="inline-flex items-center gap-1 hover:text-ink-dim"
                    onClick={() =>
                      setSort((current) =>
                        current?.key === column.key ? { key: column.key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key: column.key, dir: 'asc' },
                      )
                    }
                  >
                    {column.header}
                    <span className={cx('text-[8px] leading-none transition-opacity', sort?.key === column.key ? 'opacity-100' : 'opacity-0')}>
                      {sort?.dir === 'asc' ? '▲' : '▼'}
                    </span>
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.length === 0 && (
            <tr>
              <td colSpan={columns.length}>{empty ?? <EmptyState title="Nothing here yet" body="This view has no rows for the current filters." />}</td>
            </tr>
          )}
          {ordered.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick === undefined ? undefined : () => onRowClick(row)}
              className={cx(
                'border-b border-hair-faint transition-colors last:border-0',
                onRowClick !== undefined && 'cursor-pointer hover:bg-hover',
                density === 'compact' ? '[&>td]:py-1.5' : '[&>td]:py-2.5',
              )}
            >
              {columns.map((column) => (
                <td key={column.key} className={cx('px-3 align-middle text-xs', column.align === 'right' && 'text-right', column.hideBelow !== undefined && hide[column.hideBelow])}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MetricCard({ label, value, hint, tone = 'neutral', trend }: { readonly label: string; readonly value: ReactNode; readonly hint?: ReactNode; readonly tone?: Tone; readonly trend?: string }) {
  const value_tone = { brand: 'text-brand', allow: 'text-allow', caution: 'text-caution', deny: 'text-deny', neutral: 'text-ink' }[tone];
  return (
    <div className="group relative rounded-[var(--radius-md)] border border-hair bg-surface px-3.5 py-3 transition-colors hover:border-hair-strong">
      <div className="eyebrow">{label}</div>
      <div className={cx('mt-1.5 text-xl font-semibold num leading-none tracking-tight', value_tone)}>{value}</div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-2xs text-ink-mute">
        <span>{hint}</span>
        {trend !== undefined && <span className="num text-ink-faint">{trend}</span>}
      </div>
    </div>
  );
}

export function CodeBlock({ code, caption, language = 'ts' }: { readonly code: string; readonly caption?: string; readonly language?: string }) {
  return (
    <figure className="overflow-hidden rounded-[var(--radius-md)] border border-hair bg-[#080b0e]">
      <figcaption className="flex items-center justify-between border-b border-hair px-3 py-1.5">
        <span className="eyebrow">{caption ?? language}</span>
        <CopyButton value={code} />
      </figcaption>
      <pre className="overflow-x-auto px-3 py-2.5 text-[12px] leading-relaxed">
        <code className="font-mono text-ink-dim">{highlight(code)}</code>
      </pre>
    </figure>
  );
}

/**
 * Token colouring by regex, not a parser.
 *
 * A real highlighter is another dependency, and on a documentation surface the only thing
 * colour must do is separate a string from a key from a comment — so this is deliberately
 * dumb and never wrong about structure: it splits on the pattern and colours the pieces.
 */
function highlight(code: string): ReactNode[] {
  const pattern = /(\/\/[^\n]*|'[^']*'|"[^"]*"|\b(?:const|await|async|return|new|type|interface|from|import|export|function)\b|[A-Z_]{4,}|\b\d+(?:\.\d+)?\b)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(code)) !== null) {
    if (match.index > last) out.push(code.slice(last, match.index));
    const token = match[0]!;
    const cls = token.startsWith('//')
      ? 'text-ink-faint italic'
      : /^['"]/.test(token)
        ? 'text-allow'
        : /^[A-Z_]{4,}$/.test(token)
          ? 'text-caution'
          : /^\d/.test(token)
            ? 'text-brand'
            : 'text-ink-mute';
    out.push(<span key={`t${(i += 1)}`} className={cls}>{token}</span>);
    last = match.index + token.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function CopyButton({ value, label = 'Copy' }: { readonly value: string; readonly label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      className="inline-flex items-center gap-1 text-2xs text-ink-mute transition-colors hover:text-ink"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setDone(true);
        timer.current = window.setTimeout(() => setDone(false), 1400);
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={12} />
      {done ? 'Copied' : label}
    </button>
  );
}

/* ==========================================================================
   Inputs
   ========================================================================== */

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx('h-7.5 w-full rounded-[var(--radius-sm)] border border-hair bg-raised px-2.5 text-xs text-ink placeholder:text-ink-faint transition-colors hover:border-hair-strong focus:border-brand-dim focus:outline-none focus-visible:outline-offset-0', className)} />;
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={cx(
        'h-7.5 appearance-none rounded-[var(--radius-sm)] border border-hair bg-raised pl-2.5 pr-7 text-xs text-ink transition-colors hover:border-hair-strong focus:border-brand-dim focus:outline-none',
        'bg-[url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'10\' viewBox=\'0 0 16 16\' fill=\'none\' stroke=\'%236f767e\' stroke-width=\'1.6\' stroke-linecap=\'round\'><path d=\'M3.5 6 8 10.5 12.5 6\'/></svg>")] bg-[position:right_0.5rem_center] bg-no-repeat',
        className,
      )}
    >
      {children}
    </select>
  );
}

/* ==========================================================================
   Toasts
   ========================================================================== */

interface ToastItem {
  readonly id: number;
  readonly tone: Tone;
  readonly text: string;
}

let pushToast: ((tone: Tone, text: string) => void) | null = null;
export const toast = (tone: Tone, text: string): void => pushToast?.(tone, text);

export function ToastViewport() {
  const [items, setItems] = useState<readonly ToastItem[]>([]);
  pushToast = (tone, text) => {
    const id = Date.now() + Math.random();
    setItems((current) => [...current.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 4200);
  };
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {items.map((item) => (
        <div key={item.id} className={cx('anim-rise pointer-events-auto rounded-[var(--radius-md)] border bg-raised px-3 py-2 text-xs shadow-[0_16px_40px_-20px_rgba(0,0,0,0.95)]', toneClasses[item.tone])}>
          {item.text}
        </div>
      ))}
    </div>
  );
}

/* ==========================================================================
   Page furniture
   ========================================================================== */

export function PageHeader({ eyebrow, title, lead, actions, meta }: { readonly eyebrow?: string; readonly title: string; readonly lead?: ReactNode; readonly actions?: ReactNode; readonly meta?: ReactNode }) {
  return (
    <header className="mb-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-3xl">
          {eyebrow !== undefined && <div className="eyebrow mb-1">{eyebrow}</div>}
          <h1 className="text-2xl font-semibold leading-tight tracking-[-0.02em] text-ink">{title}</h1>
          {lead !== undefined && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-mute">{lead}</p>}
        </div>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {meta !== undefined && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-ink-faint">{meta}</div>}
      <div className="rule-fade mt-4" />
    </header>
  );
}

export function FilterBar({ children }: { readonly children: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-2">{children}</div>;
}
