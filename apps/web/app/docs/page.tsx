'use client'

import Link from 'next/link'
import { ArrowLeft, ArrowUpRight, Copy, Terminal } from 'lucide-react'

const responsibilityLayers = [
  ['01', 'AI DECIDES INTENT', 'The agent proposes what it wants to do.'],
  ['02', 'POLICY', 'ARI evaluates what is permitted.'],
  ['03', 'RISK', 'Behavioral signals identify what looks dangerous.'],
  ['04', 'SIMULATION', 'The transaction is inspected before execution.'],
  ['05', 'AUTHORIZATION', 'ARI decides whether execution may proceed.'],
  ['06', 'SIGNER', 'A short-lived, single-use ticket is re-verified.'],
  ['07', 'CHAIN', 'The enabled chain executes the transaction.'],
]

const credentials = [
  ['Agent', 'crd_', 'Proposes a payment: authorize, evaluate a preview, poll its own request.', 'Cannot decide approvals.'],
  ['Human', 'ucrd_', 'Every read, every approval decision, agents, wallets, policy activation.', 'Cannot request transactions.'],
  ['Deployment', 'bootstrap', 'Creates the first organization, users, and human credentials.', 'Bootstrap only.'],
]

const endpoints = [
  ['GET', '/healthz', 'nobody', 'no authentication'],
  ['POST', '/v1/organizations', 'bootstrap', 'creates the org and its owner'],
  ['POST', '/v1/users', 'bootstrap', 'first human principals'],
  ['POST', '/v1/users/:id/credentials', 'bootstrap', 'mints a ucrd_ secret, printed once'],
  ['POST', '/v1/transactions/authorize', 'agent', 'transaction:request'],
  ['POST', '/v1/transactions/evaluate', 'agent', 'preview; writes no row'],
  ['GET', '/v1/transactions/:id', 'agent', 'status only: three fields'],
  ['GET', '/v1/transactions', 'human', 'transaction:read'],
  ['GET', '/v1/transactions/:id/record', 'human', 'row + canonical + its own trail'],
  ['GET', '/v1/summary', 'human', 'transaction:read'],
  ['GET', '/v1/approvals', 'human', 'approval:decide'],
  ['POST', '/v1/approvals/:id/decisions', 'human', 'approval:decide'],
  ['GET', '/v1/agents', 'human', 'agent:manage'],
  ['POST', '/v1/agents', 'human', 'agent:manage'],
  ['POST', '/v1/agents/:id/revoke', 'human', 'agent:manage'],
  ['POST', '/v1/agents/:id/credentials', 'human', 'agent:manage'],
  ['GET', '/v1/wallets', 'human', 'wallet:manage'],
  ['POST', '/v1/wallets', 'human', 'wallet:manage'],
  ['POST', '/v1/agents/:id/wallets/:id', 'human', 'wallet:manage'],
  ['GET', '/v1/policies', 'human', 'policy:read'],
  ['POST', '/v1/policies', 'human', 'policy:activate'],
  ['GET', '/v1/audit/events', 'human', 'audit:read'],
]

function Label({ children }: { children: React.ReactNode }) {
  return <p className="docs-label">{children}</p>
}

export default function DocsPage() {
  return (
    <main className="docs-page">
      <header className="docs-header">
        <Link className="docs-brand" href="/" aria-label="Back to ARI home"><img src="/ari-logo.svg" alt="ARI" /><span>ARI / DOCS</span></Link>
        <nav aria-label="Documentation navigation"><a href="#quickstart">QUICKSTART</a><a href="#architecture">ARCHITECTURE</a><a href="#api">API</a><a href="#boundaries">BOUNDARIES</a><Link className="docs-cta" href="/#contact">JOIN WAITLIST <ArrowUpRight /></Link></nav>
      </header>

      <section className="docs-hero">
        <div className="docs-hero-grid" aria-hidden="true" />
        <div className="docs-hero-copy">
          <Label>DOCUMENTATION / 00</Label>
          <h1>PERMISSION<br /><em>INFRASTRUCTURE</em><br />FOR AUTONOMOUS<br />MONEY.</h1>
          <p>Give an AI agent the ability to act on capital without giving it unrestricted access. Ari decides whether a request may proceed, then enforces that decision at the boundary.</p>
          <div className="docs-actions"><a className="docs-button docs-button-primary" href="#quickstart">START BUILDING <ArrowUpRight /></a><a className="docs-button" href="#architecture">READ THE MODEL</a></div>
        </div>
        <div className="docs-console" aria-label="A real authorization response"><div className="docs-console-head"><span>ARI / DECISION PLANE</span><span>DOC-ONLY</span></div><pre>{`POST /v1/transactions/authorize\n\nrequest  transfer 2,000.00 USDC\nagent    payer\npolicy   seed v1  (escalates above 1,000.00)\nrisk     MEDIUM  NO_BEHAVIOUR_BASELINE\n\nresult   APPROVAL_PENDING\n         approvalId apr_01a0de9b\n         expiresAt  +15 min`}</pre><small>An outcome is ALLOW, DENY or REQUIRE_HUMAN_APPROVAL. A response never carries a ticket, a signature, or a provider reference.</small></div>
      </section>

      <div className="docs-marquee" aria-hidden="true">POLICY <i>✳</i> RISK <i>✳</i> AUTHORIZATION <i>✳</i> AUDIT <i>✳</i> CONTROLLED CAPITAL <i>✳</i></div>

      <section id="quickstart" className="docs-section docs-quickstart"><div className="docs-section-intro"><Label>01 / QUICKSTART</Label><h2>THE MODEL<br /><span>IS SIMPLE.</span></h2><p>Autonomy is not the same as unrestricted access. Put Ari between intent and signing.</p><p className="docs-callout"><strong>THERE IS NO PACKAGE TO INSTALL.</strong> The agent SDK is <code>@ari/client</code>, a workspace package in this repository, not published to npm. It has three methods: evaluate, authorize, status. There is no <code>sign()</code>, and a test asserts its absence.</p></div><div className="docs-code"><div className="docs-code-head"><Terminal /> <span>terminal</span><Copy /></div><pre><code><span className="docs-muted">$</span> git clone https://github.com/0xCyrildev/Ari && cd Ari{`\n`}<span className="docs-muted">$</span> pnpm install && pnpm db:up{`\n`}<span className="docs-muted">$</span> pnpm test                <span className="docs-muted"># 548 tests / 31 files</span>{`\n`}<span className="docs-muted">$</span> pnpm seed                <span className="docs-muted"># prints two bearer credentials, once</span>{`\n`}<span className="docs-muted">$</span> pnpm --filter @ari/api start{`\n`}<span className="docs-muted">$</span> pnpm ari agent create payer{`\n\n`}<span className="docs-signal">✓ Ari listening on 127.0.0.1:4000</span></code></pre></div></section>

      <section id="architecture" className="docs-section docs-dark"><Label>02 / ARCHITECTURE</Label><h2>TWO PROCESSES.<br /><span>ONE BOUNDARY.</span></h2><div className="docs-architecture"><div><b>DECISION PLANE</b><strong>ari-api</strong><p>Policy, risk, ledger, approvals, and tickets.</p></div><span>→</span><div className="docs-architecture-focus"><b>SEALED TICKET</b><strong>ARI</strong><p>Short-lived. Single-use. Re-verified.</p></div><span>→</span><div><b>AUTHORITY PLANE</b><strong>ari-signer</strong><p>Accepts only a valid ticket and its own record.</p></div></div><p className="docs-callout"><strong>THE KERNEL IS PURE.</strong> The policy and transaction engines import nothing from identity, ledger, signing, or AI-adjacent packages. The model is not the security boundary.</p></section>

      <section className="docs-section docs-steps"><Label>03 / RESPONSIBILITY LAYERS</Label><div className="docs-section-heading"><h2>WHO DECIDES<br /><span>WHAT.</span></h2><p>These are responsibility layers: who decides what. The console draws a different, shorter list per request &mdash; INTENT, POLICY, RISK, APPROVAL, SIGNING, EXECUTION &mdash; rebuilt from that request's own audit events. The two are not the same and are not interchangeable.</p></div><div className="docs-step-list">{responsibilityLayers.map(([number, title, copy]) => <div className="docs-step" key={number}><span>{number}</span><strong>{title}</strong><p>{copy}</p><ArrowUpRight /></div>)}</div></section>

      <section id="api" className="docs-section docs-dark docs-api"><Label>04 / HTTP API</Label><div className="docs-section-heading"><h2>SMALL SURFACE.<br /><span>EXPLICIT ACCESS.</span></h2><p>ari-api runs on :4000. Bodies are capped at 64 KB. Reads are capped at 200 rows and use cursors, never OFFSET.</p></div><div className="docs-table" role="table" aria-label="HTTP API endpoints"><div className="docs-table-row docs-table-head"><span>METHOD</span><span>PATH</span><span>CALLER</span><span>SCOPE</span></div>{endpoints.map(([method, path, caller, scope]) => <div className="docs-table-row" role="row" key={path}><span className="docs-method">{method}</span><code>{path}</code><span>{caller}</span><span>{scope}</span></div>)}</div></section>

      <section id="boundaries" className="docs-section docs-boundaries"><Label>05 / SECURITY BOUNDARIES</Label><div className="docs-section-heading"><h2>WHAT ARI<br /><span>DOES NOT CLAIM.</span></h2><p>Honest infrastructure is part of the threat model. These limitations are deliberate and visible.</p></div><div className="docs-boundary-grid"><article><b>NOT ON-CHAIN ENFORCEMENT</b><p>The chain and signer do not enforce an off-chain policy. Ari refuses deterministically and can prove it refused.</p></article><article><b>NOT A SETTLED PAYMENT</b><p>The lifecycle stops at TICKET_MINTED. Settlement belongs to a future provider callback or reconciliation pass.</p></article><article><b>NOT AN LLM SECURITY LAYER</b><p>Intent mode is deterministic-only. Ambiguous input becomes NEEDS_CLARIFICATION.</p></article><article><b>NOT A PRICE FEED</b><p>There is no price feed in this build. Missing evidence escalates rather than silently clearing a threshold.</p></article></div></section>

      <section className="docs-section docs-credentials docs-dark"><Label>06 / CREDENTIALS</Label><h2>THREE CALLERS.<br /><span>NOT INTERCHANGEABLE.</span></h2><div className="docs-credential-grid">{credentials.map(([name, prefix, can, cannot]) => <article key={name}><div><strong>{name}</strong><code>{prefix}</code></div><p>{can}</p><small>{cannot}</small></article>)}</div></section>

      <section className="docs-section docs-boundaries"><Label>07 / WHAT WORKS TODAY</Label><div className="docs-section-heading"><h2>THE HONEST<br /><span>STATE OF IT.</span></h2><p>Every claim on this page is labelled VERIFIED, DOC-ONLY, ASSUMED or NOT FOUND. These are the boundaries of the current build.</p></div><div className="docs-boundary-grid"><article><b>THE SIGNER IS A MOCK</b><p>SIGNING_PROVIDER=mock returns results typed trustworthy: false. ari-signer exits rather than falling back to a mock when told otherwise. Ika dWallets are not integrated.</p></article><article><b>SIMULATION IS ADVISORY</b><p>It has only ever been pointed at a local chain, whose state root proves mechanics and nothing else. An eth_call to an address with no code returns 0x, which is also what some tokens return on success, so the provider calls eth_getCode and refuses.</p></article><article><b>NO BALANCES, NO SETTLEMENT</b><p>Nothing reads a wallet balance, and no reconciler observes a broadcast. An empty balance column is silence, not zero.</p></article><article><b>SIX SCREENS REFUSE</b><p>The console reads a live tenant for overview, transactions, approvals, audit, wallets and agents. The rest say what they are waiting for rather than render sample rows under a live banner.</p></article></div></section>

<section className="docs-section docs-footer-cta"><Label>ARI / DOCUMENTATION</Label><h2>BUILD WITH<br /><span>CONTROL.</span></h2><p>Read the source. Test the boundary. Give autonomous software a safe way to act.</p><div className="docs-actions"><Link className="docs-button docs-button-primary" href="/#contact">JOIN THE WAITLIST <ArrowUpRight /></Link><Link className="docs-button" href="/">BACK TO ARI <ArrowLeft /></Link></div></section>
      <footer className="docs-footer"><Link className="docs-brand" href="/"><img src="/ari-logo.svg" alt="ARI" /><span>ARI SYSTEMS</span></Link><span>VERIFIED / DOCS</span><span>© 2026</span></footer>
    </main>
  )
}
