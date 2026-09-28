/**
 * Whether the waitlist's database URL encrypts, decided without opening a socket.
 *
 * `@ari/ledger` (`src/connection.ts`), where it guards the database that moves money. This
 * file is a copy of its shape, and the reason is the workspace: `apps/web` is deliberately
 * outside it, so a Next app cannot import a package whose toolchain it was excluded to
 * avoid. That trade is only safe if the two decide alike, so
 * `tests/unit/waitlist-tls.test.ts` asserts agreement over a corpus of URLs rather than
 * trusting this comment — a security rule that drifts into a weaker copy of itself is the
 * failure this repository has already been bitten by twice.
 */

const LOOPBACK = /^(?:127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|localhost|::1)$/

/** True when the URL is safe to connect to: loopback, or TLS that verifies the peer. */
export function waitlistUrlIsSafe(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (LOOPBACK.test(host)) return true

  // `sslmode` wins when both parameters are present, which is what node-postgres does.
  const sslmode = parsed.searchParams.get('sslmode')?.toLowerCase() ?? null
  if (sslmode !== null) return sslmode === 'verify-full'
  return (parsed.searchParams.get('ssl') ?? '').toLowerCase() === 'true'
}
