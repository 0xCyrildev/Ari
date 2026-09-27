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
/**
 * `org_` + 36, a dot, `ucrd_` + 36, a dot, then a 43-character secret: 126 characters, and the
 * count is shown while typing because the failure this prevents is silent. A paste that clipped a
 * piece, or that a password manager rewrote, arrives as a different string and the deployment
 * answers it exactly as it answers a wrong secret — one shape, no detail, by design (T8). The
 * length is the only thing this field can say about the difference without echoing a capability
 * back into the DOM.
 */
const BEARER_LENGTH = 126

export function ConnectPanel() {
  const { view, connected, error, connect, forget, refresh, loading } = useConsole()
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)

  // Trimmed, because a paste that carried a newline is the same credential, and counting it
  // untrimmed told a person their secret was five characters long when their clipboard was fine.
  const presented = draft.trim()
  const parts = presented.split('.')
  const shape =
    parts.length !== 3
      ? `${parts.length} dot-separated parts, expected 3`
      : parts[0].length === 40 && parts[1].length === 41 && parts[2].length === 43
        ? '40 · 41 · 43, as expected'
        : `parts of ${parts.map((part) => part.length).join(' · ')}, expected 40 · 41 · 43`

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
            {presented.length === 0
              ? 'Kept in this tab only, and gone when you close it. An agent credential (crd_…) will not open the human routes.'
              : `${presented.length} characters · ${shape}`}
            {presented.length !== 0 && presented.length !== BEARER_LENGTH
              ? '. The deployment reads a wrong length exactly as it reads a wrong secret, so check the paste before assuming the credential is bad.'
              : ''}
          </p>
          {hint !== null && <p className="connect-hint">{hint}</p>}
          {presented.length > 0 && !presented.includes('.ucrd_') && (
            <p className="connect-hint" data-kind="warning">
              No <code>.ucrd_</code> section in it. That is either an agent credential, which will
              not open the human routes at all, or a paste that dropped the middle piece.
            </p>
          )}
        </form>
      )}
    </section>
  )
}
