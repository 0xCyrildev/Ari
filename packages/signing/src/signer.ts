/**
 * The authority plane's decision point — what `ari-signer` does with a ticket.
 *
 * Everything here is a refusal that has its own name. That matters more than the
 * success path: an operator investigating "why didn't this pay" and an auditor
 * reconstructing an incident both need the difference between *the seal is not
 * ours*, *it aged out*, *someone already spent it*, and *those are not the bytes
 * that were approved*. Collapsing them into "invalid ticket" would leave the
 * most important distinction in the system — was this a bug, or an attack? — to
 * be guessed at.
 */

import { createHash } from 'node:crypto';
import { CANONICAL_VERSION } from '@ari/transaction-engine';
import type { CanonicalDigest, ReasonCode } from '@ari/schemas';
import { openTicket, TICKET_TTL_MS, type TicketKey } from './ticket.js';
import type { Seal } from './ring.js';

/** How far ahead of this process's clock a ticket's own issue time may claim to be. */
export const TICKET_CLOCK_SKEW_MS = 5_000n;
import type { AuthorizedSigningRequest, SigningProvider, SigningRef, SigningStatus } from './providers.js';

/**
 * Single-use, as a claim against a store.
 *
 * A ticket is a bearer string and strings get copied, so "used" cannot be a
 * property of the ticket. It has to be a fact about a database that survives the
 * process that asked.
 */
export interface TicketStore {
  /** Atomically mark `ticketId` spent against `digest`. False if already spent. */
  /**
   * `nowMs` is this process's clock, passed down so the store can compare it against the
   * expiry the *database* recorded. A seal's own expiry is a claim by whoever signed it;
   * the row's is a fact written at authorisation time, and single use without a window is
   * an authorisation that never lapses.
   */
  redeem(ticketId: string, digest: CanonicalDigest, nowMs: bigint): Promise<boolean>;
}

/** Test and single-process implementation. The Postgres form lives in `@ari/ledger`. */
export class InMemoryTicketStore implements TicketStore {
  private readonly spent = new Map<string, string>();

  async redeem(ticketId: string, digest: CanonicalDigest, _nowMs: bigint): Promise<boolean> {
    const existing = this.spent.get(ticketId);
    if (existing !== undefined) return false;
    this.spent.set(ticketId, digest);
    return true;
  }

  get size(): number {
    return this.spent.size;
  }
}

export interface SignerDeps {
  readonly key: Seal<TicketKey>;
  readonly store: TicketStore;
  readonly provider: SigningProvider;
  /**
   * Read once per attempt, and typed as a function so a process cannot pass a value it
   * captured at startup. That is exactly the bug this signature exists to prevent: the
   * signer used to hold a `bigint` taken when `startSigner` ran, so its expiry check
   * compared every ticket against the clock at process start — a ticket minted an hour
   * later still looked four minutes old, and the 60-second TTL was not enforced by the
   * one component that exists to enforce it. Tests still pin time by passing
   * `() => FIXED`; a deployment passes `() => BigInt(Date.now())`.
   */
  readonly nowMs: () => bigint;
  /** Wallets this signer holds capacity for. A ticket for another wallet is not its to honour. */
  readonly wallets: ReadonlySet<string>;
}

export interface SigningAttempt {
  readonly ticket: string;
  /** The canonical bytes to be signed. The digest is re-derived from these. */
  readonly canonical: string;
}

export type SignerOutcome =
  | {
      readonly status: 'SIGNED';
      readonly ticketId: string;
      readonly digest: CanonicalDigest;
      /**
       * The handle to poll, not the signature. A raw signature is never returned
       * to a caller (S16) — ASSUMPTIONS §4.5 is that a signature anyone holds,
       * anyone can broadcast, so it stays inside this process and the reconciliation
       * worker looks it up by ref.
       */
      readonly ref: SigningRef;
      readonly result: SigningStatus;
    }
  /**
   * Not a failure and not a success: a `user_gated` wallet is one where this
   * process cannot complete a signature at all, by construction (§2). Reporting
   * that as a refusal would be wrong, and reporting it as a signature would be
   * the single most misleading sentence available to this codebase.
   */
  | { readonly status: 'AWAITING_USER_SHARE'; readonly ticketId: string; readonly digest: CanonicalDigest }
  | { readonly status: 'REJECTED'; readonly code: ReasonCode; readonly detail: string };

function digestOf(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Verify independently, then ask the provider.
 *
 * The verification is not a restatement of the decision plane's checks. The
 * point of a second process is that it re-derives the digest from the bytes it
 * was handed and holds its own record of what has been spent, so a decision plane
 * that has been talked into sealing one thing cannot get another signed
 * (T10, T11, T25).
 */
export async function redeemAndSign(deps: SignerDeps, attempt: SigningAttempt): Promise<SignerOutcome> {
  const opened = openTicket(attempt.ticket, deps.key);
  if (!opened.ok) {
    return {
      status: 'REJECTED',
      code: opened.reason === 'BAD_SIGNATURE' ? 'SIGNER_KEY_MISMATCH' : 'TICKET_INVALID',
      detail: opened.reason,
    };
  }

  const claims = opened.claims;
  const now = deps.nowMs();

  // A seal is only worth the window it expires in, and the claim is checked
  // rather than trusted: the same key seals tickets in both directions, so a
  // year-long lifetime would verify perfectly if it were only read back.
  if (claims.expiresAtMs - claims.issuedAtMs > TICKET_TTL_MS) {
    return { status: 'REJECTED', code: 'TICKET_INVALID', detail: 'lifetime exceeds the ticket TTL' };
  }
  // The other half of the same distrust. Lifetime is bounded, but both endpoints are
  // self-reported by the decision plane, so a ticket claiming to be issued a year from
  // now expires a year and one minute from now — inside its TTL, and unreadable as
  // expired by any clock but this one. The bound is how far this process is willing to
  // believe another machine's clock, and it is not a synchronisation promise: hosts on
  // NTP are seconds apart, and anything claiming more than that is not a slow clock.
  if (claims.issuedAtMs > now + TICKET_CLOCK_SKEW_MS) {
    return {
      status: 'REJECTED',
      code: 'TICKET_INVALID',
      detail: `issued at ${claims.issuedAtMs}, which is more than ${TICKET_CLOCK_SKEW_MS}ms ahead of this signer's ${now}`,
    };
  }
  if (now >= claims.expiresAtMs) {
    return { status: 'REJECTED', code: 'TICKET_EXPIRED', detail: `expired at ${claims.expiresAtMs}, presented at ${now}` };
  }
  if (!deps.wallets.has(claims.walletId)) {
    return { status: 'REJECTED', code: 'TICKET_INVALID', detail: `wallet ${claims.walletId} is not held by this signer` };
  }

  const presented = digestOf(attempt.canonical);
  const sealed = claims.digest.startsWith(`${CANONICAL_VERSION}:`) ? claims.digest.slice(CANONICAL_VERSION.length + 1) : null;
  if (sealed === null || sealed !== presented) {
    return { status: 'REJECTED', code: 'TICKET_DIGEST_MISMATCH', detail: 'the bytes presented are not the bytes the ticket seals' };
  }

  if (claims.authorityMode === 'user_gated') {
    // The human's device holds the share; nothing in this process can finish the
    // ceremony, and the ticket is deliberately *not* consumed here — the same
    // authorisation is still valid when the second half arrives.
    return { status: 'AWAITING_USER_SHARE', ticketId: claims.ticketId, digest: claims.digest };
  }

  if (!(await deps.store.redeem(claims.ticketId, claims.digest, now))) {
    return { status: 'REJECTED', code: 'TICKET_ALREADY_USED', detail: claims.requestId };
  }

  const request: AuthorizedSigningRequest = {
    ticketId: claims.ticketId,
    walletId: claims.walletId,
    digest: claims.digest,
    canonical: attempt.canonical,
  };
  const ref = await deps.provider.createSigningRequest(request);
  const result = await deps.provider.getStatus(ref);
  return { status: 'SIGNED', ticketId: claims.ticketId, digest: claims.digest, ref, result };
}
