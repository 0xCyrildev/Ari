import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
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

export type WaitlistProblem = 'UNCONFIGURED' | 'SHARES_OPERATIONAL_DATABASE'

export function waitlistProblem(env: NodeJS.ProcessEnv = process.env): WaitlistProblem | null {
  const url = env.WAITLIST_DATABASE_URL ?? ''
  if (url.length === 0) return 'UNCONFIGURED'
  if (url === env.DATABASE_URL) return 'SHARES_OPERATIONAL_DATABASE'
  return null
}

const globalForDb = globalThis as unknown as { pool?: Pool }

function pool(): Pool {
  globalForDb.pool ??= new Pool({ connectionString: process.env.WAITLIST_DATABASE_URL, max: 2 })
  globalForDb.pool.on('error', () => {
    // A connection that fails in the background has no request to answer. An unhandled `error`
    // event on an EventEmitter throws, which would take the process down over a signup.
  })
  return globalForDb.pool
}

export const waitlist = () => drizzle(pool(), { schema: { waitlistSignups } })
export { waitlistSignups }
