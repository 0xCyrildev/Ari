/**
 * The client against a scripted transport.
 *
 * What is being tested here is not HTTP — it is the two promises a client library can
 * break silently: that the bytes an agent sends are the bytes it meant (money as
 * decimal strings), and that the client cannot be talked into holding a capability.
 * The second is why a response carrying an unexpected field is a failure rather than
 * an ignored one, and why the assertions on `client.sign` are compile-time ones.
 */

import { CandidateTransaction } from '@ari/schemas';
import { describe, expect, it } from 'vitest';
import { createClient } from '../src/client.js';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';

const candidate = CandidateTransaction.parse({
  kind: 'transfer',
  chain: 'ethereum',
  requestId: 'req_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
  agentId: 'agt_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
  walletId: 'wal_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
  deadline: '2099-01-01T00:00:00.000Z',
  idempotencyKey: 'sdk-1',
  usdEstimate: null,
  asset: { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 },
  amount: { raw: '2500000000', unit: 'usdc-6dp' },
  recipient: { chain: 'ethereum', address: RECIPIENT },
  replayProtection: { scheme: 'account_sequence', nonce: '1', chainId: '1', gasLimit: null, maxFeePerUnit: null },
});

interface Sent {
  url: string;
  method: string;
  authorization: string | undefined;
  body: string;
}

function clientAnswer(status: number, body: unknown, contentType = 'application/json') {
  const sent: Sent[] = [];
  const client = createClient({
    baseUrl: 'http://api.test:4000/',
    credential: 'org_x.crd_y.secret',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(url),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers ?? {}).get('authorization') ?? undefined,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } });
    }) as typeof fetch,
  });
  return { client, sent };
}

function networkFailure(error: unknown) {
  return createClient({
    baseUrl: 'http://api.test:4000',
    credential: 'org_x.crd_y.secret',
    fetchImpl: (async () => {
      throw error;
    }) as typeof fetch,
  });
}

describe('the request an agent means', () => {
  it('posts a parsed candidate without tripping over its bigints', async () => {
    const { client, sent } = clientAnswer(200, { state: 'COMPLETE', requestId: 'txr_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b' });
    const result = await client.authorize({ candidate, idempotencyKey: 'sdk-1' });
    expect(result.ok).toBe(true);
    expect(sent[0]?.url).toBe('http://api.test:4000/v1/transactions/authorize');
    expect(sent[0]?.authorization).toBe('Bearer org_x.crd_y.secret');
    // The claim in one assertion: money left this process as a string.
    expect(sent[0]?.body).toContain('"raw":"2500000000"');
    expect(sent[0]?.body).not.toMatch(/"\d+n"/);
  });

  it('omits an approval token that was not given, and sends one that was', async () => {
    const bare = clientAnswer(200, { state: 'COMPLETE', requestId: 'txr_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b' });
    await bare.client.authorize({ candidate, idempotencyKey: 'k' });
    expect(bare.sent[0]?.body).not.toContain('approvalToken');

    const withToken = clientAnswer(200, { state: 'COMPLETE', requestId: 'txr_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b' });
    await withToken.client.authorize({ candidate, idempotencyKey: 'k', approvalToken: 'payload.signature' });
    expect(withToken.sent[0]?.body).toContain('"approvalToken":"payload.signature"');
  });

  it('reads a preview as a preview', async () => {
    const { client } = clientAnswer(200, {
      state: 'DECIDED',
      reserves: false,
      decision: { outcome: 'ALLOW', reasonCodes: [], policyVersionId: 'ppv_1', matchedRules: ['decision'] },
    });
    const result = await client.evaluate(candidate);
    expect(result.ok && result.value.reserves).toBe(false);
    expect(result.ok && result.value.decision.outcome).toBe('ALLOW');
  });
});

describe('an answer the client will not act on', () => {
  it('reports a refusal with the server’s own code', async () => {
    const { client } = clientAnswer(401, { code: 'UNAUTHENTICATED', detail: 'the credential was not accepted' });
    const result = await client.evaluate(candidate);
    expect(result).toEqual({
      ok: false,
      status: 401,
      code: 'UNAUTHENTICATED',
      detail: 'the credential was not accepted',
    });
  });

  it('refuses a 200 that grew a field the contract does not describe', async () => {
    // This is the assertion that would fire on the day someone "just adds" the ticket
    // to the authorize response so a client can sign with it itself. The client is not
    // allowed to be the leak, so it fails the shape instead.
    const { client } = clientAnswer(200, {
      state: 'COMPLETE',
      requestId: 'txr_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
      ticket: 'eyJhbGciOiJIUzI1NiJ9.sealed-capability',
    });
    const result = await client.authorize({ candidate, idempotencyKey: 'k' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('CONTRACT_MISMATCH');
    // And the refusal does not repeat the capability back into a log line.
    expect(result.ok === false && result.detail).not.toContain('sealed-capability');
  });

  it('calls a body that is not JSON a mismatch, not a crash', async () => {
    const { client } = clientAnswer(200, '<html>502 from the proxy</html>', 'text/html');
    const result = await client.evaluate(candidate);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('CONTRACT_MISMATCH');
  });

  it('keeps "no answer" apart from "refused"', async () => {
    const timeout = await networkFailure(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }))
      .evaluate(candidate);
    const down = await networkFailure(new Error('ECONNREFUSED')).evaluate(candidate);
    expect(timeout.ok === false && timeout.code).toBe('TIMEOUT');
    expect(down.ok === false && down.code).toBe('NETWORK');
    // A payment that was never asked about is not a payment that was declined.
    expect(timeout.ok === false && timeout.status).toBe(null);
  });

  it('escapes a request id on its way into a path', async () => {
    const { sent } = clientAnswer(200, { requestId: 'txr_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b', state: 'TICKET_MINTED', createdAt: '2026-09-26T10:00:00.000Z' });
    const client = createClient({
      baseUrl: 'http://api.test:4000',
      credential: 'c',
      fetchImpl: (async (url: string | URL | Request) => {
        sent.push({ url: String(url), method: 'GET', authorization: undefined, body: '' });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    await client.status('txr_../admin');
    expect(sent[0]?.url).not.toContain('/../');
  });
});

describe('what the client type does not offer', () => {
  it('has no way to ask for a signature', () => {
    const { client } = clientAnswer(200, { state: 'COMPLETE', requestId: 'txr_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b' });
    // @ts-expect-error there is no sign(), and this line fails to compile the day someone adds it
    void client.sign;
    // @ts-expect-error nor a ticket, nor a redeem, nor a provider handle
    void client.ticket;
    expect('sign' in client).toBe(false);
  });

  it('returns an answer that carries no capability', async () => {
    const { client } = clientAnswer(200, { state: 'COMPLETE', requestId: 'txr_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b' });
    const result = await client.authorize({ candidate, idempotencyKey: 'k' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // @ts-expect-error the parsed answer has no ticket field to reach for
    void result.value.ticket;
    // @ts-expect-error nor a signature, nor the provider's handle for one
    void result.value.ref;
  });
});
