/**
 * The decision plane's client for the authority plane.
 *
 * It exists because of a line in the threat model rather than for tidiness: T2's
 * structural mitigation is that *no API path returns a signature, a ticket, or a
 * provider reference*. The pipeline hands back a ticket to whoever called it, so
 * if the HTTP layer forwarded that to the agent, the agent would hold a
 * signing capability and the whole boundary would be decorative. Instead the API
 * delivers the ticket itself, over an internal address an agent cannot reach, and
 * tells the caller only what happened.
 */

export interface DeliveryRequest {
  readonly ticket: string;
  readonly canonical: string;
}

export type DeliveryResult =
  | { readonly accepted: true; readonly state: string }
  | { readonly accepted: false; readonly code: string; readonly detail: string };

export interface SignerClient {
  deliver(request: DeliveryRequest): Promise<DeliveryResult>;
}

export interface SignerClientOptions {
  /** Internal only: an address an agent has no route to. */
  readonly url: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export function createSignerClient(options: SignerClientOptions): SignerClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return {
    async deliver(request) {
      let response: Response;
      try {
        response = await doFetch(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
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
      return {
        accepted: false,
        code: String(body.code ?? 'TICKET_INVALID'),
        detail: String(body.detail ?? `signer answered ${response.status}`),
      };
    },
  };
}
