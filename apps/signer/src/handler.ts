/**
 * The signer's request handling, kept free of transport so it can be tested and
 * reused without a socket.
 *
 * This is the authority plane: it does not evaluate policy, does not know what a
 * candidate transaction is, and cannot be told to sign something whose digest was
 * not sealed. What it decides is only whether *this ticket* is spendable, and it
 * reaches that decision with its own key, its own clock and its own record of
 * what has already been redeemed.
 */

import type { SignerOutcome } from '@ari/signing';

export interface SignRequest {
  readonly ticket: string;
  readonly canonical: string;
}

export type SignResponse = { readonly status: number; readonly body: Record<string, unknown> };

/** The HTTP status per outcome, and nothing more informative than the code. */
export function responseFor(outcome: SignerOutcome): SignResponse {
  switch (outcome.status) {
    case 'SIGNED':
      return {
        status: 202,
        body: {
          ticketId: outcome.ticketId,
          state: outcome.result.state,
          // The reconciliation key. The signature itself is deliberately absent:
          // whoever holds a signature can broadcast it (ASSUMPTIONS §4.5), so it
          // never leaves this process, and `providerRef` is what lets a caller
          // look up *whether* it happened without holding the thing that makes it
          // happen (S16).
          providerRef: outcome.ref.providerRef,
        },
      };
    case 'AWAITING_USER_SHARE':
      return {
        status: 202,
        body: {
          ticketId: outcome.ticketId,
          state: 'SIGNING_PENDING',
          awaiting: 'USER_SHARE',
        },
      };
    default:
      return { status: 403, body: { state: 'REJECTED', code: outcome.code, detail: outcome.detail } };
  }
}

export interface HandlerDeps {
  readonly sign: (request: SignRequest) => Promise<SignerOutcome>;
  /** Rejects anything that is not two strings before it reaches the verifier. */
  readonly maxCanonicalBytes?: number;
}

const DEFAULT_MAX_CANONICAL_BYTES = 64 * 1024;

export function createSignHandler(deps: HandlerDeps) {
  const maxBytes = deps.maxCanonicalBytes ?? DEFAULT_MAX_CANONICAL_BYTES;
  return async function handle(input: unknown): Promise<SignResponse> {
    if (
      typeof input !== 'object' ||
      input === null ||
      typeof (input as SignRequest).ticket !== 'string' ||
      typeof (input as SignRequest).canonical !== 'string'
    ) {
      return { status: 400, body: { state: 'REJECTED', code: 'TICKET_INVALID', detail: 'expected ticket and canonical' } };
    }
    const request = input as SignRequest;
    if (request.canonical.length === 0 || Buffer.byteLength(request.canonical, 'utf8') > maxBytes) {
      // A bounded size, because the canonical blob is attacker-influenced in
      // length through the transaction's own fields and this process should not
      // be the one place a large payload becomes an availability event (T23).
      return { status: 400, body: { state: 'REJECTED', code: 'TICKET_INVALID', detail: 'canonical blob out of range' } };
    }
    return responseFor(await deps.sign(request));
  };
}
