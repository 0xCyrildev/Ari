/**
 * The three routes that exist so someone else can watch this process: `/healthz`,
 * `/metrics`, and the `x-request-id` header on every answer.
 *
 * These are checked against a stubbed `RouteDeps` rather than a live database, because what
 * is under test is the HTTP contract of the observability surface — the status it chooses,
 * who is allowed to read it, and what it says when it cannot say much. What the probe *is*
 * (a statement that a real pool answered) is asserted in `tests/security/`, where there is
 * one to answer.
 */

import fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PipelineDeps } from '../src/authorize.js';
import { ApiMetrics } from '../src/metrics.js';
import { registerRequestId, fastifyOptions } from '../src/observe.js';
import { registerRoutes, type RouteDeps } from '../src/routes.js';

const METRICS_TOKEN = 'metrics-token-for-tests-0123456789abcdefghijklmnop';

/**
 * Only `health`, `metrics`, `metricsToken` and `version` are ever reached by the requests
 * this file makes. The rest of the shape is a lie the type requires, and saying so here is
 * cheaper than building a database to satisfy it — the routes that would notice are the
 * ones `tests/security/api.test.ts` already drives for real.
 */
function depsFor(over: Partial<Pick<RouteDeps, 'health' | 'metricsToken' | 'version'>> = {}): RouteDeps {
  return {
    pipeline: {} as PipelineDeps,
    signer: { async deliver() { return { accepted: false, code: 'STUB', detail: 'stub' }; } },
    bootstrapToken: 'bootstrap-token-for-tests-long-enough',
    metrics: new ApiMetrics('test'),
    health: async () => 'ok',
    metricsToken: METRICS_TOKEN,
    version: 'test',
    ...over,
  };
}

function serve(deps: RouteDeps): FastifyInstance {
  // The same options `startApi` builds, so the `genReqId` behind the header assertions
  // below is the production one and not a reconstruction of it.
  const app = fastify(fastifyOptions({ level: 'silent' }));
  registerRoutes(app, deps);
  registerRequestId(app);
  return app;
}

let open: FastifyInstance;
let closed: FastifyInstance;
let degraded: FastifyInstance;

beforeAll(async () => {
  open = serve(depsFor());
  closed = serve(depsFor({ metricsToken: null }));
  degraded = serve(depsFor({ health: async () => 'unavailable' }));
  for (const app of [open, closed, degraded]) await app.ready();
});

afterAll(async () => {
  for (const app of [open, closed, degraded]) await app.close();
});

describe('/healthz', () => {
  it('answers without credentials, and says which dependency it checked', async () => {
    const response = await open.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', db: 'ok', version: 'test' });
  });

  it('is a 503 when the probe cannot answer, because a 200 is a promise about the service', async () => {
    // The trap this avoids is the one already recorded in this repository: a container that
    // binds loopback, starts cleanly, passes its own health check, and 502s from outside.
    // A health answer that describes only the socket is the same shape of lie.
    const response = await degraded.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'degraded', db: 'unavailable', version: 'test' });
  });

  it('names no URL, no role and no error text', async () => {
    const response = await degraded.inject({ method: 'GET', url: '/healthz' });
    expect(response.body).not.toMatch(/postgres|password|ari_app|127\.0|pool/i);
  });
});

describe('/metrics', () => {
  it('does not exist when no token was configured', async () => {
    // 404, not 401: a door that is advertised is a door someone will try. `closed` has no
    // metrics token at all, which is what "unset" is supposed to mean.
    const response = await closed.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('refuses a stranger and a near-miss in the same shape', async () => {
    const missing = await open.inject({ method: 'GET', url: '/metrics' });
    const wrong = await open.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${'m'.repeat(METRICS_TOKEN.length)}` },
    });
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(await wrong.json()).toEqual(await missing.json());
  });

  it('answers the configured bearer with text, not JSON', async () => {
    const response = await open.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('# TYPE ari_api_build_info gauge');
    expect(response.body).toContain('ari_api_build_info{version="test"} 1');
  });

  it('carries no label that could name a tenant', async () => {
    // T20: the scrape endpoint has no principal in front of it, so a series labelled by
    // organisation, agent, credential or request id would answer "who is moving how much"
    // for anyone holding one token. The counters are about the process, not about its
    // customers, and this is the assertion that keeps it that way.
    //
    // Labels only, not the whole text: `ari_api_credential_verifications_total` is a
    // metric *name* that has to say what it counts, and matching the whole exposition
    // would have the test fail for the wrong reason — which is the same mistake, in
    // reverse, as a name that promised a per-tenant series.
    const metrics = new ApiMetrics('test');
    metrics.noteRequest({ route: '/v1/transactions/authorize', method: 'POST', status: 200, seconds: 0.03 });
    metrics.noteCredentialVerify('agent', 'refused');
    metrics.noteDelivery('parked');
    metrics.noteReconciliation(false);
    metrics.notePool({ total: 10, idle: 8, waiting: 2 });
    const text = metrics.exposition();
    expect(text).toContain('ari_api_http_requests_total{method="POST",route="/v1/transactions/authorize",status="200"} 1');
    expect(text).toContain('ari_api_pool_connections{state="waiting"} 2');

    const labels = [...text.matchAll(/^\S+?\{([^}]*)\}/gm)].map((match) => match[1] ?? '');
    const keys = [...new Set(labels.flatMap((series) => series.split(',').map((pair) => pair.split('=')[0] ?? '')))];
    // A label *key* that names a subject is the leak. `kind="agent"` on a verification
    // counter is not: it says which of the two credential tables answered, from a set of
    // two, and is the same distinction the routes make out loud.
    for (const forbidden of ['org', 'orgId', 'agentId', 'credentialId', 'userId', 'digest', 'ticket', 'ticketId', 'requestId', 'route_path']) {
      expect(keys).not.toContain(forbidden);
    }
    // And no value is allowed to be an identifier, in the shape this repository's ids have.
    expect(labels.join('\n')).not.toMatch(/"(org|ag|wal|crd|ucrd|txr|tkt|apr|req|pol|pv)_/);
    expect(labels.join('\n')).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]/);
  });

  it('counts a histogram bucket cumulatively, as the format defines it', async () => {
    const metrics = new ApiMetrics('test');
    metrics.noteRequest({ route: '/x', method: 'GET', status: 200, seconds: 0.001 });
    metrics.noteRequest({ route: '/x', method: 'GET', status: 200, seconds: 0.2 });
    const lines = metrics.exposition().split('\n').filter((line) => line.startsWith('ari_api_http_request_seconds_bucket'));
    // `_bucket{le=x}` counts every observation at or below x, so the top bucket must equal
    // `_count` once everything fits inside it — the mistake this guards is reporting
    // per-bucket counts, which reads plausibly and is wrong everywhere except the top.
    expect(lines[0]).toMatch(/le="0\.005"\} 1$/);
    expect(lines[5]).toMatch(/le="0\.25"\} 2$/);
    expect(lines.at(-1)).toMatch(/le="\+Inf"\} 2$/);
    expect(metrics.exposition()).toMatch(/ari_api_http_request_seconds_count 2/);
  });
});

describe('x-request-id', () => {
  it('is minted when the caller sent none', async () => {
    const response = await open.inject({ method: 'GET', url: '/healthz' });
    expect(String(response.headers['x-request-id'])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours a well-formed one, and ignores prose', async () => {
    const kept = await open.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'trace-abc_123' } });
    expect(kept.headers['x-request-id']).toBe('trace-abc_123');

    const junk = await open.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': `${'x'.repeat(200)}\ninjected` } });
    expect(String(junk.headers['x-request-id'])).toMatch(/^[0-9a-f-]{36}$/);
    expect(junk.headers['x-request-id']).not.toContain('\n');
  });
});
