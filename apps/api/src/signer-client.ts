/**
 * The decision plane's client for the authority plane.
 *
 * It exists because of a line in the threat model rather than for tidiness: T2's
 * structural mitigation is that *no API path returns a signature, a ticket, or a
 * provider reference*. The pipeline hands back a ticket to whoever called it, so
 * if the HTTP layer forwarded that to the agent, the agent would hold a
 * signing capability and the whole boundary would be decorative. Instead the API
 * delivers the ticket itself and tells the caller only what happened — and that delivery
 * travels over an address the agent has no route to, carrying a delivery credential only
 * this process holds whenever the deployment names one. The address and the credential
 * are two controls, not one stated twice: a platform that routes both services
 * publicly leaves the second one doing the work.
 */

export interface DeliveryRequest {
  readonly ticket: string;
  readonly canonical: string;
  /**
   * This process's request id, forwarded as a header so the two services write about the
   * same attempt using the same word. It is not part of the signing contract and never
   * enters the body: the signer's verifier works on the sealed ticket and the canonical
   * bytes, and anything else that travelled with them would be one more field someone has
   * to reason about when they ask what a signature covered.
   */
  readonly requestId?: string;
}

export type DeliveryResult =
  | { readonly accepted: true; readonly state: string }
  | { readonly accepted: false; readonly code: string; readonly detail: string };

export interface SignerClient {
  deliver(request: DeliveryRequest): Promise<DeliveryResult>;
}

export interface SignerClientOptions {
  /** An address an agent has no route to, on a deployment that can keep that promise. */
  readonly url: string;
  /**
   * The bearer the signer expects. Null sends no `authorization` header at all rather
   * than an empty one: a header that parses as an empty token is a different refusal from
   * a missing header, and the gate must not become the thing that distinguishes them.
   */
  readonly deliveryKey?: string | null;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export function createSignerClient(options: SignerClientOptions): SignerClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const deliveryKey = options.deliveryKey ?? null;

  return {
    async deliver(request) {
      let response: Response;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (deliveryKey !== null) headers.authorization = `Bearer ${deliveryKey}`;
      if (request.requestId !== undefined) headers['x-request-id'] = request.requestId;
      try {
        response = await doFetch(options.url, {
          method: 'POST',
          headers,
          // Named, not `JSON.stringify(request)`: the request now carries a field that
          // belongs to the transport and not to the contract, and the body the signer
          // parses must stay exactly the two things it verifies.
          body: JSON.stringify({ ticket: request.ticket, canonical: request.canonical }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // An unreachable signer is reported as "not signed". The alternative —
        // swallowing it and answering as though the request had been refused — would
        // leave a ticket minted and the operator told nothing happened.
        return {
          accepted: false,
          code: 'SIGNING_PROVIDER_ERROR',
          detail: `signer unreachable: ${(error as Error).message}`,
        };
      }

      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.status === 202) {
        return { accepted: true, state: String(body.state ?? 'SIGNING_PENDING') };
      }
      if (response.status === 401) {
        // Do not read the code out of the body on this path. The signer's own refusal
        // name is `TICKET_INVALID`-adjacent, and a *terminal* reading of a rejected
        // delivery credential would give the day's capacity back for what is a fault in
        // this deployment's configuration rather than an unspendable ticket.
        return { accepted: false, code: 'SIGNER_UNAUTHENTICATED', detail: 'the signer refused the delivery credential' };
      }
      const named = typeof body.code === 'string' && body.code.length > 0 ? body.code : null;
      if (named === null) {
        // **A missing code is never `TICKET_INVALID`.** Measured on the deployed pair on
        // 2026-09-28: `SIGNER_URL` carried a trailing slash, the signer answered its 404 —
        // `{"state":"NOT_FOUND"}`, no `code` — and defaulting the fallback to a terminal
        // name released the hold, wrote `reservation.released`, and moved the request to
        // `SIGNING_FAILED` while the ticket it had minted sat there unspent and spendable.
        // A misconfiguration was booked as a refusal the agent could never honour.
        //
        // So an answer this client cannot classify is reported as *not understood*, which is
        // transient by construction: the hold stays parked, the ticket stays redeemable, and
        // the operator's log says the truth. Terminal classifications belong to named codes.
        return { accepted: false, code: 'SIGNER_ANSWER_UNRECOGNISED', detail: `signer answered ${response.status} without a code` };
      }
      return {
        accepted: false,
        code: named,
        detail: String(body.detail ?? `signer answered ${response.status}`),
      };
    },
  };
}
