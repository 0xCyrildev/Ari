'use client'

import { useState } from 'react'
import { useConsole } from '@/lib/ari/console'

/**
 * The connection strip, and the only place a bearer secret is ever typed.
 *
 * It is a credential field, not a login form, because that is what the backend actually is:
 * `013` separated the subject that proposes a payment from the subject that approves it into a
 * CHECK on two tables, and a password box invented here would be a third subject the schema
 * knows nothing about. The secret lives in `sessionStorage`, so it dies with the tab; it is
 * never in a URL, never written by this component anywhere but that one call, and never shown
 * back after it is entered — the row holds an Argon2id digest, so nobody can read it again, and
 * a screen that displayed it would be implying it could.
 *
 * What the strip says while disconnected is the important half. A console that looked like it
 * was working while showing a labelled fixture is the failure this whole surface is built
 * against, so the sample state is announced, and the actions that would need a deployment
 * refuse in the same words on every screen.
 */
export function ConnectPanel() {
  const { view, connected, error, connect, forget, refresh, loading } = useConsole()
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)

  // A bearer here is three dotted parts — `org….ucrd_….secret` — because the row it verifies
// against carries the tenant it belongs to. Testing `startsWith('ucrd_')` was therefore wrong
// about every credential this system mints, and it warned people off the string that was right.
const isHumanSecret = draft.trim().includes('.ucrd_')

  return (
    <section className="connect" aria-label="Deployment connection">
      <div className="connect-state">
        <span className="label">{connected ? 'CONNECTED TENANT' : 'SAMPLE TENANT'}</span>
        <p className="connect-notice" role="status">
          {view.notice}
        </p>
        {error !== null && <p className="connect-error">{error}</p>}
        {view.unavailable.length > 0 && (
          <p className="connect-hint">
            Read without a refusal: {view.transactions.length + view.auditEvents.length} rows
            drawn. Refused for this credential:{' '}
            {view.unavailable.map((item) => `${item.route}: ${item.reason}`).join(' · ')}
          </p>
        )}
      </div>

      {connected ? (
        <div className="connect-actions">
          <button type="button" className="field connect-button" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'READING' : 'RE-READ'}
          </button>
          <button
            type="button"
            className="field connect-button"
            onClick={() => {
              forget()
              setHint(null)
            }}
          >
            FORGET CREDENTIAL
          </button>
        </div>
      ) : (
        <form
          className="connect-form"
          onSubmit={(event) => {
            event.preventDefault()
            const presented = draft.trim()
            if (presented.length === 0) return
            void connect(presented)
            setDraft('')
          }}
        >
          <label className="label" htmlFor="ari-credential">
            USER CREDENTIAL (ucrd_…)
          </label>
          <div className="connect-row">
            <input
              id="ari-credential"
              className="field"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setHint(null)
              }}
              placeholder="org….ucrd_….secret, or a bare ucrd_… where the deployment stores one"
            />
            <button type="submit" className="field connect-button">
              CONNECT
            </button>
          </div>
          <p className="connect-hint">
            {hint ??
              'Kept in this tab only, and gone when you close it. An agent credential (crd_…) will not open the human routes.'}
          </p>
          {draft.length > 0 && !isHumanSecret && (
            <p className="connect-hint" data-kind="warning">
              That does not start with <code>ucrd_</code>. It will be sent as presented and the
              deployment will answer the same way it answers a wrong secret.
            </p>
          )}
        </form>
      )}
    </section>
  )
}
