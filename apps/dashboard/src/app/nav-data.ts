import {
  ArrowsLeftRight,
  Robot,
  BracketsCurly,
  Gauge,
  Scroll,
  SealCheck,
  ShieldCheck,
  SlidersHorizontal,
  SquaresFour,
  Wallet,
  type Icon,
} from '@phosphor-icons/react';

export { DEMO_BANNER } from '../domain/sample';
export * as sampleData from '../domain/sample';

/**
 * The ten screens, in the order an operator moves through them: what is happening, who is
 * acting, what they are allowed to do, what they did, what a human owes, and the record that
 * proves all of it. Counts are derived from the same rows the screens read, so a sidebar number
 * and the list it points at cannot disagree; a hand-maintained badge is how a dashboard becomes
 * untrustworthy.
 */
export interface NavEntry {
  readonly to: string;
  readonly label: string;
  readonly icon: Icon;
  readonly count?: number | undefined;
}

export const NAV: readonly NavEntry[] = [
  { to: '/app', label: 'Overview', icon: SquaresFour },
  { to: '/app/agents', label: 'Agents', icon: Robot },
  { to: '/app/policies', label: 'Policies', icon: ShieldCheck },
  { to: '/app/transactions', label: 'Transactions', icon: ArrowsLeftRight },
  { to: '/app/approvals', label: 'Approvals', icon: SealCheck },
  { to: '/app/risk', label: 'Risk', icon: Gauge },
  { to: '/app/wallets', label: 'Wallets', icon: Wallet },
  { to: '/app/audit', label: 'Audit log', icon: Scroll },
  { to: '/app/developers', label: 'Developers', icon: BracketsCurly },
  { to: '/app/settings', label: 'Settings', icon: SlidersHorizontal },
];

/** The four screens an operator lives on when there is no room for ten. */
export const NAV_MOBILE: readonly NavEntry[] = [NAV[0]!, NAV[4]!, NAV[3]!, NAV[7]!];
