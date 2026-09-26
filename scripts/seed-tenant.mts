/**
 * Seed a working tenant, from nothing.
 *
 * This exists because Ari has an operator token but no operator *surface*: the routes
 * that create an agent, activate a policy or mint a credential for one do not exist
 * outside `POST /v1/users` and `POST /v1/users/:id/credentials`, and those take the
 * deployment's bootstrap token rather than a person's session. So an operator — or a
 * developer, or the next session — still needs a way to get from an empty database to a
 * bearer token that can ask for money *and one that can say yes*. This is that way, and
 * it is the thing the Phase 9 CLI replaces.
 *
 * It runs as the application role through the same packages the decision plane uses, so
 * what it writes is what the service writes: the same grants, the same audit events, the
 * same row-security scope.
 *
 *   pnpm seed -- --name "Acme" --cap 5000 --escalate-above 1000
 */
import {
  asTenant,
  createAgent,
  createOrganization,
  createUser,
  createWallet,
  grantWalletToAgent,
  issueCredential,
  issueUserCredential,
  type Connector,
  type Scope,
} from '@ari/identity';
import { activateVersion, createPolicy } from '@ari/policies';
import { PolicyDocument, newId } from '@ari/schemas';
import { Pool } from 'pg';

const USDC = process.env.SEED_CONTRACT ?? '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RECIPIENT = process.env.SEED_RECIPIENT ?? '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
const UNIT = 'usdc-6dp';
const SIX = 1_000_000n;

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value !== undefined && !value.startsWith('--') ? value : fallback;
}

const databaseUrl = process.env.DATABASE_URL;
const pepper = process.env.CREDENTIAL_PEPPER;
if (databaseUrl === undefined || databaseUrl.length === 0) throw new Error('DATABASE_URL is required');
if (pepper === undefined || pepper.length < 32) throw new Error('CREDENTIAL_PEPPER must be at least 32 characters');

const raw = new Pool({ connectionString: databaseUrl, max: 2 });
// The application role, not the owner: if seeding needs a privilege the service does not
// have, that is worth learning here rather than in a deployment.
const app: Connector = {
  async connect() {
    const client = await raw.connect();
    await client.query(`SET ROLE ${process.env.DATABASE_ROLE ?? 'ari_app'}`);
    return client;
  },
};

const capUsd = BigInt(flag('cap', '5000'));
const escalateUsd = BigInt(flag('escalate-above', '1000'));
const orgName = flag('name', 'Seed Co');
const email = flag('owner-email', `owner@${newId('req').slice(4, 12)}.seed.test`);

const orgId = await createOrganization(app, { name: orgName, bootstrapActor: 'seed-script' });
const owner = await asTenant(app, orgId, (tx) =>
  createUser(tx, { email, displayName: 'Seed owner', role: 'owner', grantedBy: 'seed-script' }),
);

const seeded = await asTenant(app, orgId, async (tx) => {
  const agentId = await createAgent(tx, { name: flag('agent', 'payer'), createdBy: owner });
  const walletId = await createWallet(tx, {
    displayName: flag('wallet', 'operations'),
    mode: 'delegated',
    signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
    provider: 'mock',
    actor: owner,
  });

  const document: PolicyDocument = {
    meta: { name: 'seed', description: 'created by scripts/seed-tenant.mts' },
    target: { walletId, authorityMode: 'delegated', signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256' },
    permissions: {
      transfers: {
        enabled: true,
        chains: ['ethereum'],
        assets: [{ kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6n }],
        recipients: { mode: 'allowlist', addresses: [RECIPIENT] },
        perTransaction: { maxRaw: (capUsd * SIX).toString(), unit: UNIT },
        perDay: { maxRaw: (capUsd * SIX).toString(), unit: UNIT },
        perMonth: null,
        maxTransactionsPerHour: 20,
      },
      contractCalls: { enabled: false, contracts: [] },
      newRecipients: { allowed: false, requireApproval: false },
    },
    escalation: {
      humanApproval: {
        requiredWhen: [{ op: 'amount_gt', raw: (escalateUsd * SIX).toString(), unit: UNIT }],
        approverRoles: ['owner'],
        quorumEnforcement: 'application',
        quorum: 1,
      },
    },
    validity: {
      transactionTtlSeconds: 900,
      notBefore: null,
      notAfter: null,
      signingBudget: { maxIkaRawPerDay: '5000000', alertAtIkaRawPerDay: '2500000' },
    },
    fallback: {
      onUnknownTransaction: 'deny',
      onEvaluationError: 'deny',
      onRiskUnavailable: 'escalate',
      onSimulationUnavailable: 'allow_advisory',
    },
    limits: { maxUsdEstimateAgeSeconds: 300, maxDeadlineSkewSeconds: 60 },
  };

  const policy = await createPolicy(tx, { name: 'seed', document, actor: owner });
  await activateVersion(tx, { policyId: policy.policyId, versionId: policy.versionId, actor: owner });
  await grantWalletToAgent(tx, { agentId, walletId, policyVersionId: policy.versionId, actor: owner });
  const credential = await issueCredential(tx, {
    agentId,
    scopes: ['transaction:request'] as Scope[],
    ttlMs: BigInt(flag('ttl-hours', '24')) * 3_600_000n,
    masterPepper: pepper,
    actor: owner,
  });

  // The approver's half. Without it, a policy that escalates above `escalate-above`
  // produces an `APPROVAL_PENDING` that nobody outside this process can answer, which is
  // the difference between a control and a pause. Same pepper, same Argon2id, a different
  // table — and `013`'s CHECK means this credential cannot also propose a payment, so
  // the two bearers printed below are genuinely two different subjects.
  const approver = await issueUserCredential(tx, {
    userId: owner,
    scopes: ['approval:decide'],
    ttlMs: BigInt(flag('ttl-hours', '24')) * 3_600_000n,
    masterPepper: pepper,
    actor: owner,
  });

  return { agentId, walletId, policyVersionId: policy.versionId, credential, approver };
});

console.log(
  JSON.stringify(
    {
      organizationId: orgId,
      ownerId: owner,
      agentId: seeded.agentId,
      walletId: seeded.walletId,
      policyVersionId: seeded.policyVersionId,
      recipientAllowlist: [RECIPIENT],
      perTransactionCapRaw: (capUsd * SIX).toString(),
      escalateAboveRaw: (escalateUsd * SIX).toString(),
      // The only time this secret exists. It is hashed at rest with Argon2id over a
      // pepper that is not in the database, so it cannot be read back out afterwards —
      // which is why the script prints it and then has nothing to print.
      bearerCredential: seeded.credential.presented,
      credentialId: seeded.credential.credentialId,
      approverCredential: seeded.approver.presented,
      approverCredentialId: seeded.approver.credentialId,
      approverUserId: owner,
    },
    null,
    2,
  ),
);

await raw.end();
