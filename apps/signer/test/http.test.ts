/**
 * `ari-signer`'s HTTP route, driven over a real socket.
 *
 * This file exists because the route was tested by nothing. `handler.test.ts` calls
 * `createSignHandler` as a plain function, so the 404, the body cap, the JSON refusal
 * and the "answer whatever happens" 500 were claims about a socket nobody had touched —
 * and AGENTS.md already records what happens when a claim about the wire is checked
 * through a harness that does not reproduce it. A stubbed `sign` is why this can run
 * against a real server without a database: the transport is the thing under test, and
 * the authority plane behind it is exercised in `tests/security/`.
 *
 * Two servers, because the gate's whole claim is conditional: one bound with no delivery
 * secret, one with. A single server could not show that the second refuses in the same
 * shape regardless of what it was refused for.
 */

import { newId, type CanonicalDigest } from '@ari/schemas';
import type { SignerOutcome } from '@ari/signing';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSignHandler } from '../src/handler.js';
import { createSignerRequestHandler } from '../src/http.js';
import type { SignerLog } from '../src/log.js';

const digest = `canon/v1:${'a'.repeat(64)}` as CanonicalDigest;
const ticket = newId('tkt');
const deliveryKey = 'delivery-secret-for-tests-0123456789abcdef';

interface LoggedLine {
  readonly level: string;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
}

/**
 * A recorder rather than a `console` spy: the point of these assertions is which fields
 * the signer chose to write, and reading them out of a structured object is the same
 * claim the log makes. `JSON.stringify` on the way in, because the real sink serialises
 * and a cyclic field would throw there — the guard in `log.ts` exists for that case.
 */
function recordingLog(): { readonly log: SignerLog; lines(): LoggedLine[] } {
  const captured: LoggedLine[] = [];
  const push = (level: string) => (message: string, fields?: Readonly<Record<string, unknown>>): void => {
    captured.push(JSON.parse(JSON.stringify({ level, message, fields })) as LoggedLine);
  };
  return {
    lines: () => [...captured],
    log: { info: push('info'), warn: push('warn'), error: push('error') },
  };
}

interface Stub {
  readonly server: Server;
  readonly base: string;
  readonly outcomes: SignerOutcome[];
  /** How many times the request reached the verifier. */
  calls(): number;
  explodeWith(error: Error): void;
}

async function serve(
  deliveryKeyOrNull: string | null,
  extra: { readonly log?: SignerLog; readonly ready?: () => Promise<'ok' | 'unavailable'>; readonly version?: string } = {},
): Promise<Stub> {
  const outcomes: SignerOutcome[] = [];
  let calls = 0;
  let failure: Error | null = null;

  const handle = createSignHandler({
    sign: async () => {
      calls += 1;
      if (failure !== null) {
        const thrown = failure;
        failure = null;
        throw thrown;
      }
      return outcomes.shift() ?? { status: 'REJECTED', code: 'TICKET_INVALID', detail: 'stub' };
    },
  });

  const server = createServer(createSignerRequestHandler({ handle, deliveryKey: deliveryKeyOrNull, ...extra }));
  // Port 0, read back from the socket: a fixed port means two workers, or this box's own
  // running signer, decide what the assertions are about.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the listening socket has no address');
  return { server, base: `http://127.0.0.1:${address.port}`, outcomes, calls: () => calls, explodeWith: (error) => (failure = error) };
}

let open: Stub;
let gated: Stub;

beforeAll(async () => {
  open = await serve(null);
  gated = await serve(deliveryKey);
});

afterAll(async () => {
  for (const stub of [open, gated]) {
    stub.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => stub.server.close((error) => (error ? reject(error) : resolve())));
  }
});

const jsonBody = JSON.stringify({ ticket, canonical: 'o{}' });

function ask(stub: Stub, path: string, init?: Parameters<typeof fetch>[1]) {
  return fetch(`${stub.base}${path}`, init);
}

describe('readiness', () => {
  it('answers a GET with the probe it was given, and touches no verifier', async () => {
    const before = open.calls();
    const response = await ask(open, '/healthz');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    // `db` and `version` are new, and they are the reason the route exists: `{status:'ok'}`
    // was a claim about the socket. A signer whose database is unreachable cannot tell a
    // ticket from a string, so the answer that used to be honest was the one that hid it.
    expect(await response.json()).toEqual({ status: 'ok', db: 'ok', version: 'dev' });
    expect(open.calls()).toBe(before);
  });

  it('is a 503 when the probe says it cannot do its job', async () => {
    // Not a claim about the platform's retry policy — which belongs to the platform — but
    // the fact that this process could not redeem a ticket if one arrived right now.
    const down = await serve(null, { ready: async () => 'unavailable' });
    const response = await ask(down, '/healthz');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'degraded', db: 'unavailable', version: 'dev' });
    down.server.closeAllConnections();
    await new Promise<void>((resolve) => down.server.close(() => resolve()));
  });

  it('is the only GET it answers', async () => {
    expect((await ask(open, '/healthz/extra')).status).toBe(404);
  });
});

describe('the sign path', () => {
  it('forwards an accepted handoff as 202 with the waiting state, not a refusal', async () => {
    open.outcomes.push({ status: 'AWAITING_USER_SHARE', ticketId: ticket, digest });
    const response = await ask(open, '/v1/sign', { method: 'POST', body: jsonBody });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ticketId: ticket, state: 'SIGNING_PENDING', awaiting: 'USER_SHARE' });
  });

  it('refuses anything that is not this path and this method, without reading a body', async () => {
    for (const [path, init] of [
      ['/v1/sign', { method: 'GET' }],
      ['/', { method: 'POST', body: jsonBody }],
      ['/v1/sign/extra', { method: 'POST', body: jsonBody }],
      ['/healthz', { method: 'POST', body: jsonBody }],
    ] as const) {
      const before = open.calls();
      const response = await ask(open, path, init);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ state: 'NOT_FOUND' });
      expect(open.calls()).toBe(before);
    }
  });

  it('refuses a body that is not JSON at 400, and names the code', async () => {
    const response = await ask(open, '/v1/sign', { method: 'POST', body: 'not json' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ state: 'REJECTED', code: 'TICKET_INVALID', detail: 'expected a JSON body' });
  });

  it('refuses a body over the cap at 413 and stops reading it', async () => {
    const before = open.calls();
    const oversized = JSON.stringify({ ticket, canonical: 'x'.repeat(200 * 1024) });
    const response = await ask(open, '/v1/sign', { method: 'POST', body: oversized });
    expect(response.status).toBe(413);
    expect(open.calls()).toBe(before);
  });

  it('is the same route with a query string on it', async () => {
    // `req.url` carries the query, so a comparison against the bare path made
    // `/v1/sign?anything` a 404 — and a 404 answers with no refusal code, which the
    // decision plane then has to guess at. Found on the deployed pair, where a stray
    // parameter turned a working delivery into an unclassifiable one.
    const before = open.calls();
    open.outcomes.push({ status: 'REJECTED', code: 'TICKET_INVALID', detail: 'MALFORMED' });
    const response = await ask(open, '/v1/sign?cache=1758062400', { method: 'POST', body: jsonBody });
    expect(response.status).toBe(403);
    expect(open.calls()).toBe(before + 1);

    const health = await ask(open, '/healthz?ts=1');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', db: 'ok', version: 'dev' });
  });
});

describe('the delivery gate', () => {
  const signed = { method: 'POST' as const, body: jsonBody, headers: { authorization: `Bearer ${deliveryKey}` } };

  it('keeps readiness open, because the platform health check holds no secret', async () => {
    const response = await ask(gated, '/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', db: 'ok', version: 'dev' });
  });

  it('refuses an unsigned delivery and reads nothing from the socket', async () => {
    const before = gated.calls();
    const response = await ask(gated, '/v1/sign', { method: 'POST', body: jsonBody });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      state: 'REJECTED',
      code: 'SIGNER_UNAUTHENTICATED',
      detail: 'the delivery credential was not accepted',
    });
    expect(gated.calls()).toBe(before);
  });

  it('refuses a wrong credential in exactly the same shape', async () => {
    // The refusal must not be an oracle. Same status, same code, same detail, whether
    // nothing was presented or something close was — T8's enumeration rule, read from
    // the signing side.
    const missing = await ask(gated, '/v1/sign', { method: 'POST', body: jsonBody });
    const wrong = await ask(gated, '/v1/sign', {
      method: 'POST',
      body: jsonBody,
      headers: { authorization: `Bearer ${'w'.repeat(deliveryKey.length)}` },
    });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual(await missing.json());
  });

  it('answers the same refusal before it says anything about the path', async () => {
    // An unauthenticated probe learns no route table, and the order is the mechanism:
    // the gate precedes the 404.
    expect((await ask(gated, '/nothing-here', { method: 'GET' })).status).toBe(401);
    expect((await ask(gated, '/v1/sign', { method: 'POST', body: jsonBody, headers: { authorization: 'Bearer short' } })).status).toBe(401);
  });

  it('lets the configured credential through to the verifier', async () => {
    const before = gated.calls();
    gated.outcomes.push({ status: 'REJECTED', code: 'TICKET_DIGEST_MISMATCH', detail: 'bytes differ' });
    const response = await ask(gated, '/v1/sign', signed);
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe('TICKET_DIGEST_MISMATCH');
    expect(gated.calls()).toBe(before + 1);
  });
});

describe('a signer that throws instead of refusing', () => {
  it('still answers, and logs only the error name', async () => {
    const recorder = recordingLog();
    const loud = await serve(null, { log: recorder.log });
    loud.explodeWith(new Error('the provider threw with a message nobody may log'));
    const response = await ask(loud, '/v1/sign', { method: 'POST', body: jsonBody });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      state: 'REJECTED',
      code: 'SIGNING_PROVIDER_ERROR',
      detail: 'the signer could not complete the attempt',
    });
    // The message is the thing that must not reach a log: a provider's sentence can
    // carry a wallet id or a fragment of the sealed payload. Asserted against the whole
    // serialised line, because the field name is not the risk — the value is.
    const line = JSON.stringify(recorder.lines());
    expect(line).toContain('signing attempt failed');
    expect(line).toContain('"name":"Error"');
    expect(line).not.toContain('nobody may log');
    loud.server.closeAllConnections();
    await new Promise<void>((resolve) => loud.server.close(() => resolve()));
  });

  it('is still serving on the next request', async () => {
    open.outcomes.push({ status: 'REJECTED', code: 'TICKET_DIGEST_MISMATCH', detail: 'bytes differ' });
    const response = await ask(open, '/v1/sign', { method: 'POST', body: jsonBody });
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe('TICKET_DIGEST_MISMATCH');
  });
});

describe('what the signer writes about an attempt', () => {
  it('carries the decision plane\'s request id, and never the body it was given', async () => {
    const recorder = recordingLog();
    const heard = await serve(null, { log: recorder.log });
    const before = heard.calls();
    heard.outcomes.push({ status: 'REJECTED', code: 'TICKET_DIGEST_MISMATCH', detail: 'bytes differ' });
    const response = await fetch(`${heard.base}/v1/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'abc123' },
      body: JSON.stringify({ ticket, canonical: 'o{}' }),
    });
    expect(response.status).toBe(403);
    expect(heard.calls()).toBe(before + 1);

    const [line] = recorder.lines();
    expect(line?.message).toBe('signing attempt answered');
    expect(line?.level).toBe('info');
    // One id across two processes: `ari-api` writes the same value on its side of the
    // delivery, which is what turns "a ticket was parked" and "the signer refused it" into
    // one story rather than two events that happened to overlap.
    expect(line?.fields).toMatchObject({ httpRequestId: 'abc123', status: 403, code: 'TICKET_DIGEST_MISMATCH' });
    // The canonical bytes are the digest's input and the ticket is a capability until it is
    // spent; neither belongs in a file that outlives the request.
    expect(JSON.stringify(recorder.lines())).not.toContain('o{}');

    heard.server.closeAllConnections();
    await new Promise<void>((resolve) => heard.server.close(() => resolve()));
  });

  it('drops a caller-supplied id that is not a bounded opaque string', async () => {
    // The header is honoured so one attempt reads as one story, and only so: a value that
    // is prose, an escape sequence, or 4 KB long must not end up in every line this process
    // writes about the request that carried it.
    const recorder = recordingLog();
    const heard = await serve(null, { log: recorder.log });
    heard.outcomes.push({ status: 'REJECTED', code: 'TICKET_INVALID', detail: 'stub' });
    await fetch(`${heard.base}/v1/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'a'.repeat(200) },
      body: jsonBody,
    });
    const line = JSON.stringify(recorder.lines());
    expect(line).not.toContain('a'.repeat(200));
    heard.server.closeAllConnections();
    await new Promise<void>((resolve) => heard.server.close(() => resolve()));
  });

  it('reports a refused delivery at info, not warn', async () => {
    // With the gate on, this is the normal answer to everything that is not the decision
    // plane — scanners included. A run of them is worth noticing; one per stranger is not
    // an incident, and warn-level noise is how a real one stops being visible.
    const recorder = recordingLog();
    const gatedWithLog = await serve(deliveryKey, { log: recorder.log });
    const response = await ask(gatedWithLog, '/v1/sign', { method: 'POST', body: jsonBody });
    expect(response.status).toBe(401);
    const lines = recorder.lines();
    expect(lines.map((entry) => entry.level)).toEqual(['info']);
    expect(lines[0]?.fields?.code).toBe('SIGNER_UNAUTHENTICATED');
    gatedWithLog.server.closeAllConnections();
    await new Promise<void>((resolve) => gatedWithLog.server.close(() => resolve()));
  });
});
