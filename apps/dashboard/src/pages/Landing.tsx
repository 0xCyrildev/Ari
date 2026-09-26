import { Badge, Button, CodeBlock } from '../components/ui';
import { Mark, PipelineRail, Wordmark } from '../components/product';
import { Link } from '../app/router';
import { cx } from '../lib/util';

const REQUEST = `const decision = await ari.authorize({
  candidate: {
    kind: 'transfer', chain: 'ethereum',
    asset: { kind: 'erc20', contract: USDC, decimals: '6' },
    amount: { raw: '4200000000', unit: 'usdc-6dp' },
    recipient: { address: '0x3f2a…2b3c' },
  },
  idempotencyKey: 'invoice-INV-2291',
});`;

const RESPONSES = [
  {
    tone: 'allow' as const,
    label: 'ALLOW',
    body: `The policy said yes, the reservation held, and a single-use
ticket was sealed to this digest in another process.
→ { state: "COMPLETE", ticketId: "tkt_01a0…" }`,
  },
  {
    tone: 'caution' as const,
    label: 'REQUIRE_HUMAN_APPROVAL',
    body: `Within limits, but a condition your policy wrote down
matched. A named person is asked, and the token is minted
from the row that records their vote.
→ { state: "APPROVAL_PENDING", expiresAt: "…" }`,
  },
  {
    tone: 'deny' as const,
    label: 'DENY',
    body: `Refused, with the reason codes your engine produced and an
audit row that says so. No ticket exists to be misused.
→ { state: "DENIED", reasonCodes: ["AMOUNT_EXCEEDS_DAILY_LIMIT"] }`,
  },
];

export function Landing() {
  return (
    <div className="min-h-screen bg-base">
      <header className="sticky top-0 z-30 border-b border-hair bg-base/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5">
          <Wordmark size={24} />
          <nav className="ml-auto hidden items-center gap-6 text-[13px] text-ink-mute md:flex">
            <a href="#how" className="transition-colors hover:text-ink">How it works</a>
            <a href="#policy" className="transition-colors hover:text-ink">Policy</a>
            <a href="#developers" className="transition-colors hover:text-ink">Developers</a>
            <Link to="/app" className="transition-colors hover:text-ink">Console</Link>
          </nav>
          <Link to="/app" className="ml-auto md:ml-0"><Button variant="primary">Start building</Button></Link>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div className="mx-auto max-w-6xl px-5 pb-16 pt-16 sm:pt-24">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_26rem] lg:gap-16">
            <div className="max-w-2xl">
              <div className="mb-6 flex items-center gap-3">
                <span className="text-ink"><Mark size={40} /></span>
                <span className="h-8 w-px bg-hair" />
                <p className="eyebrow">authorization for autonomous financial agents</p>
              </div>

              <h1 className="text-hero font-semibold leading-[1.06] tracking-[-0.03em] text-ink">
                Give AI agents access to money.
                <span className="mt-1 block text-ink-dim">Not unlimited access.</span>
              </h1>

              <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-ink-mute">
                ARI sits between an agent and a signature. Every request is parsed into one canonical form, evaluated against a
                deterministic policy, scored against your own transaction history, escalated to a named human when the policy says
                it must, and only then handed to a signer in a separate process as a single-use ticket. The agent never holds a key,
                never sees a ticket, and cannot approve anything.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link to="/app"><Button variant="primary" size="md" className="h-9 px-4 text-[13px]">Start building</Button></Link>
                <a href="#developers"><Button size="md" className="h-9 px-4 text-[13px]">Read the docs</Button></a>
              </div>

              <p className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-ink-faint">
                <span>self-hostable</span>
                <span>·</span>
                <span>row-level tenancy in Postgres</span>
                <span>·</span>
                <span>append-only hash chain per organisation</span>
                <span>·</span>
                <span>dWallet signing</span>
              </p>
            </div>

            {/* the system, as a diagram rather than a mood */}
            <div className="lg:pt-4">
              <div className="rounded-[var(--radius-lg)] border border-hair bg-surface p-5">
                <div className="eyebrow mb-4">every request, in order</div>
                <div className="flex flex-col gap-2.5">
                  {[
                    { k: 'AI AGENT', v: 'proposes a payment', tone: 'neutral' as const },
                    { k: 'INTENT', v: 'one canonical form, one digest', tone: 'brand' as const },
                    { k: 'POLICY', v: 'allow · escalate · deny', tone: 'brand' as const },
                    { k: 'RISK', v: 'advisory — cannot grant', tone: 'brand' as const },
                    { k: 'APPROVAL', v: 'a human, a quorum, a sealed token', tone: 'caution' as const },
                    { k: 'SIGNING', v: 'another process, one ticket, 60s', tone: 'brand' as const },
                    { k: 'EXECUTION', v: 'confirmed by a provider, not assumed', tone: 'allow' as const },
                  ].map((row, index) => (
                    <div key={row.k} className="flex items-center gap-3" style={{ animationDelay: `${index * 45}ms` }}>
                      <span
                        className={cx(
                          'grid h-6 w-[5.75rem] shrink-0 place-items-center rounded-[var(--radius-xs)] border text-[9px] font-semibold uppercase tracking-[0.1em]',
                          row.tone === 'allow' && 'border-allow-line bg-allow-wash text-allow',
                          row.tone === 'caution' && 'border-caution-line bg-caution-wash text-caution',
                          row.tone === 'brand' && 'border-brand-dim bg-brand-wash text-brand',
                          row.tone === 'neutral' && 'border-hair-strong bg-raised text-ink-dim',
                        )}
                      >
                        {row.k}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-ink-mute">{row.v}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-5 border-t border-hair pt-4">
                  <p className="text-2xs leading-relaxed text-ink-faint">
                    A refusal leaves no ticket behind. That is enforced by a trigger on the row, not by a convention in the code.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* three answers */}
      <section id="how" className="border-y border-hair bg-[#090c10]">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <div className="max-w-2xl">
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">One call. Three possible answers.</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-ink-mute">
              The agent that asks is not the subject that decides, and neither of them is the one that signs. What comes back is a
              decision with reasons your policy produced, in a vocabulary you can branch on.
            </p>
          </div>

          <div className="mt-10 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <CodeBlock caption="authorize" code={REQUEST} />
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
              {RESPONSES.map((response) => (
                <div key={response.label} className="rounded-[var(--radius-md)] border border-hair bg-surface p-4">
                  <Badge tone={response.tone}>{response.label}</Badge>
                  <p className="mt-2.5 whitespace-pre-line font-mono text-[11px] leading-relaxed text-ink-mute">{response.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* policy */}
      <section id="policy" className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid gap-10 lg:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">A policy is a document, compiled and frozen.</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-ink-mute">
              You write what is allowed: which assets, which chains, which recipients, which ceilings, and what happens when the
              risk plane is down. The compiler refuses what it cannot express — two limits that disagree about units, transfers
              enabled with no permitted chains, an allowlist entry that is not a valid address, a wildcard recipient that does not
              exist in the vocabulary at all.
            </p>
            <ul className="mt-6 space-y-3 text-[13px]">
              {[
                ['Default deny is structural', 'There is no `unrestricted` option to select, because it is not in the schema. An option a human can write that does nothing is a policy that reads as protection.'],
                ['The digest is derived, never supplied', 'The engine computes the bytes it authorized. A caller could otherwise ask about one transaction and seal another.'],
                ['Versions cannot be edited', 'A published version’s content is frozen, and no version can be walked back into a draft. Widening needs the owner role; a rollback needs a written reason.'],
                ['Risk cannot grant', 'It can refuse and it can escalate. That is a property of the type, not a code review note.'],
              ].map(([title, body]) => (
                <li key={title} className="flex gap-3">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-brand" />
                  <span>
                    <span className="block font-medium text-ink">{title}</span>
                    <span className="mt-0.5 block text-ink-mute">{body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-3">
            {[
              { title: 'Allowed', tone: 'allow' as const, rows: [['assets', 'USDC (ethereum)'], ['per transaction', '$10,000'], ['per day', '$25,000'], ['per month', '$250,000'], ['recipients', '2 allowlisted · no wildcard']] },
              { title: 'Escalation', tone: 'caution' as const, rows: [['amount above', '$5,000'], ['new recipient', 'within 30 days'], ['risk at or above', 'MEDIUM'], ['quorum', '1 of owner / approver']] },
              { title: 'Refused outright', tone: 'deny' as const, rows: [['contract calls', 'disabled'], ['native value on a call', 'CONTRACT_VALUE_NOT_PERMITTED'], ['unknown transaction', 'deny'], ['evaluation error', 'deny']] },
            ].map((group) => (
              <div key={group.title} className="rounded-[var(--radius-md)] border border-hair bg-surface">
                <div className="flex items-center gap-2 border-b border-hair px-4 py-2.5">
                  <span className={cx('h-1.5 w-1.5 rounded-full', group.tone === 'allow' ? 'bg-allow' : group.tone === 'caution' ? 'bg-caution' : 'bg-deny')} />
                  <span className="eyebrow">{group.title}</span>
                </div>
                <dl className="divide-y divide-hair-faint px-4">
                  {group.rows.map(([k, v]) => (
                    <div key={k} className="flex items-baseline justify-between gap-4 py-2">
                      <dt className="text-2xs uppercase tracking-[0.06em] text-ink-mute">{k}</dt>
                      <dd className="text-right text-xs text-ink">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* signing boundary */}
      <section className="border-y border-hair bg-[#090c10]">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_24rem]">
            <div>
              <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">The signer is another process, and it is not convinced by anything it is told.</h2>
              <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-mute">
                A ticket is minted only against a recorded ALLOW, redeemed once, in a second process with its own database role. It
                carries the digest, the wallet and an expiry; the columns that define what was authorized cannot be edited after
                minting, because editing one would not amend an authorization — it would forge a different one under an identifier
                that already cleared policy.
              </p>
              <div className="mt-8 overflow-x-auto"><PipelineRail size="md" /></div>
            </div>
            <div className="space-y-3 text-[13px]">
              {[
                ['No key in the application', 'The decision plane cannot sign, and the signer cannot decide.'],
                ['Single use, across processes', 'A retry of a spent request returns the original answer, not a second signature.'],
                ['60 second TTL', 'A short-lived capability, enforced by the clock of the process that has to honour it.'],
                ['Honest about a mock', 'A signature from a test provider is labelled untrustworthy on the type, and the console says so.'],
              ].map(([title, body]) => (
                <div key={title} className="rounded-[var(--radius-md)] border border-hair bg-surface px-4 py-3">
                  <div className="font-medium text-ink">{title}</div>
                  <div className="mt-1 text-ink-mute">{body}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* developers */}
      <section id="developers" className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid gap-10 lg:grid-cols-[24rem_minmax(0,1fr)]">
          <div>
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-ink">Built for the person wiring an agent to it.</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-ink-mute">
              One client, three methods, and a type test that fails the build the day anyone adds a fourth that could bypass the
              decision. Idempotency is the default, so a timeout is a retry rather than a double spend.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Link to="/app/developers"><Button variant="primary">API reference</Button></Link>
              <Link to="/app"><Button>Open the console</Button></Link>
            </div>
          </div>
          <CodeBlock
            caption="@ari/client"
            code={`import { createClient, CandidateTransaction } from '@ari/client';

const ari = createClient({ baseUrl, credential });   // crd_… — printed once

const result = await ari.authorize({ candidate, idempotencyKey: 'invoice-INV-2291' });

if (result.state === 'APPROVAL_PENDING') {
  // A human decides through their own credential (ucrd_…).
  // The agent can wait; it cannot approve.
}

// ari.sign() does not exist, and a test asserts that it stays that way.`}
          />
        </div>
      </section>

      <footer className="border-t border-hair">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <Wordmark size={22} />
            <p className="mt-3 text-xs leading-relaxed text-ink-mute">
              Permission infrastructure for autonomous money. ARI’s guarantee is that it refuses deterministically and can prove it
              refused — not that the chain will stop what a key holder signs.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-12 gap-y-2 text-xs sm:grid-cols-3">
            {[
              ['Product', ['Console', 'Policy', 'Approvals', 'Audit']],
              ['Developers', ['SDK', 'API reference', 'Webhooks', 'Environments']],
              ['Company', ['Security posture', 'Disclosure', 'Status']],
            ].map(([group, items]) => (
              <div key={group as string}>
                <div className="eyebrow mb-2">{group as string}</div>
                <ul className="space-y-1.5 text-ink-mute">
                  {(items as readonly string[]).map((item) => (
                    <li key={item}><a href="#how" className="transition-colors hover:text-ink">{item}</a></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 border-t border-hair px-5 py-4 text-2xs text-ink-faint">
          <span>© {new Date().getFullYear()} ARI</span>
          <span className="flex items-center gap-2">
            <Mark size={12} className="text-ink-faint" />
            <span>no marketing claim in this product is one the code does not make</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
