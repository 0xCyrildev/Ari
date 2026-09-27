import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { waitlistSignups } from '@/lib/db/schema'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
    }

    await db.insert(waitlistSignups).values({ email }).onConflictDoNothing({ target: waitlistSignups.email })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to join right now. Please try again.' }, { status: 500 })
  }
}
