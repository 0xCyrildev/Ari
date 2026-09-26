/**
 * Canonicalisation and lifecycle.
 *
 * `canonicalize` is the most security-relevant 40 lines in the repository. The
 * digest it produces is what policy evaluates, what a human approves, what the
 * ticket seals and what the signer re-verifies. If two stages disagree about how
 * bytes are produced, an attacker does not need to bypass the policy engine —
 * they need only make the approval and the signature disagree (THREAT_MODEL
 * T10, T11, T12). If it has a collision, nothing else in Ari matters.
 *
 * Properties that are tested, not asserted:
 *   - deterministic and key-order independent
 *   - every substitution-critical field participates
 *   - bigint values survive at full precision (no JSON number anywhere)
 *   - the algorithm version is inside the digest string itself
 */

import { createHash } from 'node:crypto';
import {
  CandidateTransaction,
  CanonicalDigest,
  DIGEST_FIELD_ALLOWLIST,
  type CanonicalDigest as CanonicalDigestType,
} from '@ari/schemas';
import { z } from 'zod';

/** Versioned so a future change cannot silently reinterpret old digests. */
export const CANONICAL_VERSION = 'canon/v1' as const;
const PREFIX = `${CANONICAL_VERSION}:`;

/**
 * Deterministic, type-tagged encoding.
 *
 * Type tags are not decoration: without them `{amount: "10"}` and
 * `{amount: 10}` (bigint) would encode identically, and a field that changes
 * JSON type during a refactor would keep its digest while changing its meaning.
 */
export function canonicalEncode(value: unknown): string {
  if (typeof value === 'bigint') return `b${value.toString()}`;
  if (typeof value === 'boolean') return `d${value ? 1 : 0}`;
  if (typeof value === 'string') return `s${value.length}:${value}`;
  if (value === null) return 'n';
  if (value === undefined) return 'u';
  if (Array.isArray(value)) {
    return `a[${value.map((item) => canonicalEncode(item)).join(',')}]`;
  }
  if (value instanceof Uint8Array) {
    return `y${value.byteLength}:${Buffer.from(value).toString('hex')}`;
  }
  if (typeof value === 'object') {
    // A `Date`, a `Map`, a class instance: `Object.keys` finds nothing on any of them,
    // so they encode as `o{}` — every one of them, distinctly different, identically
    // digested. Unreachable through a parsed candidate, which is exactly the kind of
    // "the type system means it" reasoning this file refuses to rely on for a digest.
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      const name = (prototype as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'non-plain';
      throw new TypeError(`canonicalEncode: a ${name} has no canonical form; convert it to a plain value first`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const body = keys
      .map((key) => `${canonicalEncode(key)}=>${canonicalEncode(record[key])}`)
      .join(',');
    return `o{${body}}`;
  }
  if (typeof value === 'number') {
    // Reaching this line means a float entered the money path. Refusing is the
    // feature; encoding it "best effort" would be the bug.
    throw new TypeError(
      'canonicalize: float numbers are not encodable — use bigint raw units with an explicit unit',
    );
  }
  throw new TypeError(`canonicalize: unsupported value of type ${typeof value}`);
}

export interface CanonicalizationContext {
  readonly policyVersionId: string;
}

/**
 * Field selection is an allowlist owned by `@ari/schemas`. Two copies of that
 * list is the T10 substitution bug in waiting: the day they disagree, the
 * transaction a human approved and the transaction that gets signed may differ
 * by exactly the field one copy forgot.
 */
export function canonicalize(
  candidate: CandidateTransaction,
  context: CanonicalizationContext,
): string {
  const source = candidate as unknown as Record<string, unknown>;
  const selected: Record<string, unknown> = {};
  for (const field of DIGEST_FIELD_ALLOWLIST) {
    const value = source[field];
    if (value !== undefined) selected[field] = value;
  }
  selected.__policyVersion = context.policyVersionId;
  return canonicalEncode(selected);
}

/**
 * The only sanctioned way to obtain a `CanonicalDigest`. It is not exported as a
 * raw hash: callers get a branded value or nothing, which is what stops a
 * component computing "its own" digest of something slightly different.
 */
export function computeDigest(
  candidate: CandidateTransaction,
  context: CanonicalizationContext,
): CanonicalDigestType {
  const hex = createHash('sha256').update(canonicalize(candidate, context)).digest('hex');
  return CanonicalDigest.parse(`${PREFIX}${hex}`);
}

/**
 * Re-derive and compare. Used at approval redemption, at ticket minting and at
 * signing. Constant-time comparison is not needed for a digest both sides
 * computed themselves, and saying so here prevents someone adding a
 * timingSafeEqual that implies a secret is being compared.
 */
export function verifyDigest(
  candidate: CandidateTransaction,
  context: CanonicalizationContext,
  digest: CanonicalDigestType,
): boolean {
  return computeDigest(candidate, context) === digest;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const LifecycleState = z.enum([
  'DRAFT',
  'VALIDATED',
  'EVALUATING',
  'DENIED',
  'APPROVAL_PENDING',
  'APPROVAL_GRANTED',
  'APPROVAL_REJECTED',
  'APPROVAL_EXPIRED',
  'RESERVED',
  'TICKET_MINTED',
  'SIGNING_PENDING',
  'SIGNING_COMPLETE',
  'SIGNING_FAILED',
  'SIGNING_TIMEOUT',
  'BROADCAST',
  'BROADCAST_CONFIRMED',
  'ABANDONED',
]);
export type LifecycleState = z.infer<typeof LifecycleState>;

/**
 * Terminal states have no outgoing edges. `DENIED` in particular is absorbing:
 * re-deciding a denied request until it says yes is how an authorization system
 * becomes a retry loop, so a second attempt must be a new request with its own
 * audit chain (ARCHITECTURE §4).
 *
 * `TICKET_MINTED → SIGNING_PENDING` is the one edge after which funds may become
 * movable, and the dashboard highlights it for that reason.
 */
const TRANSITIONS = {
  DRAFT: ['VALIDATED', 'DENIED', 'ABANDONED'],
  VALIDATED: ['EVALUATING', 'DENIED', 'ABANDONED'],
  EVALUATING: ['DENIED', 'APPROVAL_PENDING', 'RESERVED', 'ABANDONED'],
  DENIED: [],
  APPROVAL_PENDING: ['APPROVAL_GRANTED', 'APPROVAL_REJECTED', 'APPROVAL_EXPIRED', 'DENIED', 'ABANDONED'],
  APPROVAL_GRANTED: ['RESERVED', 'DENIED', 'ABANDONED'],
  APPROVAL_REJECTED: [],
  APPROVAL_EXPIRED: [],
  RESERVED: ['TICKET_MINTED', 'DENIED', 'ABANDONED'],
  TICKET_MINTED: ['SIGNING_PENDING', 'ABANDONED'],
  SIGNING_PENDING: ['SIGNING_COMPLETE', 'SIGNING_FAILED', 'SIGNING_TIMEOUT'],
  SIGNING_COMPLETE: ['BROADCAST', 'ABANDONED'],
  SIGNING_FAILED: ['ABANDONED'],
  SIGNING_TIMEOUT: ['SIGNING_PENDING', 'ABANDONED'],
  BROADCAST: ['BROADCAST_CONFIRMED', 'ABANDONED'],
  BROADCAST_CONFIRMED: [],
  ABANDONED: [],
} as const satisfies Record<LifecycleState, readonly LifecycleState[]>;

export type TransitionTable = typeof TRANSITIONS;

export function allowedTransitions(from: LifecycleState): readonly LifecycleState[] {
  return TRANSITIONS[from];
}

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return (TRANSITIONS[from] as readonly string[]).includes(to);
}

export function isTerminal(state: LifecycleState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** Reservation release on failure paths (THREAT_MODEL T13/T23). */
export function releasesReservation(state: LifecycleState): boolean {
  return (
    state === 'DENIED' ||
    state === 'ABANDONED' ||
    state === 'APPROVAL_REJECTED' ||
    state === 'APPROVAL_EXPIRED' ||
    state === 'SIGNING_FAILED' ||
    state === 'SIGNING_TIMEOUT'
  );
}
