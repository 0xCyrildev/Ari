'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowUpRight, Check, Menu, Moon, Sun, X } from 'lucide-react'
import { useTheme } from 'next-themes'

// One array, seven rows. `ask` is the question the checkpoint actually puts to a request, and
// `value`/`why` is what the sample request got when it passed through — so the pipeline and its
// receipt are taught once, in the same column, instead of in two sections that had already
// started to disagree. The numbers are the console's own sample tenant, row for row: the same
// agent, the same policy version (`treasury-payments`, v8), the same 4,200 USDC payment to
// Brightline at 0x3f2a1b0c…1a2b3c. Nothing here is a second set of figures about a second
// fictional tenant.
const checkpoints = [
  { num: '01', title: 'AGENT', ask: 'Is this a known agent with a live credential and a bound wallet?', time: '12:41:02', value: 'treasury-agent', why: 'credential live · wallet bound' },
  { num: '02', title: 'INTENT', ask: 'Is the request a well-formed payment: asset, amount, recipient, chain?', time: '12:41:02', value: '4,200 USDC', why: 'transfer · ethereum · recipient 0x3f2a…1a2b3c' },
  { num: '03', title: 'POLICY', ask: 'Do the compiled rules allow this exact action?', time: '12:41:03', value: 'ALLOW', why: 'transfers.recipients · perTransaction ≤ 10,000 · perDay ≤ 25,000' },
  { num: '04', title: 'RISK', ask: 'Does it look unlike this agent — by size, recipient, hour or frequency?', time: '12:41:03', value: 'LOW', why: 'amount within baseline · known recipient · score 0.12' },
  { num: '05', title: 'APPROVAL', ask: 'If policy says so, has a human decided in time?', time: '12:41:03', value: 'NOT REQUIRED', why: '4,200 is below the 5,000 line · the same vendor at 8,500 stops here and waits' },
  { num: '06', title: 'SIGN', ask: 'Is there a valid, unspent ticket for these exact bytes?', time: '12:41:03', value: 'TICKET MINTED', why: 'single use · 60s · sealed digest' },
  // Row 07 is drawn differently for a reason. The signer's answer is that a provider accepted
  // a ticket; whether anything landed on a chain is a separate question this build cannot
  // answer, and a row that reads "sent" would be the one lie the page could not take back.
  { num: '07', title: 'EXECUTE', ask: 'Did a provider accept the ticket? Acceptance is not settlement.', time: '12:41:08', value: 'ACCEPTED', why: 'a provider took the ticket — settlement is a separate question', soft: true },
]

// The nine signals `@ari/risk-engine` actually weights, read off `WEIGHTS`. `NEW_CHAIN`,
// `NEW_ASSET` and `NEW_CONTRACT` are excluded on purpose: they are in the vocabulary the
// policy language can name and are not in the set the engine can compute, so a page that
// lists them is advertising a check that silently never runs.
const riskSignals = [
  'NO BEHAVIOUR BASELINE',
  'AMOUNT ABOVE BASELINE',
  'AMOUNT 8× BASELINE',
  'NEW RECIPIENT',
  'RECIPIENT VELOCITY CHANGE',
  'BEHAVIOUR PROFILE DRIFT',
  'DORMANT AGENT RESUMED',
  'OUT OF HOURS',
  'NEAR POLICY BOUNDARY',
]

// `SupportedChain` in packages/schemas names two chains. Everything past that line is
// architecture, not shipping support, and the labels below say which is which — including
// Ethereum, where what ships is the authorization path, not a settled payment.
const primaryNetworks = [
  ['Ethereum', 'ethereum', 'AUTHORIZATION PATH · CANDIDATE MODEL'],
  ['Bitcoin', 'bitcoin', 'SCHEMA · NO SIMULATION ADAPTER'],
  ['Base', 'base', 'EVM — NOT SHIPPED'],
  ['Arbitrum', 'arbitrum', 'EVM — NOT SHIPPED'],
  ['Optimism', 'optimism', 'EVM — NOT SHIPPED'],
  ['Polygon', 'polygon', 'EVM — NOT SHIPPED'],
  ['Avalanche', 'avalanche', 'EVM — NOT SHIPPED'],
]

/**
 * The marquee carries the vocabulary the API returns, not a technology wishlist.
 *
 * It used to name `2PC-MPC`, `SUI` and `SOLANA`, which is the opposite of everything else on
 * this page: an honest build advertised as supporting the sealing scheme and the chains it
 * does not have. Every token below is a string a route emits.
 */
const marquee = [
  'ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL', 'APPROVAL_PENDING', 'TICKET_MINTED',
  'RECIPIENT_NOT_IN_ALLOWLIST', 'AMOUNT_EXCEEDS_DAILY_LIMIT', 'NO_BEHAVIOUR_BASELINE',
  'POLICY_VERSION_FROZEN', 'SINGLE USE',
]

function Reveal({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      className={`reveal ${className}`}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.12 }}
      transition={{ duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}



function ButtonLink({ children, light = false, href = '#contact' }: { children: React.ReactNode; light?: boolean; href?: string }) {
  return <a href={href} className={`button-link ${light ? 'button-link-light' : ''}`}>{children}<ArrowUpRight data-icon="inline-end" /></a>
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const isDark = mounted && resolvedTheme === 'dark'

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? <Sun /> : <Moon />}
      <span>{isDark ? 'LIGHT' : 'DARK'}</span>
    </button>
  )
}

export default function Page() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeStage, setActiveStage] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [waitlistState, setWaitlistState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')

  async function joinWaitlist(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setWaitlistState('loading')
    try {
      const response = await fetch('/api/waitlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
      if (!response.ok) throw new Error('waitlist request failed')
      setWaitlistState('success')
      setEmail('')
    } catch {
      setWaitlistState('error')
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => setIsLoading(false), 1650)
    return () => window.clearTimeout(timeout)
  }, [])

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add('is-visible')), { threshold: 0.12 })
    document.querySelectorAll('.reveal, .section-reveal').forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <AnimatePresence>
        {isLoading && (
          <motion.div
            className="page-loader"
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.55, ease: 'easeInOut' }}
            aria-label="Loading ARI"
            role="status"
          >
            {/* The mark, the word and the bar animate in CSS, not here. Their entrance is the
                thing a visitor sees while the page is still loading, and a framer-motion
                `initial` state only exists once React has hydrated — so on a phone, where
                hydration is the slow part, the loader rendered as a black rectangle with
                nothing on it. Same durations, same easing, same order; now they run from the
                first paint. */}
            <img className="loader-mark" src="/ari-logo.svg" alt="ARI" />
            <strong className="loader-wordmark">ARI</strong>
            <span className="loader-bar" />
          </motion.div>
        )}
      </AnimatePresence>
      <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="ARI home"><img src="/ari-logo.svg" alt="ARI" /></a>
        <nav className={menuOpen ? 'nav-open' : ''} aria-label="Main navigation">
          <details className="nav-group"><summary>PRODUCT</summary><div className="nav-group-items"><a href="#build-state">WHAT THIS IS</a><a href="#control">CONTROL PLANE</a><a href="#networks">NETWORKS</a><a href="#policy">POLICY</a><a href="#audit">AUDIT TRAIL</a><a href="#sdk">BUILD ON THIS</a></div></details>
          <a href="/docs">DOCS</a><a href="/console">CONSOLE</a>
          <ThemeToggle />
          <ButtonLink href="/console">OPEN THE CONSOLE</ButtonLink>
        </nav>
        <button className="menu-button" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? 'Close menu' : 'Open menu'}>{menuOpen ? <X /> : <Menu />}</button>
      </header>

      <section id="top" className="hero section-pad">
        <div className="hero-atmosphere" aria-hidden="true">
          <motion.div className="hero-orb hero-orb-one" animate={{ x: [0, 24, 0], y: [0, -18, 0], scale: [1, 1.08, 1] }} transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }} />
          <motion.div className="hero-orb hero-orb-two" animate={{ x: [0, -18, 0], y: [0, 22, 0] }} transition={{ duration: 11, repeat: Infinity, ease: 'easeInOut' }} />
          <div className="hero-grid-lines" />
        </div>
        <div className="hero-grid">
          <div className="hero-copy">
            <Reveal><p className="eyebrow">AI AGENT AUTHORIZATION INFRASTRUCTURE <span>↗</span></p></Reveal>
            <Reveal className="delay-1"><h1><span className="hero-line">FINANCIAL</span><span className="hero-line"><em>CONTROL</em></span><span className="hero-line">FOR AUTONOMOUS</span><span className="hero-line">AGENTS.</span></h1></Reveal>
            <Reveal className="delay-2"><p className="hero-description">Agents may request a payment. Policy allows, denies, or asks a human. Signing only happens with a single-use ticket.</p></Reveal>
            <Reveal className="delay-3"><div className="button-row"><ButtonLink href="/console">OPEN THE CONSOLE</ButtonLink><ButtonLink light href="/docs">READ THE DOCS</ButtonLink><a className="text-link" href="#build-state">WHAT WORKS IN THIS BUILD →</a></div></Reveal>
          </div>
          <Reveal className="hero-terminal delay-2"><div className="terminal-head"><span>ARI / AUTHORIZATION LAYER</span><span>SAMPLE INTENT</span></div><div className="terminal-body"><div className="terminal-line"><span className="muted">agent</span><span>treasury-agent</span></div><div className="terminal-line"><span className="muted">request</span><span>transfer(4200000000, 6dp)</span></div><div className="terminal-divider" /><div className="terminal-line"><span className="accent">status</span><strong>AWAITING POLICY</strong></div><div className="terminal-bracket">[ <b>intent</b> → <b>policy</b> → <b>risk</b> → <b>sign</b> ]</div></div></Reveal>
        </div>
        <div className="hero-meta"><span>AGENT</span><i /> <span>INTENT</span><i /> <span>POLICY</span><i /> <span>RISK</span><i /> <span>APPROVAL</span><i /> <span>SIGN</span><i /> <span>EXECUTE</span></div>
      </section>

      <section id="build-state" className="isnot section-pad dark-section section-reveal"><Reveal><p className="section-kicker">00 / WHAT THIS IS</p><div className="isnot-grid"><div><b>IS</b><p>A policy engine that answers one question about one payment: allow it, refuse it, or ask a human. Three words, and there is no fourth.</p></div><div><b>IS</b><p>A sealed, single-use ticket between the decision and the signature, verified by a second process that re-derives the bytes it was given.</p></div><div><b>IS NOT</b><p>A wallet, a custodian, or a signing provider you would trust. The signer in this build is a mock that reports itself untrustworthy.</p></div><div><b>IS NOT</b><p>Settlement. Nothing here confirms that anything landed on a chain, and the lifecycle stops before it would claim to.</p></div></div></Reveal></section>


      <section id="control" className="section-pad control-section dark-section section-reveal"><div className="split-heading"><Reveal><p className="section-kicker">01 / CONTROL PLANE</p><h2 className="section-lead">THE PERMISSION LAYER<br /><span>FOR MONEY THE AGENT DOES NOT OWN.</span></h2></Reveal><Reveal className="delay-1"><p className="side-copy">One wedge, end to end. <code>treasury-agent</code> may send USDC on Ethereum to vendors on an allowlist, up to 5,000 USDC per transaction unattended. Above that a human must approve. Anything else is DENY. Signing happens only with a single-use ticket, and nothing here claims a provider settled it.</p></Reveal></div><div className="architecture"><div className="arch-untrusted"><span>UNTRUSTED</span><b>AI MODEL</b><b>TOOLS</b><b>PROMPTS</b><b>EXTERNAL DATA</b></div><div className="arch-arrow">↓</div><div className="arch-ari"><span>ARI</span><b>POLICY</b><b>VERIFICATION</b><b>RISK</b><b>APPROVAL</b><em>ALLOW · DENY · REQUIRE_HUMAN_APPROVAL</em></div><div className="arch-arrow">↓</div><div className="arch-execution"><span>EXECUTION</span><b>SIGN</b><b>TRANSACTION</b><em>MOCK PROVIDER · NO SETTLEMENT CLAIM</em></div></div><div className="checkpoint-layout"><div className="checkpoint-list" aria-label="The seven checkpoints, and what the sample request got at each">{checkpoints.map((row, index) => <motion.button key={row.title} layout type="button" className={`pipeline-stage ${activeStage === index ? 'active' : ''} ${row.soft ? 'soft' : ''}`} onMouseEnter={() => setActiveStage(index)} onFocus={() => setActiveStage(index)} onClick={() => setActiveStage(index)} initial={false} animate={{ opacity: activeStage === index ? 1 : 0.68 }} transition={{ duration: 0.3 }}><span className="stage-num">{row.num}</span><span className="stage-content"><strong>{row.title}</strong><small>{row.ask}</small><AnimatePresence initial={false}>{activeStage === index && <motion.small className="stage-why" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>{row.why}</motion.small>}</AnimatePresence></span><span className={`stage-value ${row.soft ? 'soft' : ''}`}>{row.value}</span></motion.button>)}</div><Reveal className="checkpoint-foot"><p className="band-label">SAMPLE FIGURES FROM THE CONSOLE'S SAMPLE TENANT</p><small>The words in the right column are what the API returns. The numbers are a request that was never made. Nothing in this build moves funds, and the last row is the signer's answer about a ticket, not a chain.</small></Reveal></div><Reveal className="risk-band"><div><p className="band-label">THE NINE SIGNALS THE ENGINE WEIGHTS</p><div className="risk-signals">{riskSignals.map((signal, i) => <span className="risk-signal" key={signal}><b>{String(i + 1).padStart(2, '0')}</b>{signal}</span>)}</div></div><p className="risk-note">Risk is advisory. It cannot override a DENY and it cannot mint a ticket — it can only raise a decision or annotate one. This build has no price feed, and an agent with no history scores <b>NO_BEHAVIOUR_BASELINE</b>: missing evidence escalates, it never passes silently.</p></Reveal></section>

      <section id="networks" className="section-pad networks-section section-reveal"><Reveal><p className="section-kicker">02 / NETWORKS</p><div className="networks-intro"><h2 className="section-lead">ONE DECISION MODEL.<br /><span>ONE CHAIN IT RUNS ON TODAY.</span></h2><p className="wide-copy">The policy language, the ticket and the audit chain are the same on every chain. The adapter that turns a decision into a signed transaction is not, and only one exists in this repository.</p></div></Reveal><div className="network-strip reveal" aria-label="Networks ARI names today"><div className="network-track">{/* No per-item `whileInView`: the strip clips its own overflow, so a cell whose turn passed while the section was off-screen was never reported as intersecting and stayed blank. The section fades as one. */}{[...primaryNetworks, ...primaryNetworks].map(([name, slug, status], index) => <a className="network-item" href="#sdk" key={`${name}-${index}`} aria-label={`${name}, ${status}`}><span className="network-identity"><strong>{name}</strong></span><small>{status}</small></a>)}</div></div><p className="network-footnote">Two chains are in the schema today: Ethereum, which has a candidate model, address grammar, ERC-20 assets and a simulation adapter, and Bitcoin, which has address grammars and signature triples but no simulation adapter yet. An EVM chain needs one enum entry, its own fee semantics and a sequencer-uptime rule before it is honest about dry runs. Solana, Sui, Aptos, Cardano, TON and XRP Ledger are not supported: each needs an address grammar, a candidate model and a simulation adapter that does not exist in this repository.</p></section>

      <section id="policy" className="section-pad policy-section section-reveal"><div className="split-heading"><Reveal><p className="section-kicker">03 / POLICY ENGINE</p><h2 className="section-lead">DEFINE WHAT<br /><span>AGENTS CAN DO.</span></h2></Reveal><Reveal className="delay-1"><p className="side-copy">One document, bound to one wallet version. It decides, it escalates, and it refuses. It cannot grant anything at runtime that it did not grant when it compiled.</p></Reveal></div><div className="policy-grid reveal"><pre>{`meta:\n  name: treasury-payments    # v8, ACTIVE\n\ntarget:\n  walletId: wal_01a0e70e…\n  authorityMode: delegated\n\npermissions.transfers:\n  chains: [ethereum]\n  assets: [{ symbol: USDC, decimals: 6 }]\n  recipients:\n    mode: allowlist\n    addresses: [0x3f2a1b0c…]\n  perTransaction: { maxRaw: "10000000000", unit: usdc-6dp }\n  perDay:         { maxRaw: "25000000000", unit: usdc-6dp }\n  maxTransactionsPerHour: 20\n\nescalation.humanApproval:\n  requiredWhen:\n    - { op: amount_gt, raw: "5000000000" }\n    - { op: risk_gte, level: MEDIUM }\n    - { op: recipient_first_seen_within_days, days: 30 }\n  approverRoles: [owner, approver]\n  quorum: 1\n\nfallback:\n  onUnknownTransaction: deny\n  onEvaluationError: deny\n  onRiskUnavailable: escalate`}</pre><div className="decision"><p>THE SAME DOCUMENT, THREE ANSWERS</p><div className="verdict"><strong><Check /> ALLOW</strong><span>4,200 USDC · Brightline, an allowlisted vendor, under every limit</span><span>transfers.recipients · perTransaction · perDay</span></div><div className="verdict"><strong>REQUIRE_HUMAN_APPROVAL</strong><span>8,500 USDC · the same vendor, above the unattended line</span><span>escalation.humanApproval · amount_gt 5,000 · one vote</span></div><div className="verdict"><strong className="verdict-stop"><X /> DENY</strong><span>3,100 USDC · a recipient nobody listed</span><span>RECIPIENT_NOT_IN_ALLOWLIST · no ticket is minted</span></div><p className="verdict-foot">Every figure above is a row in the console's sample tenant. Amounts are raw <code>bigint</code> units — 10000000000 is 10,000 USDC at six decimals, never a float.</p></div></div></section>

      <section id="audit" className="section-pad audit-section section-reveal"><div className="split-heading"><Reveal><p className="section-kicker">04 / AUDIT TRAIL</p><h2 className="section-lead">EVERY DECISION<br /><span>LEAVES A RECEIPT.</span></h2></Reveal><Reveal className="delay-1"><p className="side-copy">The receipt is a row in the same Postgres that holds the money. It is append-only because the role the API connects as cannot update or delete it, and it is a chain because every row carries the hash of the row before it.</p></Reveal></div><Reveal className="receipt-band"><div><b>WHAT ONE ROW HOLDS</b><p><code>seq</code> <code>prev_hash</code> <code>hash</code> <code>actor</code> <code>actor_type</code> <code>event_type</code> <code>resource</code> <code>decision</code> <code>reason_codes</code> <code>metadata</code></p></div><div><b>THE SAMPLE'S END STATE</b><p className="receipt-state">TICKET MINTED<span> · </span>NOT SETTLED</p><small>A provider took the ticket. Whether anything landed on a chain is a question this build does not answer.</small></div><div><b>HOW TO CHECK IT</b><p><code>ari audit tail --verify</code> recomputes every hash from the first row. <code>GET /v1/audit/events</code> is scoped to one tenant by row security: another organisation's trail is not a smaller number, it is nothing.</p></div></Reveal></section>

      <section id="sdk" className="section-pad sdk-section section-reveal"><div className="split-heading"><Reveal><p className="section-kicker">05 / BUILD ON THIS</p><h2 className="section-lead">THREE CALLS<br /><span>FOR AN AGENT.</span><br />ONE IT CANNOT MAKE.</h2></Reveal><Reveal className="delay-1"><p className="side-copy">A workspace package and a CLI today, not a registry package: <code>@ari/client</code> is fetched from this repository, it has no <code>sign()</code>, and nothing in it can approve its own request.</p></Reveal></div><Reveal className="code-window"><div className="window-bar"><span /> <span /> <span /><label>terminal</label></div><pre><code><span className="muted"># @ari/client — WORKSPACE PACKAGE · NOT ON NPM</span>{`\n`}<span className="muted">$</span> ari policy apply treasury.json --activate{`\n`}<span className="muted">$</span> ari agent credential payer --ttl 1h<span className="muted">        # the bearer prints once, then never again</span>{`\n`}<span className="muted">$</span> ari audit tail --verify<span className="muted">                   # the hash chain, recomputed</span>{`\n\n`}<span className="muted"># the three calls an agent makes, in order</span>{`\n`}<span className="accent">POST</span> /v1/transactions/evaluate<span className="muted">   ALLOW · REQUIRE_HUMAN_APPROVAL · DENY</span>{`\n`}<span className="accent">POST</span> /v1/transactions/authorize<span className="muted">  the same, recorded, with an idempotency key</span>{`\n`}<span className="accent">GET</span> /v1/transactions/{'{id}'}<span className="muted">          the state, the reason codes, the receipt</span>{`\n\n`}<span className="muted"># the call an agent credential cannot make</span>{`\n`}<span className="accent">POST</span> /v1/approvals/{'{id}'}/decisions<span className="muted"> a human, with a </span><span className="success">ucrd_</span><span className="muted"> credential</span>{`\n`}<span className="muted">#</span> scopes, limits and errors: /docs<span className="muted"> · the same routes by hand: /console</span></code></pre></Reveal></section>

      <div className="marquee" aria-label="The vocabulary Ari returns"><div>{[...marquee, ...marquee].map((word, index) => <span key={`${word}-${index}`}>{word} <i>✳</i></span>)}</div></div>

      <section id="contact" className="final section-pad section-reveal"><Reveal><p className="section-kicker">ARI / WHAT IS REAL TODAY</p><h2>LET AGENTS ACT.<br /><span>KEEP CONTROL.</span></h2><p className="wide-copy">Autonomy is inevitable. Unrestricted access is optional. What is real today: the policy engine, the ledger, the risk plane, the audit chain, the approvals loop and the console, covered by a suite that runs against a real Postgres. What is not: a live signing provider. The signer in this build is a mock that reports itself untrustworthy, and Ari will not dress a mock signature up as a settled payment.</p><div className="button-row"><ButtonLink href="/console">OPEN THE CONSOLE</ButtonLink><ButtonLink light href="/docs">READ THE DOCS</ButtonLink></div></Reveal><Reveal className="waitlist-card delay-1"><div><p className="section-kicker">06 / PRIVATE BETA</p><h3>JOIN THE<br /><span>WAITLIST.</span></h3><p>There is no hosted Ari yet. The engine, the console, the CLI and the docs run today on your own infrastructure, with your own keys and your own database. Join the list if you want that operated for you.</p></div><form onSubmit={joinWaitlist}><label htmlFor="waitlist-email">WORK EMAIL</label><div className="waitlist-input"><input id="waitlist-email" type="email" required value={email} onChange={(event) => { setEmail(event.target.value); setWaitlistState('idle') }} placeholder="you@company.com" /><button type="submit" disabled={waitlistState === 'loading'} aria-label="Join waitlist">{waitlistState === 'loading' ? '...' : <ArrowUpRight />}</button></div><small aria-live="polite">{waitlistState === 'success' ? 'You are on the list. We will be in touch.' : waitlistState === 'error' ? 'Something went wrong. Try again.' : 'No noise. Just signal.'}</small></form></Reveal></section>
      <section className="origin-strip" aria-labelledby="origin-heading"><p id="origin-heading">BUILT FROM NIGERIA. <span>DESIGNED FOR THE WORLD.</span></p><small>The origin is a fact about who wrote this. The control plane is the product, and the difference between those two claims is why this line sits above the footer rather than second on the page.</small></section>
      <footer><a className="brand" href="#top"><img src="/ari-logo.svg" alt="ARI" /></a><span>© 2026 ZEROXYCIRIL</span><span>AUTHORIZATION INFRASTRUCTURE FOR AUTONOMOUS AGENTS</span><span className="footer-note">No domain yet, and no mailbox behind this one — open an issue on the repository.</span><div className="social-links" aria-label="Links"><a href="https://github.com/0xCyrildev/Ari" target="_blank" rel="noreferrer" aria-label="Source repository" style={{ width: "auto", padding: "0 10px", font: "10px monospace", letterSpacing: ".14em" }}>SOURCE</a></div><a href="#top">BACK TO TOP ↑</a></footer>
      </main>
    </>
  )
}
