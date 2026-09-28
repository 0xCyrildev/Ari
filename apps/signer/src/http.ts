/**
 * `ari-signer`'s HTTP transport, separated from the process so the route can be driven
 * without a database.
 *
 * Two claims live here. The first is that the signer answers *something* to every
 * request: it is a signing process, and an outage caused by a client hanging up
 * mid-body is the availability half of T13's shape. The second is that the route table
 * is two paths long — `POST /v1/sign` and the readiness path — because everything the
 * process knows is a sealed ticket, and a surface that reports wallets, keys or counts
 * is a second decision plane with better visibility. A third now belongs to the same
 * file: when a delivery secret is configured, only a caller that presents it gets as far
 * as the first two claims.
 */

import { acceptsBearerSecret, bearerToken } from '@ari/signing';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SignerLog } from './log.js';
import { silentLog } from './log.js';
import type { createSignHandler } from './handler.js';

/** A bounded request body, because the canonical blob is attacker-influenced in length (T23). */
const MAX_REQUEST_BYTES = 128 * 1024;

const SIGN_PATH = '/v1/sign';
const HEALTH_PATH = '/healthz';

export interface SignerTransportDeps {
  readonly handle: ReturnType<typeof createSignHandler>;
  /**
   * The delivery secret this deployment requires, or null when the bind is loopback and
   * the operator has chosen not to set one. Presence enforces; a non-loopback bind
   * requires — the check is the same comparison the bootstrap gate makes, from the same
   * module, so the two cannot disagree about what a bearer token looks like.
   */
  readonly deliveryKey: string | null;
  /**
   * Absent means silent, which is what the transport tests want: they drive the route
   * without a database and have nothing to report. A process that means to be observed
   * passes one — the tests that assert *what was logged* do exactly that.
   */
  readonly log?: SignerLog;
  /**
   * Whether this process can still do its job. Absent answers `ok`, because a transport
   * with no database to reach is not lying about one; `main.ts` supplies the real probe.
   */
  readonly ready?: () => Promise<'ok' | 'unavailable'>;
  readonly version?: string;
}

export function createSignerRequestHandler(deps: SignerTransportDeps) {
  const log = deps.log ?? silentLog;
  return function requestHandler(req: IncomingMessage, res: ServerResponse): void {
    void route(deps, log, req, res);
  };
}

/**
 * Answer, whatever happens.
 *
 * The body read and `handle` were both outside any `try`, and the caller discards the
 * promise. An aborted upload mid-body, or a provider that throws instead of returning a
 * refusal, therefore did two things at once: left `res` unwritten, so the decision plane
 * sat on its own timeout with no answer to read, and produced an unhandled rejection,
 * which on Node's default kills `ari-signer` outright.
 *
 * The refusal this answers with is the same one the guard store already makes for a
 * failed database — nothing is signed, and the ticket is treated as spent.
 */
async function route(
  deps: SignerTransportDeps,
  log: SignerLog,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const started = performance.now();
  try {
    await respond(deps, log, req, res, started);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      // The provider may have been reached before it threw, so the ticket must not be
      // re-presentable: the message says as much rather than pretending nothing happened.
      res.end(
        JSON.stringify({
          state: 'REJECTED',
          code: 'SIGNING_PROVIDER_ERROR',
          detail: 'the signer could not complete the attempt',
        }),
      );
    } else {
      res.destroy();
    }
    // Only the error's name: a provider message can carry a wallet id or a fragment of
    // the sealed payload, and the log outlives the request.
    log.error('signing attempt failed', { err: { name: (error as Error).name }, elapsedMs: Math.round(performance.now() - started) });
  }
}

async function respond(
  deps: SignerTransportDeps,
  log: SignerLog,
  req: IncomingMessage,
  res: ServerResponse,
  started: number,
): Promise<void> {
  // `req.url` is the whole request target, query string included, so comparing it to a
  // path makes `/v1/sign?x=1` a different endpoint than `/v1/sign`. Measured on the
  // deployed pair: a stray parameter or a trailing slash turns the route into a 404, and a
  // 404 carries no refusal code — leaving the decision plane to guess at what it was told.
  // The path is the route; the query is not part of it.
  const path = (req.url ?? '').split('?')[0];

  // Readiness is answered first, and before any body is read: a platform health check is
  // a GET, and a check that returns 404 is a service that never gets promoted.
  if (req.method === 'GET' && path === HEALTH_PATH) {
    const db = deps.ready === undefined ? 'ok' : await deps.ready();
    res.writeHead(db === 'ok' ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: db === 'ok' ? 'ok' : 'degraded', db, version: deps.version ?? 'dev' }));
    return;
  }

  // Then the gate, ahead of the path table: an unauthenticated caller learns nothing
  // about which routes exist, and nothing is read from its socket. The seal is still what
  // authorises a signature — this says only whose request is worth verifying.
  if (deps.deliveryKey !== null && !acceptsBearerSecret(deps.deliveryKey, bearerToken(req.headers.authorization))) {
    // At info, not warn: with the gate on, this is the normal answer to everything that is
    // not the decision plane, including a scanner. A run of them is worth noticing and is
    // what the delivery-side counters on `ari-api` are for; one per stranger is not an
    // incident.
    log.info('delivery credential refused', {
      code: 'SIGNER_UNAUTHENTICATED',
      httpRequestId: forwardedRequestId(req),
    });
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        state: 'REJECTED',
        code: 'SIGNER_UNAUTHENTICATED',
        detail: 'the delivery credential was not accepted',
      }),
    );
    return;
  }

  if (req.method !== 'POST' || path !== SIGN_PATH) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"state":"NOT_FOUND"}');
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_REQUEST_BYTES) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end('{"state":"REJECTED","code":"TICKET_INVALID","detail":"request body too large"}');
      req.destroy();
      return;
    }
    chunks.push(chunk as Buffer);
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"state":"REJECTED","code":"TICKET_INVALID","detail":"expected a JSON body"}');
    return;
  }

  const response = await deps.handle(body);
  // The one line that ties the two processes together: `ari-api` logs the same
  // `httpRequestId` on its side of this call, so a parked ticket reads as one story rather
  // than two coincidences. The body is never logged — it carries a `providerRef`, and the
  // rule that a signature does not leave this process (S16) is no reason to write its
  // coordinates into a file that outlives the request.
  log.info('signing attempt answered', {
    httpRequestId: forwardedRequestId(req),
    status: response.status,
    state: typeof response.body.state === 'string' ? response.body.state : undefined,
    code: typeof response.body.code === 'string' ? response.body.code : undefined,
    elapsedMs: Math.round(performance.now() - started),
  });
  res.writeHead(response.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(response.body));
}

/**
 * Honoured only as a bounded opaque string, and only from the decision plane that this
 * deployment chose to trust. A stranger's header cannot reach a log line here anyway —
 * the gate runs first — but the shape rule is kept identical to the API's so neither
 * process can be made to write prose it did not author.
 */
function forwardedRequestId(req: IncomingMessage): string | undefined {
  const value = req.headers['x-request-id'];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(first) ? first : undefined;
}
