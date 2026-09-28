/**
 * The delivery client's own half of the gate: what it puts on the wire, and how it reads
 * back a refusal. The socket behaviour of the peer is asserted in
 * `apps/signer/test/http.test.ts`; the classification that matters for the ledger —
 * terminal versus parked — is asserted against the real routes in `tests/security/`.
 */

import { describe, expect, it } from 'vitest';
import { createSignerClient } from '../src/signer-client.js';

const key = 'delivery-secret-for-tests-0123456789abcdef';

interface Sent {
  url: string;
  headers: Record<string, string>;
}

function responder(status: number, body: Record<string, unknown>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    sent.push({ url: String(input), headers: (init?.headers ?? {}) as Sent['headers'] });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const request = { ticket: 'a'.repeat(60), canonical: 'o{}' };

describe('what the client puts on the wire', () => {
  it('sends no authorization header at all when the deployment named no secret', async () => {
    const { sent, fetchImpl } = responder(202, { state: 'COMPLETE' });
    await createSignerClient({ url: 'http://127.0.0.1:4100/v1/sign', fetchImpl }).deliver(request);
    // An empty bearer is a different refusal from no header at the gate, and a client
    // that sends one has invented a third state.
    expect(sent[0]?.headers.authorization).toBeUndefined();
    expect(sent[0]?.headers['content-type']).toBe('application/json');
  });

  it('presents the configured secret as a bearer', async () => {
    const { sent, fetchImpl } = responder(202, { state: 'COMPLETE' });
    const result = await createSignerClient({ url: 'http://127.0.0.1:4100/v1/sign', deliveryKey: key, fetchImpl }).deliver(request);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${key}`);
    expect(result).toEqual({ accepted: true, state: 'COMPLETE' });
  });
});

describe('how the client reads a refusal', () => {
  it('calls a 401 our credential being refused, whatever the body named', async () => {
    const { fetchImpl } = responder(401, { code: 'TICKET_INVALID' });
    const result = await createSignerClient({ url: 'http://127.0.0.1:4100/v1/sign', deliveryKey: key, fetchImpl }).deliver(request);
    // The classification is the money-bearing part. `TICKET_INVALID` is terminal, so
    // reading a rejected delivery credential through the body would give the day's
    // capacity back for a fault in this deployment's configuration.
    expect(result).toEqual({ accepted: false, code: 'SIGNER_UNAUTHENTICATED', detail: 'the signer refused the delivery credential' });
  });

  it('passes through the signer’s own reason at 403', async () => {
    const { fetchImpl } = responder(403, { code: 'TICKET_ALREADY_USED', detail: 'redeemed' });
    const result = await createSignerClient({ url: 'http://127.0.0.1:4100/v1/sign', deliveryKey: key, fetchImpl }).deliver(request);
    expect(result).toEqual({ accepted: false, code: 'TICKET_ALREADY_USED', detail: 'redeemed' });
  });

  it('calls an answer with no code "not understood", never a terminal ticket refusal', async () => {
    const { fetchImpl } = responder(404, { state: 'NOT_FOUND' });
    const result = await createSignerClient({ url: 'http://127.0.0.1:4100/v1/sign', deliveryKey: key, fetchImpl }).deliver(request);
    // The default on this path was `TICKET_INVALID`, which is terminal — so a `SIGNER_URL`
    // with a trailing slash released a day's capacity, wrote `reservation.released`, and
    // moved the request to `SIGNING_FAILED` while the minted ticket sat unspent and still
    // spendable. Measured on the deployed pair, 2026-09-28. An answer this client cannot
    // classify is this client's problem to report, not a refusal the agent cannot honour.
    expect(result).toEqual({
      accepted: false,
      code: 'SIGNER_ANSWER_UNRECOGNISED',
      detail: 'signer answered 404 without a code',
    });
  });

  it('reports an unreachable signer as an attempt that did not happen', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await createSignerClient({ url: 'http://127.0.0.1:4100/v1/sign', deliveryKey: key, fetchImpl }).deliver(request);
    expect(result.accepted).toBe(false);
    expect(result).toMatchObject({ code: 'SIGNING_PROVIDER_ERROR' });
  });
});
