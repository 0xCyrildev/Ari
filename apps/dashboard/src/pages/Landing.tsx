import { lazy, Suspense } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, ShieldCheck } from '@phosphor-icons/react';
import { LinkButton, Button, CodeBlock, Tag } from '../components/ui';
import { Reveal, RevealGroup, riseItem } from '../components/hero';

/**
 * The WebGL field is the only thing on this page that needs `three`, so it is the only thing
 * loaded on demand. A console visit never parses it.
 */
const GlassField = lazy(() => import('../components/glass-field').then((m) => ({ default: m.GlassField })));
import { Mark, Wordmark, PIPELINE } from '../components/product';
import { Link } from '../app/router';
import { cx } from '../lib/util';

/* ==========================================================================
   Landing
   --------------------------------------------------------------------------
   Dials for this page: variance 6, motion 4, density 4. It is a technical
   audience reading about permission infrastructure, so the language is close to
   a specification and far from a launch page: no mesh gradient behind a centred
   headline, no logo wall of customers that do not exist, no counter that goes
   up. The one piece of continuous motion is the WebGL field in the hero, and it
   stops for prefers-reduced-motion.
   ========================================================================== */

const SDK_SNIPPET = `const decision = await ari.transactions.authorize({
  agentId,
  candidate: { chain: 'ethereum', kind: 'transfer', asset: 'usdc', amountRaw: '4200000', recipient },
});

switch (decision.outcome) {
  case 'ALLOW':                    // policy said yes, digest sealed
    return signer.sign(decision.ticket);
  case 'REQUIRE_HUMAN_APPROVAL':   // quorum of named humans, enforced in Postgres
    return queue.decision(decision.approvalId);
  case 'DENY':
    throw new Refused(decision.codes); // ['AMOUNT_EXCEEDS_DAILY_LIMIT']
}`;

export function Landing() {
  const reduce = useReducedMotion();
  return (
    <div className="min-h-screen bg-base">
      <header className="sticky top-0 z-40 border-b border-line bg-base/92 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-6 px-5">
          <Wordmark size={22} href="/" />
          <nav className="hidden items-center gap-5 text-xs text-ink-2 md:flex" aria-label="Sections">
            <a href="#model" className="transition-colors hover:text-ink">Policy model</a>
            <a href="#flow" className="transition-colors hover:text-ink">The seven stages</a>
            <a href="#boundaries" className="transition-colors hover:text-ink">Trust boundaries</a>
            <a href="#build" className="transition-colors hover:text-ink">Build on it</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <LinkButton to="/app" variant="default" size="md">Open the control center</LinkButton>
          </div>
        </div>
      </header>

      {/* 1. Hero: split, left-aligned copy against a rendered field. */}
      <section className="mx-auto grid max-w-[1200px] items-stretch gap-8 px-5 py-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-10 lg:py-20">
        <motion.div
          className="relative z-10 flex max-w-xl flex-col justify-center"
          initial={reduce === true ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.2, 0.7, 0.3, 1] }}
        >
          <p className="mb-4 flex items-center gap-2 text-[11px] text-ink-3">
            <ShieldCheck size={14} weight="regular" className="text-accent" />
            Permission infrastructure for autonomous money
          </p>
          <h1 className="display text-3xl text-ink sm:text-[2.6rem]">
            An agent asks.<br />
            A policy decides.<br />
            <span className="text-ink-3">A signer never sees the agent.</span>
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-ink-2">
            Ari sits between an autonomous agent and the key that can move funds. Every request is
            compiled against a versioned policy, evaluated in one kernel, and answered with a
            single-use ticket bound to a digest. The agent cannot widen its own envelope, and the
            signer cannot be talked into a different transaction.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-2.5">
            <LinkButton to="/app" variant="primary" size="lg" trailingIcon>Review the sample tenant</LinkButton>
            <a href="#model" className="inline-flex h-10 items-center gap-1.5 rounded-control border border-transparent px-1 text-sm text-ink-2 transition-colors hover:text-ink">
              Read what a policy enforces <ArrowRight size={14} weight="bold" />
            </a>
          </div>
          <div className="mt-9 hidden lg:block">
            <StageStrip />
          </div>
        </motion.div>

        <Suspense fallback={<div className="min-h-[18rem] border border-line bg-sunken lg:min-h-[26rem]" aria-hidden="true" />}>
          <GlassField className="min-h-[18rem] border border-line lg:min-h-[26rem]" />
        </Suspense>
      </section>

      {/* 2. Facts, as a strip on a hairline rather than a grid of identical cards. */}
      <section className="border-y border-line bg-panel">
        <div className="mx-auto grid max-w-[1200px] grid-cols-2 divide-line px-5 md:grid-cols-4 md:divide-x">
          {[
            { k: 'One kernel', v: 'Policy, risk and approval resolve in a single compiled evaluation. No second place where a yes can be found.' },
            { k: 'Digest bound', v: 'The approval is sealed against canon/v1 of the exact candidate. A changed amount invalidates it.' },
            { k: '60 second tickets', v: 'Minted in one process, redeemed in another, once. Replay gets TICKET_ALREADY_USED.' },
            { k: 'Append-only chain', v: 'Every decision is a row with a hash over the previous one. Verify recomputes; it does not trust.' },
          ].map((item, i) => (
            <Reveal key={item.k} delay={i * 0.04} className="px-0 py-5 md:px-5 md:first:pl-0">
              <p className="text-[13px] font-medium text-ink">{item.k}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-3">{item.v}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* 3. The model, as a definition list with a sticky headline. */}
      <section id="model" className="mx-auto max-w-[1200px] px-5 py-16 lg:py-24">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <h2 className="display text-2xl text-ink">What a policy actually says</h2>
            <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
              A policy document is data. It compiles once, at activation, into a plan the engine
              runs without interpreting JSON at decision time. These are the fields, and the
              behaviour each one causes.
            </p>
          </div>

          <RevealGroup className="divide-y divide-line border-y border-line">
            {[
              { field: 'permissions.transfers.perDay', effect: 'A running total in the ledger, reserved at decision time and released if execution never happens. Over it: AMOUNT_EXCEEDS_DAILY_LIMIT.' },
              { field: 'permissions.transfers.recipients', effect: 'An address allowlist. A recipient never seen before is either refused or escalated, never silently accepted.' },
              { field: 'permissions.contractCalls', effect: 'Call data is matched against an allowlist of addresses. Native value to a contract is refused at the schema, before the engine runs.' },
              { field: 'escalation.humanApproval.quorum', effect: 'How many named approvers must vote, enforced by a uniqueness constraint in Postgres rather than by a count in the application.' },
              { field: 'fallback.onRiskUnavailable', effect: 'What happens when an advisory service is down. Both branches are written in the document, so the outage never decides policy by itself.' },
              { field: 'validity.transactionTtlSeconds', effect: 'How long a signed decision stays good. An execution that arrives late is refused with DEADLINE_EXPIRED.' },
            ].map((row) => (
              <motion.div key={row.field} variants={riseItem} className="grid gap-1.5 py-4 sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] sm:gap-6">
                <code className="font-mono text-xs text-accent">{row.field}</code>
                <p className="text-[13px] leading-relaxed text-ink-2">{row.effect}</p>
              </motion.div>
            ))}
          </RevealGroup>
        </div>
      </section>

      {/* 4. The flow, as a wide table: stage, enforcement, record. */}
      <section id="flow" className="border-y border-line bg-panel">
        <div className="mx-auto max-w-[1200px] px-5 py-16 lg:py-20">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <h2 className="display text-2xl text-ink">Seven stages, one decision</h2>
            <p className="max-w-sm text-xs leading-relaxed text-ink-3">
              The same rail appears in the console on every request. What a stage reached, what it
              enforced, and which row it wrote are the same three questions in both places.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="border-b border-line-strong">
                  <th className="label w-[9rem] py-2 font-normal">Stage</th>
                  <th className="label py-2 font-normal">What is enforced here</th>
                  <th className="label hidden w-[34%] py-2 font-normal md:table-cell">What the audit log gets</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { stage: PIPELINE[0], enforce: 'The credential is scoped. An agent with no envelope has no authority to ask.', row: 'agent.request.received' },
                  { stage: PIPELINE[1], enforce: 'The candidate is canonicalised. Amounts stay decimal strings; nothing is rounded to fit a float.', row: 'intent.captured' },
                  { stage: PIPELINE[2], enforce: 'The compiled plan is evaluated under the tenant role, inside one advisory lock per organization.', row: 'policy.evaluated, digest' },
                  { stage: PIPELINE[3], enforce: 'Advisory. Risk can escalate or refuse. It can never grant something policy refused.', row: 'risk.assessed, signals[]' },
                  { stage: PIPELINE[4], enforce: 'A named human, the quorum in the database, and a vote sealed against the digest.', row: 'approval.granted / rejected' },
                  { stage: PIPELINE[5], enforce: 'A single-use ticket, 60 second TTL, redeemed in the signer process and nowhere else.', row: 'ticket.minted / redeemed' },
                  { stage: PIPELINE[6], enforce: 'Simulation before signing. If the chain would refuse, the kernel refuses first.', row: 'simulation.evaluated' },
                ].map((line) => (
                  <tr key={line.stage} className="border-b border-line/70 last:border-0">
                    <td className="py-3 pr-4 font-mono text-xs text-ink">{line.stage}</td>
                    <td className="py-3 pr-6 leading-relaxed text-ink-2">{line.enforce}</td>
                    <td className="hidden py-3 font-mono text-[11px] text-ink-3 md:table-cell">{line.row}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* 5. Boundaries: a large statement, answered by three claims under hairlines. */}
      <section id="boundaries" className="mx-auto max-w-[1200px] px-5 py-16 lg:py-24">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div>
            <h2 className="display max-w-lg text-2xl text-ink">Three places a system like this usually lies</h2>
            <ol className="mt-8 divide-y divide-line border-t border-line">
              {[
                { n: '01', t: 'The UI does not hold the decision', b: 'Every number on a screen in this product is read back from the same row the engine wrote. The browser cannot approve its own request, and the API does not ask the client what the limit was.' },
                { n: '02', t: 'Risk advises, it never grants', b: 'A high risk score can escalate to a human or refuse outright. Nothing in the risk path can turn a policy denial into an approval, and the kernel rejects a plan that tries to encode one.' },
                { n: '03', t: 'An unavailable node is not a yes', b: 'When simulation or risk is down, the document already says what happens. The engine does not treat an outage as an absence of objection, and it does not pretend an advisory it never received passed.' },
              ].map((item) => (
                <li key={item.n} className="grid gap-2 py-5 sm:grid-cols-[2.5rem_minmax(0,1fr)]">
                  <span className="font-mono text-[11px] text-ink-4">{item.n}</span>
                  <div>
                    <h3 className="text-[15px] font-medium text-ink">{item.t}</h3>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{item.b}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <aside className="border border-line bg-panel p-5 lg:mt-16">
            <p className="label">Where the money is</p>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              Ari holds no key. Signing lives behind a provider adapter, today a mock and tomorrow
              an ika dWallet, and the adapter only ever receives a ticket it cannot read past.
            </p>
            <p className="mt-4 border-t border-line pt-4 text-[13px] leading-relaxed text-ink-2">
              The consequence is deliberate: compromise the decision plane and you can refuse
              transactions. You cannot send one.
            </p>
            <Link to="/app/wallets" className="mt-5 inline-flex items-center gap-1.5 text-xs text-accent transition-colors hover:text-accent-strong">
              See how a wallet is granted <ArrowRight size={13} weight="bold" />
            </Link>
          </aside>
        </div>
      </section>

      {/* 6. Build: the integration, with the shape of the answer next to it. */}
      <section id="build" className="border-t border-line bg-panel">
        <div className="mx-auto grid max-w-[1200px] gap-8 px-5 py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:py-20">
          <div>
            <h2 className="display text-2xl text-ink">One call, three possible answers</h2>
            <p className="mt-3 max-w-md text-[13px] leading-relaxed text-ink-2">
              The client asks the engine to authorize a candidate. It gets back a decision, the
              reason codes, and either a ticket or nothing. There is no state to poll and no
              callback that has to arrive for the answer to be true.
            </p>
            <ul className="mt-6 space-y-2.5 text-xs leading-relaxed text-ink-2">
              <li className="flex gap-2.5"><Tag tone="ok" mono>ALLOW</Tag><span>ticket sealed, digest pinned</span></li>
              <li className="flex gap-2.5"><Tag tone="wait" mono>APPROVAL</Tag><span>queued for a named quorum</span></li>
              <li className="flex gap-2.5"><Tag tone="stop" mono>DENY</Tag><span>reason codes, never a prose guess</span></li>
            </ul>
            <p className="mt-6 text-[11px] text-ink-4">
              The command line covers the same surface: 16 commands, from policy validation to
              audit verification, all against the same API.
            </p>
          </div>
          <CodeBlock code={SDK_SNIPPET} caption="authorize and branch" />
        </div>
      </section>

      {/* 7. What is real here. A landing page that does not say so is a demo pretending. */}
      <section className="border-t border-line">
        <div className="mx-auto max-w-[1200px] px-5 py-14">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <h2 className="display text-xl text-ink">What this build is, and is not</h2>
            <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
              <dl className="text-[13px] leading-relaxed">
                <dt className="text-ink">Real, in this repository</dt>
                <dd className="mt-1.5 text-ink-3">
                  The policy compiler and kernel, the transaction engine, the audit hash chain, the
                  ticket signer in its own process, the Postgres schema and its row-level security,
                  the simulation provider, the CLI. 536 tests, of which 231 are the adversarial
                  suite, run against a local chain for the simulation paths.
                </dd>
              </dl>
              <dl className="text-[13px] leading-relaxed">
                <dt className="text-ink">Not real, and labelled where it shows</dt>
                <dd className="mt-1.5 text-ink-3">
                  This landing page and the console screens read a sample tenant. No deployment is
                  attached, no chain data is fetched, and no balances, agents or recipients on these
                  pages correspond to anyone. The signing adapter here is a mock, and it reports
                  itself as untrustworthy rather than pretending to have signed.
                </dd>
              </dl>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-line bg-panel">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-5 py-8">
          <span className="flex items-center gap-2.5">
            <Mark size={20} className="text-ink-2" />
            <span className="text-xs text-ink-3">ARI. Permission infrastructure for autonomous money.</span>
          </span>
          <span className="flex items-center gap-4 text-xs">
            <Link to="/app/audit" className={cx('text-ink-3 transition-colors hover:text-ink')}>Audit log</Link>
            <Link to="/app/developers" className="text-ink-2 transition-colors hover:text-ink">Developers</Link>
            <Button variant="ghost" size="sm" onClick={() => document.getElementById('model')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
              Back to the model
            </Button>
          </span>
        </div>
      </footer>
    </div>
  );
}

/** The rail, set small and mono, as it will appear in the console. */
function StageStrip() {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-4">
      {PIPELINE.map((stage, index) => (
        <span key={stage} className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-ink-3">{stage.toLowerCase()}</span>
          {index < PIPELINE.length - 1 && <span className="h-px w-3 bg-line-strong" aria-hidden="true" />}
        </span>
      ))}
    </div>
  );
}
