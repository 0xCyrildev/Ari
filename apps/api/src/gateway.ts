/**
 * The gateway: who is calling, and whether this deployment is allowed to answer.
 *
 * Two mechanisms, deliberately kept apart. An *agent* authenticates with a bearer
 * credential, and verification is Argon2id over a peppered secret — which is why
 * every unauthenticated failure here returns one status code and one shape: the
 * difference between "no such key" and "wrong secret" is the difference between an
 * oracle and an obstacle (T8's enumeration half).
 *
 * Organisation creation is not agent-authenticated and not human-authenticated. It
 * is bootstrap-authenticated: one token, held by the deployment rather than by a
 * tenant, compared in constant time. §5.6 exists because an open `POST /v1/organizations`
 * hands anyone the ability to mint tenant boundaries.
 */

import { verifyCredential, verifyUserCredential, type Connector } from '@ari/identity';
import { acceptsBearerSecret, bearerToken } from '@ari/signing';

export interface Principal {
  readonly orgId: string;
  readonly agentId: string;
  readonly credentialId: string;
  /**
   * Deliberately not the scopes. `verifyCredential` reads them outside any tenant
   * transaction, and the kernel must not be handed a scope list that a request ten
   * seconds after a revocation could still be carrying — `authorize` reads them again
   * inside its own transaction, from the row that is authoritative at that moment. A
   * field here would be a second source of truth that looks authoritative.
   */
}

export type AuthFailure = {
  readonly ok: false;
  readonly status: 401 | 403;
  readonly code: string;
  readonly detail: string;
};

export type AuthResult = { readonly ok: true; readonly principal: Principal } | AuthFailure;

export interface GatewayDeps {
  readonly pool: Connector;
  readonly masterPepper: string;
  readonly nowMs: () => bigint;
  /**
   * The one observability seam in this module, and it is a callback rather than an import:
   * this file decides who is calling and knows nothing about how the process reports
   * itself. Absent means no counting, which is what every test and any caller that does
   * not care gets.
   *
   * It fires only when a hash was actually computed. A request with no bearer header at
   * all is refused before Argon2id runs and costs this process nothing, so counting it
   * beside a wrong-secret attempt would blur exactly the distinction the endpoint exists to
   * make — and the number worth watching is how much hashing a stranger can buy.
   */
  readonly noteVerify?: (kind: 'agent' | 'user', result: 'accepted' | 'refused') => void;
}

/** The bearer grammar lives in `@ari/signing`, because so does the other gate that uses it. */
const bearer = bearerToken;

export async function authenticateAgent(deps: GatewayDeps, header: string | undefined): Promise<AuthResult> {
  const presented = bearer(header);
  if (presented === null) {
    return { ok: false, status: 401, code: 'CREDENTIAL_MISSING', detail: 'expected a bearer credential' };
  }
  const verified = await verifyCredential(deps.pool, presented, deps.masterPepper);
  deps.noteVerify?.('agent', verified.ok ? 'accepted' : 'refused');
  if (!verified.ok) {
    // One code for every reason a credential fails at the gate. `AGENT_PAUSED` and
    // `CREDENTIAL_REVOKED` are distinguished *inside* the decision, where they
    // reach the audit trail; at the boundary they must look identical, or the
    // endpoint answers "does this key exist" for anyone who asks.
    return { ok: false, status: 401, code: 'UNAUTHENTICATED', detail: 'the credential was not accepted' };
  }
  return {
    ok: true,
    principal: {
      orgId: verified.orgId,
      agentId: verified.agentId,
      credentialId: verified.credentialId,
    },
  };
}

/**
 * The length floor is this gate's own policy — a deployment that named no token has
 * closed the endpoint, not opened it — and the comparison is the shared one.
 */
export function acceptsBootstrapToken(configured: string, header: string | undefined): boolean {
  if (configured.length < 16) return false;
  return acceptsBearerSecret(configured, bearer(header));
}

/**
 * An approver is a different kind of caller, and it is a different function because the
 * two must not be able to be confused.
 *
 * The shape is deliberately the same as `authenticateAgent`, including what it does not
 * carry: no scopes on the principal. `verifyUserCredential` reads them outside any
 * tenant transaction, and a scope list that a request ten seconds after a revocation
 * could still be carrying is not an authority — the route re-reads them inside its own
 * transaction from the row that is authoritative at that moment.
 *
 * What differs is only which table answers and which refusal names are returned. An
 * `ucrd_` secret cannot reach the agent gate at all — it does not parse there — and
 * every failure at either gate looks the same from outside, for T8's enumeration half.
 */
export interface ApproverPrincipal {
  readonly orgId: string;
  readonly userId: string;
  readonly credentialId: string;
}

export type ApproverAuthResult =
  | { readonly ok: true; readonly principal: ApproverPrincipal }
  | AuthFailure;

export async function authenticateApprover(deps: GatewayDeps, header: string | undefined): Promise<ApproverAuthResult> {
  const presented = bearer(header);
  if (presented === null) {
    return { ok: false, status: 401, code: 'CREDENTIAL_MISSING', detail: 'expected a bearer credential' };
  }
  const verified = await verifyUserCredential(deps.pool, presented, deps.masterPepper);
  deps.noteVerify?.('user', verified.ok ? 'accepted' : 'refused');
  if (!verified.ok) {
    return { ok: false, status: 401, code: 'UNAUTHENTICATED', detail: 'the credential was not accepted' };
  }
  return {
    ok: true,
    principal: { orgId: verified.orgId, userId: verified.userId, credentialId: verified.credentialId },
  };
}
