'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowUpRight, Check, Menu, Moon, Sun, X } from 'lucide-react'
import { useTheme } from 'next-themes'

const stages = [
  ['01', 'AGENT', 'Is this a known agent with a live credential and a bound wallet?'],
  ['02', 'INTENT', 'Is the request a well-formed payment: asset, amount, recipient, chain?'],
  ['03', 'POLICY', 'Do the compiled rules allow this exact action?'],
  ['04', 'RISK', 'Does it look unlike this agent — by size, recipient, hour or frequency?'],
  ['05', 'APPROVAL', 'If policy says so, has a human decided in time?'],
  ['06', 'SIGN', 'Is there a valid, unspent ticket for these exact bytes?'],
  // Step 07 is drawn differently for a reason. The signer's answer is that a provider
  // accepted a ticket; whether anything landed on a chain is a separate question this build
  // cannot answer, and a row that reads "sent" would be the one lie the page could not take
  // back.
  ['07', 'EXECUTE', 'Did a provider accept the ticket? Acceptance is not settlement.'],
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

// `why` is the part a receipt is for: the outcome word alone tells you what happened, the
// rule tells you which line of a document caused it. Kept off the `strong` so the row stays
// readable at phone width, where the value column is about 170px.
const trace = [
  { time: '12:41:02', label: 'AGENT', value: 'treasury-agent', why: 'credential live · wallet bound' },
  { time: '12:41:02', label: 'INTENT', value: '4,200 USDC', why: 'transfer · ethereum · recipient 0x3f2a…1a2b3c' },
  { time: '12:41:03', label: 'POLICY', value: 'ALLOW', why: 'transfers.recipients · perTransaction ≤ 5,000 · perDay ≤ 25,000' },
  { time: '12:41:03', label: 'RISK', value: 'LOW', why: 'amount within baseline · known recipient' },
  { time: '12:41:03', label: 'APPROVAL', value: 'NOT REQUIRED', why: 'below the amount_gt line' },
  { time: '12:41:03', label: 'SIGN', value: 'TICKET MINTED', why: 'single use · 60s · sealed digest' },
  { time: '12:41:08', label: 'EXECUTION', value: 'ACCEPTED', why: 'a provider took the ticket — settlement is a separate question' },
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
          <a href="#control">CONTROL PLANE</a><a href="#policy">POLICY</a><a href="#sdk">SDK</a><a href="#audit">AUDIT</a><a href="/docs">DOCS</a><a href="/console">CONSOLE</a>
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
            <Reveal className="delay-3"><div className="button-row"><ButtonLink href="/console">OPEN THE CONSOLE</ButtonLink><ButtonLink light href="/docs">READ THE DOCS</ButtonLink></div></Reveal>
          </div>
          <Reveal className="hero-terminal delay-2"><div className="terminal-head"><span>ARI / AUTHORIZATION LAYER</span><span>SAMPLE INTENT</span></div><div className="terminal-body"><div className="terminal-line"><span className="muted">agent</span><span>treasury-agent</span></div><div className="terminal-line"><span className="muted">request</span><span>transfer(4200000, 6dp)</span></div><div className="terminal-divider" /><div className="terminal-line"><span className="accent">status</span><strong>AWAITING POLICY</strong></div><div className="terminal-bracket">[ <b>intent</b> → <b>policy</b> → <b>risk</b> → <b>sign</b> ]</div></div></Reveal>
        </div>
        <div className="hero-meta"><span>AGENT</span><i /> <span>INTENT</span><i /> <span>POLICY</span><i /> <span>RISK</span><i /> <span>APPROVAL</span><i /> <span>SIGN</span><i /> <span>EXECUTE</span></div>
      </section>

      <section className="thesis section-pad dark-section section-reveal"><Reveal><p className="section-kicker">THE THESIS / 00</p><h2>AUTONOMOUS AGENTS.<br /><span>CONTROLLED CAPITAL.</span></h2><p className="wide-copy">ARI turns autonomous financial actions into policy-controlled, auditable transactions. The model can propose. ARI decides.</p></Reveal></section>

      <section className="africa-section section-pad dark-section section-reveal" aria-labelledby="africa-heading">
        <div className="africa-atmosphere" aria-hidden="true"><motion.div className="africa-glow africa-glow-one" animate={{ x: [0, 80, 0], y: [0, -36, 0], scale: [1, 1.14, 1] }} transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }} /><motion.div className="africa-glow africa-glow-two" animate={{ x: [0, -60, 0], y: [0, 42, 0], scale: [1, 0.9, 1] }} transition={{ duration: 17, repeat: Infinity, ease: 'easeInOut' }} /><div className="africa-map-wrap"><img className="africa-map" src="/africa-map.png" alt="" /><span className="city-marker city-lagos"><i className="city-dot" /><b>LAGOS</b></span><span className="city-marker city-abuja"><i className="city-dot" /><b>ABUJA</b></span><span className="city-marker city-accra"><i className="city-dot" /><b>ACCRA</b></span><span className="city-marker city-nairobi"><i className="city-dot" /><b>NAIROBI</b></span><span className="city-marker city-cairo"><i className="city-dot" /><b>CAIRO</b></span><span className="city-marker city-johannesburg"><i className="city-dot" /><b>JOHANNESBURG</b></span></div><div className="africa-scanlines" /></div>
        <div className="africa-content">
          <Reveal><p className="section-kicker">04 — AFRICA</p><h2 id="africa-heading">BUILT FROM AFRICA.<br /><span>BUILT FOR WHAT&apos;S NEXT.</span></h2><p className="wide-copy">Africa is producing a new generation of builders, businesses, and internet-native economies. ARI is infrastructure for that future — giving autonomous agents controlled access to capital without giving up control.</p></Reveal>
          <Reveal className="africa-details delay-1"><p className="africa-origin">BUILT FROM NIGERIA. <span>DESIGNED FOR THE WORLD.</span></p><div className="africa-pillars"><div><b>01</b><strong>AFRICAN BUILDERS</strong><p>A new generation building globally relevant technology.</p></div><div><b>02</b><strong>GLOBAL CAPITAL</strong><p>Autonomous software will move capital across borders.</p></div><div><b>03</b><strong>TRUSTED INFRASTRUCTURE</strong><p>ARI provides the authorization layer between agents and money.</p></div></div></Reveal>
          <Reveal className="africa-finale delay-2"><p>FROM AFRICA,<br /><span>FOR THE WORLD.</span></p><small>NIGERIA → AFRICA → GLOBAL</small></Reveal>
        </div>
      </section>

      <section id="control" className="section-pad control-section section-reveal"><div className="split-heading"><Reveal><p className="section-kicker">01 / CONTROL PLANE</p><h2>THE PERMISSION<br /><span>LAYER FOR AI.</span></h2></Reveal><Reveal className="delay-1"><p className="side-copy">ARI sits between autonomous agents and financial execution. Every action passes through a programmable authorization layer before it can reach the signing infrastructure.</p></Reveal></div><motion.div className="architecture reveal" initial={{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }} whileInView={{ opacity: 1, clipPath: 'inset(0 0% 0 0)' }} viewport={{ once: true, amount: 0.2 }} transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}><div className="arch-untrusted"><span>UNTRUSTED</span><b>AI MODEL</b><b>TOOLS</b><b>PROMPTS</b><b>EXTERNAL DATA</b></div><div className="arch-arrow">↓</div><div className="arch-ari"><span>ARI</span><b>POLICY</b><b>VERIFICATION</b><b>RISK</b><b>APPROVAL</b></div><div className="arch-arrow">↓</div><div className="arch-execution"><span>EXECUTION</span><b>SIGN</b><b>TRANSACTION</b></div></motion.div></section>

      <section className="pipeline-section section-pad dark-section section-reveal"><div className="sticky-label"><p className="section-kicker">02 / TRANSACTION PIPELINE</p><h2>EVERY ACTION<br /><span>HAS A CHECKPOINT.</span></h2><p className="side-copy">A controlled path from agent intent to financial execution. No shortcuts. No implicit trust.</p></div><div className="pipeline-list" aria-label="Transaction pipeline stages">{stages.map(([num, title, copy], index) => <motion.button key={title} layout type="button" className={`pipeline-stage ${activeStage === index ? 'active' : ''}`} onMouseEnter={() => setActiveStage(index)} onFocus={() => setActiveStage(index)} onClick={() => setActiveStage(index)} initial={false} animate={{ opacity: activeStage === index ? 1 : 0.62 }} transition={{ duration: 0.3 }}><span className="stage-num">{num}</span><span className="stage-content"><strong>{title}</strong><AnimatePresence initial={false}>{activeStage === index && <motion.small initial={{ opacity: 0, height: 0, y: 8 }} animate={{ opacity: 1, height: 'auto', y: 0 }} exit={{ opacity: 0, height: 0, y: 8 }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}>{copy}</motion.small>}</AnimatePresence></span><span className="stage-mark">{activeStage === index ? '↗' : num}</span></motion.button>)}</div></section>

      <section className="section-pad networks-section section-reveal"><Reveal><p className="section-kicker">03 / NETWORKS</p><div className="networks-intro"><h2>ONE DECISION MODEL.<br /><span>ONE CHAIN IT RUNS ON TODAY.</span></h2><p className="wide-copy">The policy language, the ticket and the audit chain are the same on every chain. The adapter that turns a decision into a signed transaction is not, and only one exists in this repository.</p></div></Reveal><div className="network-strip reveal" aria-label="Networks ARI names today"><div className="network-track">{[...primaryNetworks, ...primaryNetworks].map(([name, slug, status], index) => <motion.a className="network-item" href="#sdk" key={`${name}-${index}`} aria-label={`${name}, ${status}`} initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.2 }} transition={{ duration: 0.5, delay: (index % primaryNetworks.length) * 0.06, ease: [0.22, 1, 0.36, 1] }}><span className="network-identity"><strong>{name}</strong></span><small>{status}</small></motion.a>)}</div></div><p className="network-footnote">Two chains are in the schema today: Ethereum, which has a candidate model, address grammar, ERC-20 assets and a simulation adapter, and Bitcoin, which has address grammars and signature triples but no simulation adapter yet. An EVM chain needs one enum entry, its own fee semantics and a sequencer-uptime rule before it is honest about dry runs. Solana, Sui, Aptos, Cardano, TON and XRP Ledger are not supported: each needs an address grammar, a candidate model and a simulation adapter that does not exist in this repository.</p></section>

      <section id="policy" className="section-pad policy-section section-reveal"><div className="split-heading"><Reveal><p className="section-kicker">04 / POLICY ENGINE</p><h2>DEFINE WHAT<br /><span>AGENTS CAN DO.</span></h2></Reveal><Reveal className="delay-1"><p className="side-copy">One document, bound to one wallet version. It decides, it escalates, and it refuses. It cannot grant anything at runtime that it did not grant when it compiled.</p></Reveal></div><div className="policy-grid reveal"><pre>{`meta:\n  name: treasury-payments\n\ntarget:\n  walletId: wal_01a0e70e…\n  authorityMode: delegated\n\npermissions.transfers:\n  chains: [ethereum]\n  assets: [{ symbol: USDC, decimals: 6 }]\n  recipients:\n    mode: allowlist\n    addresses: [0x3f2a1b0c…]\n  perTransaction: { maxRaw: \"5000000000\", unit: usdc-6dp }\n  perDay:         { maxRaw: \"25000000000\", unit: usdc-6dp }\n\nescalation.humanApproval:\n  requiredWhen: [{ op: amount_gt, raw: \"1000000000\" }]\n  quorum: 1\n\nfallback:\n  onUnknownTransaction: deny\n  onRiskUnavailable: escalate`}</pre><div className="decision"><p>THE SAME DOCUMENT, THREE ANSWERS</p><div className="verdict"><strong><Check /> ALLOW</strong><span>420 USDC · an allowlisted vendor, under every limit</span><span>transfers.recipients · perTransaction · perDay</span></div><div className="verdict"><strong>REQUIRE_HUMAN_APPROVAL</strong><span>4,200 USDC · the same vendor, above the unattended line</span><span>escalation.humanApproval · amount_gt $1,000 · one vote</span></div><div className="verdict"><strong className="verdict-stop"><X /> DENY</strong><span>420 USDC · a recipient nobody listed</span><span>RECIPIENT_NOT_IN_ALLOWLIST · no ticket is minted</span></div><p className="verdict-foot">Amounts are raw <code>bigint</code> units — 5000000000 is 5,000 USDC at six decimals, never a float.</p></div></div></section>

      <section className="section-pad risk-section dark-section section-reveal"><Reveal><p className="section-kicker">05 / RISK ENGINE</p><h2>KNOW WHEN<br /><span>BEHAVIOR CHANGES.</span></h2></Reveal><div className="risk-layout"><div className="risk-signals">{riskSignals.map((signal, i) => <Reveal key={signal} className={`risk-signal delay-${i % 4}`}><span>{String(i + 1).padStart(2, '0')}</span>{signal}<b>+</b></Reveal>)}</div><Reveal className="risk-result"><p>COMPOSITE DECISION</p><div className="risk-level"><span>LOW</span><i /><span className="muted">MEDIUM</span><i /><span className="muted">HIGH</span></div><strong>LOW RISK</strong><small>Signals match expected agent behavior.</small><p className="risk-note">Risk is advisory. It cannot override a DENY and it cannot mint a ticket — it can only raise a decision or annotate one. This build has no price feed, and an agent with no history scores <b>NO_BEHAVIOUR_BASELINE</b>: missing evidence escalates, it never passes silently.</p></Reveal></div></section>

      <section id="sdk" className="section-pad sdk-section section-reveal"><div className="split-heading"><Reveal><p className="section-kicker">06 / DEVELOPER EXPERIENCE</p><h2>ONE AUTHORIZATION<br /><span>LAYER. EVERY AGENT.</span></h2></Reveal><Reveal className="delay-1"><p className="side-copy">Drop ARI into the execution path. Keep your agent architecture. Add controlled financial access.</p></Reveal></div><Reveal className="code-window"><div className="window-bar"><span /> <span /> <span /><label>terminal</label></div><pre><code><span className="muted"># @ari/client is a workspace package: not on npm yet, and it has no sign()</span>{`\n`}<span className="muted">$</span> ari init{`\n`}<span className="muted">$</span> ari agent create payer{`\n`}<span className="muted">$</span> ari wallet create --name operations{`\n`}<span className="muted">$</span> ari policy apply treasury.json --activate{`\n\n`}<span className="success">✓ agent created · policy activated · grant issued</span>{`\n`}<span className="muted">$</span> ari agent credential payer --ttl 1h<span className="muted">   # the bearer prints once, then never again</span>{`\n`}<span className="muted">$</span> ari audit tail --verify<span className="muted">            # the hash chain, recomputed</span>{`\n`}<span className="muted">#</span> or drive the same routes from the console: /console{`\n`}<span className="muted">#</span> and the contract, the scopes and the limits: /docs</code></pre></Reveal></section>

      <section id="audit" className="section-pad audit-section dark-section section-reveal"><div className="split-heading"><Reveal><p className="section-kicker">07 / AUDIT TRAIL</p><h2>EVERY DECISION<br /><span>LEAVES A RECEIPT.</span></h2></Reveal><Reveal className="delay-1"><p className="side-copy">A complete, readable record of what the agent asked for, why it was allowed, and what finally executed.</p></Reveal></div><div className="trace reveal">{trace.map((row, index) => <div className="trace-row" key={row.label}><time>{row.time}</time><div><span>{row.label}</span><strong className={row.value === 'ALLOW' || row.value === 'LOW' || row.value === 'NOT REQUIRED' ? 'success' : ''}>{row.value}</strong><em>{row.why}</em></div><i>{index < trace.length - 1 ? '↓' : ''}</i></div>)}</div></section>

      <div className="marquee" aria-label="The vocabulary Ari returns"><div>{[...marquee, ...marquee].map((word, index) => <span key={`${word}-${index}`}>{word} <i>✳</i></span>)}</div></div>

      <section id="contact" className="final section-pad section-reveal"><Reveal><p className="section-kicker">ARI / INFRASTRUCTURE FOR THE NEXT ECONOMY</p><h2>LET AGENTS ACT.<br /><span>KEEP CONTROL.</span></h2><p className="wide-copy">Autonomy is inevitable. Unrestricted access is optional. What is real today: the policy engine, the ledger, the risk plane, the audit chain, the approvals loop and the console, covered by a suite that runs against a real Postgres. What is not: a live signing provider. The signer in this build is a mock that reports itself untrustworthy, and Ari will not dress a mock signature up as a settled payment.</p><div className="button-row"><ButtonLink href="/console">OPEN THE CONSOLE</ButtonLink><ButtonLink light href="/docs">READ THE DOCS</ButtonLink></div></Reveal><Reveal className="waitlist-card delay-1"><div><p className="section-kicker">08 / PRIVATE BETA</p><h3>JOIN THE<br /><span>WAITLIST.</span></h3><p>There is no hosted Ari yet. The engine, the console, the CLI and the docs run today on your own infrastructure, with your own keys and your own database. Join the list if you want that operated for you.</p></div><form onSubmit={joinWaitlist}><label htmlFor="waitlist-email">WORK EMAIL</label><div className="waitlist-input"><input id="waitlist-email" type="email" required value={email} onChange={(event) => { setEmail(event.target.value); setWaitlistState('idle') }} placeholder="you@company.com" /><button type="submit" disabled={waitlistState === 'loading'} aria-label="Join waitlist">{waitlistState === 'loading' ? '...' : <ArrowUpRight />}</button></div><small aria-live="polite">{waitlistState === 'success' ? 'You are on the list. We will be in touch.' : waitlistState === 'error' ? 'Something went wrong. Try again.' : 'No noise. Just signal.'}</small></form></Reveal></section>
      <footer><a className="brand" href="#top"><img src="/ari-logo.svg" alt="ARI" /></a><span>© 2026 ARI SYSTEMS</span><span>AUTHORIZATION INFRASTRUCTURE FOR AUTONOMOUS AGENTS</span><span className="footer-note">No domain yet, and no mailbox behind this one — open an issue on the repository.</span><div className="social-links" aria-label="Links"><a href="https://github.com/0xCyrildev/Ari" target="_blank" rel="noreferrer" aria-label="Source repository" style={{ width: "auto", padding: "0 10px", font: "10px monospace", letterSpacing: ".14em" }}>SOURCE</a></div><a href="#top">BACK TO TOP ↑</a></footer>
      </main>
    </>
  )
}
