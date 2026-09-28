/**
 * The two things a process needs before it can tell anyone anything about a request:
 * a level, and an id that survives from the edge of the socket to the log line.
 *
 * Before this file existed, `startApi` passed `logger: false`, which made `app.log` a
 * no-op. Every deliberate silence outward in `routes.ts` — the 500 that answers
 * `{code:'INTERNAL'}` and nothing else, the parked delivery that names its code to the
 * caller and not to the trail — was therefore also silent *inward*, and the only way to
 * find out what had broken was to reproduce it. Outward silence is a security property;
 * inward silence was just the missing half.
 *
 * The id is the other half. A ledger row, the caller's own `req_` id and this process's
 * request id are three different identifiers, and the log names them distinctly on
 * purpose: `httpRequestId` for the one this file mints, `transactionRequestId` for the
 * `txr_` row. Collapsing them into one field called `requestId` is how an operator ends
 * up grepping for a payment in the wrong namespace.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyBaseLogger, FastifyInstance, FastifyServerOptions } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * A caller's own id is honoured only in this shape.
 *
 * The alternative — take the header verbatim — lets anyone put a hundred characters of
 * prose, an ANSI escape, or a forged correlation id into every log line this process
 * writes, in a service where a stranger can reach the socket. Minting is always legal,
 * so the fallback costs nothing.
 */
const FORWARDED_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LEVELS)[number];

/** Anything unrecognised becomes `info` rather than an error: a typo in a log level must not stop a payment service. */
export function logLevelOf(env: NodeJS.ProcessEnv): LogLevel {
  // `LOG_LEVEL` is the name `.env.example` has carried since before either process read
  // anything — decoration, which is the same defect `API_HOST` had. So the shared name is
  // honoured, and the per-service one exists for the case where an operator needs the
  // decision plane louder or quieter than the signer beside it.
  const named = env.API_LOG_LEVEL ?? env.LOG_LEVEL ?? 'info';
  return (LEVELS as readonly string[]).includes(named) ? (named as LogLevel) : 'info';
}

export function loggerOptions(level: LogLevel): NonNullable<FastifyServerOptions['logger']> {
  return {
    level,
    base: { service: 'ari-api' },
    // `authorization` carries a bearer credential, and a logged request line that repeats
    // it turns every log drain into a store of live secrets. Redacted at the serializer,
    // so it cannot come back through a different path.
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  };
}

/**
 * The server options, in one place, so the wiring a test asserts is the wiring that runs.
 *
 * `genReqId` belongs here rather than inline at the `fastify()` call for exactly that
 * reason: the request id is what every log line and every `x-request-id` header is built
 * from, and an option buried in one file cannot be exercised from another without
 * rebuilding it — which is how a test ends up green against a configuration no process
 * ever uses.
 */
export function fastifyOptions(args: {
  readonly level: LogLevel;
  readonly bodyLimitBytes?: number;
  readonly loggerInstance?: FastifyBaseLogger | undefined;
}) {
  const shared = {
    genReqId: (request: IncomingMessage) => requestIdOf(request.headers[REQUEST_ID_HEADER]),
    bodyLimit: args.bodyLimitBytes ?? 64 * 1024,
  };
  return args.loggerInstance === undefined
    ? { ...shared, logger: loggerOptions(args.level) }
    : { ...shared, logger: false, loggerInstance: args.loggerInstance };
}

/** The id for one request: the caller's if it is well-formed, otherwise a fresh one. */
export function requestIdOf(incoming: unknown): string {
  const first = Array.isArray(incoming) ? incoming[0] : incoming;
  return typeof first === 'string' && FORWARDED_ID.test(first) ? first : randomUUID();
}

/**
 * Echo the id on every response, including the ones that never reach a handler.
 *
 * `onSend` rather than a per-route write, because the requests worth correlating are
 * disproportionately the ones that failed: a 500 that answers `{code:'INTERNAL'}` says
 * nothing about itself by design, and the header is what lets the person holding it name
 * the line this process wrote about the same request.
 */
export function registerRequestId(app: FastifyInstance): void {
  // The hook's own `request` argument, not `reply.request`: the latter is a convenience
  // added late enough that a hook this early is not the case it was written for.
  app.addHook('onSend', (request, reply, _payload, done) => {
    if (!reply.hasHeader(REQUEST_ID_HEADER)) {
      void reply.header(REQUEST_ID_HEADER, request.id);
    }
    done();
  });
}
