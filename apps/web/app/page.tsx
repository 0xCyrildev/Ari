'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowUpRight, Check, Mail, Menu, Moon, Sun, X } from 'lucide-react'
import { useTheme } from 'next-themes'

const stages = [
  ['01', 'AGENT', 'Does this principal hold an envelope at all?'],
  ['02', 'INTENT', 'What does the agent want to do?'],
  ['03', 'POLICY', 'Does the action fit its permissions?'],
  ['04', 'RISK', 'Is the behavior known and safe?'],
  ['05', 'APPROVAL', 'Should a human confirm this action?'],
  ['06', 'SIGN', 'Authorize with 2PC-MPC.'],
  ['07', 'EXECUTE', 'Send the transaction.'],
]

const trace = [
  ['12:41:02', 'AGENT', 'treasury-agent'],
  ['12:41:02', 'INTENT', 'Pay Brightline Cartage 4,200 USDC'],
  ['12:41:03', 'POLICY', 'ALLOW'],
  ['12:41:03', 'RISK', 'LOW'],
  ['12:41:03', 'APPROVAL', 'NOT REQUIRED'],
  ['12:41:03', 'SIGN', 'TICKET MINTED'],
  ['12:41:08', 'EXECUTION', 'NOT SETTLED'],
]

// `SupportedChain` in packages/schemas names two chains. Everything past that line is
// architecture, not shipping support, and the labels below say which is which.
const primaryNetworks = [
  ['Ethereum', 'ethereum', 'SUPPORTED TODAY'],
  ['Bitcoin', 'bitcoin', 'IN THE SCHEMA'],
  ['Base', 'base', 'EVM: CONFIG AWAY'],
  ['Arbitrum', 'arbitrum', 'EVM: CONFIG AWAY'],
  ['Optimism', 'optimism', 'EVM: CONFIG AWAY'],
  ['Polygon', 'polygon', 'EVM: CONFIG AWAY'],
  ['Avalanche', 'avalanche', 'EVM: CONFIG AWAY'],
]

const evmNetworks = ['Base', 'Arbitrum', 'Optimism', 'Polygon', 'Avalanche', 'Celo']

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
            exit={{ opacity: 0 }}
            transition={{ duration: 0.55, ease: 'easeInOut' }}
            aria-label="Loading ARI"
            role="status"
          >
            <motion.img
              src="/ari-logo.svg"
              alt="ARI"
              initial={{ scale: 0.82, opacity: 0, rotate: -12 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            />
            <motion.strong
              className="loader-wordmark"
              initial={{ opacity: 0, letterSpacing: '0.6em', y: 10 }}
              animate={{ opacity: 1, letterSpacing: '0.24em', y: 0 }}
              transition={{ duration: 0.8, delay: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >ARI</motion.strong>
            <motion.span
              initial={{ width: 0 }}
              animate={{ width: '100%' }}
              transition={{ duration: 1.25, delay: 0.15, ease: 'easeInOut' }}
            />
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
            <Reveal className="delay-1"><h1>FINANCIAL<br /><em>CONTROL</em><br />FOR AUTONOMOUS<br />AGENTS.</h1></Reveal>
            <Reveal className="delay-2"><p className="hero-description">Give AI agents the ability to act on capital without giving them unrestricted access.</p></Reveal>
            <Reveal className="delay-3"><div className="button-row"><ButtonLink href="/console">OPEN THE CONSOLE</ButtonLink><ButtonLink light href="/docs">READ THE DOCS</ButtonLink></div></Reveal>
          </div>
          <Reveal className="hero-terminal delay-2"><div className="terminal-head"><span>ARI / AUTHORIZATION LAYER</span><span>LIVE</span></div><div className="terminal-body"><div className="terminal-line"><span className="muted">agent</span><span>treasury-agent</span></div><div className="terminal-line"><span className="muted">request</span><span>transfer(4200000, 6dp)</span></div><div className="terminal-divider" /><div className="terminal-line"><span className="accent">status</span><strong>AWAITING POLICY</strong></div><div className="terminal-bracket">[ <b>intent</b> → <b>policy</b> → <b>risk</b> → <b>sign</b> ]</div></div></Reveal>
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

      <section className="section-pad networks-section section-reveal"><Reveal><p className="section-kicker">03 / NETWORKS</p><div className="networks-intro"><h2>ONE AUTHORIZATION LAYER.<br /><span>MULTIPLE EXECUTION ENVIRONMENTS.</span></h2><p className="wide-copy">ARI&apos;s policy and authorization layer is chain-agnostic. Chain-specific adapters handle addresses, transactions, simulation, replay protection, fees, and signing.</p></div></Reveal><div className="network-strip reveal" aria-label="Networks ARI names today"><div className="network-track">{[...primaryNetworks, ...primaryNetworks].map(([name, slug, status], index) => <motion.a className="network-item" href="#sdk" key={`${name}-${index}`} aria-label={`${name}, ${status}`} initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.2 }} transition={{ duration: 0.5, delay: (index % primaryNetworks.length) * 0.06, ease: [0.22, 1, 0.36, 1] }}><span className="network-identity"><strong>{name}</strong></span><small>{status}</small></motion.a>)}</div></div><div className="evm-compatible reveal"><p>EVM COMPATIBLE</p><small>EVM networks largely reuse ARI&apos;s existing transaction, policy, replay, and signing model, with chain-specific configuration and fee semantics.</small><div className="evm-list">{evmNetworks.map((name, index) => <motion.a className="evm-item" href="#sdk" key={name} initial={{ opacity: 0, x: -12 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true, amount: 0.3 }} transition={{ duration: 0.45, delay: index * 0.1, ease: [0.22, 1, 0.36, 1] }}><span>{name}</span></motion.a>)}</div></div><p className="network-footnote">Two chains are in the schema today: Ethereum, which has a candidate model, address grammar, ERC-20 assets and a simulation adapter, and Bitcoin, which has address grammars and signature triples but no simulation adapter yet. An EVM chain needs one enum entry, its own fee semantics and a sequencer-uptime rule before it is honest about dry runs. Solana, Sui, Aptos, Cardano, TON and XRP Ledger are not supported: each needs an address grammar, a candidate model and a simulation adapter that does not exist in this repository.</p></section>

      <section id="policy" className="section-pad policy-section section-reveal"><div className="split-heading"><Reveal><p className="section-kicker">04 / POLICY ENGINE</p><h2>DEFINE WHAT<br /><span>AGENTS CAN DO.</span></h2></Reveal><Reveal className="delay-1"><p className="side-copy">Policies are the boundary. Specify assets, chains, limits, recipients, and when a human must step in.</p></Reveal></div><div className="policy-grid reveal"><pre>{`agent:\n  name: treasury-agent\n\npermissions:\n  assets: [USDC]\n  chains: [ethereum]\n  maxPerTransaction: $5,000\n  dailyLimit: $25,000\n\napproval:\n  above: $5,000`}</pre><div className="decision"><p>POLICY / V12</p><strong><Check /> ALLOW</strong><span>Within transaction limit</span><span>Approved recipient</span><span>Known chain</span></div></div></section>

      <section className="section-pad risk-section dark-section section-reveal"><Reveal><p className="section-kicker">05 / RISK ENGINE</p><h2>KNOW WHEN<br /><span>BEHAVIOR CHANGES.</span></h2></Reveal><div className="risk-layout"><div className="risk-signals">{['TRANSACTION SIZE', 'RECIPIENT', 'CHAIN', 'ASSET', 'FREQUENCY', 'CONTRACT', 'BEHAVIOR'].map((signal, i) => <Reveal key={signal} className={`risk-signal delay-${i % 4}`}><span>0{i + 1}</span>{signal}<b>+</b></Reveal>)}</div><Reveal className="risk-result"><p>COMPOSITE DECISION</p><div className="risk-level"><span>LOW</span><i /><span className="muted">MEDIUM</span><i /><span className="muted">HIGH</span></div><strong>LOW RISK</strong><small>Signals match expected agent behavior.</small></Reveal></div></section>

      <section id="sdk" className="section-pad sdk-section section-reveal"><div className="split-heading"><Reveal><p className="section-kicker">06 / DEVELOPER EXPERIENCE</p><h2>ONE AUTHORIZATION<br /><span>LAYER. EVERY AGENT.</span></h2></Reveal><Reveal className="delay-1"><p className="side-copy">Drop ARI into the execution path. Keep your agent architecture. Add controlled financial access.</p></Reveal></div><Reveal className="code-window"><div className="window-bar"><span /> <span /> <span /><label>terminal</label></div><pre><code><span className="muted"># @ari/client is a workspace package: not on npm yet, and it has no sign()</span>{`\n`}<span className="muted">$</span> ari init{`\n`}<span className="muted">$</span> ari agent create payer{`\n`}<span className="muted">$</span> ari wallet create --name operations{`\n`}<span className="muted">$</span> ari policy apply treasury.json --activate{`\n\n`}<span className="success">✓ agent created · policy activated · grant issued</span>{`\n`}<span className="muted">$</span> ari agent credential payer --ttl 1h<span className="muted">   # the bearer prints once, then never again</span>{`\n`}<span className="muted">$</span> ari audit tail --verify<span className="muted">            # the hash chain, recomputed</span>{`\n`}<span className="muted">#</span> or drive the same routes from the console: /console{`\n`}<span className="muted">#</span> and the contract, the scopes and the limits: /docs</code></pre></Reveal></section>

      <section id="audit" className="section-pad audit-section dark-section section-reveal"><div className="split-heading"><Reveal><p className="section-kicker">07 / AUDIT TRAIL</p><h2>EVERY DECISION<br /><span>LEAVES A RECEIPT.</span></h2></Reveal><Reveal className="delay-1"><p className="side-copy">A complete, readable record of what the agent asked for, why it was allowed, and what finally executed.</p></Reveal></div><div className="trace reveal">{trace.map(([time, label, value], index) => <div className="trace-row" key={label}><time>{time}</time><div><span>{label}</span><strong className={value === 'ALLOW' || value === 'LOW' || value === 'AUTHORIZED' || value === 'CONFIRMED' ? 'success' : ''}>{value}</strong></div><i>{index < trace.length - 1 ? '↓' : '��'}</i></div>)}</div></section>

      <div className="marquee" aria-label="ARI infrastructure ecosystem"><div>AI AGENTS <i>✳</i> POLICY ENGINE <i>✳</i> RISK ENGINE <i>✳</i> HUMAN APPROVAL <i>✳</i> 2PC-MPC <i>✳</i> EVM <i>✳</i> SUI <i>✳</i> SOLANA <i>✳</i></div></div>

      <section id="contact" className="final section-pad section-reveal"><Reveal><p className="section-kicker">ARI / INFRASTRUCTURE FOR THE NEXT ECONOMY</p><h2>LET AGENTS ACT.<br /><span>KEEP CONTROL.</span></h2><p className="wide-copy">Autonomy is inevitable. Unrestricted access is optional. What is real today: the policy engine, the ledger, the risk plane, the audit chain, the approvals loop and the console, covered by 548 tests. What is not: a live signing provider. The signer in this build is a mock that reports itself untrustworthy, and Ari will not dress a mock signature up as a settled payment.</p><div className="button-row"><ButtonLink href="/console">OPEN THE CONSOLE</ButtonLink><ButtonLink light href="/docs">READ THE DOCS</ButtonLink></div></Reveal><Reveal className="waitlist-card delay-1"><div><p className="section-kicker">08 / PRIVATE BETA</p><h3>JOIN THE<br /><span>WAITLIST.</span></h3><p>There is no hosted Ari yet. The engine, the console, the CLI and the docs run today on your own infrastructure, with your own keys and your own database. Join the list if you want that operated for you.</p></div><form onSubmit={joinWaitlist}><label htmlFor="waitlist-email">WORK EMAIL</label><div className="waitlist-input"><input id="waitlist-email" type="email" required value={email} onChange={(event) => { setEmail(event.target.value); setWaitlistState('idle') }} placeholder="you@company.com" /><button type="submit" disabled={waitlistState === 'loading'} aria-label="Join waitlist">{waitlistState === 'loading' ? '...' : <ArrowUpRight />}</button></div><small aria-live="polite">{waitlistState === 'success' ? 'You are on the list. We will be in touch.' : waitlistState === 'error' ? 'Something went wrong. Try again.' : 'No noise. Just signal.'}</small></form></Reveal></section>
      <footer><a className="brand" href="#top"><img src="/ari-logo.svg" alt="ARI" /></a><span>© 2026 ARI SYSTEMS</span><span>AUTHORIZATION INFRASTRUCTURE FOR AUTONOMOUS AGENTS</span><div className="social-links" aria-label="Links"><a href="https://github.com/0xCyrildev/Ari" target="_blank" rel="noreferrer" aria-label="Source repository" style={{ width: "auto", padding: "0 10px", font: "10px monospace", letterSpacing: ".14em" }}>SOURCE</a><a href="mailto:hello@ari.systems" aria-label="Email"><Mail /></a></div><a href="#top">BACK TO TOP ↑</a></footer>
      </main>
    </>
  )
}
