'use client'

import { ButtonLink, DataTable, MetricBand, Panel, PageHead, Reveal, State, Tag, type Column } from '@/components/console/ui'
import * as sampleData from '@/lib/ari/sample'
import { useConsole } from '@/lib/ari/console'
import { UnwiredScreen } from '@/components/console/ui'
import { money, relativeTime, shortAddress, shortHash } from '@/lib/ari/format'
import type { Wallet, WalletMode } from '@/lib/ari/types'

/**
 * Wallets. The execution resource, not the money in it.
 *
 * A wallet on this screen answers one question: whose key had to be present for this to be signed.
 * Balances are rendered because the fixture carries them, and they are labelled sample figures in
 * the column header, in the panel note and in the band above, because a number that looks like a
 * balance is the one thing on this page an operator might act on. Nothing here queries a chain, so
 * `LIVE` means Ari holds a record of a wallet and a provider names it, and an address is a value in
 * a row rather than something observed on a network.
 *
 * The grant list at the bottom is built from the version id each request actually carried, which is
 * why it can disagree with the carried-policies column in the table: that column is derived from
 * which version of a policy is live today. A grant binds a version. It does not bind whatever the
 * document became afterwards, and the two views of the same tenant are shown side by side rather
 * than reconciled by picking one.
 */

/** The states whose row had a signature returned or confirmed. Mirrors the fixture's own sums. */
const SIGNED: readonly string[] = ['SIGNING_COMPLETE', 'BROADCAST', 'BROADCAST_CONFIRMED']

/** A figure and the noun that fits it, so a count of one and a count of two both read correctly. */
const count = (value: number, one: string, many: string): string => `${value} ${value === 1 ? one : many}`

/** The one sentence each mode is allowed to make, in its own words. */
const MODE_COPY: Readonly<Record<WalletMode, string>> = {
  delegated: 'A shared dWallet the engine may use inside policy.',
  user_gated: 'The human’s device still has to sign, even when policy allows.',
}

export default function Wallets() {
  const { view } = useConsole()

  const wallets = view.wallets
  const txs = view.transactions
  const live = wallets.filter((wallet) => wallet.status === 'LIVE').length
  const noAddress = wallets.filter((wallet) => wallet.address === null)
  const providers = [...new Set(wallets.map((wallet) => wallet.provider))]
  const byMode = (mode: WalletMode) => wallets.filter((wallet) => wallet.mode === mode)
  const agentsOn = (group: readonly Wallet[]) => group.reduce((sum, wallet) => sum + wallet.agents.length, 0)
  const requestsOn = (walletId: string) => txs.filter((tx) => tx.walletId === walletId)

  const modeSummary = (mode: WalletMode) => {
    const group = byMode(mode)
    const ids = new Set(group.map((wallet) => wallet.id))
    const own = txs.filter((tx) => ids.has(tx.walletId))
    const allowed = own.filter((tx) => tx.outcome === 'ALLOW')
    const signed = allowed.filter((tx) => SIGNED.includes(tx.state))
    const deviceMentions = own
      .flatMap((tx) => tx.trace.flatMap((stage) => [stage.headline, ...stage.detail]))
      .filter((line) => line.toLowerCase().includes('device')).length
    return {
      group,
      own,
      allowed,
      signed,
      deviceMentions,
      waiting: own.filter((tx) => tx.outcome === 'REQUIRE_HUMAN_APPROVAL').length,
      refused: own.filter((tx) => tx.outcome === 'DENY').length,
    }
  }

  /**
   * One row per grant, and every field on it read from the grant itself.
   *
   * This used to rebuild the binding through the fixture: an agent's policy *key*, then whichever
   * version is live *today*, then a wallet looked up by index. That derivation cannot survive a
   * live tenant, because a grant binds one version and the read returns the version id the grant
   * carries. So the shape below is the grant's own data, and `crossed` is the disagreement the
   * panel talks about — the document's target wallet against the wallet the grant points at —
   * computed rather than asserted.
   */
  const grants = view.grantRows.map((row) => ({
    agent: { id: row.agentId, name: row.agentLabel },
    own: txs.filter((tx) => tx.agentId === row.agentId),
    version: {
      id: row.policyVersionId,
      number: row.policyVersionNumber,
      status: row.policyVersionStatus,
      activatedAt: row.grantedAt,
      createdAt: row.grantedAt,
      document: { meta: { name: row.policyName } },
    },
    liveVersion: { id: row.policyVersionId, number: row.policyVersionNumber, status: row.policyVersionStatus },
    ranOn: { id: row.walletId, name: row.walletName },
    target: wallets.find((wallet) => wallet.id === (row.targetWalletId ?? '')),
    crossed: row.targetWalletId !== null && row.targetWalletId !== row.walletId,
  }))
  const crossedWires = grants.filter((grant) => grant.crossed).length
  const boundLabels = new Set(txs.map((tx) => `${tx.walletId}|${tx.policyName} v${tx.policyVersionNumber}`))
  const unboundCarriers = wallets.filter((wallet) => wallet.policies.some((label) => !boundLabels.has(`${wallet.id}|${label}`)))

  const columns: readonly Column<Wallet>[] = [
    {
      key: 'name',
      header: 'WALLET',
      cell: (wallet) => (
        <>
          {wallet.name}
          <span className="sub">{shortHash(wallet.id)} · {requestsOn(wallet.id).length} request rows here</span>
        </>
      ),
    },
    { key: 'chain', header: 'CHAIN', hideBelow: 'sm', cell: (wallet) => <span className="num">{wallet.chain}</span> },
    { key: 'provider', header: 'PROVIDER', hideBelow: 'md', cell: (wallet) => <span style={{ fontSize: 12 }}>{wallet.provider}</span> },
    { key: 'mode', header: 'AUTHORITY MODE', cell: (wallet) => <Tag>{wallet.mode}</Tag> },
    {
      key: 'address',
      header: 'ADDRESS',
      hideBelow: 'sm',
      cell: (wallet) => <span className="num" title={wallet.address ?? 'no address'}>{shortAddress(wallet.address)}</span>,
    },
    {
      key: 'carries',
      header: 'CARRIES',
      hideBelow: 'md',
      cell: (wallet) => (
        <>
          {wallet.agents.length} agents · {wallet.policies.length} policy version{wallet.policies.length === 1 ? '' : 's'}
          <span className="sub">{wallet.agents.join(', ') || 'no agent recorded against it'}</span>
          <span className="sub">{wallet.policies.join(' · ') || 'no policy version attached'}</span>
        </>
      ),
    },
    { key: 'status', header: 'STATUS', cell: (wallet) => <State value={wallet.status} /> },
    {
      key: 'balances',
      // The header says BALANCES and the cell says why the list is empty: there is no balance
      // read on this API at all, so an empty column is a missing capability, not a zero.
      header: 'BALANCES',
      hideBelow: 'md',
      cell: (wallet) =>
        wallet.balances.length === 0 ? (
          <span className="muted">{view.source === 'sample' ? 'sample figures only; no chain read was made' : 'no balance read exists on this API, so this is silence, not zero'}</span>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {wallet.balances.map((balance) => (
              <span key={balance.asset}>
                <span className="num">{money(balance.raw, balance.unit)}</span> <span className="muted">{balance.asset} · {balance.unit}</span>
              </span>
            ))}
          </div>
        ),
    },
  ]

  return (
    <div className="console-body">
      <Reveal>
        <PageHead
          title="WHO HAS TO BE PRESENT."
          lede="A wallet is an execution resource: an address, a provider, and a rule about whose key signs. It is not a balance display, and nothing here has asked a chain what any address holds. The useful column is authority mode, because that is the one that says whether a permission from policy is enough on its own."
          actions={
            <ButtonLink href="/console/policies" small>
              POLICY DOCUMENTS
            </ButtonLink>
          }
        />
      </Reveal>

      <MetricBand
        items={[
          {
            label: 'WALLETS',
            value: wallets.length,
            note: `${live} recorded LIVE · ${wallets.length - live} SUPERSEDED. A status here is Ari’s record, not a network fact`,
          },
          {
            label: 'DELEGATED',
            value: byMode('delegated').length,
            note: `${agentsOn(byMode('delegated'))} agents are recorded against them. Inside a policy the engine may spend one with nobody at a keyboard`,
          },
          {
            label: 'USER GATED',
            value: byMode('user_gated').length,
            tone: 'wait',
            note: `${agentsOn(byMode('user_gated'))} agents. A policy ALLOW on these is still not a completed payment`,
          },
          {
            label: 'NO ADDRESS ON RECORD',
            value: noAddress.length,
            tone: 'wait',
            note: `every row names the same provider, ${providers.join(', ')}. Nothing on this screen was fetched from a chain`,
          },
        ]}
      />

      <Panel
        title="EXECUTION RESOURCES"
        note={
          view.source === 'sample'
            ? `${wallets.length} WALLETS · BALANCES ARE SAMPLE FIGURES`
            : `${wallets.length} WALLETS · NO BALANCE READ EXISTS ON THIS API`
        }
      >
        <DataTable rows={wallets} columns={columns} rowKey={(wallet) => wallet.id} />
      </Panel>

      <Panel title="WHAT EACH MODE CAN PROMISE" note="AND WHAT NEITHER OF THEM PROMISES" pad>
        <p style={{ margin: '0 0 20px', fontSize: 12, lineHeight: 1.5, color: 'var(--muted)', maxWidth: '72ch' }}>
          Read the modes as statements about who has to be present, not about how safe a balance
          is. Neither one says anything about settlement: a signature returned is not a payment
          observed, and no row on this page can be promoted past what its own state claims.
        </p>
        {(['delegated', 'user_gated'] as readonly WalletMode[]).map((mode) => {
          const summary = modeSummary(mode)
          return (
            <div key={mode} style={{ borderTop: '1px solid var(--line)', padding: '20px 0' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                <Tag>{mode}</Tag>
                <span style={{ fontSize: 15 }}>{MODE_COPY[mode]}</span>
              </div>
              <span className="sub">
                {summary.group.map((wallet) => wallet.name).join(', ')} · {agentsOn(summary.group)} agents ·{' '}
                {count(summary.own.length, 'request row', 'request rows')} · {count(summary.allowed.length, 'allowed request', 'allowed requests')} ·{' '}
                {count(summary.signed.length, 'signed state', 'signed states')} · {count(summary.waiting, 'request waiting on a person', 'requests waiting on a person')} ·{' '}
                {count(summary.refused, 'refusal', 'refusals')}
              </span>
              {mode === 'delegated' ? (
                <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, maxWidth: '72ch' }}>
                  Once policy allows a request and the ticket is minted, no second signature is
                  waiting for a person somewhere else. The wallet is the authority Ari holds, and
                  the only thing standing between a document and a broadcast is the policy that
                  produced it, which is why the ceilings live in the document and not in the client.
                  The line above is the widest claim these rows support: it counts what Ari decided
                  and what state the row reached. None of it says a payment settled.
                </p>
              ) : (
                <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, maxWidth: '72ch' }}>
                  Ari can authorise the intent and mint the ticket, and the wallet still does not
                  move until a person’s key is on it, so a policy ALLOW is not a completed payment.
                  Two consequences are worth stating plainly: an approval queue can be empty while
                  money has still not moved, and a signed state on one of these wallets is not
                  evidence that a human was there. On these rows there{' '}
                  {summary.signed.length === 1 ? 'is' : 'are'}{' '}
                  {count(summary.signed.length, 'signed state', 'signed states')} and{' '}
                  {count(summary.deviceMentions, 'trace line mentioning a device', 'trace lines mentioning a device')}
                  . Read that as a gap in what was recorded rather than as a gate that quietly opened.
                </p>
              )}
            </div>
          )
        })}
        <p style={{ margin: '20px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--muted)', maxWidth: '72ch' }}>
          An address is a value in a row. Saying it belongs to the wallet it names is a claim a
          provider callback would have to make, and nothing on this screen has one:{' '}
          {count(noAddress.length, 'wallet carries', 'wallets carry')} no address at all (
          {noAddress.map((wallet) => wallet.name).join(', ') || 'none'}).{' '}
          {count(wallets.filter((wallet) => wallet.address !== null).length, 'row', 'rows')} do show
          one, and the ellipsis in the middle of it is the same shortening every other address on
          this console gets.
        </p>
      </Panel>

      <Panel title="GRANTS: WALLET, POLICY VERSION, AGENT" note={`${grants.length} BINDINGS`} pad>
        <p style={{ margin: '0 0 20px', fontSize: 14, lineHeight: 1.55, maxWidth: '72ch' }}>
          Each line below is built from the version id a request actually carried, not from a
          lookup of what is live now. That is the difference that matters: a grant binds one
          version, so an approval given against v3 keeps meaning v3 after v4 goes live, and the
          audit trail can be re-read months later without the document having shifted underneath
          it. The carried-policies column in the table above is a different derivation, per agent,
          of whichever version is live today, which is how{' '}
          {count(unboundCarriers.length, 'wallet ends', 'wallets end')} up listing a policy version
          no request on it ever bound ({unboundCarriers.map((wallet) => wallet.name).join(', ') || 'nothing'}).
          Where the two disagree, the version id on the request is the one Ari stored.
        </p>
        <div className="stack-list">
          {grants.map((grant) => (
            <div key={grant.agent.id}>
              <time dateTime={(grant.version.activatedAt ?? grant.version.createdAt) ?? undefined}>
                {relativeTime(grant.version.activatedAt ?? grant.version.createdAt).toUpperCase()}
              </time>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 15 }}>
                  {grant.ranOn.name} <span className="muted">→</span> {grant.version.document.meta.name} v{grant.version.number}{' '}
                  <span className="muted">→</span> {grant.agent.name}
                </span>
                <span className="sub">
                  version id {shortHash(grant.version.id)} · {grant.own.length} request row
                  {grant.own.length === 1 ? '' : 's'} by this agent · status from the document, not from this screen
                </span>
                {grant.version.id !== grant.liveVersion.id && (
                  <span className="sub" style={{ color: 'var(--ink)' }}>
                    The live document is v{grant.liveVersion.number} ({grant.liveVersion.status}). This binding still
                    names v{grant.version.number}, and that is the correct reading of the row: the agent was authorised
                    against the older document.
                  </span>
                )}
                {grant.crossed && (
                  <span className="sub" style={{ color: 'var(--accent)' }}>
                    This request ran on {grant.ranOn.name}. The document it bound targets{' '}
                    {grant.target?.name ?? 'a wallet this read cannot name'}. {count(crossedWires, 'binding', 'bindings')} disagree
                    that way, and the screen reports the disagreement rather than drawing the tidier one.
                  </span>
                )}
              </div>
              <Tag stop={grant.version.status !== 'ACTIVE'}>{grant.version.status}</Tag>
            </div>
          ))}
        </div>
        <p style={{ margin: '20px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--muted)', maxWidth: '72ch' }}>
          What these rows do not show: a signing key, a quorum of devices, or a balance the wallet
          is allowed to spend. A grant says which document was in force for which agent on which
          wallet, and everything else on this page is a sample figure or a record of a decision.
        </p>
      </Panel>
    </div>
  )
}
