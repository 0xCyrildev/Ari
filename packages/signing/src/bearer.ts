/**
 * The bearer grammar and the comparison behind every shared-secret gate here.
 *
 * Three places in this repository already compare a presented secret against a
 * configured one, each with the same two statements: a length mismatch is not a secret
 * worth hiding, and equal lengths must be compared without an early exit — because
 * `timingSafeEqual` *throws* on unequal input, and a throw inside a refusal path reads
 * as a malformed request rather than as a denied one. Writing it once is not tidiness.
 * A fourth copy is how the length guard eventually goes missing in the one place that
 * needed it, and the failure would be silent in exactly the direction that matters.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * The presented token from an `Authorization: Bearer …` header, or null.
 *
 * Deliberately strict: a scheme this parser does not name is not a bearer credential,
 * and a gate that accepts `Basic` because it was close enough is a gate with two
 * grammars.
 */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const value = header.slice(7).trim();
  return value.length === 0 ? null : value;
}

/**
 * Constant-time on equal lengths; a length mismatch is not a secret worth hiding.
 *
 * An empty configured secret refuses everything rather than matching an empty
 * presented one: a deployment that named no secret must not accidentally accept the
 * absence of one.
 */
export function acceptsBearerSecret(configured: string, presented: string | null): boolean {
  if (configured.length === 0 || presented === null) return false;
  const expected = Buffer.from(configured, 'utf8');
  const candidate = Buffer.from(presented, 'utf8');
  return expected.byteLength === candidate.byteLength && timingSafeEqual(expected, candidate);
}
