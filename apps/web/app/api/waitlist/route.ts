import { NextResponse } from 'next/server'
import { waitlist, waitlistProblem, waitlistSignups } from '@/lib/db'

/**
 * The one thing this page writes.
 *
 * Two rules, both cheap and both easy to lose. The email is validated here rather than trusted
 * from the client, because the client is a browser someone can open devtools in, and the column
 * is `UNIQUE` so a repeat subscriber is absorbed rather than duplicated — `onConflictDoNothing`
 * is only honest because `db/waitlist.sql` puts the unique index on the column.
 *
 * And when there is no waitlist database configured, the answer is a 503 that says so, not a
 * 500 that reads as a broken form and not a silent success that files the address nowhere. An
 * operator who sees `WAITLIST_UNCONFIGURED` in a log knows what to do; one who sees a 200 does
 * not know the email was thrown away.
 */
export async function POST(request: Request) {
  const problem = waitlistProblem()
  if (problem !== null) {
    return NextResponse.json(
      { code: problem === 'UNCONFIGURED' ? 'WAITLIST_UNCONFIGURED' : 'WAITLIST_MISCONFIGURED' },
      { status: 503 },
    )
  }

  try {
    const body = await request.json()
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
    }

    await waitlist().insert(waitlistSignups).values({ email }).onConflictDoNothing({ target: waitlistSignups.email })
    return NextResponse.json({ ok: true })
  } catch {
    // One sentence for "the body was not JSON", "the column refused it" and "the database was
    // unreachable": which one it was is a fact about this process's configuration, and the
    // address that failed is somebody's email, so it does not go into a log either.
    return NextResponse.json({ error: 'Unable to join right now. Please try again.' }, { status: 500 })
  }
}
