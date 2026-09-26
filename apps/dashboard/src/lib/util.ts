import { clsx, type ClassValue } from 'clsx';

export const cx = (...values: ClassValue[]): string => clsx(values);

/**
 * Money, from a decimal string.
 *
 * Every amount in this application is a decimal string until it is displayed, because the
 * wire format is `numeric(80,0)` and a JavaScript number cannot hold 10^30 wei without
 * rounding it. Rounding a figure silently on a screen whose whole job is to say "this is
 * what will be signed" is a UI bug with financial consequences.
 */
export function formatRaw(raw: string | null, decimals: number, opts: { readonly symbol?: string; readonly compact?: boolean } = {}): string {
  if (raw === null) return '—';
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals) || '0';
  const frac = decimals > 0 ? padded.slice(-decimals).replace(/0+$/, '') : '';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = negative ? '−' : '';
  const symbol = opts.symbol ?? '$';
  if (opts.compact === true) {
    const value = Number(`${grouped.replaceAll(',', '')}.${frac || '0'}`);
    if (value >= 1_000_000) return `${sign}${symbol}${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2)}M`;
    if (value >= 1_000) return `${sign}${symbol}${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
    return `${sign}${symbol}${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }
  return `${sign}${symbol}${grouped}${frac.length > 0 ? `.${frac}` : ''}`;
}

export const unitDecimals = (unit: string): number => {
  const match = /(\d+)dp$/.exec(unit);
  return match?.[1] === undefined ? 6 : Number(match[1]);
};

export function money(raw: string | null, unit: string, compact = false): string {
  return formatRaw(raw, unitDecimals(unit), { symbol: unit.startsWith('usdc') ? '$' : '', compact });
}

export function relativeTime(iso: string | null): string {
  if (iso === null) return '—';
  const delta = Date.parse(iso) - Date.now();
  const abs = Math.abs(delta);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  const suffix = delta < 0 ? 'ago' : 'from now';
  if (abs < minute) return delta < 0 ? 'just now' : 'in moments';
  if (abs < hour) return `${Math.round(abs / minute)}m ${suffix}`;
  if (abs < day) return `${Math.round(abs / hour)}h ${suffix}`;
  if (abs < 30 * day) return `${Math.round(abs / day)}d ${suffix}`;
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function clockTime(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fullTime(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour12: false })}`;
}

export const shortHash = (value: string, keep = 6): string =>
  value.length <= keep * 2 + 3 ? value : `${value.slice(0, keep + (value.startsWith('canon/') ? 8 : 0))}…${value.slice(-keep)}`;

export const shortAddress = (value: string | null): string => (value === null ? '—' : `${value.slice(0, 8)}…${value.slice(-6)}`);

export const titleCase = (value: string): string =>
  value
    .toLowerCase()
    .split(/[_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

export const sentenceFromCode = (code: string): string => code.toLowerCase().replaceAll('_', ' ');

export const pct = (value: number): string => `${Math.round(value * 100)}%`;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Stable, tiny id for DOM anchors. */
export const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
