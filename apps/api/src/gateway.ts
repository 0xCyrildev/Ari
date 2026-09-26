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

import { verifyCredential, type Connector } from '@ari/identity';
import { timingSafeEqual } from 'node:crypto';

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
}

function bearer(header: string | undefined): string | null {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const value = header.slice(7).trim();
  return value.length === 0 ? null : value;
}

export async function authenticateAgent(deps: GatewayDeps, header: string | undefined): Promise<AuthResult> {
  const presented = bearer(header);
  if (presented === null) {
    return { ok: false, status: 401, code: 'CREDENTIAL_MISSING', detail: 'expected a bearer credential' };
  }
  const verified = await verifyCredential(deps.pool, presented, deps.masterPepper, deps.nowMs);
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

/** Constant-time on equal lengths; a length mismatch is not a secret worth hiding. */
export function acceptsBootstrapToken(configured: string, header: string | undefined): boolean {
  const presented = bearer(header);
  if (configured.length < 16 || presented === null || presented.length !== configured.length) return false;
  const a = Buffer.from(configured, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}
