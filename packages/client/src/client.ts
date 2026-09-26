/**
 * The agent-facing client.
 *
 * One method per route, and the interesting one is the method that is not here:
 * there is no `sign`. Not a `sign` that returns an error — a `sign` that does not
 * exist on the type, because a client library is where an agent's author gets to
 * see what is callable, and S16's claim is that no path from an agent to a
 * signature exists. `client.test.ts` holds the type-level assertion, so deleting
 * that guarantee is a compile failure rather than a code review miss.
 *
 * Responses are parsed, not trusted. Each shape is `.strict()`, which means a
 * server that started answering with an extra field — a ticket, a signature, a
 * provider reference — is a server this client refuses to read. That is the
 * backwards direction of the same invariant: the edge strips before answering, and
 * the client would rather fail than accept a capability it has no type for.
 */

import type { CandidateTransaction } from '@ari/schemas';
import { z } from 'zod';
import { wireStringify } from './serialize.js';

const RequestId = z.string().regex(/^txr_[0-9a-f-]{36}$/, 'expected txr_<uuidv7>');

const PublicDecision = z
  .object({
    outcome: z.enum(['ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL']),
    reasonCodes: z.array(z.string()),
    policyVersionId: z.string(),
    matchedRules: z.array(z.string()),
  })
  .strict();

/**
 * What came back from a request that reached a decision: the signer's own word,
 * passed through unchanged (§2 keeps the authority plane's vocabulary out of the
 * decision plane's hands).
 *
 * The three names are enumerated rather than left as `string` for one reason: a union
 * with an open `state` cannot be narrowed, so a caller writing
 * `if (value.state === 'DENIED')` would still be holding `reasonCodes` as a type
 * error. The cost is that a provider inventing a fourth state reads as
 * `CONTRACT_MISMATCH` — which, for a payment system, is the direction to fail.
 */
export const Delivered = z
  .object({ state: z.enum(['SIGNING_PENDING', 'PENDING', 'COMPLETE']), requestId: RequestId })
  .strict();
export type Delivered = z.infer<typeof Delivered>;

export const DeniedBody = z
  .object({ state: z.literal('DENIED'), requestId: RequestId, reasonCodes: z.array(z.string()) })
  .strict();

export const RefusedBody = z
  .object({ state: z.literal('REFUSED'), requestId: RequestId, reason: z.string() })
  .strict();

export const PendingBody = z
  .object({
    state: z.literal('APPROVAL_PENDING'),
    requestId: RequestId,
    approvalId: z.string().regex(/^apr_/),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export const NotDeliveredBody = z
  .object({
    state: z.literal('TICKET_ISSUED_NOT_DELIVERED'),
    requestId: RequestId,
    code: z.string(),
  })
  .strict();

export const AuthorizeBody = z.union([DeniedBody, RefusedBody, PendingBody, NotDeliveredBody, Delivered]);
export type AuthorizeBody = z.infer<typeof AuthorizeBody>;

export const PreviewBody = z
  .object({ state: z.literal('DECIDED'), reserves: z.literal(false), decision: PublicDecision })
  .strict();
export type PreviewBody = z.infer<typeof PreviewBody>;

export const StatusBody = z
  .object({ requestId: RequestId, state: z.string(), createdAt: z.iso.datetime() })
  .strict();
export type StatusBody = z.infer<typeof StatusBody>;

export type CallResult<T> =
  | { readonly ok: true; readonly status: number; readonly value: T }
  /**
   * `code` is the server's machine code when there was one, `CONTRACT_MISMATCH` when
   * the body did not fit the published shape, and `NETWORK` or `TIMEOUT` when there
   * was no answer to read. The last two are not refusals to authorise and must not be
   * reported as such: a payment Ari declined and a payment Ari never heard about need
   * opposite answers from the caller.
   */
  | { readonly ok: false; readonly status: number | null; readonly code: string; readonly detail: string };

export interface ClientOptions {
  /** The decision plane's address. A signer's address is not a thing this client knows. */
  readonly baseUrl: string;
  /** The presented credential — `org.credential.secret`, held by the agent's runtime. */
  readonly credential: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface AriClient {
  authorize(input: {
    readonly candidate: CandidateTransaction;
    readonly idempotencyKey: string;
    readonly approvalToken?: string;
  }): Promise<CallResult<AuthorizeBody>>;
  evaluate(candidate: CandidateTransaction): Promise<CallResult<PreviewBody>>;
  status(requestId: string): Promise<CallResult<StatusBody>>;
}


export function createClient(options: ClientOptions): AriClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<CallResult<T>> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.credential}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: wireStringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name ?? '';
      return {
        ok: false,
        status: null,
        code: name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
        detail: (error as Error).message,
      };
    }

    const text = await response.text();
    if (!response.ok) {
      const fields = errorFields(text);
      return {
        ok: false,
        status: response.status,
        code: fields.code ?? `HTTP_${response.status}`,
        detail: fields.detail ?? text.slice(0, 500),
      };
    }

    const value = schema.safeParse(safeJson(text));
    if (!value.success) {
      // The server answered 200 with something the contract does not describe. Say
      // that, and say it without echoing the body: if this ever fires because a
      // response grew a ticket in it, the ticket should not be copied into a log line
      // on the way past.
      return {
        ok: false,
        status: response.status,
        code: 'CONTRACT_MISMATCH',
        detail: `the ${path} response did not match the published shape: ${value.error.issues[0]?.message ?? 'unknown'}`,
      };
    }
    return { ok: true, status: response.status, value: value.data };
  }

  return {
    authorize: (input) =>
      call('POST', '/v1/transactions/authorize', AuthorizeBody, {
        candidate: input.candidate,
        idempotencyKey: input.idempotencyKey,
        ...(input.approvalToken === undefined ? {} : { approvalToken: input.approvalToken }),
      }),
    evaluate: (candidate) => call('POST', '/v1/transactions/evaluate', PreviewBody, { candidate }),
    status: (requestId) => call('GET', `/v1/transactions/${encodeURIComponent(requestId)}`, StatusBody),
  };
}

/**
 * The two fields an error answer is allowed to carry, read defensively.
 *
 * Deliberately not a strict schema: a refusal the client cannot parse must still come
 * back with its status code rather than as a crash in the parser, and the codes are
 * the server's to add to.
 */
function errorFields(text: string): { readonly code?: string; readonly detail?: string } {
  const body = safeJson(text);
  if (body === null || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  return {
    ...(typeof record['code'] === 'string' ? { code: record['code'] } : {}),
    ...(typeof record['detail'] === 'string' ? { detail: record['detail'] } : {}),
  };
}

/** A body that is not JSON is still a body worth reporting, not a crash in the client. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
