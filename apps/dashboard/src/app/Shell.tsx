import { List, MagnifyingGlass, X } from '@phosphor-icons/react';
import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState, type ReactNode } from 'react';
import { CommandPalette, Mark, Wordmark, type Command } from '../components/product';
import { Tag, toast } from '../components/ui';
import { useMotionAllowed } from './motion-pref';
import { cx } from '../lib/util';
import { Link, useRouter } from './router';
import { DEMO_BANNER, NAV, NAV_MOBILE, sampleData } from './nav-data';

/* ==========================================================================
   The frame
   --------------------------------------------------------------------------
   Sidebar, header, and the honesty strip. Two things are deliberately missing:

   A notification bell. There is no notification store behind this screen, so a bell
   with a dot on it would be a promise the interface cannot keep.

   A live latency readout. Without a connected API there is no p50 to show, and the
   first pass invented one. What is there instead says "sample", which is true.
   ========================================================================== */

const PENDING_APPROVALS = sampleData.approvals.filter((approval) => approval.status === 'PENDING').length;

export function Shell({ children }: { readonly children: ReactNode }) {
  const { raw } = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const reduce = useReducedMotion();
  const animateRoute = useMotionAllowed() && reduce !== true;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => setNavOpen(false), [raw]);

  const active = (to: string): boolean => (to === '/app' ? raw === '/app' : raw.startsWith(to));
  const current = NAV.find((item) => active(item.to));

  return (
    <div className="min-h-screen bg-base">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[15rem] border-r border-line bg-panel lg:flex lg:flex-col">
        <Sidebar active={active} onPick={() => undefined} />
      </aside>

      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button aria-label="Close navigation" className="absolute inset-0 bg-[#040608cc]" onClick={() => setNavOpen(false)} />
          <motion.aside
            className="absolute inset-y-0 left-0 w-[15rem] border-r border-line-strong bg-panel"
            initial={reduce ? false : { x: -16, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ duration: 0.18, ease: [0.2, 0.7, 0.3, 1] }}
          >
            <div className="flex items-center justify-between px-3 py-3">
              <span className="text-[11px] text-ink-3">Sections</span>
              <button aria-label="Close navigation" className="text-ink-3" onClick={() => setNavOpen(false)}>
                <X size={16} weight="bold" />
              </button>
            </div>
            <Sidebar active={active} onPick={() => setNavOpen(false)} bare />
          </motion.aside>
        </div>
      )}

      <div className="lg:pl-[15rem]">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-line bg-base/95 px-4 backdrop-blur-sm">
          <button className="text-ink-2 lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <List size={18} weight="regular" />
          </button>
          <Wordmark size={20} href="/app" />
          <span className="hidden items-center gap-1.5 text-xs text-ink-3 sm:flex">
            <span className="text-ink-4">/</span>
            <span className="text-ink-2">{current?.label ?? 'Control center'}</span>
          </span>

          <button
            onClick={() => setPalette(true)}
            className="ml-auto hidden h-7 w-full max-w-[18rem] items-center gap-2 rounded-control border border-line bg-raised px-2.5 text-left text-xs text-ink-3 transition-colors hover:border-line-strong md:flex"
          >
            <MagnifyingGlass size={13} weight="regular" />
            <span className="flex-1 truncate">Search agents, policies, transactions</span>
            <kbd className="font-mono text-[10px] text-ink-4">⌘K</kbd>
          </button>
          <button
            onClick={() => setPalette(true)}
            aria-label="Search"
            className="ml-auto grid h-7 w-7 place-items-center rounded-control text-ink-2 hover:bg-press hover:text-ink md:hidden"
          >
            <MagnifyingGlass size={15} weight="regular" />
          </button>

          <Tag tone="wait">sample tenant</Tag>
        </header>

        <div className="flex items-start gap-2 border-b border-wait-line bg-wait-wash px-4 py-1.5 text-[11px] leading-relaxed text-wait">
          <Mark size={11} className="mt-[3px] shrink-0" />
          <span>{DEMO_BANNER}</span>
        </div>

        {/* One screen at a time: the new page arrives rather than replacing the old one
            mid-frame. Keyed on the path so it replays per navigation and only per navigation. */}
        <main className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 lg:px-8">
          {animateRoute ? (
            <motion.div key={raw} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}>
              {children}
            </motion.div>
          ) : (
            children
          )}
        </main>

        <nav className="sticky bottom-0 z-20 grid grid-cols-4 border-t border-line bg-panel lg:hidden" aria-label="Primary">
          {NAV_MOBILE.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={cx('flex flex-col items-center gap-1 py-2 text-[10px]', active(item.to) ? 'text-accent' : 'text-ink-3')}
            >
              <item.icon size={17} weight="regular" />
              {item.label}
            </Link>
          ))}
        </nav>
      </div>

      {palette && <PaletteAdapter onClose={() => setPalette(false)} />}
    </div>
  );
}

function Sidebar({ active, onPick, bare = false }: { readonly active: (to: string) => boolean; readonly onPick: () => void; readonly bare?: boolean }) {
  return (
    <div className={cx('flex h-full flex-col', bare && 'pt-1')}>
      {!bare && (
        <div className="px-3 py-3.5">
          <Wordmark size={20} href="/app" />
        </div>
      )}

      <nav className="flex-1 overflow-y-auto pb-2" aria-label="Sections">
        {NAV.map((item) => {
          const on = active(item.to);
          const count = item.to === '/app/approvals' ? PENDING_APPROVALS : undefined;
          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={onPick}
              className={cx(
                'flex items-center gap-2.5 border-l-2 py-[7px] pl-[10px] pr-3 text-[13px] transition-colors duration-[var(--dur)]',
                on ? 'border-accent bg-raised text-ink' : 'border-transparent text-ink-2 hover:bg-raised/60 hover:text-ink',
              )}
            >
              <item.icon size={16} weight="regular" className={on ? 'text-accent' : 'text-ink-3'} />
              <span className="flex-1 truncate">{item.label}</span>
              {count !== undefined && count > 0 && <span className="font-mono text-[11px] text-wait">{count}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-line px-3 py-2.5 text-[11px]">
        <p className="truncate text-xs text-ink">{sampleData.organization.name}</p>
        <p className="mt-0.5 text-ink-3">
          {sampleData.organization.environment} · {sampleData.organization.region}
        </p>
        <button
          onClick={() => toast('wait', 'No Ari deployment is answering on this screen. The rows below come from domain/sample.ts, shaped exactly as apps/api/src/routes.ts answers.')}
          className="mt-2 flex w-full items-center gap-1.5 text-left text-ink-3 transition-colors hover:text-ink"
        >
          <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-wait" aria-hidden="true" />
          API not connected
          <span className="ml-auto font-mono text-ink-4">sample</span>
        </button>
        <p className="mt-2 border-t border-line pt-2 text-ink-3">
          {sampleData.users[0]!.name} · {sampleData.users[0]!.role}
        </p>
      </div>
    </div>
  );
}

function PaletteAdapter({ onClose }: { readonly onClose: () => void }) {
  const { navigate } = useRouter();
  return <CommandPalette open onClose={onClose} commands={buildCommands(navigate)} />;
}

function buildCommands(navigate: (to: string) => void): readonly Command[] {
  const screens: readonly { readonly to: string; readonly label: string; readonly hint: string }[] = [
    { to: '/app', label: 'Overview', hint: 'what is happening right now' },
    { to: '/app/agents', label: 'Agents', hint: 'every agent and the envelope around it' },
    { to: '/app/policies', label: 'Policies', hint: 'versions, diffs and activations' },
    { to: '/app/transactions', label: 'Transactions', hint: 'the ledger of decisions' },
    { to: '/app/approvals', label: 'Approvals', hint: 'what is waiting on a human' },
    { to: '/app/risk', label: 'Risk', hint: 'signals and how close limits are' },
    { to: '/app/wallets', label: 'Wallets', hint: 'execution resources, not balances' },
    { to: '/app/audit', label: 'Audit log', hint: 'the hash chain, verifiable' },
    { to: '/app/developers', label: 'Developers', hint: 'keys, SDK, webhooks' },
  ];
  return [
    ...screens.map((screen) => ({ group: 'go', label: screen.label, hint: screen.hint, run: () => navigate(screen.to) })),
    ...sampleData.agents.map((agent) => ({
      group: 'agent',
      label: agent.name,
      hint: agent.purpose,
      run: () => navigate(`/app/agents/${agent.name}`),
    })),
    ...sampleData.policies.map((policy) => ({
      group: 'policy',
      label: policy.name,
      hint: 'policy',
      run: () => navigate(`/app/policies/${policy.name}`),
    })),
  ];
}
