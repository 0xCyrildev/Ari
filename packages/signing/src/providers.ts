/**
 * The signing boundary's provider contract (§13).
 *
 * `SigningProvider` has no method that accepts a transaction. That absence is
 * the API-level expression of S4: there is nothing to call wrongly. A caller
 * arrives with an already-authorized request whose digest has been verified, or
 * it does not arrive at all.
 *
 * The interface is submit-then-poll because Ika is (ASSUMPTIONS I7). A
 * synchronous `sign()` would be a shape Ari could not honour when the real
 * provider lands, and the shape a system is built around is the shape its
 * failure modes take.
 */

import type { CanonicalDigest } from '@ari/schemas';

/** What a verified ticket authorises. Note what is absent: no candidate, no key. */
export interface AuthorizedSigningRequest {
  readonly ticketId: string;
  readonly walletId: string;
  readonly digest: CanonicalDigest;
  /**
   * The canonical bytes the digest commits to. The provider signs *these*, and
   * the signer has already re-hashed them against the ticket, so a caller cannot
   * present a digest it approved alongside different bytes (T11).
   */
  readonly canonical: string;
}

export interface SigningRef {
  readonly providerRef: string;
}

export type SigningStatus =
  | { readonly state: 'PENDING' }
  | {
      readonly state: 'COMPLETE';
      readonly signature: string;
      /**
       * Carried on the result rather than in a comment, because the only failure
       * mode that matters here is someone presenting a mock as chain truth (A10).
       * Every consumer that renders or reasons about a signature has to read this
       * field to get the answer at all.
       */
      readonly trustworthy: boolean;
      readonly provider: string;
    }
  | { readonly state: 'FAILED'; readonly reason: string };

export interface SigningProvider {
  readonly name: string;
  createSigningRequest(request: AuthorizedSigningRequest): Promise<SigningRef>;
  getStatus(ref: SigningRef): Promise<SigningStatus>;
}

/**
 * Records every invocation and can be asked whether it was called at all.
 *
 * The counter is the point (A9). "The signing provider must never be reached on
 * a denied request" is a claim about an absence, and an absence is invisible to
 * a log-grep: a test that asserts *zero* is the only witness that will not
 * agree to a story.
 */
export class MockSigningProvider implements SigningProvider {
  readonly name = 'mock';
  invocations = 0;
  readonly digests: CanonicalDigest[] = [];

  async createSigningRequest(request: AuthorizedSigningRequest): Promise<SigningRef> {
    this.invocations += 1;
    this.digests.push(request.digest);
    return { providerRef: `mock-ref-${this.invocations}` };
  }

  async getStatus(ref: SigningRef): Promise<SigningStatus> {
    return {
      state: 'COMPLETE',
      signature: `mock-signature-for-${ref.providerRef}`,
      trustworthy: false,
      provider: this.name,
    };
  }
}

/**
 * The Ika provider is a type and nothing else, deliberately (Phase 8).
 *
 * An implementation here would be a guess dressed up as an integration, and the
 * brief's own standard — and invariant S12 — is that an absent feature is a
 * smaller error than a fake one presented as real. What it will need is already
 * pinned down in `ASSUMPTIONS.md` §6: whether `futureSign` binds its message,
 * whether a presign is single-use, and what a fee actually costs.
 */
export interface IkaSigningProvider extends SigningProvider {
  readonly network: 'testnet' | 'mainnet';
}
