/**
 * The authorization ticket (CC1, ADR-5, invariant S4).
 *
 * A ticket is the only thing the authority plane accepts, so its three
 * properties are the whole of Ari's structural claim:
 *
 *   - **sealed** — an HMAC over the exact bytes of the claims, with a key both
 *     planes hold. That is what ADR-5 actually buys, and it is worth stating
 *     precisely rather than at its best: the signer cannot be *tricked* into
 *     signing bytes whose digest was not sealed, because it re-hashes what it is
 *     handed and compares. A compromised decision plane can still seal a
 *     transaction its policy should not have allowed, which is why the digest,
 *     the approval view and the audit trail all re-derive the same bytes.
 *   - **short-lived** — 60 seconds, checked against a supplied clock rather than
 *     `Date.now()`, so the check is testable and replayable like everything else
 *     in the kernel.
 *   - **single-use** — the redemption is a claim on a store, not a flag on the
 *     ticket, because a ticket is a string and strings can be copied.
 */

import { AuthorizationTicket, TicketClaims, type CanonicalDigest } from '@ari/schemas';
import type { ChainFamily, ChainTransactionDigest } from '@ari/chain-core';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { headOf, keysOf, type Seal } from './ring.js';

/** Hard ceiling on a ticket's lifetime. A longer seal is refused, not honoured. */
export const TICKET_TTL_MS = 60_000n;

export class TicketKey {
  constructor(readonly secret: string, readonly id = 'v1') {
    // A short sealing key makes every property above theoretical, and the
    // configuration that supplies one is a deploy-time accident, not a runtime
    // surprise someone remembers to test for.
    if (secret.length < 32) {
      throw new RangeError('ticket key must be at least 32 characters; generate with `openssl rand -base64 48`');
    }
  }

  sign(payload: string): string {
    return base64url(createHmac('sha256', this.secret).update(`${this.id}:`).update(payload).digest());
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function encodeClaims(claims: TicketClaims): string {
  // Big integers are decimal strings on the wire. A JSON number would silently
  // round a wei-scale amount, and the payload bytes are what the HMAC commits to.
  return JSON.stringify(claims, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

export type SealResult = { readonly ok: true; readonly ticket: AuthorizationTicket } | { readonly ok: false; readonly reason: string };

/**
 * The only constructor of an `AuthorizationTicket`.
 *
 * Callers hand over claims and get back a branded string; the brand plus this
 * single export is what makes "we skipped authorization" unrepresentable rather
 * than merely discouraged (S4). Note what is *not* here: no candidate
 * transaction, no key, no signature. A ticket cannot be minted from anything
 * that has not already been decided.
 */
export function sealTicket(claims: TicketClaims, seal: Seal<TicketKey>): SealResult {
  const parsed = TicketClaims.safeParse(claims);
  if (!parsed.success) {
    return { ok: false, reason: `claims are not well-formed: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  const lifetime = parsed.data.expiresAtMs - parsed.data.issuedAtMs;
  if (lifetime <= 0n || lifetime > TICKET_TTL_MS) {
    return { ok: false, reason: `ticket lifetime ${lifetime}ms is outside (0, ${TICKET_TTL_MS}ms]` };
  }
  const payload = base64url(Buffer.from(encodeClaims(parsed.data), 'utf8'));
  // The head, always: a ring exists so an old seal still *verifies*, not so new work is
  // signed with a key an operator is on the way to retiring.
  return { ok: true, ticket: AuthorizationTicket.parse(`${payload}.${headOf(seal).sign(payload)}`) };
}

export type OpenResult =
  | { readonly ok: true; readonly claims: TicketClaims; readonly keyId: string }
  | { readonly ok: false; readonly reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'UNPARSEABLE_CLAIMS' };

/**
 * Verify the seal and read the claims. Checks nothing else — expiry and
 * single-use are the signer's, because they depend on a clock and a store that
 * this function deliberately does not own.
 *
 * Accepts a ring, and reports which key in it verified. That field is not for the
 * signature check — any key that reproduces the MAC is enough for that — it is for the
 * operator mid-rotation, who needs to know that traffic is still arriving under the seal
 * they intend to retire and when it stops.
 */
export function openTicket(ticket: string, seal: Seal<TicketKey>): OpenResult {
  const parts = ticket.split('.');
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const [payload, signature] = parts;
  const presented = Buffer.from(signature!, 'base64url');
  let verified: { claims: TicketClaims; keyId: string } | null = null;
  for (const key of keysOf(seal)) {
    const expected = Buffer.from(key.sign(payload!), 'base64url');
    // Same-length comparison first, because timingSafeEqual throws on a mismatch
    // and a throw here would read as a malformed ticket rather than a bad seal.
    if (expected.byteLength !== presented.byteLength || !timingSafeEqual(expected, presented)) continue;
    try {
      const claims = TicketClaims.safeParse(JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')));
      if (!claims.success) return { ok: false, reason: 'UNPARSEABLE_CLAIMS' };
      verified = { claims: claims.data, keyId: key.id };
      break;
    } catch {
      return { ok: false, reason: 'UNPARSEABLE_CLAIMS' };
    }
  }
  if (verified === null) return { ok: false, reason: 'BAD_SIGNATURE' };
  return { ok: true, claims: verified.claims, keyId: verified.keyId };
}

/**
 * The claims a caller must assemble to get a ticket minted.
 *
 * `digest` is the only transactional content. There is no field here that could
 * carry a transaction, so a caller that has not canonicalised and decided cannot
 * build one — the type is the boundary.
 */
export interface TicketRequest {
  readonly ticketId: string;
  readonly requestId: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly policyVersionId: string;
  readonly digest: CanonicalDigest;
  readonly chain: ChainFamily;
  readonly signingDigest: ChainTransactionDigest;
  readonly txDigest: ChainTransactionDigest | null;
  readonly bytesSha256: string;
  readonly byteLength: bigint;
  readonly amountRaw: bigint;
  readonly issuedAtMs: bigint;
  readonly authorityMode: 'delegated' | 'user_gated';
  readonly nonce: string;
}

export function claimsFor(request: TicketRequest, ttlMs: bigint = TICKET_TTL_MS): TicketClaims {
  return {
    ...request,
    expiresAtMs: request.issuedAtMs + ttlMs,
  };
}
