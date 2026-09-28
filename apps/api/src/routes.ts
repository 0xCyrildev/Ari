/**
 * The HTTP surface.
 *
 * Small on purpose. A route handler here holds no logic that could get the order of
 * operations wrong: it authenticates, parses, calls the pipeline, and *strips*
 * before answering. The stripping is the substantive part — the pipeline returns a
 * ticket because that is its job, and the edge must not pass it on (T2, S16).
 *
 * Three kinds of caller, and they are not interchangeable. An *agent* proposes a
 * payment. A *human approver* decides an approval, with a credential that cannot carry
 * `transaction:request` (`013` makes that a CHECK, not a convention). The *deployment's*
 * bootstrap token creates tenants and hands out the first approver credentials, because
 * the routes that mint authority cannot be inside the thing they seed.
 *
 * What is still missing is a session model — a person signing in rather than presenting
 * a bearer secret. That is deliberately not improvised here: Phase 10's dashboard will
 * mint these credentials on a signed-in user's behalf, and an auth scheme invented to
 * fill out a route table is a security decision taken as a side effect.
 */

import { CandidateTransaction, PolicyDocument, type Decision } from '@ari/schemas';
import {
  activeUserScopes,
  asTenant,
  createAgent,
  createOrganization,
  createUser,
  createWallet,
  grantWalletToAgent,
  issueCredential,
  issueUserCredential,
  isScope,
  requestStateOf,
  setAgentStatus,
  type Scope,
  type TenantTx,
} from '@ari/identity';
import { readEventLog, verifyEventLog } from '@ari/audit';
import { activateVersion, createPolicy } from '@ari/policies';
import {
  approvalDetail,
  listApprovals,
  recordDecision,
  sealGrantedApproval,
} from '@ari/approvals';
import { authorize, recordDeliveryOutcome, type AuthorizeOutcome, type PipelineDeps } from './authorize.js';
import { listPolicies, listRequests, listWallets, MAX_READ_LIMIT, organizationSummary, requestRecord } from './reads.js';
import { acceptsBootstrapToken, authenticateAgent, authenticateApprover, type ApproverPrincipal } from './gateway.js';
import { acceptsBearerSecret, bearerToken } from '@ari/signing';
import type { ApiMetrics } from './metrics.js';
import type { SignerClient } from './signer-client.js';
import type { FastifyBaseLogger, FastifyError, FastifyInstance, FastifyReply } from 'fastify';

export interface RouteDeps {
  readonly pipeline: PipelineDeps;
  readonly signer: SignerClient;
  readonly bootstrapToken: string;
  /** The counters this process keeps about itself. Written on the same paths that answer. */
  readonly metrics: ApiMetrics;
  /** A statement that proves the pool is usable right now, bounded by the caller. */
  readonly health: () => Promise<'ok' | 'unavailable'>;
  /** Null means there is no metrics route at all — see `ApiConfig.metricsToken`. */
  readonly metricsToken: string | null;
  readonly version: string;
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

async function handleOutcome(call: {
  readonly deps: RouteDeps;
  readonly log: FastifyBaseLogger;
  readonly requestId: string;
  readonly orgId: string;
  readonly outcome: AuthorizeOutcome;
}): Promise<Record<string, unknown>> {
  const { deps, log, requestId: httpRequestId, orgId, outcome } = call;
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
        requestId: httpRequestId,
      });
      // The books move after the answer is carried, in a transaction of its own: a hold
      // that became a signature is no longer parked capacity, and a hold the authority
      // plane can never honour must go back to the agent's daily total (T13).
      const books = await recordDeliveryOutcome(deps.pipeline, orgId, outcome.requestId, delivered);
      deps.metrics.noteDelivery(delivered.accepted ? 'accepted' : 'parked');
      if (!delivered.accepted) {
        // The caller sees it in the response; the operator sees it here, at warn, because
        // a parked delivery is the state where capacity is held and nothing will move it
        // on its own. A parked delivery still writes no audit event on purpose — nothing
        // about the request is final — and before this line existed, that decision left a
        // signing outage visible only to whoever happened to ask about one ticket at a
        // time. The code and the row id, never the ticket.
        log.warn(
          {
            // pino stamps the same value as `reqId` on every line of this request. Named
            // again here because `httpRequestId` is the word both processes write —
            // `ari-signer` has no pino and no `reqId` — and one incident should be one
            // query, not a join across two field names.
            httpRequestId,
            transactionRequestId: outcome.requestId,
            code: delivered.code,
            reservation: books,
          },
          'ticket minted but not delivered',
        );
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
    // The response says nothing, and that is the decision (S16's cousin: an idempotency
    // conflict names two digests, a constraint error quotes a fragment of SQL, and a client
    // that sees either has learned the shape of the interior). Silence *outward* was never
    // meant to mean silence inward — but until `observe.ts` it did, because `logger: false`
    // made `app.log` a no-op and a 500 left no trace anywhere at all. Whoever was holding the
    // failing request had to reproduce it to learn what broke.
    //
    // Written here rather than trusted to the framework's own error log, because a custom
    // error handler is the point where that default stops applying, and because the
    // fields are this process's choice: the name, the message and four lines of stack say
    // what broke, and nothing in them is the caller's to read. The message is what a
    // constraint or an idempotency conflict actually says — an operator needs it, and it
    // never crosses the socket.
    reply.log.error(
      {
        status,
        code: 'INTERNAL',
        err: {
          name: error.name,
          message: error.message,
          stack: error.stack?.split('\n').slice(1, 5).join('\n'),
        },
      },
      'unhandled failure; the response said nothing and this line is the only record of it',
    );
    return reply.code(500).send({ code: 'INTERNAL' });
  });

  // An unknown route is not a bug in this process, so it gets no description of one.
  // Fastify's default answers `{"message":"Route GET:/ not found",…}`, which names the
  // framework and reflects the caller's path back at it — and the same reasoning that put
  // `setErrorHandler` above says the body a stranger reads is not theirs to have. The
  // console's proxy already refuses with "a 404 that names nothing"; the payment API is
  // held to the same standard, including for the one case that is not an error.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ code: 'NOT_FOUND' });
  });

  // `{status:'ok'}` used to be the whole answer, which made it a claim about the process
  // and not about the service. A deployment where every pooled connection had gone to a
  // dead host answered 200 and then 500'd at the first statement — the same shape as the
  // loopback-bind trap this file already records, where a container "starts cleanly,
  // passes its own health check, and 502s from outside".
  //
  // So a failed probe is a 503, and the platform stops promoting the route. That is the
  // right trade: an `ari-api` with no database cannot answer anything else correctly
  // either, and a monitor that reads 200 with a `"db":"unavailable"` body has to
  // understand the body to be useful, while one that reads 503 already does.
  // Flapping is the platform's problem to bound, not this handler's to hide.
  app.get('/healthz', async (_request, reply) => {
    const db = await deps.health();
    return reply.code(db === 'ok' ? 200 : 503).send({ status: db === 'ok' ? 'ok' : 'degraded', db, version: deps.version });
  });

  // Registered only when a token was configured, so `METRICS_TOKEN` unset means there is no
  // metrics route to find — the same 404 as any unknown path, rather than a 401 that
  // advertises a door. The body is text the caller's monitoring reads, never a response an
  // agent's contract describes, so it is the one place here that answers outside JSON.
  if (deps.metricsToken !== null) {
    const token = deps.metricsToken;
    app.get('/metrics', async (request, reply) => {
      if (!acceptsBearerSecret(token, bearerToken(request.headers.authorization))) {
        return reply.code(401).send({ code: 'METRICS_UNAUTHENTICATED' });
      }
      return reply
        .code(200)
        .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(deps.metrics.exposition());
    });
  }

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
        noteVerify: (kind, result) => deps.metrics.noteCredentialVerify(kind, result),
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
    return reply.code(200).send(
      await handleOutcome({ deps, log: reply.log, requestId: request.id, orgId: auth.principal.orgId, outcome }),
    );
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
    return reply.code(200).send(
      await handleOutcome({ deps, log: reply.log, requestId: request.id, orgId: auth.principal.orgId, outcome }),
    );
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

  // ---------------------------------------------------------------------------
  // The approver's half.
  //
  // These exist because `REQUIRE_HUMAN_APPROVAL` was the one outcome the edge could
  // announce and nobody outside the process could act on: the pipeline returned an
  // `approvalId`, `recordDecision` counted a vote from a user id, and there was no path
  // by which a person presented one. That made the most important branch of the decision
  // set resolve to "stuck", and a policy that asks a human and cannot ask anyone is a
  // delay, not a control.
  //
  // What a caller presents here is a *user* credential (`ucrd_`), which cannot carry
  // `transaction:request` — the CHECK is in `013`, not in this file — so the subject that
  // proposes a payment and the subject that approves it are different in the row, not by
  // convention in a handler.
  // ---------------------------------------------------------------------------

  const gateway = {
    pool: deps.pipeline.pool,
    masterPepper: deps.pipeline.masterPepper,
    nowMs: deps.pipeline.nowMs,
    noteVerify: (kind: 'agent' | 'user', result: 'accepted' | 'refused') =>
      deps.metrics.noteCredentialVerify(kind, result),
  };

  interface GateReply {
    readonly status: number;
    readonly body: Record<string, unknown>;
  }

  /**
   * Authenticate, then re-read the authority inside the tenant transaction.
   *
   * The scope is looked up from the row rather than carried in from the credential the
   * gate verified, for the same reason `authorize` does: a revocation ten seconds ago has
   * to be reflected in what this request is allowed to do, and a principal holding a
   * scope list from authentication is a second source of truth that looks authoritative.
   */
  /**
   * Run `fn` as an authenticated human, with the scope this route needs.
   *
   * The scope is named per route rather than once for the group, because the group is not
   * one authority: deciding an approval, managing agents and reading the audit trail are
   * three different things a credential can be refused. All of them read the live list from
   * `user_credentials` inside the tenant transaction — never from what authentication
   * returned, which is a value from before the revocation that may have happened since.
   */
  const asUser = (requiredScope: string) => async (
    request: { headers: Record<string, string | string[] | undefined> },
    reply: FastifyReply,
    fn: (tx: TenantTx, principal: ApproverPrincipal) => Promise<GateReply>,
  ): Promise<void> => {
    const auth = await authenticateApprover(gateway, request.headers.authorization as string | undefined);
    if (!auth.ok) {
      await reply.code(auth.status).send({ code: auth.code, detail: auth.detail });
      return;
    }
    const principal = auth.principal;
    const outcome = await asTenant<GateReply>(deps.pipeline.pool, principal.orgId, async (tx) => {
      const scopes = await activeUserScopes(tx, principal.credentialId);
      if (!scopes.includes(requiredScope)) {
        return { status: 403, body: { code: 'SCOPE_REFUSED', detail: `this route requires ${requiredScope}` } };
      }
      return fn(tx, principal);
    });
    await reply.code(outcome.status).send(outcome.body);
  };

  const asApprover = asUser('approval:decide');

  app.get('/v1/approvals', async (request, reply) =>
    asApprover(request, reply, async (tx, principal) => {
      const approvals = await listApprovals(tx, { userId: principal.userId });
      return { status: 200, body: { approvals } };
    }),
  );

  app.get('/v1/approvals/:id', async (request, reply) => {
    const params = request.params as { id: string };
    if (params.id.length === 0 || params.id.length > 200) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', detail: 'approval id is malformed' });
    }
    return asApprover(request, reply, async (tx) => {
      const detail = await approvalDetail(tx, params.id);
      // Another tenant's approval and no approval at all answer identically, because the
      // existence of a payment waiting on a human is itself information.
      if (detail === null) return { status: 404, body: { code: 'NOT_FOUND' } };
      return { status: 200, body: { approval: detail } };
    });
  });

  app.post('/v1/approvals/:id/decisions', async (request, reply) => {
    const params = request.params as { id: string };
    const body = request.body as { decision?: unknown };
    if (body.decision !== 'APPROVED' && body.decision !== 'REJECTED') {
      return reply.code(400).send({ code: 'INVALID_REQUEST', detail: "decision must be 'APPROVED' or 'REJECTED'" });
    }
    const decision = body.decision;
    return asApprover(request, reply, async (tx, principal) => {
      const recorded = await recordDecision(tx, { approvalId: params.id, approver: principal.userId, decision });
      if (!recorded.ok) {
        // The refusal is the record: `recordDecision` appends its own event inside this
        // same transaction, and the codes distinguish a person who cannot approve this
        // one, an approval that is already decided, and a window that closed (S10).
        return { status: 409, body: { code: recorded.code, detail: recorded.detail, state: 'REFUSED' } };
      }
      if (recorded.status !== 'GRANTED') {
        return { status: 200, body: { state: recorded.status, votes: recorded.votes } };
      }
      // Quorum reached. The token is sealed *from the row* here and handed to the human
      // whose decision produced it — never stored, and never returned to the agent that
      // asked. `requestApproval`'s own token was minted into the pipeline's process and
      // discarded on the way out, deliberately: it would have arrived at the caller that
      // is being restricted.
      const token = await sealGrantedApproval(tx, params.id, deps.pipeline.approvalKey);
      const subject = await approvalDetail(tx, params.id);
      return {
        status: 200,
        body: {
          state: 'GRANTED',
          votes: recorded.votes,
          ...(token !== null && subject?.subjectKind === 'transaction' ? { approvalToken: token } : {}),
          ...(subject?.subjectKind === 'policy_activation' ? { nextStep: 'the policy version activates on the operator’s next apply' } : {}),
        },
      };
    });
  });

  // ---------------------------------------------------------------------------
  // The operator's half, gated by the deployment's bootstrap token rather than by a
  // tenant's credential — the same mechanism `POST /v1/organizations` uses, and the same
  // reason: these two routes mint the authority that every other human-facing route is
  // checked against, so they cannot be inside the thing they seed.
  //
  // This is not a session model and does not pretend to be one. It is how an operator
  // gets the first approver credential into the system; Phase 10's dashboard is the thing
  // that will mint these on a signed-in person's behalf rather than being handed one.
  // ---------------------------------------------------------------------------

  const bootstrapOnly = (request: { headers: Record<string, string | string[] | undefined> }) =>
    acceptsBootstrapToken(deps.bootstrapToken, request.headers.authorization as string | undefined);

  const USER_ROLES = ['owner', 'admin', 'approver', 'viewer'] as const;

  app.post('/v1/users', async (request, reply) => {
    if (!bootstrapOnly(request)) return reply.code(403).send({ code: 'BOOTSTRAP_REQUIRED' });
    const body = request.body as { organizationId?: unknown; email?: unknown; displayName?: unknown; role?: unknown };
    if (
      typeof body.organizationId !== 'string' ||
      typeof body.email !== 'string' ||
      typeof body.displayName !== 'string' ||
      typeof body.role !== 'string' ||
      !USER_ROLES.includes(body.role as (typeof USER_ROLES)[number]) ||
      body.email.length === 0 ||
      body.email.length > 320 ||
      body.displayName.trim().length === 0 ||
      body.displayName.length > 200
    ) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', detail: `organizationId, email, displayName and one of ${USER_ROLES.join('|')}` });
    }
    const userId = await asTenant(deps.pipeline.pool, body.organizationId, (tx) =>
      createUser(tx, {
        email: body.email as string,
        displayName: body.displayName as string,
        role: body.role as 'owner',
        grantedBy: 'bootstrap',
      }),
    );
    return reply.code(201).send({ userId, role: body.role });
  });

  app.post('/v1/users/:userId/credentials', async (request, reply) => {
    if (!bootstrapOnly(request)) return reply.code(403).send({ code: 'BOOTSTRAP_REQUIRED' });
    const params = request.params as { userId: string };
    const body = request.body as { organizationId?: unknown; scopes?: unknown; ttlMs?: unknown };
    if (
      typeof body.organizationId !== 'string' ||
      !Array.isArray(body.scopes) ||
      body.scopes.length === 0 ||
      body.scopes.length > 8 ||
      !body.scopes.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 64) ||
      typeof body.ttlMs !== 'string' ||
      !/^\d{1,20}$/.test(body.ttlMs)
    ) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', detail: 'organizationId, scopes[] and a decimal-string ttlMs are required' });
    }
    let ttlMs: bigint;
    try {
      ttlMs = BigInt(body.ttlMs);
    } catch {
      return reply.code(400).send({ code: 'INVALID_REQUEST', detail: 'ttlMs is not a number' });
    }
    // Bounded rather than trusted: `expires_at > created_at` is the only database-side
    // rule about a lifetime, and a credential minted for a hundred years satisfies it.
    if (ttlMs < 60_000n || ttlMs > 30n * 24n * 60n * 60n * 1_000n) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', detail: 'ttlMs must be between one minute and thirty days' });
    }
    const scopes = body.scopes as string[];
    if (!scopes.every((s) => isScope(s))) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', detail: 'one or more scopes are not part of the vocabulary' });
    }
    if (scopes.includes('transaction:request')) {
      // Refused here in words, and in a CHECK in `013` in fact.
      return reply.code(400).send({ code: 'INVALID_REQUEST', detail: 'a human credential cannot carry transaction:request' });
    }

    const issued = await asTenant(deps.pipeline.pool, body.organizationId, (tx) =>
      issueUserCredential(tx, {
        userId: params.userId,
        scopes: scopes as Scope[],
        ttlMs,
        masterPepper: deps.pipeline.masterPepper,
        actor: 'bootstrap',
      }),
    );
    return reply.code(201).send({
      credentialId: issued.credentialId,
      // Printed once and unrecoverable afterwards, exactly like an agent's: the row holds
      // an Argon2id digest of a peppered secret, so this response is the only place the
      // bearer value has ever existed.
      bearer: issued.presented,
      scopes: issued.scopes,
      expiresAt: issued.expiresAt,
    });
  });

  // ---------------------------------------------------------------------------
  // The operator's half, over a human credential rather than the deployment's bootstrap
  // token: create an agent, give it a secret, point it at a wallet, put a policy live, read
  // the trail.
  //
  // Each of these existed only as a package call a test or `pnpm seed` made directly, which
  // is the gap an operator actually has — and the reason the scopes below are `agent:manage`,
  // `wallet:manage`, `policy:activate` and `audit:read` is that `013` already permits a human
  // credential to hold them. `SCOPES` declared that vocabulary long before any route could
  // ask for it, which is exactly how a scope list quietly becomes decoration.
  // ---------------------------------------------------------------------------

  const idParam = (request: { params: unknown }, name: string): string =>
    (request.params as Record<string, string>)[name] ?? '';

  const unusable = (value: string, max: number): boolean => value.length === 0 || value.length > max;

  const asOperator = asUser;

  app.post('/v1/agents', async (request, reply) =>
    asOperator('agent:manage')(request, reply, async (tx, principal) => {
      const body = request.body as { name?: unknown };
      if (typeof body.name !== 'string' || unusable(body.name.trim(), 120)) {
        return { status: 400, body: { code: 'INVALID_REQUEST', detail: 'name is required, at most 120 characters' } };
      }
      const agentId = await createAgent(tx, { name: body.name.trim(), createdBy: principal.userId });
      return { status: 201, body: { agentId } };
    }),
  );

  app.get('/v1/agents', async (request, reply) =>
    asOperator('agent:manage')(request, reply, async (tx) => {
      const rows = await tx.client.query<{ id: string; name: string; status: string }>(
        `SELECT id, name, status FROM ari.agents ORDER BY id`,
      );
      return { status: 200, body: { agents: rows.rows } };
    }),
  );

  app.post('/v1/agents/:agentId/revoke', async (request, reply) =>
    asOperator('agent:manage')(request, reply, async (tx, principal) => {
      const agentId = idParam(request, 'agentId');
      if (unusable(agentId, 200)) {
        return { status: 400, body: { code: 'INVALID_REQUEST', detail: 'agentId is required' } };
      }
      const found = await tx.client.query<{ status: string }>(
        `SELECT status FROM ari.agents WHERE id = $1 AND org_id = $2`,
        [agentId, tx.orgId],
      );
      const status = found.rows[0]?.status;
      if (status === undefined) {
        // Another tenant's agent reads exactly as no agent at all, which is the same rule
        // `GET /v1/transactions/:id` follows and the reason the lookup is scoped rather than
        // the error message being careful.
        return { status: 404, body: { code: 'NOT_FOUND', detail: 'no such agent in this organisation' } };
      }
      if (status === 'REVOKED') {
        // A second revoke is not a second act, and refusing it would push an operator into
        // scripting around the refusal. `REVOKED` is terminal and absorbs, so "already" is a
        // complete and honest answer — and the trail still shows who revoked it when.
        return { status: 200, body: { agentId, status: 'REVOKED', credentialsRevoked: 0, alreadyRevoked: true } };
      }
      // The credentials go with the agent, inside the same transaction — `setAgentStatus`
      // does both or neither, because a status check that stands alone between a leaked
      // secret and a payment is a single control, and single controls break.
      const { credentialsRevoked } = await setAgentStatus(tx, {
        agentId,
        status: 'REVOKED',
        actor: principal.userId,
      });
      return { status: 200, body: { agentId, status: 'REVOKED', credentialsRevoked, alreadyRevoked: false } };
    }),
  );

  app.post('/v1/agents/:agentId/credentials', async (request, reply) =>
    asOperator('agent:manage')(request, reply, async (tx, principal) => {
      const agentId = idParam(request, 'agentId');
      const body = request.body as { scopes?: unknown; ttlMs?: unknown };
      if (
        unusable(agentId, 200) ||
        !Array.isArray(body.scopes) ||
        body.scopes.length === 0 ||
        body.scopes.length > 8 ||
        !body.scopes.every((s) => typeof s === 'string' && isScope(s)) ||
        typeof body.ttlMs !== 'string' ||
        !/^\d{1,20}$/.test(body.ttlMs)
      ) {
        return {
          status: 400,
          body: { code: 'INVALID_REQUEST', detail: 'agentId, scopes[] from the vocabulary, and a decimal-string ttlMs' },
        };
      }
      const scopes = body.scopes as Scope[];
      if (scopes.includes('approval:decide')) {
        // Refused in words before `013`'s CHECK refuses it in fact: an agent that could
        // approve is one secret sitting on both sides of the boundary.
        return { status: 400, body: { code: 'INVALID_REQUEST', detail: 'an agent credential cannot carry approval:decide' } };
      }
      const ttlMs = BigInt(body.ttlMs);
      if (ttlMs < 60_000n || ttlMs > 30n * 24n * 60n * 60n * 1_000n) {
        return { status: 400, body: { code: 'INVALID_REQUEST', detail: 'ttlMs must be between one minute and thirty days' } };
      }
      const issued = await issueCredential(tx, {
        agentId,
        scopes,
        ttlMs,
        masterPepper: deps.pipeline.masterPepper,
        actor: principal.userId,
      });
      return {
        status: 201,
        body: { credentialId: issued.credentialId, bearer: issued.presented, scopes: issued.scopes, expiresAt: issued.expiresAt },
      };
    }),
  );

  app.post('/v1/wallets', async (request, reply) =>
    asOperator('wallet:manage')(request, reply, async (tx, principal) => {
      const body = request.body as {
        displayName?: unknown;
        mode?: unknown;
        signatureTriple?: unknown;
        provider?: unknown;
        address?: unknown;
      };
      // Optional, and validated by `createWallet` rather than here: the same grammar the
      // candidate's recipient is parsed with, because an address stored with one character
      // transposed makes every simulation of this wallet a question about an account that
      // holds nothing.
      const address = body.address === undefined || body.address === null ? null : body.address;
      if (address !== null && typeof address !== 'string') {
        return { status: 400, body: { code: 'INVALID_REQUEST', detail: 'address must be a string or absent' } };
      }
      if (
        typeof body.displayName !== 'string' ||
        unusable(body.displayName.trim(), 200) ||
        (body.mode !== 'delegated' && body.mode !== 'user_gated') ||
        typeof body.signatureTriple !== 'string' ||
        unusable(body.signatureTriple, 200) ||
        typeof body.provider !== 'string' ||
        unusable(body.provider, 80)
      ) {
        return {
          status: 400,
          body: { code: 'INVALID_REQUEST', detail: 'displayName, mode (delegated|user_gated), signatureTriple, provider' },
        };
      }
      // The mode is the guarantee, and it is immutable after this row exists: `delegated`
      // is what software can move on its own, `user_gated` is what needs a person. Refusing
      // a typo here is refusing a wrong answer to "could the agent have done that alone".
      const walletId = await createWallet(tx, {
        displayName: body.displayName.trim(),
        mode: body.mode,
        signatureTriple: body.signatureTriple,
        provider: body.provider,
        actor: principal.userId,
        ...(address === null ? {} : { address }),
      });
      return { status: 201, body: { walletId, mode: body.mode, address } };
    }),
  );

  app.post('/v1/agents/:agentId/wallets/:walletId', async (request, reply) =>
    asOperator('wallet:manage')(request, reply, async (tx, principal) => {
      const agentId = idParam(request, 'agentId');
      const walletId = idParam(request, 'walletId');
      const body = request.body as { policyVersionId?: unknown };
      if (
        unusable(agentId, 200) ||
        unusable(walletId, 200) ||
        typeof body.policyVersionId !== 'string' ||
        unusable(body.policyVersionId, 200)
      ) {
        return { status: 400, body: { code: 'INVALID_REQUEST', detail: 'policyVersionId is required' } };
      }
      await grantWalletToAgent(tx, { agentId, walletId, policyVersionId: body.policyVersionId, actor: principal.userId });
      return { status: 201, body: { agentId, walletId, policyVersionId: body.policyVersionId } };
    }),
  );

  app.post('/v1/policies', async (request, reply) =>
    asOperator('policy:activate')(request, reply, async (tx, principal) => {
      const body = request.body as { name?: unknown; document?: unknown; activate?: unknown; justification?: unknown };
      if (typeof body.name !== 'string' || unusable(body.name.trim(), 120)) {
        return { status: 400, body: { code: 'INVALID_REQUEST', detail: 'name is required, at most 120 characters' } };
      }
      const parsed = PolicyDocument.safeParse(body.document);
      if (!parsed.success) {
        return { status: 400, body: { code: 'INVALID_REQUEST', detail: parsed.error.message } };
      }
      const created = await createPolicy(tx, { name: body.name.trim(), document: parsed.data, actor: principal.userId });
      if (body.activate !== true) {
        return { status: 201, body: { policyId: created.policyId, versionId: created.versionId, status: 'DRAFT' } };
      }
      // Activation is where a human's authority is checked against a document, and both
      // checks live in the package rather than being re-implemented here: the compiler
      // refuses limits that disagree about units, and `activateVersion` refuses a broadening
      // the caller does not own — plus the justification `014` now demands for a reactivation.
      const activated = await activateVersion(tx, {
        policyId: created.policyId,
        versionId: created.versionId,
        actor: principal.userId,
        ...(typeof body.justification === 'string' && body.justification.length <= 2_000
          ? { justification: body.justification }
          : {}),
      });
      return {
        status: 201,
        body: {
          policyId: created.policyId,
          versionId: activated.versionId,
          versionNumber: activated.versionNumber,
          status: 'ACTIVE',
          widened: activated.widened,
        },
      };
    }),
  );

  app.get('/v1/audit/events', async (request, reply) =>
    asOperator('audit:read')(request, reply, async (tx) => {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const after = typeof query.after === 'string' ? query.after : undefined;
      const limit = typeof query.limit === 'string' ? query.limit : undefined;
      if (after !== undefined && !/^\d{1,20}$/.test(after)) {
        return { status: 400, body: { code: 'INVALID_REQUEST', detail: 'after must be a decimal seq' } };
      }
      if (limit !== undefined && (!/^\d{1,6}$/.test(limit) || Number(limit) < 1)) {
        return { status: 400, body: { code: 'INVALID_REQUEST', detail: 'limit must be between 1 and 999999' } };
      }
      const log = await readEventLog(tx.client, tx.orgId, {
        ...(after === undefined ? {} : { afterSeq: after }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      });
      // `head` is the point of a full export, and it is a claim about the *whole* chain: an
      // export that verifies only against itself proves nothing about where it came from, so
      // the recomputed head is what an auditor compares against the value this API reported
      // at the time, or one written down when the payment happened.
      //
      // A window makes no head claim at all. `head` below is the hash the *whole* chain
      // recomputes to, which is the value an auditor compares against one written down
      // elsewhere; a prefix of rows cannot honestly carry that name, so the paged answer
      // reports only where to resume and leaves the walking to the reader — a tail that
      // verifies each page as it arrives is holding its own anchor, and one that reads a
      // server's word for it would not be verifying anything.
      if (after !== undefined || limit !== undefined) {
        return {
          status: 200,
          body: {
            organizationId: tx.orgId,
            readAt: new Date().toISOString(),
            events: log,
            nextCursor: log.at(-1)?.seq ?? after ?? '0',
          },
        };
      }
      return {
        status: 200,
        body: {
          organizationId: tx.orgId,
          exportedAt: new Date().toISOString(),
          events: log,
          head: verifyEventLog(log).head,
        },
      };
    }),
  );

  // ---------------------------------------------------------------------------
  // The console's reads.
  //
  // Until now every read in this file was by primary key and answered a question the
  // *caller's own process* had already asked: an agent polling a request it submitted, an
  // approver opening an approval id that reached them out of band. A person who wants to see
  // a tenant — what moved today, what is waiting, which policy is live, who was refused and
  // why — had no route at all, and the numbers were only in a database they are not given
  // access to.
  //
  // Two of these scopes are the reason for the section. `transaction:read` and `policy:read`
  // have been in `SCOPES` since well before any route could ask for them, and `013` permits a
  // human credential to hold both, so a mint with either in its list looked like a grant while
  // nothing checked. A scope no route requires is decoration, which is the exact drift the
  // `013` CHECK was written to stop.
  //
  // What `GET /v1/transactions/:id` stays as: the thin status poll an agent makes about its
  // own request, on an agent credential, answering three fields. The console's record of the
  // same row is `/record` below, on a human credential with `transaction:read`, and the two are
  // separate paths because the two subjects are separate in the row (`013`) — one handler that
  // branches on which kind of caller it got is how that separation becomes a convention.
  // ---------------------------------------------------------------------------

  const readWindow = (query: Record<string, unknown>): { readonly limit: number } | GateReply => {
    const limit = query.limit;
    // The default is applied here rather than left to the read, so that the `limit` in the
    // response is the page the caller got, whatever either side's default happens to be.
    if (limit === undefined) return { limit: 50 };
    if (typeof limit !== 'string' || !/^\d{1,6}$/.test(limit) || Number(limit) < 1) {
      return { status: 400, body: { code: 'INVALID_REQUEST', detail: `limit must be between 1 and ${MAX_READ_LIMIT}` } };
    }
    // Clamped, not refused: a screen that asks for a thousand rows is asking for "everything
    // you have", and the answer is the first two hundred with the ceiling stated in the body.
    return { limit: Math.min(Number(limit), MAX_READ_LIMIT) };
  };

  app.get('/v1/transactions', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const window = readWindow(query);
    if ('status' in window) return reply.code(window.status).send(window.body);
    const agent = query.agent;
    if (agent !== undefined && (typeof agent !== 'string' || agent.length === 0 || agent.length > 200)) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', detail: 'agent must be a non-empty id, at most 200 characters' });
    }
    return asUser('transaction:read')(request, reply, async (tx) => ({
      status: 200,
      body: {
        organizationId: tx.orgId,
        readAt: new Date().toISOString(),
        limit: window.limit,
        transactions: await listRequests(tx, {
          limit: window.limit,
          ...(typeof agent === 'string' ? { agentId: agent } : {}),
        }),
      },
    }));
  });

  app.get('/v1/transactions/:id/record', async (request, reply) => {
    const params = request.params as { id: string };
    if (params.id.length === 0 || params.id.length > 200) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', detail: 'request id is malformed' });
    }
    return asUser('transaction:read')(request, reply, async (tx) => {
      const record = await requestRecord(tx, params.id);
      // The same rule the status poll follows: another tenant's row and no row at all answer
      // alike, because which one it was is itself a fact about someone else's payments.
      if (record === null) return { status: 404, body: { code: 'NOT_FOUND' } };
      return { status: 200, body: { transaction: record } };
    });
  });

  app.get('/v1/summary', async (request, reply) =>
    asUser('transaction:read')(request, reply, async (tx) => ({
      status: 200,
      body: {
        organizationId: tx.orgId,
        readAt: new Date().toISOString(),
        summary: await organizationSummary(tx),
      },
    })),
  );

  app.get('/v1/wallets', async (request, reply) =>
    asUser('wallet:manage')(request, reply, async (tx) => ({
      status: 200,
      body: {
        organizationId: tx.orgId,
        readAt: new Date().toISOString(),
        wallets: await listWallets(tx),
      },
    })),
  );

  app.get('/v1/policies', async (request, reply) => {
    const window = readWindow((request.query ?? {}) as Record<string, unknown>);
    if ('status' in window) return reply.code(window.status).send(window.body);
    return asUser('policy:read')(request, reply, async (tx) => ({
      status: 200,
      body: {
        organizationId: tx.orgId,
        readAt: new Date().toISOString(),
        limit: window.limit,
        policies: await listPolicies(tx, { limit: window.limit }),
      },
    }));
  });
}
