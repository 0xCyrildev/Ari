import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { waitlistUrlIsSafe } from './tls'
import { retryWithinBudget, safeErrorSummary } from './retry'
import { waitlistSignups } from './schema'

/**
 * The waitlist's own connection, and the reason it is not the one the API uses.
 *
 * `DATABASE_URL` in this repository is the Ari deployment's operational database: its schema
 * holds limit counters, reservations, signing tickets and an append-only audit chain, and both
 * services connect as `ari_app` under row security. A marketing form pointed at the same URL
 * would put a public, drizzle-managed, tenant-less `waitlist_signups` table into the database
 * that moves money — and `ari_app` holds no grant on it, so the first signup would fail with a
 * permission error nobody holding the form could interpret. Sharing a login between a public
 * funnel and a payment authority is not a decision anyone should be able to make by forgetting
 * one environment variable.
 *
 * So this reads `WAITLIST_DATABASE_URL`, and `waitlistProblem` is asked before every write: a
 * 503 with a code, rather than a 500 that looks like a broken form. The pool is built lazily on
 * purpose — a module-scope throw would fail `next build` for every clone with no waitlist
 * configured, which is the common case, and a build gate that requires a database nobody asked
 * for is a gate that gets deleted.
 */

export type WaitlistProblem = 'UNCONFIGURED' | 'SHARES_OPERATIONAL_DATABASE' | 'UNENCRYPTED_CONNECTION'

export function waitlistProblem(env: NodeJS.ProcessEnv = process.env): WaitlistProblem | null {
  const url = env.WAITLIST_DATABASE_URL ?? ''
  if (url.length === 0) return 'UNCONFIGURED'
  if (url === env.DATABASE_URL) return 'SHARES_OPERATIONAL_DATABASE'
  // A hosted Postgres reached without a verifying sslmode is the provider's default
  // connection string, and it sends every address in plaintext. Refused here rather than
  // at first signup, because the first signup is a person's email.
  if (!waitlistUrlIsSafe(url)) return 'UNENCRYPTED_CONNECTION'
  return null
}

const globalForDb = globalThis as unknown as { pool?: Pool }

function pool(): Pool {
  // `connectionTimeoutMillis` is stated rather than inherited: node-postgres' default is 10 s,
  // and a hosted Postgres that scales to zero can take longer than that to answer the first
  // socket of the day. The ceiling is not what fixes the cold start — `recordSignup`'s retry is —
  // but saying it out loud keeps the next person from tuning a number they cannot see.
  globalForDb.pool ??= new Pool({ connectionString: process.env.WAITLIST_DATABASE_URL, max: 2, connectionTimeoutMillis: 10_000 })
  globalForDb.pool.on('error', () => {
    // A connection that fails in the background has no request to answer. An unhandled `error`
    // event on an EventEmitter throws, which would take the process down over a signup.
  })
  return globalForDb.pool
}

export const waitlist = () => drizzle(pool(), { schema: { waitlistSignups } })

/**
 * One signup, retried within a budget.
 *
 * Measured on this project's own waitlist database: with the hosted compute asleep, the first
 * signup after an idle period failed, an immediate retry failed the same way inside 4.7 s, and a
 * request a few seconds later succeeded. So the remedy is a *patient* retry, not a second attempt
 * — what was missing was time, not another try. The budget is four attempts inside twelve seconds,
 * sized against that measured wake rather than picked: a database that is not waking at all must
 * answer with a refusal a visitor can read, not hang until the platform kills the request.
 *
 * Retrying is safe for exactly one reason: the insert is `on conflict do nothing` against a
 * `UNIQUE` column, so stating the same fact twice writes one row. Around a non-idempotent write
 * this would be a double charge wearing a form's clothes.
 *
 * `describe` reads structural fields only — a code, a name, a syscall. The error's `message` is
 * left out on purpose: it is the one place a query fragment can surface, and the value that
 * failed is somebody's email address, which does not go into a log. The response follows the same
 * rule from the other side.
 */
export async function recordSignup(email: string): Promise<void> {
  const insert = () => waitlist().insert(waitlistSignups).values({ email }).onConflictDoNothing({ target: waitlistSignups.email })
  await retryWithinBudget(insert, safeErrorSummary)
}

export { waitlistSignups }
