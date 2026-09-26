/**
 * The chain verifier, for a file and nothing else.
 *
 * This is the reason `@ari/audit`'s walk is a pure function: an export handed to an
 * auditor, a lawyer, an insurer or a counterparty has to be checkable by someone who
 * cannot query the tenant's tables. If this file reached for a database connection
 * anywhere in the loop it would be examining the evidence with the evidence's own answer
 * key, and the claim "Ari's history is verifiable by a third party" would be false.
 *
 * What it can prove, precisely: that the events in this file form an unbroken chain in
 * which every row's content agrees with the hash it carries — so an edit, a deletion or a
 * reordering shows up as a break. What it cannot prove is *provenance*: a chain that
 * verifies only against itself is a self-consistent document, which is why `--head` exists.
 * The head hash is the value worth having written down somewhere else at the moment the
 * payment happened; `verify --in export.json --head <that>` turns the file into evidence
 * rather than a story.
 */

import { verifyEventLog, type EventLogEntry } from '@ari/audit';
import { z } from 'zod';

/** The columns that were hashed, plus the two Postgres assigned and never entered the digest. */
const EventEntry = z
  .object({
    seq: z.union([z.string(), z.number()]).transform(String),
    madeAt: z.string(),
    id: z.string(),
    org: z.string(),
    actor: z.string(),
    actorType: z.string(),
    eventType: z.string(),
    resource: z.string().nullable(),
    resourceId: z.string().nullable(),
    request: z.string().nullable(),
    correlation: z.string().nullable(),
    policyVersion: z.string().nullable(),
    decision: z.string().nullable(),
    reasons: z.array(z.string()),
    severity: z.string(),
    meta: z.record(z.string(), z.unknown()),
    prev: z.string(),
    storedHash: z.string(),
  })
  .strict();

const ExportFile = z
  .object({
    organizationId: z.string(),
    exportedAt: z.string(),
    head: z.string(),
    events: z.array(EventEntry),
  })
  .strict();

export type AuditExport = z.infer<typeof ExportFile>;

export interface Verdict {
  readonly ok: boolean;
  readonly events: number;
  readonly breaks: readonly { readonly seq: string; readonly kind: string }[];
  readonly recomputedHead: string;
  /** The file's own claim about its head, checked against the recomputation. */
  readonly fileHeadMatches: boolean;
  /** Whether the third value — the one held somewhere else — agrees. Undefined if unasked. */
  readonly externalHeadMatches: boolean | undefined;
  readonly organizationId: string;
  readonly exportedAt: string;
}

export function parseExport(raw: unknown): AuditExport {
  const parsed = ExportFile.safeParse(raw);
  if (!parsed.success) {
    // Loud about the shape rather than permissive: an export this tool cannot read is a
    // different export format, and silently verifying "nothing" from a file whose fields
    // moved would be the worst possible answer to give someone holding evidence.
    throw new Error(`not an Ari audit export: ${parsed.error.issues[0]?.message ?? 'unrecognised shape'}`);
  }
  return parsed.data;
}

/**
 * Rows as they come back over HTTP, checked against the same schema the file is checked
 * against, and refused otherwise.
 *
 * This is not ceremony. An empty array verifies — every chain walk over no events returns
 * `ok: true` and the genesis head, because there is nothing to contradict. So a server that
 * renamed one column would, without this, turn `ari audit tail` into a tool that reported
 * "verified, no breaks" about rows it had silently dropped. The same rule `@ari/client`
 * applies to every response it parses: strict, and a field the contract does not describe is
 * a refusal rather than something to ignore.
 */
export function parseEventList(raw: unknown): EventLogEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error('expected an array of audit events');
  }
  return raw.map((entry, index) => {
    const parsed = EventEntry.safeParse(entry);
    if (!parsed.success) {
      throw new Error(
        `audit event ${index} is not a row this tool knows: ${parsed.error.issues[0]?.message ?? 'unrecognised shape'}`,
      );
    }
    return parsed.data satisfies EventLogEntry;
  });
}

export function verifyExport(file: AuditExport, expectedHead?: string): Verdict {
  const entries = file.events as unknown as readonly EventLogEntry[];
  const report = verifyEventLog(entries);
  return {
    ok: report.ok && report.head === file.head && (expectedHead === undefined || expectedHead === report.head),
    events: report.events,
    breaks: report.breaks,
    recomputedHead: report.head,
    fileHeadMatches: report.head === file.head,
    externalHeadMatches: expectedHead === undefined ? undefined : expectedHead === report.head,
    organizationId: file.organizationId,
    exportedAt: file.exportedAt,
  };
}
