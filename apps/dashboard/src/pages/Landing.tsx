import { lazy, Suspense, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, ShieldCheck } from '@phosphor-icons/react';
import { CodeBlock, LinkButton, Tag } from '../components/ui';
import { CountUp, HeroEnter, HorizontalPan, Marquee, ParallaxImage, Reveal, ScrollProgress, Stagger, StaggerItem, Tilt } from '../components/motion';
import { MotionSwitch } from '../app/motion-pref';
import { Mark, Wordmark } from '../components/product';
import { Link } from '../app/router';
import { cx } from '../lib/util';

/* ==========================================================================
   Landing
   --------------------------------------------------------------------------
   Reading this as: infrastructure landing page for technical buyers (a treasury
   operator and the platform engineer who integrates them), dark precision-instrument
   language, Tailwind v4 utilities plus Motion scroll choreography and real
   photography. Dials: VARIANCE 7 / MOTION 7 / DENSITY 4.

   Section families, deliberately all different, because a page where every section
   is the same split is the tell:
     1 split hero over a live render      5 selector and detail panel
     2 full-bleed photograph band         6 tilted object beside offset text
     3 marquee of reason codes            7 code panel, no image
     4 horizontal pan, pinned             8 one panel split by a hairline
   ========================================================================== */

/** The WebGL field is the only thing here that needs `three`, so it loads on demand. */
const GlassField = lazy(() => import('../components/glass-field').then((m) => ({ default: m.GlassField })));

const STAGES: readonly { readonly stage: string; readonly enforce: string; readonly record: string }[] = [
  { stage: 'AGENT', enforce: 'The credential is scoped. An agent with no envelope has no authority to ask.', record: 'agent.request.received' },
  { stage: 'INTENT', enforce: 'The candidate is canonicalised. Amounts stay decimal strings, never floats.', record: 'intent.captured' },
  { stage: 'POLICY', enforce: 'The compiled plan runs under the tenant role, inside one advisory lock.', record: 'policy.evaluated + digest' },
  { stage: 'RISK', enforce: 'Advisory. It can escalate or refuse. It cannot grant past policy.', record: 'risk.assessed + signals' },
  { stage: 'APPROVAL', enforce: 'A named human, a quorum held in Postgres, a vote sealed to the digest.', record: 'approval.granted / rejected' },
  { stage: 'SIGN', enforce: 'A single-use ticket, 60 second TTL, redeemed in a second process.', record: 'ticket.minted / redeemed' },
  { stage: 'EXECUTE', enforce: 'Simulated before signing. If the chain would refuse, the kernel refuses first.', record: 'simulation.evaluated' },
];

const CODES = [
  'AMOUNT_EXCEEDS_DAILY_LIMIT', 'RECIPIENT_NOT_IN_ALLOWLIST', 'CONTRACT_VALUE_NOT_PERMITTED',
  'VELOCITY_EXCEEDS_HOURLY_LIMIT', 'TICKET_DIGEST_MISMATCH', 'RISK_ESCALATION_REQUIRED',
  'SIMULATION_MISMATCH', 'APPROVAL_ALREADY_CONSUMED', 'DEADLINE_EXPIRED', 'AGENT_REVOKED',
  'QUORUM_NOT_REACHED', 'FX_STALE', 'CHAIN_NOT_SUPPORTED', 'LIMIT_RESERVATION_FAILED',
];

const FIELDS: readonly { readonly path: string; readonly title: string; readonly body: string; readonly code: string }[] = [
  {
    path: 'permissions.transfers.perDay',
    title: 'A day, counted in the ledger',
    code: 'AMOUNT_EXCEEDS_DAILY_LIMIT',
    body: 'A running total, reserved at decision time and released if execution never happens. The ceiling is read from the row the policy compiled into, not repeated back by the caller.',
  },
  {
    path: 'permissions.transfers.recipients',
    title: 'An address has to have been seen',
    code: 'RECIPIENT_NOT_IN_ALLOWLIST',
    body: 'Recipients are an allowlist with no wildcard. A first-time address is refused or escalated, and which one happens is written in the document rather than decided in the moment.',
  },
  {
    path: 'permissions.contractCalls',
    title: 'Call data, matched to an allowlist',
    code: 'CONTRACT_NOT_ALLOWED',
    body: 'Contract calls name the addresses they may touch. Native value sent to a contract is refused at the schema, before the engine runs a plan at all.',
  },
  {
    path: 'escalation.humanApproval.quorum',
    title: 'A quorum the database enforces',
    code: 'QUORUM_NOT_REACHED',
    body: 'How many named approvers must vote, held by a uniqueness constraint rather than a count in application code. One person cannot approve twice to reach it.',
  },
  {
    path: 'fallback.onRiskUnavailable',
    title: 'What an outage means, written in advance',
    code: 'RISK_ENGINE_UNAVAILABLE',
    body: 'Both branches are in the document, so an unavailable advisory service never decides policy by itself. Silence is not treated as an absence of objection.',
  },
];

const SDK_SNIPPET = `const decision = await ari.transactions.authorize({
  agentId,
  candidate: {
    chain: 'ethereum', kind: 'transfer',
    asset: 'usdc', amountRaw: '4200000', recipient,
  },
});

switch (decision.outcome) {
  case 'ALLOW':                   // digest sealed, ticket minted
    return signer.sign(decision.ticket);
  case 'REQUIRE_HUMAN_APPROVAL':  // a named quorum, enforced in Postgres
    return queue.open(decision.approvalId);
  case 'DENY':
    throw new Refused(decision.codes); // ['AMOUNT_EXCEEDS_DAILY_LIMIT']
}`;

export function Landing() {
  const [selected, setSelected] = useState(3);
  const field = FIELDS[selected]!;

  return (
    <div className="min-h-[100dvh] bg-base">
      <ScrollProgress />

      <header className="sticky top-0 z-40 h-16 border-b border-line bg-base/92 backdrop-blur-sm">
        <div className="mx-auto flex h-full max-w-[75rem] items-center gap-6 px-5">
          <Wordmark size={22} href="/" />
          <nav className="hidden items-center gap-5 text-xs text-ink-2 md:flex" aria-label="Sections">
            <a href="#stages" className="transition-colors hover:text-ink">Seven stages</a>
            <a href="#fields" className="transition-colors hover:text-ink">Policy</a>
            <a href="#keys" className="transition-colors hover:text-ink">The key</a>
            <a href="#build" className="transition-colors hover:text-ink">Build</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <MotionSwitch />
            <LinkButton to="/app" variant="default" size="md" className="hidden sm:inline-flex">Open the console</LinkButton>
          </div>
        </div>
      </header>

      {/* 1. The hero has to fit the first screen: headline, twenty words, one action. */}
      <section className="mx-auto grid max-w-[75rem] items-center gap-8 px-5 pb-10 pt-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)] lg:gap-12 lg:pb-14 lg:pt-14">
        <div>
          <HeroEnter order={0}>
            <p className="flex items-center gap-2 text-xs text-ink-3">
              <ShieldCheck size={14} weight="regular" className="text-accent" />
              Permission infrastructure for autonomous money
            </p>
          </HeroEnter>
          <HeroEnter order={1}>
            <h1 className="display mt-4 max-w-[17ch] text-[2rem] leading-[1.03] text-ink sm:text-[2.6rem] lg:text-[2.95rem]">
              The layer between an agent and the money.
            </h1>
          </HeroEnter>
          <HeroEnter order={2}>
            <p className="mt-5 max-w-[44ch] text-[15px] leading-relaxed text-ink-2">
              Ari compiles each request against a versioned policy and answers with a single-use
              ticket. No key, no exceptions, no prose.
            </p>
          </HeroEnter>
          <HeroEnter order={3}>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <LinkButton to="/app" variant="primary" size="lg" trailingIcon>Open the sample console</LinkButton>
              <a href="#stages" className="group inline-flex items-center gap-1.5 text-sm text-ink-2 transition-colors hover:text-ink">
                See what a policy enforces
                <ArrowRight size={14} weight="bold" className="transition-transform duration-300 group-hover:translate-x-1" />
              </a>
            </div>
          </HeroEnter>
        </div>

        <HeroEnter order={2} className="h-[16rem] sm:h-[20rem] lg:h-[24rem]">
          <Suspense fallback={<div className="h-full border border-line bg-sunken" aria-hidden="true" />}>
            <GlassField className="h-full border border-line" />
          </Suspense>
        </HeroEnter>
      </section>

      {/* 2. A real photograph, full bleed, moving at its own rate. */}
      <section>
        <ParallaxImage
          src="/images/ari-port-night.jpg"
          alt="A container terminal at night, cranes lit along the quay and reflected in the water."
          className="h-[58vh] min-h-[22rem] w-full"
          strength={11}
        >
          <div className="absolute inset-0 bg-gradient-to-t from-base via-base/72 to-base/20" />
          <div className="absolute inset-x-0 bottom-0 mx-auto max-w-[75rem] px-5 pb-10">
            <Reveal>
              <h2 className="display max-w-[24ch] text-[1.6rem] leading-[1.06] text-ink sm:text-[2.3rem]">
                An agent that can move money is the most valuable target in your stack.
              </h2>
            </Reveal>
          </div>
        </ParallaxImage>
      </section>

      {/* 3. One marquee, carrying a finite vocabulary rather than decoration. */}
      <section className="border-b border-line bg-base py-6">
        <div className="mx-auto max-w-[75rem] px-5">
          <p className="mb-3 max-w-[62ch] text-xs leading-relaxed text-ink-3">
            A refusal is one of a fixed set of codes, and the set lives in the schema. It is not a
            sentence written at the moment of the decision.
          </p>
          <Marquee items={CODES} duration={54} />
        </div>
      </section>

      {/* 4. A pipeline is sideways, so scrolling sideways is the honest layout. */}
      <section id="stages" className="border-b border-line bg-panel py-14 lg:py-16">
        <HorizontalPan
          title={
            <h2 className="display max-w-[24ch] text-[1.6rem] leading-[1.08] text-ink sm:text-[2.1rem]">
              Seven stages, one decision, and nothing in between can say yes alone.
            </h2>
          }
          lead="The same rail appears in the console on every request, at the stage each one actually reached. Keep scrolling and the row pans."
        >
          {STAGES.map((line, index) => <StageCard key={line.stage} line={line} index={index} />)}
        </HorizontalPan>
      </section>

      {/* 5. Five fields, one visible at a time. */}
      <section id="fields" className="bg-base py-16 lg:py-24">
        <div className="mx-auto grid max-w-[75rem] gap-8 px-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-14">
          <div>
            <Reveal>
              <h2 className="display text-[1.6rem] leading-[1.08] text-ink sm:text-[2rem]">A policy is data, compiled once</h2>
              <p className="mt-3 max-w-[46ch] text-[13px] leading-relaxed text-ink-3">
                Five of the fields in a document, and the behaviour each one causes at decision
                time. Choose one.
              </p>
            </Reveal>
            <ul className="mt-6 divide-y divide-line border-y border-line">
              {FIELDS.map((item, index) => (
                <li key={item.path}>
                  <FieldRow path={item.path} active={index === selected} onSelect={() => setSelected(index)} />
                </li>
              ))}
            </ul>
          </div>

          <div className="min-h-[20rem]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={field.path}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
                className="border border-line bg-panel p-5 sm:p-7"
              >
                <code className="font-mono text-[11px] text-accent">{field.path}</code>
                <h3 className="display mt-2 max-w-[20ch] text-[1.5rem] leading-tight text-ink sm:text-[1.9rem]">{field.title}</h3>
                <p className="mt-3 max-w-[62ch] text-[14px] leading-relaxed text-ink-2">{field.body}</p>
                <div className="mt-7 flex flex-wrap items-center gap-3 border-t border-line pt-4">
                  <span className="text-[11px] text-ink-3">the engine answers with</span>
                  <Tag tone="stop" mono>{field.code}</Tag>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </section>

      {/* 6. One object, offered to the cursor, beside the claim it illustrates. */}
      <section id="keys" className="border-t border-line bg-base">
        <div className="mx-auto grid max-w-[75rem] items-center gap-10 px-5 py-16 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)] lg:gap-16 lg:py-24">
          <Reveal>
            <Tilt className="mx-auto w-full max-w-[34rem] [perspective:1200px]">
              <figure className="border border-line bg-sunken">
                <img
                  src="/images/ari-vault-door.jpg"
                  alt="A circular steel bank vault door standing open in a dark room."
                  loading="lazy"
                  decoding="async"
                  className="h-[19rem] w-full object-cover sm:h-[24rem]"
                />
                <figcaption className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-[11px] text-ink-3">
                  <span>A door with a mechanism, not a person standing in front of it.</span>
                  <span className="shrink-0 font-mono text-ink-4">CC BY-SA</span>
                </figcaption>
              </figure>
            </Tilt>
          </Reveal>

          <div>
            <Reveal delay={0.05}>
              <h2 className="display max-w-[16ch] text-[1.6rem] leading-[1.08] text-ink sm:text-[2.1rem]">Ari holds no key</h2>
              <p className="mt-4 max-w-[58ch] text-[14px] leading-relaxed text-ink-2">
                Signing lives behind a provider adapter: today a mock, later an ika dWallet. The
                adapter receives a ticket and can read nothing past it. The decision plane never
                touches a private key, and the ceremony stays with the signer.
              </p>
              <p className="mt-3 max-w-[58ch] text-[14px] leading-relaxed text-ink-2">
                The consequence is deliberate. Compromise the plane that decides and you can refuse
                transactions. You cannot send one.
              </p>
              <ul className="mt-8 grid gap-x-8 gap-y-4 sm:grid-cols-2">
                {[
                  { k: 'Ticket', v: 'single use, 60 seconds, bound to one digest' },
                  { k: 'Redemption', v: 'a second process, its own role, its own key' },
                  { k: 'Agent', v: 'may propose, may never approve its own request' },
                  { k: 'Audit', v: 'append-only rows, each hashing the one before' },
                ].map((item) => (
                  <li key={item.k} className="border-t border-line pt-2.5">
                    <p className="text-[13px] font-medium text-ink">{item.k}</p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-3">{item.v}</p>
                  </li>
                ))}
              </ul>
              <Link to="/app/wallets" className="mt-8 inline-flex items-center gap-1.5 text-xs text-accent transition-colors hover:text-accent-strong">
                How a wallet is granted <ArrowRight size={13} weight="bold" />
              </Link>
            </Reveal>
          </div>
        </div>
      </section>

      {/* 7. The integration, with the shape of the answer beside it. */}
      <section id="build" className="border-t border-line bg-panel py-16 lg:py-20">
        <div className="mx-auto grid max-w-[75rem] gap-8 px-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-12">
          <Reveal>
            <h2 className="display text-[1.6rem] leading-[1.08] text-ink sm:text-[2rem]">One call, three answers</h2>
            <p className="mt-3 max-w-[52ch] text-[13px] leading-relaxed text-ink-2">
              Ask the engine to authorize a candidate. It returns a decision, the codes behind it,
              and either a ticket or nothing. No state to poll, and no callback that has to arrive
              before the answer is true.
            </p>
            <ul className="mt-6 space-y-2.5 text-xs leading-relaxed text-ink-2">
              <li className="flex flex-wrap items-center gap-2.5"><Tag tone="ok" mono>ALLOW</Tag><span>ticket sealed, digest pinned</span></li>
              <li className="flex flex-wrap items-center gap-2.5"><Tag tone="wait" mono>REQUIRE_HUMAN_APPROVAL</Tag><span>queued for a named quorum</span></li>
              <li className="flex flex-wrap items-center gap-2.5"><Tag tone="stop" mono>DENY</Tag><span>reason codes, never a prose guess</span></li>
            </ul>
          </Reveal>
          <Reveal delay={0.08}>
            <CodeBlock code={SDK_SNIPPET} caption="authorize and branch" />
          </Reveal>
        </div>
      </section>

      {/* 8. The honesty section, as one panel rather than a grid of cards. */}
      <section className="border-t border-line bg-base py-16 lg:py-20">
        <div className="mx-auto max-w-[75rem] px-5">
          <Reveal>
            <h2 className="display max-w-[26ch] text-[1.6rem] leading-[1.08] text-ink sm:text-[2rem]">
              What this build is, and what it is not
            </h2>
          </Reveal>

          <Stagger className="mt-9 grid gap-y-9 border-t border-line pt-9 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,15rem)] lg:gap-x-12">
            <StaggerItem>
              <p className="text-[13px] font-medium text-ink">Real, in this repository</p>
              <p className="mt-2 max-w-[52ch] text-[13px] leading-relaxed text-ink-3">
                The policy compiler and kernel, the transaction engine, the audit hash chain, the
                ticket signer in its own process, the Postgres schema and its row-level security,
                the simulation provider, the command line. Run against a local chain for the paths
                that touch one.
              </p>
            </StaggerItem>
            <StaggerItem>
              <p className="text-[13px] font-medium text-ink">Not real, and labelled where it shows</p>
              <p className="mt-2 max-w-[52ch] text-[13px] leading-relaxed text-ink-3">
                This page and the console read a sample tenant. No deployment is attached, no chain
                data is fetched, and no balance, agent or recipient here belongs to anyone. The
                signing adapter is a mock, and it reports itself as untrustworthy rather than
                pretending to have signed.
              </p>
            </StaggerItem>
            <StaggerItem className="grid grid-cols-2 gap-x-6 gap-y-6 lg:border-l lg:border-line lg:pl-10">
              {[
                { to: 536, label: 'tests in the suite' },
                { to: 231, label: 'of them adversarial' },
                { to: 16, label: 'CLI commands' },
                { to: 14, label: 'migrations' },
              ].map((stat) => (
                <div key={stat.label}>
                  <p className="font-mono text-[26px] leading-none text-accent"><CountUp to={stat.to} /></p>
                  <p className="mt-1.5 text-[11px] leading-snug text-ink-3">{stat.label}</p>
                </div>
              ))}
            </StaggerItem>
          </Stagger>
        </div>
      </section>

      <footer className="border-t border-line bg-panel">
        <div className="mx-auto flex max-w-[75rem] flex-wrap items-center justify-between gap-5 px-5 py-9">
          <span className="flex items-center gap-2.5">
            <Mark size={20} className="text-ink-2" />
            <span className="text-xs text-ink-3">ARI. Permission infrastructure for autonomous money.</span>
          </span>
          <span className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            <Link to="/app/audit" className="text-ink-3 transition-colors hover:text-ink">Audit log</Link>
            <Link to="/app/developers" className="text-ink-3 transition-colors hover:text-ink">Developers</Link>
            <Link to="/app" className="text-ink-3 transition-colors hover:text-ink">Console</Link>
          </span>
        </div>
        <div className="border-t border-line px-5 py-3">
          <p className="mx-auto max-w-[75rem] text-[11px] leading-relaxed text-ink-4">
            Photographs via Wikimedia Commons: a container terminal at Altenwerder (CC0) and the
            Winona Savings Bank vault door by Jonathunder (CC BY-SA 3.0).
          </p>
        </div>
      </footer>
    </div>
  );
}

function FieldRow({ path, active, onSelect }: { readonly path: string; readonly active: boolean; readonly onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      aria-pressed={active}
      className={cx(
        'group flex w-full items-center justify-between gap-3 py-2.5 text-left transition-colors',
        active ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
      )}
    >
      <code className="truncate font-mono text-[11px]">{path}</code>
      <ArrowRight
        size={12}
        weight="bold"
        className={cx('shrink-0 transition-transform duration-300', active ? 'translate-x-0 text-accent' : '-translate-x-1 opacity-0 group-hover:translate-x-0 group-hover:opacity-100')}
      />
    </button>
  );
}

/** One card in the panned rail. Fixed width, so the pan distance is measurable. */
function StageCard({ line, index }: { readonly line: (typeof STAGES)[number]; readonly index: number }) {
  return (
    <div className="flex w-[15.5rem] shrink-0 snap-start flex-col justify-between border border-line bg-base p-4 sm:w-[17.5rem]">
      <div>
        <p className="flex items-baseline justify-between gap-2">
          <span className="font-mono text-[13px] text-accent">{line.stage}</span>
          <span className="font-mono text-[11px] text-ink-4">{index + 1} of 7</span>
        </p>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-2">{line.enforce}</p>
      </div>
      <p className="mt-5 border-t border-line pt-2.5 font-mono text-[11px] leading-snug text-ink-3">{line.record}</p>
    </div>
  );
}
