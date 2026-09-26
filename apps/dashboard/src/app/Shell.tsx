import { useEffect, useState, type ReactNode } from 'react';
import { Link, useRouter } from './router';
import { Badge, Icon, toast, type Tone } from '../components/ui';
import { CommandPalette, Mark, Wordmark } from '../components/product';
import { cx } from '../lib/util';
import { DEMO_BANNER, sampleData } from './nav-data';

type NavItem = { readonly to: string; readonly label: string; readonly icon: Parameters<typeof Icon>[0]['name']; readonly badge?: number };

// Counts are derived from the same rows the screens read, so a sidebar number and the list
// it points at cannot disagree — the classic way a dashboard becomes untrustworthy is a
// badge that is maintained by hand.
const NAV: readonly NavItem[] = [
  { to: '/app', label: 'Overview', icon: 'overview' },
  { to: '/app/agents', label: 'Agents', icon: 'agents', badge: sampleData.agents.length },
  { to: '/app/policies', label: 'Policies', icon: 'policies' },
  { to: '/app/transactions', label: 'Transactions', icon: 'transactions' },
  { to: '/app/approvals', label: 'Approvals', icon: 'approvals', badge: sampleData.approvals.filter((a) => a.status === 'PENDING').length },
  { to: '/app/risk', label: 'Risk', icon: 'risk' },
  { to: '/app/wallets', label: 'Wallets', icon: 'wallets' },
  { to: '/app/audit', label: 'Audit log', icon: 'audit' },
  { to: '/app/developers', label: 'Developers', icon: 'developers' },
  { to: '/app/settings', label: 'Settings', icon: 'settings' },
];

const API_STATUS: readonly { readonly state: string; readonly tone: Tone; readonly note: string }[] = [
  {
    state: 'not connected',
    tone: 'neutral',
    note: 'This is a sample tenant: no ari-api, no ari-signer, no database is answering. Point api/client.ts at a deployment and this line becomes a health check rather than a disclaimer.',
  },
];

export function Shell({ children }: { readonly children: ReactNode }) {
  const { raw } = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const [palette, setPalette] = useState(false);

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
  const status = API_STATUS[0]!;

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-4 pt-4">
        <Wordmark size={26} />
      </div>

      <nav className="flex-1 space-y-px overflow-y-auto px-2" aria-label="Sections">
        {NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={cx(
              'group flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-[7px] text-[13px] transition-colors',
              active(item.to) ? 'bg-brand-wash text-ink ring-1 ring-inset ring-brand-dim/60' : 'text-ink-mute hover:bg-hover hover:text-ink',
            )}
          >
            <Icon name={item.icon} className={active(item.to) ? 'text-brand' : 'text-ink-faint group-hover:text-ink-dim'} />
            <span className="flex-1 truncate">{item.label}</span>
            {item.badge !== undefined && (
              <span className={cx('num rounded px-1 text-[10px]', item.badge > 0 ? 'bg-[#1d242c] text-ink-dim' : 'text-ink-faint')}>{item.badge}</span>
            )}
          </Link>
        ))}
      </nav>

      <div className="space-y-2 border-t border-hair px-3 py-3 text-2xs">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium text-ink-dim">Northwind Treasury</span>
          <Icon name="chevron-down" size={11} className="text-ink-faint" />
        </div>
        <div className="flex items-center gap-1.5 text-ink-mute">
          <span className="uppercase tracking-[0.08em]">env</span>
          <Badge tone="allow">production</Badge>
        </div>
        <button
          onClick={() => toast(status.tone, status.note)}
          className="flex w-full items-center gap-1.5 text-left text-ink-mute transition-colors hover:text-ink-dim"
        >
          <span className={cx('h-1.5 w-1.5 rounded-full', status.tone === 'allow' ? 'bg-allow' : 'bg-ink-faint')} />
          API {status.state}
          <span className="ml-auto num text-ink-faint">sample</span>
        </button>
        <div className="flex items-center gap-1.5 border-t border-hair-faint pt-2 text-ink-faint">
          <span className="grid h-5 w-5 place-items-center rounded-full border border-hair-strong bg-raised text-[9px] font-semibold text-ink-dim">ME</span>
          <span className="truncate text-ink-mute">Mara Ellison · owner</span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-base">
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[15.5rem] border-r border-hair bg-surface lg:block">{sidebar}</aside>

      {/* mobile drawer */}
      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button aria-label="Close navigation" className="absolute inset-0 bg-[#030507cc]" onClick={() => setNavOpen(false)} />
          <aside className="anim-rise absolute inset-y-0 left-0 w-[16rem] border-r border-hair-strong bg-surface">{sidebar}</aside>
        </div>
      )}

      <div className="lg:pl-[15.5rem]">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-hair bg-base/92 px-4 backdrop-blur-sm">
          <button className="text-ink-mute lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Icon name="menu" size={18} />
          </button>
          <div className="hidden items-center gap-2 text-xs text-ink-mute sm:flex">
            <span className="text-ink-faint">ARI</span>
            <Icon name="chevron-right" size={10} className="text-ink-faint" />
            <span className="text-ink-dim">{NAV.find((item) => active(item.to))?.label ?? 'Control center'}</span>
          </div>

          {/* The field only on widths that can afford it; below that, the same palette
              behind an icon, because a 390px header with a search box in it has no room
              left for the page title it is supposed to be labelling. */}
          <button
            onClick={() => setPalette(true)}
            className="ml-auto hidden h-7 w-full max-w-[19rem] items-center gap-2 rounded-[var(--radius-sm)] border border-hair bg-raised px-2.5 text-left text-xs text-ink-faint transition-colors hover:border-hair-strong hover:text-ink-mute md:flex"
          >
            <Icon name="search" size={13} />
            <span className="flex-1 truncate">Search agents, policies, transactions…</span>
            <kbd className="rounded border border-hair px-1 text-[10px]">⌘K</kbd>
          </button>
          <button
            onClick={() => setPalette(true)}
            aria-label="Search"
            className="ml-auto grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-ink-mute hover:bg-hover hover:text-ink md:hidden"
          >
            <Icon name="search" size={15} />
          </button>

          <div className="flex items-center gap-1.5">
            <Badge tone="caution" className="hidden md:inline-flex">sample data</Badge>
            <button className="relative grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-ink-mute hover:bg-hover hover:text-ink" aria-label="Notifications">
              <Icon name="alert" size={15} />
              <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-caution" />
            </button>
          </div>
        </header>

        <div className="flex items-start gap-2 border-b border-caution-line bg-caution-wash/35 px-4 py-1.5 text-2xs text-caution">
          <Mark size={12} className="mt-[1px] shrink-0 text-caution" />
          <span>{DEMO_BANNER}</span>
        </div>

        <main className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6 lg:px-8">{children}</main>

        {/* mobile bottom nav — the four screens an operator actually lives on */}
        <nav className="sticky bottom-0 z-20 grid grid-cols-4 border-t border-hair bg-surface/95 backdrop-blur lg:hidden" aria-label="Primary">
          {[NAV[0]!, NAV[4]!, NAV[3]!, NAV[7]!].map((item) => (
            <Link key={item.to} to={item.to} className={cx('flex flex-col items-center gap-1 py-2 text-[10px]', active(item.to) ? 'text-brand' : 'text-ink-mute')}>
              <Icon name={item.icon} size={17} />
              {item.label}
            </Link>
          ))}
        </nav>
      </div>

      {palette && <PaletteAdapter onClose={() => setPalette(false)} />}
    </div>
  );
}

function PaletteAdapter({ onClose }: { readonly onClose: () => void }) {
  const { navigate } = useRouter();
  return <CommandPalette open onClose={onClose} commands={buildCommands(navigate)} />;
}

function buildCommands(navigate: (to: string) => void) {
  return [
    { group: 'go', label: 'Overview', hint: 'what is happening right now', run: () => navigate('/app') },
    { group: 'go', label: 'Agents', hint: 'every autonomous agent and its envelope', run: () => navigate('/app/agents') },
    { group: 'go', label: 'Policies', hint: 'versions, diffs and activations', run: () => navigate('/app/policies') },
    { group: 'go', label: 'Transactions', hint: 'the ledger of decisions', run: () => navigate('/app/transactions') },
    { group: 'go', label: 'Approvals', hint: 'what is waiting on a human', run: () => navigate('/app/approvals') },
    { group: 'go', label: 'Risk center', hint: 'signals and boundary proximity', run: () => navigate('/app/risk') },
    { group: 'go', label: 'Audit log', hint: 'the hash chain, verifiable', run: () => navigate('/app/audit') },
    { group: 'go', label: 'Wallets', hint: 'execution resources, not balances', run: () => navigate('/app/wallets') },
    { group: 'go', label: 'Developers', hint: 'keys, SDK, webhooks', run: () => navigate('/app/developers') },
  ];
}
