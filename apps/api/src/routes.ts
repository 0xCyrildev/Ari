/**
 * The HTTP surface.
 *
 * Small on purpose. A route handler here holds no logic that could get the order of
 * operations wrong: it authenticates, parses, calls the pipeline, and *strips*
 * before answering. The stripping is the substantive part — the pipeline returns a
 * ticket because that is its job, and the edge must not pass it on (T2, S16).
 *
 * Only agent-scoped routes and the bootstrap route exist. The human-facing ones —
 * creating agents, issuing credentials, deciding approvals, activating policies —
 * all require a user session, and Ari has no session model yet; inventing one to
 * fill out a route table would be a security decision made as a side effect.
 */

import { CandidateTransaction, type Decision } from '@ari/schemas';
import {
  asTenant,
  createOrganization,
  createUser,
  requestStateOf,
} from '@ari/identity';
import { authorize, recordDeliveryOutcome, type AuthorizeOutcome, type PipelineDeps } from './authorize.js';
import { acceptsBootstrapToken, authenticateAgent } from './gateway.js';
import type { SignerClient } from './signer-client.js';
import type { FastifyError, FastifyInstance } from 'fastify';

export interface RouteDeps {
  readonly pipeline: PipelineDeps;
  readonly signer: SignerClient;
  readonly bootstrapToken: string;
}

/** What an agent is allowed to learn about a decision. Note the absence of a ticket. */
function publicDecision(decision: Decision) {
  return {
    outcome: decision.outcome,
    reasonCodes: decision.reasonCodes,
    policyVersionId: decision.policyVersionId,
    matchedRules: decision.matchedRules.map((rule) => rule.rulePath),
  };
}

async function handleOutcome(deps: RouteDeps, orgId: string, outcome: AuthorizeOutcome): Promise<Record<string, unknown>> {
  switch (outcome.status) {
    case 'DENIED':
      return { state: 'DENIED', requestId: outcome.requestId, reasonCodes: outcome.codes };
    case 'REFUSED':
      return { state: 'REFUSED', requestId: outcome.requestId, reason: outcome.reason };
    case 'DECIDED':
      return { state: 'DECIDED', reserves: false, decision: publicDecision(outcome.decision) };
    case 'AWAITING_APPROVAL':
      return {
        state: 'APPROVAL_PENDING',
        requestId: outcome.requestId,
        approvalId: outcome.approvalId,
        expiresAt: outcome.expiresAt,
      };
    case 'TICKET_ISSUED': {
      // The ticket goes to the signer and no further. If delivery fails the answer
      // says so, because a minted-but-undelivered ticket is a real state an operator
      // has to be able to see, not a bug to hide behind a generic refusal.
      const delivered = await deps.signer.deliver({
        ticket: outcome.ticket,
        canonical: outcome.canonical,
      });
      // The books move after the answer is carried, in a transaction of its own: a hold
      // that became a signature is no longer parked capacity, and a hold the authority
      // plane can never honour must go back to the agent's daily total (T13).
      await recordDeliveryOutcome(deps.pipeline, orgId, outcome.requestId, delivered);
      if (!delivered.accepted) {
        return {
          state: 'TICKET_ISSUED_NOT_DELIVERED',
          requestId: outcome.requestId,
          code: delivered.code,
        };
      }
      return { state: delivered.state, requestId: outcome.requestId };
    }
  }
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  // What an unexpected failure answers with. A throw out of the pipeline is a bug in
  // this process, and the message that describes it — an idempotency conflict, a
  // constraint, part of a query — is not this caller's to read. Fastify's default
  // serializer puts `message` in the body.
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) {
      return reply.code(status).send({ code: 'INVALID_REQUEST', detail: error.message.slice(0, 200) });
    }
    return reply.code(500).send({ code: 'INTERNAL' });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.post('/v1/organizations', async (request, reply) => {
    if (!acceptsBootstrapToken(deps.bootstrapToken, request.headers.authorization)) {
      return reply.code(403).send({ code: 'BOOTSTRAP_REQUIRED' });
    }
    const body = request.body as { name?: unknown; ownerEmail?: unknown; ownerDisplayName?: unknown };
    if (
      typeof body.name !== 'string' ||
      typeof body.ownerEmail !== 'string' ||
      typeof body.ownerDisplayName !== 'string' ||
      body.name.trim().length === 0 ||
      body.name.length > 200 ||
      body.ownerDisplayName.trim().length === 0 ||
      body.ownerEmail.length > 320 ||
      body.ownerDisplayName.length > 200
    ) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', detail: 'name, ownerEmail and ownerDisplayName are required' });
    }
    const orgId = await createOrganization(deps.pipeline.pool, {
      name: body.name,
      bootstrapActor: 'bootstrap',
    });
    // The owner is created here and nowhere signs in as them yet: without a session
    // model, the honest answer is an identifier and nothing more. Handing back a
    // password or a token would be inventing an auth scheme in a route handler.
    const ownerId = await asTenant(deps.pipeline.pool, orgId, (tx) =>
      createUser(tx, {
        email: body.ownerEmail as string,
        displayName: body.ownerDisplayName as string,
        role: 'owner',
        grantedBy: 'bootstrap',
      }),
    );
    return reply.code(201).send({ organizationId: orgId, ownerId });
  });

  const agentOnly = async (request: { headers: Record<string, string | string[] | undefined> }) =>
    authenticateAgent(
      {
        pool: deps.pipeline.pool,
        masterPepper: deps.pipeline.masterPepper,
        nowMs: deps.pipeline.nowMs,
      },
      request.headers.authorization as string | undefined,
    );

  app.post('/v1/transactions/authorize', async (request, reply) => {
    const auth = await agentOnly(request);
    if (!auth.ok) return reply.code(auth.status).send({ code: auth.code, detail: auth.detail });
    const body = request.body as { candidate?: unknown; idempotencyKey?: unknown; approvalToken?: unknown };
    const parsed = CandidateTransaction.safeParse(body.candidate);
    // Bounded here because the column bounds it and a 23-column INSERT is a worse way to
    // say "too long" — or "too short" — than a 400. `idempotency_key` is
    // `BETWEEN 1 AND 200` in `004`; the body limit is 64 KB, so without this a caller can
    // send a 60 KB "key", or an empty one, and get a constraint error as a 500.
    if (
      !parsed.success ||
      typeof body.idempotencyKey !== 'string' ||
      body.idempotencyKey.length === 0 ||
      body.idempotencyKey.length > 200
    ) {
      // A body the parser cannot read is not the same case as `kind: 'unknown'`:
      // that is a *parsed* transaction the policy refuses with a reason code, and
      // this is a request that never reached a decision at all.
      return reply
        .code(400)
        .send({ code: 'INVALID_REQUEST', detail: parsed.success ? 'idempotencyKey is required, and at most 200 characters' : parsed.error.message });
    }
    const outcome = await authorize(deps.pipeline, auth.principal.orgId, {
      credentialId: auth.principal.credentialId,
      agentId: auth.principal.agentId,
      candidate: parsed.data,
      idempotencyKey: body.idempotencyKey,
      ...(typeof body.approvalToken === 'string' ? { approvalToken: body.approvalToken } : {}),
    });
    return reply.code(200).send(await handleOutcome(deps, auth.principal.orgId, outcome));
  });

  app.post('/v1/transactions/evaluate', async (request, reply) => {
    const auth = await agentOnly(request);
    if (!auth.ok) return reply.code(auth.status).send({ code: auth.code, detail: auth.detail });
    const body = request.body as { candidate?: unknown };
    const parsed = CandidateTransaction.safeParse(body.candidate);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', detail: parsed.error.message });
    }
    const outcome = await authorize(deps.pipeline, auth.principal.orgId, {
      credentialId: auth.principal.credentialId,
      agentId: auth.principal.agentId,
      candidate: parsed.data,
      idempotencyKey: `preview:${parsed.data.requestId}`,
      dryRun: true,
    });
    return reply.code(200).send(await handleOutcome(deps, auth.principal.orgId, outcome));
  });

  app.get('/v1/transactions/:id', async (request, reply) => {
    const auth = await agentOnly(request);
    if (!auth.ok) return reply.code(auth.status).send({ code: auth.code, detail: auth.detail });
    const params = request.params as { id: string };
    const state = await asTenant(deps.pipeline.pool, auth.principal.orgId, (tx) =>
      requestStateOf(tx, params.id),
    );
    // A request from another tenant reads as one that does not exist. Row security
    // already returns nothing here; the response must not confirm the difference.
    if (state === null) return reply.code(404).send({ code: 'NOT_FOUND' });
    return reply.code(200).send({ requestId: state.id, state: state.lifecycleState, createdAt: state.createdAt });
  });
}
