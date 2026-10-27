/**
 * Expiry across clock domains, and where a transaction may be constructed.
 *
 * Ari has one ticket TTL — 60 seconds — and today that is coherent, because there is no chain
 * artifact for it to disagree with. Once there is, four different clocks are in play and they are
 * not even the same unit:
 *
 *   - a Solana blockhash-bound transaction is rejectable after **150 slots**, which at the
 *     200 ms slot time set at epoch 1053 is about **30 seconds**;
 *   - a Sui transaction with `expiration: None` **never** expires, and is byte-identical on every
 *     network — so for Sui the absence of an expiry is also the absence of a network binding;
 *   - a Sui epoch is protocol configuration, not a constant, and the millisecond bounds in the
 *     newer expiration variants are documented as not yet implemented;
 *   - a 2PC-MPC signing ceremony is polled, and the vendor's own SDK raised its default poll
 *     timeout from 30 s to 600 s because 30 s was too short in practice.
 *
 * So a single global TTL cannot be right for all of them, and the direction of the error matters.
 * If the ticket outlives the chain artifact, the signature is obtained over bytes the network will
 * reject — and on Solana a durable-nonce transaction *advances the nonce and takes the fee even
 * when execution fails*, so a stale authorization is not merely useless, it is charged. If the
 * chain artifact outlives the ticket, the money is simply not moved and somebody re-asks. The
 * second is friction. The first is a paid mistake. Hence the rule below.
 */

import { z } from 'zod';
import type { Expiry } from './adapter.js';

/** A conservative default where slot times are not published (a local validator, or a slow cluster). */
export const CONSERVATIVE_SLOT_MILLIS = 400n;

/** Slots a blockhash-bound Solana transaction stays acceptable. */
export const SOLANA_BLOCKHASH_SLOTS = 150n;

/**
 * How long a chain artifact remains signable, in milliseconds. `null` means "this artifact has no
 * window Ari can price a ticket against" — reported rather than treated as infinite headroom,
 * because an unbounded artifact is the case to refuse, not the case that relaxes the ticket.
 */
export function chainValidityWindowMs(expiry: Expiry, slotMillis: bigint = CONSERVATIVE_SLOT_MILLIS): bigint | null {
  switch (expiry.domain) {
    case 'none':
      // No deadline, and on Sui no network binding either. Nothing honest to bound a ticket by.
      return null;
    case 'evm_nonce':
      // Also `null`, but for the opposite reason, and the two must not be conflated: an EVM
      // transaction has no *wall-clock* window because it does not age — it is superseded by an
      // equal nonce, and EIP-155 already put the chain id inside the payload. `none` above is
      // "nothing bounds this"; this is "something bounds it, and it is not a duration".
      // `chooseConstructionSite` reads that difference; `maxTicketTtlMs` deliberately does not.
      return null;
    case 'solana_blockhash':
      return SOLANA_BLOCKHASH_SLOTS * slotMillis;
    case 'solana_durable_nonce':
      // Never expires, exactly one use: the window is not the constraint, the nonce value is, and
      // Ari cannot assume the nonce it read is still the nonce that will be spent.
      return null;
    case 'sui_epoch':
      // Epoch length is protocol configuration and an epoch-sized ticket is a standing
      // authorization. Refused rather than guessed at.
      return null;
    case 'sui_validity':
      // The chain-and-nonce bound shape is what Ari wants, but its millisecond fields are not
      // enforced by the chain yet, so the real boundary is still the epoch.
      return null;
  }
}

/**
 * The largest ticket TTL that is honest about the artifact it authorises, less a margin for the
 * hop between the two processes. Bounding the ticket *inside* the chain window is the only
 * direction that fails safely: a ticket that outlives its transaction can produce a signature
 * over bytes no network will accept.
 */
export function maxTicketTtlMs(expiry: Expiry, deliveryMarginMs: bigint, slotMillis?: bigint): bigint | null {
  const window = chainValidityWindowMs(expiry, slotMillis);
  if (window === null) return null;
  const usable = window - deliveryMarginMs;
  return usable > 0n ? usable : 0n;
}

/**
 * Where the chain transaction bytes come from. This is the decision the four clocks force, and it
 * is easy to make silently.
 *
 * `pre_authorization` — the bytes exist before the decision, so their digest can be sealed in the
 * ticket and re-verified at signing. Strongest binding, but the artifact starts aging while the
 * decision is made, which a 600-second ceremony cannot survive.
 *
 * `at_signing` — the authority plane builds the bytes after re-verifying the sealed *semantic*
 * digest. The only shape that tolerates asynchronous signing, and it moves the adapter inside the
 * trust boundary: the signer holds the construction code, and the security property becomes "the
 * signer constructs only from the validated representation and refuses a semantic digest it did
 * not seal" instead of "nobody can hand the signer different bytes".
 *
 * A chain whose validity window is shorter than the ceremony must use `at_signing`, and that
 * consequence belongs in the threat model written down, not discovered during an incident.
 */
export const ConstructionSite = z.enum(['pre_authorization', 'at_signing']);
export type ConstructionSite = z.infer<typeof ConstructionSite>;

export interface BindingDecision {
  readonly site: ConstructionSite;
  readonly reason: string;
  /** Milliseconds the ceremony may take and still fit inside the artifact's own window. */
  readonly ceremonyBudgetMs: bigint | null;
}

/**
 * Which construction site a chain's expiry shape permits, given how long signing actually takes.
 * `ceremonyMs` for a mock provider is zero, which is exactly why this must be asked with a real
 * number: the answer on the mock is not the answer in production.
 */
export function chooseConstructionSite(
  expiry: Expiry,
  ceremonyMs: bigint,
  slotMillis?: bigint,
): BindingDecision {
  // Before the window is consulted: a sequence-bound artifact does not decay while a ceremony runs,
  // so `null` from `chainValidityWindowMs` here means "no duration applies", not "unbounded and
  // therefore unauthorizable". Treating every `null` alike would push EVM — Ari's one live chain —
  // into `at_signing` for the wrong reason, and the wrong reason is the part that misleads whoever
  // reads the log during an incident.
  if (expiry.domain === 'evm_nonce') {
    return {
      site: 'pre_authorization',
      ceremonyBudgetMs: null,
      reason: `the payload is bound to nonce ${expiry.nonce} and, by EIP-155, to its chain id; it stays `
        + `signable until an equal nonce supersedes it, so no wall-clock window constrains the ceremony`,
    };
  }
  const window = chainValidityWindowMs(expiry, slotMillis);
  if (window === null) {
    return {
      site: 'at_signing',
      ceremonyBudgetMs: null,
      reason: `the ${expiry.domain} expiry gives no usable window, so bytes built before the `
        + `decision cannot be assumed signable after it`,
    };
  }
  if (window - ceremonyMs <= 0n) {
    return {
      site: 'at_signing',
      ceremonyBudgetMs: window,
      reason: `the signing ceremony (${ceremonyMs}ms) does not fit inside the chain's own ${window}ms `
        + `validity window; pre-authorizing bytes would produce signatures for transactions the `
        + `network already rejects`,
    };
  }
  return {
    site: 'pre_authorization',
    ceremonyBudgetMs: window - ceremonyMs,
    reason: `bytes can be built and digested before the decision and still be ${window - ceremonyMs}ms `
      + `inside their validity window when signed`,
  };
}
