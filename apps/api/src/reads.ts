/**
 * The reads a human surface asks for, and the reason they are here rather than in a handler.
 *
 * `routes.ts` states the rule for the write path: a handler authenticates, parses, calls,
 * strips. A list query is not a write, but it has the same hazard in a different costume —
 * the interesting part of "show me this tenant's payment requests" is which row is chosen as
 * the decision that governs a request, whether a refusal's reason codes come from the row or
 * from the trail, and what happens when a page has no bound. That is logic, so it does not go
 * in a handler.
 *
 * They are in the API process rather than in `@ari/identity` on purpose. `identity` owns
 * tenancy, credentials, wallets, grants and the request row; these reads join across
 * `policy_versions`, `approval_requests` and `limit_counters` too, and moving them into
 * identity would make that package the thing that knows everyone else's columns while the
 * pipeline still reads its own through its own functions. This is the human plane's read
 * layer: it composes, it does not decide.
 *
 * Three invariants every function here keeps:
 *
 * - **Every query is scoped by `tx.orgId` and runs inside `asTenant`,** so row security is the
 *   enforcement and the predicate is the second line. There is no "bootstrap connections skip
 *   the policy" carve-out in this file, because that carve-out is the hole.
 * - **Money and counts cross as decimal strings.** `numeric(80,0)` and `bigint` both arrive
 *   from the driver as strings, and an `int8` cast would overflow 10³⁰ raw wei silently while
 *   `Number()` loses precision above 2⁵³. Nothing here converts either; the boundary that
 *   formats them is `apps/web/lib/ari/format.ts`.
 * - **Every list is capped, and the cap is in the response.** An uncapped read is a page that
 *   works at three rows and stops working at thirty thousand, and `GET /v1/agents` is the
 *   counter-example this file does not repeat.
 */

import type { TenantTx } from '@ari/identity';

/** The newest-row-first ceiling on every list here, and the default page a screen gets. */
const DEFAULT_LIMIT = 50;
/**
 * Exported because the route echoes the page it applied, and a ceiling that lives in two
 * files is a ceiling one of them will drift: a response that says `limit: 999999` while the
 * read returned two hundred rows is the same lie as an uncapped one, only quieter.
 */
export const MAX_READ_LIMIT = 200;
const MAX_LIMIT = MAX_READ_LIMIT;

/** The trail attached to one request: enough to read a payment's life, not a whole chain. */
const RECORD_TRAIL_LIMIT = 100;

/** The ISO instant a `timestamptz` becomes, or null when the column is nullable and empty. */
const iso = (value: Date | null): string | null => (value instanceof Date ? value.toISOString() : null);

export interface RequestListItem {
  readonly id: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly lifecycleState: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly digest: string;
  readonly recipientAddress: string | null;
  /** Decimal string, or null for a request that carries no amount. Not zero. */
  readonly amountRaw: string | null;
  readonly currencyUnit: string | null;
  /**
   * What the risk plane said, from the newest `risk.assessed` event — or null when nothing
   * assessed this candidate, which is a state a policy decided around rather than a zero.
   * `score` stays a string: re-parsing it into a number would put a float on a path whose
   * founding rule is that floats do not carry money.
   */
  readonly risk: { readonly level: string; readonly score: string; readonly signals: readonly string[] } | null;
  /**
   * What decided this request, from the newest `policy.evaluated` event.
   *
   * Not from `authorization_decisions`, which is the tempting source and the wrong one: that
   * table is written at one call site, on the path where an ALLOW reserves money and a ticket
   * is minted from the row. A denial and an escalation write no decision row at all, so a read
   * that joined the table alone would report "nothing decided this" about exactly the requests
   * a human is most interested in. The trail is the only record every outcome has, and the
   * `committedDecisionId` below is what distinguishes a decision that committed capacity from
   * one that only refused.
   */
  readonly decision: {
    readonly outcome: 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN_APPROVAL';
    readonly policyVersionId: string;
    readonly madeAt: string;
    readonly reasonCodes: readonly string[];
    /** The `authorization_decisions` row, when the outcome created one. Null is a refusal. */
    readonly committedDecisionId: string | null;
  } | null;
}

/**
 * The one copy of "which row is this request's decision, and why".
 *
 * Both reads below append their own `WHERE`/`ORDER BY`/`LIMIT` to this, because the rule it
 * encodes — the newest evaluation governs, and the reason codes are the event's — is the answer
 * two screens have to agree about. Written twice in two query strings is how `011`'s dropped
 * CHECK and `014`'s `rows[0]` readers happened: the day the two copies disagree, one of them is
 * showing a human a reason no decision gave.
 *
 * Params: `$1` is the tenant, and the predicates live in the callers.
 */
const GOVERNED_REQUEST = `
  SELECT r.id, r.agent_id, r.wallet_id, r.lifecycle_state, r.created_at, r.updated_at,
         r.digest, r.recipient_address, r.amount_raw, r.currency_unit,
         r.canonical, r.idempotency_key,
         e.outcome, e.policy_version_id, e.made_at, e.reason_codes,
         k.risk_level, k.risk_score, k.risk_signals,
         (SELECT dd.id
            FROM ari.authorization_decisions dd
           WHERE dd.org_id = r.org_id AND dd.request_id = r.id
           ORDER BY dd.made_at DESC, dd.id
           LIMIT 1) AS committed_decision_id
    FROM ari.transaction_requests r
    LEFT JOIN LATERAL (
      SELECT ee.decision AS outcome, ee.policy_version_id, ee.made_at, ee.reason_codes
        FROM ari.audit_events ee
       WHERE ee.org_id = r.org_id
         AND ee.resource = 'transaction_request'
         AND ee.resource_id = r.id
         AND ee.event_type = 'policy.evaluated'
       ORDER BY ee.seq DESC
       LIMIT 1
    ) e ON TRUE
    LEFT JOIN LATERAL (
      SELECT rr.metadata ->> 'riskLevel' AS risk_level,
             rr.metadata ->> 'riskScore' AS risk_score,
             rr.metadata -> 'riskSignals' AS risk_signals
        FROM ari.audit_events rr
       WHERE rr.org_id = r.org_id
         AND rr.resource = 'transaction_request'
         AND rr.resource_id = r.id
         AND rr.event_type = 'risk.assessed'
       ORDER BY rr.seq DESC
       LIMIT 1
    ) k ON TRUE
`;

/** The row shape `GOVERNED_REQUEST` returns: every column, in the driver's own types. */
interface GovernedRequestRow {
  readonly id: string;
  readonly agent_id: string;
  readonly wallet_id: string;
  readonly lifecycle_state: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly digest: string;
  readonly recipient_address: string | null;
  readonly amount_raw: string | null;
  readonly currency_unit: string | null;
  readonly canonical: string;
  readonly idempotency_key: string;
  readonly outcome: 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN_APPROVAL' | null;
  readonly policy_version_id: string | null;
  readonly made_at: Date | null;
  readonly reason_codes: string[] | null;
  readonly committed_decision_id: string | null;
  readonly risk_level: string | null;
  readonly risk_score: string | null;
  readonly risk_signals: string[] | null;
}

/** The one mapping from that row to the two interfaces above. */
const governedToListItem = (row: GovernedRequestRow): RequestListItem => ({
  id: row.id,
  agentId: row.agent_id,
  walletId: row.wallet_id,
  lifecycleState: row.lifecycle_state,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  digest: row.digest,
  recipientAddress: row.recipient_address,
  amountRaw: row.amount_raw,
  currencyUnit: row.currency_unit,
  risk:
    row.risk_level === null || row.risk_score === null
      ? null
      : { level: row.risk_level, score: row.risk_score, signals: row.risk_signals ?? [] },
  decision:
    row.outcome === null || row.made_at === null
      ? null
      : {
          outcome: row.outcome,
          policyVersionId: row.policy_version_id as string,
          madeAt: row.made_at.toISOString(),
          reasonCodes: row.reason_codes ?? [],
          committedDecisionId: row.committed_decision_id,
        },
});

export async function listRequests(
  tx: TenantTx,
  input: { readonly limit?: number; readonly agentId?: string } = {},
): Promise<readonly RequestListItem[]> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const rows = await tx.client.query<GovernedRequestRow>(
    `${GOVERNED_REQUEST}
      WHERE r.org_id = $1 AND ($2::text IS NULL OR r.agent_id = $2)
      ORDER BY r.created_at DESC, r.id
      LIMIT $3`,
    [tx.orgId, input.agentId ?? null, limit],
  );
  return rows.rows.map(governedToListItem);
}

export interface TrailEvent {
  readonly seq: string;
  readonly madeAt: string;
  readonly eventType: string;
  readonly actor: string;
  readonly actorType: string;
  readonly severity: string;
  readonly decision: string | null;
  readonly reasonCodes: readonly string[];
  /** The writer's `SafeLogFields` object: typed at the append, so no secret has a shape here. */
  readonly meta: unknown;
}

export interface RequestRecord extends RequestListItem {
  /** The canonicalised candidate the digest was taken over — the bytes the ticket sealed. */
  readonly canonical: string;
  readonly idempotencyKey: string;
  readonly trail: readonly TrailEvent[];
}

/**
 * Everything one request is: the row, its governing decision, and its own slice of the chain.
 *
 * The trail travels with the record because the question a detail screen answers is "what
 * happened to *this*", and answering it from `GET /v1/audit/events` would mean reading the
 * tenant's whole log and filtering it in a browser — a page that goes quieter as the tenant
 * gets busier. `015` is the index that makes this one probe per event instead.
 *
 * A row from another tenant is `null`, and the route turns that into the same 404 it uses for
 * a row that does not exist; row security has already made the two indistinguishable here.
 */
export async function requestRecord(tx: TenantTx, requestId: string): Promise<RequestRecord | null> {
  const rows = await tx.client.query<GovernedRequestRow>(
    `${GOVERNED_REQUEST}
      WHERE r.org_id = $1 AND r.id = $2`,
    [tx.orgId, requestId],
  );
  const row = rows.rows[0];
  if (row === undefined) return null;

  const trail = await tx.client.query<{
    seq: string;
    made_at: Date;
    event_type: string;
    actor: string;
    actor_type: string;
    severity: string;
    decision: string | null;
    reason_codes: string[];
    metadata: unknown;
  }>(
    `SELECT seq, made_at, event_type, actor, actor_type, severity, decision, reason_codes, metadata
       FROM ari.audit_events
      WHERE org_id = $1 AND resource = 'transaction_request' AND resource_id = $2
      ORDER BY seq DESC
      LIMIT $3`,
    [tx.orgId, requestId, RECORD_TRAIL_LIMIT],
  );

  return {
    ...governedToListItem(row),
    canonical: row.canonical,
    idempotencyKey: row.idempotency_key,
    trail: trail.rows
      .map((event) => ({
        seq: event.seq,
        madeAt: event.made_at.toISOString(),
        eventType: event.event_type,
        actor: event.actor,
        actorType: event.actor_type,
        severity: event.severity,
        decision: event.decision,
        reasonCodes: event.reason_codes,
        meta: event.metadata,
      }))
      // Oldest first: a payment's life reads forward, and the chain itself is linked forward,
      // so the display order matches the order the hashes were computed in.
      .reverse(),
  };
}

export interface WalletRow {
  readonly id: string;
  readonly displayName: string;
  readonly mode: 'delegated' | 'user_gated';
  readonly provider: string;
  /** The chain address, or null while nobody has recorded one — which is a refusal, not a bug. */
  readonly address: string | null;
  readonly createdAt: string;
  readonly supersededAt: string | null;
  readonly grants: readonly {
    readonly agentId: string;
    readonly policyVersionId: string;
    readonly grantedAt: string;
    readonly revokedAt: string | null;
  }[];
}

/**
 * The tenant's wallets and who may act through each.
 *
 * Two queries, grouped in TypeScript, because a `json_agg` of grants would put the shape of a
 * join in a string and the shape of the response in two places that can disagree.
 * `superseded_at` is returned rather than filtered out: "this wallet was rotated, and the
 * agent that used it now has nothing" is a fact an operator needs to see, not history to hide.
 */
export async function listWallets(tx: TenantTx): Promise<readonly WalletRow[]> {
  const wallets = await tx.client.query<{
    id: string;
    display_name: string;
    mode: 'delegated' | 'user_gated';
    provider: string;
    address: string | null;
    created_at: Date;
    superseded_at: Date | null;
  }>(
    `SELECT id, display_name, mode, provider, address, created_at, superseded_at
       FROM ari.wallets WHERE org_id = $1 ORDER BY created_at DESC, id LIMIT $2`,
    [tx.orgId, MAX_LIMIT],
  );

  const grants = await tx.client.query<{
    wallet_id: string;
    agent_id: string;
    policy_version_id: string;
    granted_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT wallet_id, agent_id, policy_version_id, granted_at, revoked_at
       FROM ari.agent_wallet_grants WHERE org_id = $1 ORDER BY granted_at DESC, agent_id LIMIT $2`,
    [tx.orgId, MAX_LIMIT * 4],
  );

  return wallets.rows.map((wallet) => ({
    id: wallet.id,
    displayName: wallet.display_name,
    mode: wallet.mode,
    provider: wallet.provider,
    address: wallet.address,
    createdAt: wallet.created_at.toISOString(),
    supersededAt: iso(wallet.superseded_at),
    grants: grants.rows
      .filter((grant) => grant.wallet_id === wallet.id)
      .map((grant) => ({
        agentId: grant.agent_id,
        policyVersionId: grant.policy_version_id,
        grantedAt: grant.granted_at.toISOString(),
        revokedAt: iso(grant.revoked_at),
      })),
  }));
}

export interface PolicyRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly versions: readonly {
    readonly id: string;
    readonly versionNumber: number;
    readonly status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'RETIRED';
    readonly createdAt: string;
    readonly activatedAt: string | null;
    readonly justification: string | null;
    /** The authoring document: decimal strings for money, exactly as `createPolicy` stored it. */
    readonly document: unknown;
  }[];
}

/**
 * Policies and their version history, newest version first.
 *
 * This is the read that makes `policy:read` mean something. The scope has been in `SCOPES`
 * since before there was a route that could ask for it, and a scope no route requires is
 * decoration — which is the failure `013`'s CHECK was written against.
 *
 * The document comes back because a version's *content* is the thing an operator compares when
 * deciding whether a widening was justified; `005` froze it precisely so that this read can be
 * trusted to still mean what the decision did.
 */
export async function listPolicies(
  tx: TenantTx,
  input: { readonly limit?: number } = {},
): Promise<readonly PolicyRow[]> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const policies = await tx.client.query<{ id: string; name: string; created_at: Date }>(
    `SELECT id, name, created_at FROM ari.policies WHERE org_id = $1
      ORDER BY created_at DESC, id LIMIT $2`,
    [tx.orgId, limit],
  );
  const versions = await tx.client.query<{
    policy_id: string;
    id: string;
    version_number: number;
    status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'RETIRED';
    created_at: Date;
    activated_at: Date | null;
    justification: string | null;
    document: unknown;
  }>(
    `SELECT policy_id, id, version_number, status, created_at, activated_at, justification, document
       FROM ari.policy_versions WHERE org_id = $1
      ORDER BY created_at DESC, version_number DESC LIMIT $2`,
    [tx.orgId, limit * 10],
  );

  return policies.rows.map((policy) => ({
    id: policy.id,
    name: policy.name,
    createdAt: policy.created_at.toISOString(),
    versions: versions.rows
      .filter((version) => version.policy_id === policy.id)
      .map((version) => ({
        id: version.id,
        versionNumber: version.version_number,
        status: version.status,
        createdAt: version.created_at.toISOString(),
        activatedAt: iso(version.activated_at),
        justification: version.justification,
        document: version.document,
      })),
  }));
}

export interface Summary {
  /**
   * The two windows that are open *by the database's clock*, per agent. `window_key` is
   * derived from `now()` rather than accepted from the caller for the reason `014` states about
   * a limit that binds nothing: a key computed from a process clock half a day behind reads as
   * an empty window and a spent day looks unspent.
   */
  readonly windows: readonly {
    readonly agentId: string;
    readonly dimension: string;
    readonly windowKey: string;
    readonly currentReserved: string;
    readonly settled: string;
    readonly settledRequests: string;
    readonly reservedRequests: string;
  }[];
  readonly requestCountsByState: readonly { readonly state: string; readonly count: number }[];
  readonly agentsByStatus: readonly { readonly status: string; readonly count: number }[];
  readonly pendingApprovals: number;
  readonly liveWallets: number;
  readonly activePolicies: readonly {
    readonly policyVersionId: string;
    readonly policyName: string;
    readonly versionNumber: number;
  }[];
}

/**
 * The overview band's numbers, all from one tenant transaction.
 *
 * Every figure here is a count or a sum the row already holds; nothing is inferred, because an
 * overview that computes "spend today" by walking requests would be a second implementation of
 * the window the ledger actually enforces, and the two would drift.
 */
export async function organizationSummary(tx: TenantTx): Promise<Summary> {
  const windows = await tx.client.query<{
    agent_id: string;
    dimension: string;
    window_key: string;
    current_reserved: string;
    settled: string;
    settled_requests: string;
    reserved_requests: string;
  }>(
    `SELECT agent_id, dimension, window_key, current_reserved, settled, settled_requests, reserved_requests
       FROM ari.limit_counters
      WHERE org_id = $1
        AND (
          (dimension LIKE 'daily%'   AND window_key = to_char(now(), 'YYYY-MM-DD'))
          OR (dimension LIKE 'monthly%' AND window_key = to_char(now(), 'YYYY-MM'))
        )
      ORDER BY agent_id, dimension LIMIT $2`,
    [tx.orgId, MAX_LIMIT],
  );

  const requests = await tx.client.query<{ lifecycle_state: string; count: number }>(
    `SELECT lifecycle_state, count(*)::int AS count FROM ari.transaction_requests
      WHERE org_id = $1 GROUP BY lifecycle_state ORDER BY lifecycle_state`,
    [tx.orgId],
  );

  const agents = await tx.client.query<{ status: string; count: number }>(
    `SELECT status, count(*)::int AS count FROM ari.agents WHERE org_id = $1 GROUP BY status ORDER BY status`,
    [tx.orgId],
  );

  const approvals = await tx.client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ari.approval_requests
      WHERE org_id = $1 AND status = 'PENDING' AND expires_at > now()`,
    [tx.orgId],
  );

  const wallets = await tx.client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ari.wallets WHERE org_id = $1 AND superseded_at IS NULL`,
    [tx.orgId],
  );

  const active = await tx.client.query<{ id: string; policy_name: string; version_number: number }>(
    `SELECT pv.id, p.name AS policy_name, pv.version_number
       FROM ari.policy_versions pv
       JOIN ari.policies p ON p.id = pv.policy_id AND p.org_id = pv.org_id
      WHERE pv.org_id = $1 AND pv.status = 'ACTIVE'
      ORDER BY p.name, pv.version_number DESC`,
    [tx.orgId],
  );

  return {
    windows: windows.rows.map((row) => ({
      agentId: row.agent_id,
      dimension: row.dimension,
      windowKey: row.window_key,
      currentReserved: row.current_reserved,
      settled: row.settled,
      settledRequests: row.settled_requests,
      reservedRequests: row.reserved_requests,
    })),
    requestCountsByState: requests.rows.map((row) => ({ state: row.lifecycle_state, count: row.count })),
    agentsByStatus: agents.rows.map((row) => ({ status: row.status, count: row.count })),
    pendingApprovals: approvals.rows[0]?.count ?? 0,
    liveWallets: wallets.rows[0]?.count ?? 0,
    activePolicies: active.rows.map((row) => ({
      policyVersionId: row.id,
      policyName: row.policy_name,
      versionNumber: row.version_number,
    })),
  };
}
