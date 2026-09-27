import { bigint, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const waitlistSignups = pgTable('waitlist_signups', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
