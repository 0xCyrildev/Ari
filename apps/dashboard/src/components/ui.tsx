import * as Dialog from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as Tip from '@radix-ui/react-tooltip';
import {
  ArrowRight,
  Check,
  Copy,
  CaretDown,
  CaretRight,
  X as XIcon,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from '../lib/util';

/* ==========================================================================
   Primitives
   --------------------------------------------------------------------------
   Written against the second-pass tokens in `styles/tokens.css`, after an audit
   of the first pass found the usual signatures: an uppercase micro-label above
   every section, ten identical card containers, a decorative dot on every
   status, and depth carried by shadows. What replaced them is four rules, each
   one enforced here rather than left to whoever writes the next screen:

   1. Surfaces are sharp. Only controls get `rounded-control`.
   2. One accent. `ok` / `wait` / `stop` appear on a real state and nowhere else.
   3. `.label` belongs to table heads and field keys. A heading is a heading.
   4. No shadows. The surface ramp and one hairline do the work.

   Icons come from Phosphor at a single weight. There is no hand-drawn icon set
   in this file, and the reason there isn't one is that a hand-drawn set is how
   the first pass read as generated.
   ========================================================================== */

export type Tone = 'accent' | 'ok' | 'wait' | 'stop' | 'neutral';

const TEXT: Record<Tone, string> = {
  accent: 'text-accent',
  ok: 'text-ok',
  wait: 'text-wait',
  stop: 'text-stop',
  neutral: 'text-ink-2',
};

const TAG: Record<Tone, string> = {
  accent: 'border-accent-line bg-accent-wash text-accent',
  ok: 'border-ok-line bg-ok-wash text-ok',
  wait: 'border-wait-line bg-wait-wash text-wait',
  stop: 'border-stop-line bg-stop-wash text-stop',
  neutral: 'border-line bg-raised text-ink-2',
};

const DOT: Record<Tone, string> = {
  accent: 'bg-accent',
  ok: 'bg-ok',
  wait: 'bg-wait',
  stop: 'bg-stop',
  neutral: 'bg-ink-4',
};

/**
 * Engine vocabulary to colour, and nothing else.
 *
 * The strings on the left are the values `packages/api-contracts` actually emits. They are
 * rendered verbatim rather than rephrased: if the console says "needs a second signer" while
 * the API says `REQUIRE_HUMAN_APPROVAL`, an operator stops trusting the console.
 */
const TONE_BY_STATE: Record<string, Tone> = {
  ACTIVE: 'ok', LIVE: 'ok', ALLOW: 'ok', APPROVED: 'ok', GRANTED: 'ok', COMPLETE: 'ok',
  PASSED: 'ok', HEALTHY: 'ok', CONFIRMED: 'ok', SETTLED: 'ok', LOW: 'ok', NONE: 'neutral',
  PAUSED: 'wait', PENDING: 'wait', AWAITING_APPROVAL: 'wait', RETRYING: 'wait',
  REQUIRE_HUMAN_APPROVAL: 'wait', ESCALATED: 'wait', ADVISORY: 'wait', NOTICE: 'wait',
  UNSETTLED: 'wait', DRAFT: 'wait', MEDIUM: 'wait', PREVIEW: 'wait',
  DENIED: 'stop', DENY: 'stop', REJECTED: 'stop', ANOMALOUS: 'stop', FAILED: 'stop',
  BLOCKED: 'stop', ERROR: 'stop', CRITICAL: 'stop', HIGH: 'stop',
  REVOKED: 'neutral', EXPIRED: 'neutral', SUPERSEDED: 'neutral', RETIRED: 'neutral',
  NOT_REACHED: 'neutral', UNAVAILABLE: 'neutral',
};

export const toneFor = (value: string): Tone => TONE_BY_STATE[value.toUpperCase()] ?? 'neutral';

/* ==========================================================================
   Buttons
   ========================================================================== */

type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'border-accent-line bg-accent text-[#071119] hover:bg-accent-strong',
  default: 'border-line-strong bg-raised text-ink hover:bg-press',
  ghost: 'border-transparent bg-transparent text-ink-2 hover:bg-press hover:text-ink',
  danger: 'border-stop-line bg-stop-wash text-stop hover:bg-[#2a1715]',
};

const BUTTON_SIZE = {
  sm: 'h-6 gap-1 px-2 text-2xs',
  md: 'h-7 gap-1.5 px-2.5 text-xs',
  lg: 'h-10 gap-2 px-4 text-sm',
} as const;

/**
 * Labels here name the consequence. "Approve this transfer", not "Confirm": a button that
 * sends money is the one place a dashboard cannot be vague.
 */
export function Button({
  variant = 'default',
  size = 'md',
  trailingIcon = false,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: ButtonVariant;
  readonly size?: keyof typeof BUTTON_SIZE;
  readonly trailingIcon?: boolean;
}) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-control border font-medium',
        'transition-[background-color,border-color,color] duration-[var(--dur)] ease-out',
        'active:translate-y-px disabled:pointer-events-none disabled:opacity-40',
        BUTTON_SIZE[size],
        BUTTON_VARIANT[variant],
        className,
      )}
    >
      {children}
      {trailingIcon && (size === 'lg' ? <ArrowRight size={17} weight="bold" /> : <ArrowRight size={13} weight="bold" />)}
    </button>
  );
}

export function LinkButton({
  to,
  variant = 'primary',
  size = 'md',
  trailingIcon = false,
  className,
  children,
}: {
  readonly to: string;
  readonly variant?: ButtonVariant;
  readonly size?: keyof typeof BUTTON_SIZE;
  readonly trailingIcon?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={to}
      className={cx(
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-control border font-medium',
        'transition-[background-color,border-color,color] duration-[var(--dur)] ease-out',
        'active:translate-y-px',
        BUTTON_SIZE[size],
        BUTTON_VARIANT[variant],
        className,
      )}
    >
      {children}
      {trailingIcon && (size === 'lg' ? <ArrowRight size={17} weight="bold" /> : <ArrowRight size={13} weight="bold" />)}
    </a>
  );
}

export function IconButton({
  label,
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly label: string; readonly children: ReactNode }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cx(
        'grid h-7 w-7 shrink-0 place-items-center rounded-control border border-transparent text-ink-3',
        'transition-colors duration-[var(--dur)] hover:border-line hover:bg-press hover:text-ink',
        className,
      )}
    >
      {children}
    </button>
  );
}

export const ChevronRight = ({ size = 12 }: { readonly size?: number }) => <CaretRight size={size} weight="bold" />;
export const ChevronDown = ({ size = 12 }: { readonly size?: number }) => <CaretDown size={size} weight="bold" />;

/* ==========================================================================
   Tags and state
   ========================================================================== */

/**
 * A short inline marker. Uppercase only because the engine's enum members are uppercase,
 * `Tag` never transforms prose into small caps.
 */
export function Tag({
  tone = 'neutral',
  mono = false,
  children,
  className,
}: {
  readonly tone?: Tone | undefined;
  readonly mono?: boolean | undefined;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-control border px-1.5 py-[1px] text-[11px] leading-[16px]',
        mono ? 'font-mono' : 'font-medium',
        TAG[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export const StateTag = ({ value, className }: { readonly value: string; readonly className?: string }) => (
  <Tag tone={toneFor(value)} mono className={className}>
    {value}
  </Tag>
);

/**
 * State as a word with a dot beside it. The dot is redundant by design, and it is only here
 * because a table column of uppercase codes is hard to scan at a glance; nothing in this file
 * puts a dot next to something that is not a state.
 */
export function StateCell({ value, label }: { readonly value: string; readonly label?: string }) {
  const tone = toneFor(value);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx('h-[6px] w-[6px] shrink-0 rounded-full', DOT[tone])} aria-hidden="true" />
      <span className={cx('font-mono text-[11px]', TEXT[tone])}>{label ?? value}</span>
    </span>
  );
}

/** Four bars, filled by the risk level the engine returned. Not a colour swatch. */
export function RiskPip({ level }: { readonly level: string }) {
  const filled = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[level.toUpperCase()] ?? 0;
  const tone = toneFor(level);
  return (
    <span className="inline-flex items-end gap-[2px]" role="img" aria-label={`risk ${level.toLowerCase()}`}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={cx('w-[3px] rounded-[1px]', i < filled ? DOT[tone] : 'bg-line-strong')}
          style={{ height: `${5 + i * 2.5}px` }}
        />
      ))}
    </span>
  );
}

/* ==========================================================================
   Surfaces
   ========================================================================== */

/** A bordered region. Sharp corners, hairline, one surface step above the page. */
export function Surface({
  title,
  action,
  footer,
  children,
  className,
  bodyClassName,
}: {
  readonly title?: ReactNode;
  readonly action?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
}) {
  return (
    <section className={cx('flex flex-col border border-line bg-panel', className)}>
      {(title !== undefined || action !== undefined) && (
        <header className="flex items-baseline justify-between gap-3 border-b border-line px-3 py-2">
          <h3 className="text-[13px] font-medium text-ink">{title}</h3>
          {action}
        </header>
      )}
      <div className={cx('p-3', bodyClassName)}>{children}</div>
      {footer !== undefined && <footer className="border-t border-line px-3 py-2">{footer}</footer>}
    </section>
  );
}

/** A titled run of content inside a surface, separated by hairlines rather than nested boxes. */
export function Block({ label, hint, children }: { readonly label: string; readonly hint?: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="border-t border-line px-3 py-2.5 first:border-t-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-4">
        <span className="label">{label}</span>
        {hint !== undefined && <span className="text-[11px] text-ink-4">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * Key/value runs. `stacked` puts the key above the value, which is what a column needs when the
 * value is a 36-character identifier and the rail is 20rem wide.
 */
export function KeyValue({ items, dense = false, stacked = false }: { readonly items: readonly { readonly k: string; readonly v: ReactNode }[]; readonly dense?: boolean | undefined; readonly stacked?: boolean | undefined }) {
  if (stacked) {
    return (
      <dl className={cx('grid grid-cols-1', dense ? 'gap-y-2' : 'gap-y-2.5')}>
        {items.map((item) => (
          <div key={item.k} className="min-w-0">
            <dt className="label">{item.k}</dt>
            <dd className="mt-0.5 text-xs text-ink">{item.v}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className={cx('grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-x-4', dense ? 'gap-y-1' : 'gap-y-1.5')}>
      {items.map((item) => (
        <div key={item.k} className="contents">
          <dt className="truncate text-xs text-ink-3">{item.k}</dt>
          <dd className="min-w-0 text-xs text-ink">{item.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Headline numbers, one row, hairline-separated.
 *
 * This exists because `MetricCard` produced a grid of identical boxes: ten cards on one screen,
 * each the same size, each with a label above and a number below, which is the single most
 * recognisable generated-dashboard layout. A band says the same thing in one container.
 */
export function MetricBand({
  items,
}: {
  readonly items: readonly { readonly label: string; readonly value: ReactNode; readonly hint?: ReactNode; readonly tone?: Tone }[];
}) {
  return (
    <div className="grid border border-line bg-panel sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
      {items.map((item, i) => (
        <div
          key={item.label}
          className={cx(
            'flex flex-col gap-1 px-3.5 py-3',
            'border-t border-line first:border-t-0 sm:border-l-0 lg:[&:not(:first-child)]:border-l',
            i % 2 === 1 && 'sm:border-l sm:border-line',
            'lg:border-t-0',
          )}
        >
          <span className="label">{item.label}</span>
          <span className={cx('font-mono text-[22px] leading-none tabular-nums', TEXT[item.tone ?? 'neutral'])}>
            {item.value}
          </span>
          {item.hint !== undefined && <span className="text-[11px] leading-snug text-ink-3">{item.hint}</span>}
        </div>
      ))}
    </div>
  );
}

export function Meter({ value, max, tone = 'accent', label }: { readonly value: number; readonly max: number; readonly tone?: Tone | undefined; readonly label?: string | undefined }) {
  const target = max <= 0 ? 0 : Math.min(100, (value / max) * 100);
  const fill = { accent: 'bg-accent', ok: 'bg-ok', wait: 'bg-wait', stop: 'bg-stop', neutral: 'bg-ink-4' }[tone];
  // Fills from zero on mount: the number is the fact, the arrival is the emphasis.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(target));
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return (
    <div className="w-full">
      <div className="h-[3px] w-full bg-sunken">
        <div className={cx('h-full transition-[width] duration-700 ease-out', fill)} style={{ width: `${shown}%` }} />
      </div>
      {label !== undefined && <div className="mt-1 font-mono text-[11px] text-ink-3">{label}</div>}
    </div>
  );
}

export function EmptyState({ title, body, action }: { readonly title: string; readonly body: string; readonly action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 px-3.5 py-8">
      <span className="ari-mark h-6 w-6 text-ink-4" role="img" aria-label="ARI" />
      <p className="text-[13px] font-medium text-ink">{title}</p>
      <p className="max-w-sm text-xs leading-relaxed text-ink-3">{body}</p>
      {action}
    </div>
  );
}

/** Bars shaped like the rows that are coming, so the layout does not move when data lands. */
export function LoadingRow({ columns = 5, rows = 4 }: { readonly columns?: number; readonly rows?: number }) {
  const widths = ['58%', '34%', '44%', '26%', '40%'];
  return (
    <div role="status" aria-label="Loading" className="divide-y divide-line">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-3 px-3 py-2.5">
          {Array.from({ length: columns }, (_, c) => (
            <span
              key={c}
              className="anim-fade h-2.5 bg-line-strong"
              style={{ width: widths[c % widths.length], animationDelay: `${(r * columns + c) * 24}ms` }}
            />
          ))}
        </div>
      ))}
      <span className="sr-only">Loading</span>
    </div>
  );
}

/* ==========================================================================
   Overlays
   ========================================================================== */

/** One provider for the whole tree; see `main.tsx`. */
export function TooltipProvider({ children }: { readonly children: ReactNode }) {
  return <Tip.Provider delayDuration={200} skipDelayDuration={400}>{children}</Tip.Provider>;
}

export function Tooltip({ content, children, side = 'top' }: { readonly content: ReactNode; readonly children: ReactNode; readonly side?: 'top' | 'bottom' | 'right' }) {
  return (
    <Tip.Root delayDuration={220}>
      <Tip.Trigger asChild>{children}</Tip.Trigger>
      <Tip.Portal>
        <Tip.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-xs rounded-control border border-line-strong bg-raised px-2.5 py-1.5 text-[11px] leading-relaxed text-ink data-[state=delayed-open]:anim-fade"
        >
          {content}
        </Tip.Content>
      </Tip.Portal>
    </Tip.Root>
  );
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'w-[calc(100vw-2rem)] max-w-lg',
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly width?: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[#04060899] data-[state=open]:anim-fade" />
        <Dialog.Content
          className={cx(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 border border-line-strong bg-panel data-[state=open]:anim-rise',
            width,
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] font-medium text-ink">{title}</Dialog.Title>
              {subtitle !== undefined && <div className="mt-0.5 text-xs text-ink-3">{subtitle}</div>}
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close dialog"><XIcon size={14} weight="bold" /></IconButton>
            </Dialog.Close>
          </header>
          <div className="max-h-[70vh] overflow-y-auto px-4 py-3.5">{children}</div>
          {footer !== undefined && <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[#040608b3] data-[state=open]:anim-fade" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-[36rem] flex-col border-l border-line-strong bg-panel data-[state=open]:anim-rise">
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <Dialog.Title className="text-[15px] font-medium">{title}</Dialog.Title>
            <Dialog.Close asChild><IconButton label="Close panel"><XIcon size={14} weight="bold" /></IconButton></Dialog.Close>
          </header>
          <div className="flex-1 overflow-y-auto">{children}</div>
          {footer !== undefined && <footer className="border-t border-line px-4 py-3">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  readonly tabs: readonly { readonly id: string; readonly label: string; readonly count?: number }[];
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onChange} className="mb-3 border-b border-line">
      <TabsPrimitive.List className="flex overflow-x-auto">
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.id}
            value={tab.id}
            className={cx(
              'relative whitespace-nowrap border-b-2 border-transparent px-2.5 py-1.5 text-xs text-ink-3 transition-colors',
              'hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink',
            )}
          >
            {tab.label}
            {tab.count !== undefined && <span className="ml-1.5 font-mono text-[11px] text-ink-4">{tab.count}</span>}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

/* ==========================================================================
   Tables
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

const HIDE = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' } as const;

export function DataTable<Row>({
  rows,
  columns,
  rowKey,
  onRowClick,
  empty,
  initialSort,
  loading = false,
  density = 'normal',
}: {
  readonly rows: readonly Row[];
  readonly columns: readonly Column<Row>[];
  readonly rowKey: (row: Row) => string;
  readonly onRowClick?: (row: Row) => void;
  readonly empty?: ReactNode;
  readonly initialSort?: { readonly key: string; readonly dir: 'asc' | 'desc' };
  readonly loading?: boolean;
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

  if (loading) return <LoadingRow columns={columns.length} />;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-line">
            {columns.map((column) => (
              <th
                key={column.key}
                style={column.width === undefined ? undefined : { width: column.width }}
                className={cx(
                  'label px-3 py-2 font-normal',
                  column.align === 'right' && 'text-right',
                  column.hideBelow !== undefined && HIDE[column.hideBelow],
                )}
              >
                {column.sortValue === undefined ? (
                  column.header
                ) : (
                  <button
                    className="inline-flex items-center gap-1 transition-colors hover:text-ink"
                    onClick={() =>
                      setSort((current) =>
                        current?.key === column.key
                          ? { key: column.key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
                          : { key: column.key, dir: 'asc' },
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
              <td colSpan={columns.length} className="p-0">
                {empty ?? <EmptyState title="Nothing matches these filters" body="Widen the filter, or check the environment. This view only shows rows for the tenant you are looking at." />}
              </td>
            </tr>
          )}
          {ordered.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick === undefined ? undefined : () => onRowClick(row)}
              className={cx(
                'border-b border-line/70 transition-colors last:border-0 hover:bg-raised',
                onRowClick !== undefined && 'cursor-pointer',
                density === 'compact' ? '[&>td]:py-1.5' : '[&>td]:py-2.5',
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cx('px-3 align-middle text-xs text-ink-2', column.align === 'right' && 'text-right', column.hideBelow !== undefined && HIDE[column.hideBelow])}
                >
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

/* ==========================================================================
   Code
   ========================================================================== */

export function CodeBlock({ code, caption = 'typescript' }: { readonly code: string; readonly caption?: string }) {
  return (
    <figure className="border border-line bg-sunken">
      <figcaption className="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5">
        <span className="label">{caption}</span>
        <CopyButton value={code} />
      </figcaption>
      <pre className="overflow-x-auto px-3 py-2.5 text-[12px] leading-relaxed">
        <code className="font-mono text-ink-2">{highlight(code)}</code>
      </pre>
    </figure>
  );
}

/**
 * Colour by pattern, not by parser. On a documentation surface the only job colour has is to
 * separate a string from a keyword from a comment; a real tokenizer is another dependency and
 * would be wrong about nothing more than this one does.
 */
function highlight(code: string): ReactNode[] {
  const pattern = /(\/\/[^\n]*|'[^']*'|"[^"]*"|\b(?:const|await|async|return|new|type|interface|from|import|export|function)\b|[A-Z_]{4,}|\b\d+(?:\.\d+)?\b)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    if (match.index > last) out.push(code.slice(last, match.index));
    const token = match[0]!;
    const cls = token.startsWith('//')
      ? 'text-ink-4 italic'
      : /^['"]/.test(token)
        ? 'text-ok'
        : /^[A-Z_]{4,}$/.test(token)
          ? 'text-wait'
          : /^\d/.test(token)
            ? 'text-accent'
            : 'text-ink-3';
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
      className="inline-flex items-center gap-1 text-[11px] text-ink-3 transition-colors hover:text-ink"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setDone(true);
        timer.current = window.setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <Check size={12} weight="bold" /> : <Copy size={12} weight="regular" />}
      {done ? 'Copied' : label}
    </button>
  );
}

/* ==========================================================================
   Inputs
   ========================================================================== */

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cx(
        'h-7 w-full rounded-control border border-line bg-raised px-2.5 text-xs text-ink',
        'placeholder:text-ink-4 hover:border-line-strong focus:border-accent-line focus:outline-none',
        className,
      )}
    />
  );
}

export function Field({ label, hint, children }: { readonly label: string; readonly hint?: ReactNode; readonly children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      {children}
      {hint !== undefined && <span className="text-[11px] text-ink-4">{hint}</span>}
    </label>
  );
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative inline-flex">
      <select
        {...rest}
        className={cx(
          'h-7 appearance-none rounded-control border border-line bg-raised pl-2.5 pr-7 text-xs text-ink',
          'hover:border-line-strong focus:border-accent-line focus:outline-none',
          className,
        )}
      >
        {children}
      </select>
      <CaretDown size={11} weight="bold" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-3" />
    </span>
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
        <div key={item.id} className={cx('anim-rise pointer-events-auto border bg-raised px-3 py-2 text-xs', TAG[item.tone])}>
          {item.text}
        </div>
      ))}
    </div>
  );
}

/* ==========================================================================
   Page furniture
   ========================================================================== */

/**
 * No eyebrow. The first pass put a small-caps word above every page title; four screens later
 * it reads as a template. What is left is the title, one line about what the screen governs,
 * and the actions that act on it.
 */
export function PageHead({
  title,
  lead,
  actions,
  meta,
}: {
  readonly title: string;
  readonly lead?: ReactNode;
  readonly actions?: ReactNode;
  readonly meta?: ReactNode;
}) {
  return (
    <header className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 max-w-3xl">
          <h1 className="text-xl font-medium leading-tight tracking-[-0.02em] text-ink">{title}</h1>
          {lead !== undefined && <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{lead}</p>}
        </div>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {meta !== undefined && <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-4">{meta}</div>}
    </header>
  );
}

export function FilterBar({ children }: { readonly children: ReactNode }) {
  return <div className="mb-2.5 flex flex-wrap items-center gap-2">{children}</div>;
}
