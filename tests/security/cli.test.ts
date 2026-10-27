/**
 * The CLI, driven against the real routes over a real socket.
 *
 * This is the test that turns the command line from a set of claims into a working thing.
 * Every flag below is exercised through `run()`, which opens an HTTP connection to a
 * listening `ari-api` — so the suite covers the parts `inject` cannot: the URL the operator
 * configures, the JSON the tool actually sends, the response shapes it actually parses, and
 * the one flow that has never been completable without a hand-written fixture: an agent
 * asks, a human answers, the agent finishes.
 *
 * Nothing here imports `@ari/identity`, `@ari/policies` or a database handle. That is the
 * assertion people will want to check: a tenant comes up from *one* command plus the
 * bootstrap token, and after that the CLI holds exactly what the API gave it — a bearer
 * secret and nothing else. No code path in this file can reach a table.
 */

import { readConfig, startApi, type DeliveryResult, type RunningApi, type SignerClient } from '@ari/api';
import { run } from '@ari/cli';
import { newId } from '@ari/schemas';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, DATABASE_URL } from './database.js';

const BOOTSTRAP = 'cli-suite-bootstrap-token';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';

const CONFIG = readConfig({
  // Mandatory since `017`, with no defaults on purpose: a suite that wants a config states which
  // chains, fee bounds and tokens it signs for, exactly as a deployment must.
  EVM_ALLOWED_CHAIN_IDS: '1',
  EVM_MAX_GAS_LIMIT: '500000',
  EVM_MAX_FEE_COST_WEI: '100000000000000000',
  ARI_NETWORK_NAME: 'mainnet',
  EVM_ASSET_REGISTRY: new URL('./fixtures/evm-assets.json', import.meta.url).pathname,
  DATABASE_URL,
  DATABASE_ROLE: 'ari_app',
  CREDENTIAL_PEPPER: 'cli-test-pepper-0123456789abcdef0123456789ab',
  TICKET_KEY: 't'.repeat(48),
  APPROVAL_KEY: 'a'.repeat(48),
  ORG_BOOTSTRAP_TOKEN: BOOTSTRAP,
});

/** Stands in for `ari-signer`: records the delivery, accepts it, and reports it as pending. */
const delivered: { ticket: string; canonical: string }[] = [];
const signer: SignerClient = {
  async deliver(request): Promise<DeliveryResult> {
    delivered.push(request);
    return { accepted: true, state: 'SIGNING_PENDING' };
  },
};

let api: RunningApi;
let url = '';
let dir = '';
const errors: string[] = [];

/** Run one command and give back its exit code plus the single JSON result it printed. */
async function ari(
  ...argv: string[]
): Promise<{ exit: number; body: Record<string, any>; err: readonly string[] }> {
  const lines: string[] = [];
  const seen: string[] = [];
  const result = await run(
    ['--url', url, ...argv],
    (line) => lines.push(line),
    (line) => {
      seen.push(line);
      errors.push(line);
    },
  );
  // Stdout is parsed as JSON and nothing else: if the tool ever prints prose down that
  // stream, this line is where the test finds out, loudly.
  return { exit: result.exit, body: lines.length === 0 ? {} : (JSON.parse(lines.join('')) as Record<string, any>), err: seen };
}

beforeAll(async () => {
  const pool = await connect(1);
  await pool.end();
  api = await startApi(CONFIG, signer);
  // A real port, because `--url` is the thing under test. Port 0 lets the kernel pick, so
  // two workers cannot collide on a number someone wrote down.
  await api.app.listen({ port: 0, host: '127.0.0.1' });
  const address = api.app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('the listening socket has no address');
  url = `http://127.0.0.1:${address.port}`;
  dir = mkdtempSync(join(tmpdir(), 'ari-cli-'));
});

afterAll(async () => {
  await api?.close();
});

const state: {
  token: string;
  organizationId: string;
  agentId: string;
  walletId: string;
  versionId: string;
  agentToken: string;
  approvalId: string;
  requestId: string;
} = {
  token: '',
  organizationId: '',
  agentId: '',
  walletId: '',
  versionId: '',
  agentToken: '',
  approvalId: '',
  requestId: '',
};

describe('ari, end to end', () => {
  it('refuses to guess a deployment', async () => {
    const lines: string[] = [];
    const result = await run(['agent', 'list'], (line) => lines.push(line), (line) => lines.push(`err ${line}`));
    expect(result.exit).toBe(2);
    expect(lines.join(' ')).toMatch(/err ari: --url is required/);
    // The refusal is not also on stdout.
    expect(lines.some((line) => !line.startsWith('err '))).toBe(false);
  });

  it('names an unknown command instead of running the nearest one', async () => {
    const { exit } = await ari('appprovals', 'list');
    expect(exit).toBe(2);
  });

  it('brings a tenant up from the bootstrap token alone', async () => {
    const made = await ari('--bootstrap', BOOTSTRAP, 'init', '--name', 'CLI Co');
    expect(made.exit, made.err.join(' ')).toBe(0);
    expect(made.body.organizationId).toMatch(/^org_/);
    expect(made.body.bearer).toContain('.ucrd_');
    state.organizationId = String(made.body.organizationId);
    state.token = String(made.body.bearer);
  });

  it('sends no credential at all to the routes that need one', async () => {
    const anonymous = await ari('agent', 'list');
    expect(anonymous.exit).toBe(1);
    expect(anonymous.err.join(' ')).toMatch(/401 (UNAUTHENTICATED|CREDENTIAL_MISSING)/);
  });

  it('creates the agent, the wallet and the policy, in that order', async () => {
    const agent = await ari('--token', state.token, 'agent', 'create', '--name', 'payer');
    expect(agent.exit, agent.err.join(' ')).toBe(0);
    state.agentId = String(agent.body.agentId);

    const wallet = await ari(
      '--token', state.token,
      'wallet', 'create',
      '--name', 'operations',
      '--mode', 'delegated',
      '--triple', 'SECP256K1/ECDSASecp256k1/KECCAK256',
      '--provider', 'mock',
    );
    expect(wallet.exit, wallet.err.join(' ')).toBe(0);
    state.walletId = String(wallet.body.walletId);

    const document = {
      meta: { name: 'cli', description: null },
      target: {
        walletId: state.walletId,
        authorityMode: 'delegated',
        signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
      },
      permissions: {
        transfers: {
          enabled: true,
          chains: ['ethereum'],
          assets: [{ kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 }],
          recipients: { mode: 'allowlist', addresses: [RECIPIENT] },
          perTransaction: { maxRaw: '5000000000', unit: 'usdc-6dp' },
          perDay: { maxRaw: '5000000000', unit: 'usdc-6dp' },
          perMonth: null,
          maxTransactionsPerHour: 20,
        },
        contractCalls: { enabled: false, contracts: [] },
        newRecipients: { allowed: false, requireApproval: false },
      },
      escalation: {
        humanApproval: {
          requiredWhen: [{ op: 'amount_gt', raw: '1000000000', unit: 'usdc-6dp' }],
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
    const policyPath = join(dir, 'policy.json');
    writeFileSync(policyPath, JSON.stringify({ name: 'cli', document }, null, 2), 'utf8');

    const applied = await ari('--token', state.token, 'policy', 'apply', '--file', policyPath, '--activate');
    expect(applied.exit, applied.err.join(' ')).toBe(0);
    expect(applied.body.status).toBe('ACTIVE');
    state.versionId = String(applied.body.versionId);

    const granted = await ari(
      '--token', state.token,
      'wallet', 'grant',
      '--agent', state.agentId,
      '--wallet', state.walletId,
      '--policy-version', state.versionId,
    );
    expect(granted.exit, granted.err.join(' ')).toBe(0);

    const credential = await ari(
      '--token', state.token,
      'agent', 'credential',
      '--agent', state.agentId,
      '--scopes', 'transaction:request',
      '--ttl-ms', '3600000',
    );
    expect(credential.exit, credential.err.join(' ')).toBe(0);
    expect(credential.body.bearer).toContain('.crd_');
    state.agentToken = String(credential.body.bearer);
  });

  it('refuses the one credential that would put both sides of the boundary on one secret', async () => {
    const attempted = await ari(
      '--token', state.token,
      'agent', 'credential',
      '--agent', state.agentId,
      '--scopes', 'transaction:request,approval:decide',
    );
    expect(attempted.exit).toBe(1);
    expect(attempted.err.join(' ')).toMatch(/400 INVALID_REQUEST.*approval:decide/s);
  });

  it('asks for money the agent cannot spend alone, and gets a human instead', async () => {
    const payload = {
      candidate: {
        kind: 'transfer',
        chain: 'ethereum',
        requestId: newId('req'),
        agentId: state.agentId,
        walletId: state.walletId,
        deadline: new Date(Date.now() + 300_000).toISOString(),
        idempotencyKey: 'cli-2000',
        usdEstimate: null,
        asset: { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 },
        amount: { raw: '2000000000', unit: 'usdc-6dp' },
        recipient: { chain: 'ethereum', address: RECIPIENT },
        replayProtection: { scheme: 'account_sequence', nonce: '1', chainId: '1', gasLimit: '21000', maxFeePerUnit: '20000000000', maxPriorityFeePerUnit: '1000000000' },
      },
      idempotencyKey: 'cli-2000',
    };
    const path = join(dir, 'ask.json');
    writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');

    const pending = await ari('--token', state.token, 'tx', 'authorize', '--file', path, '--agent-token', state.agentToken);
    expect(pending.exit, pending.err.join(' ')).toBe(0);
    expect(pending.body.state).toBe('APPROVAL_PENDING');
    state.approvalId = String(pending.body.approvalId);
    state.requestId = String(pending.body.requestId);

    const queue = await ari('--token', state.token, 'approvals', 'list');
    expect(queue.exit, queue.err.join(' ')).toBe(0);
    expect((queue.body.approvals as { approvalId: string }[]).map((a) => a.approvalId)).toContain(state.approvalId);

    const decided = await ari('--token', state.token, 'approvals', 'decide', '--id', state.approvalId, '--decision', 'APPROVED');
    expect(decided.exit, decided.err.join(' ')).toBe(0);
    expect(decided.body.state).toBe('GRANTED');
    // The seal went to the human on stderr, not into the JSON on stdout — the stream a
    // script reads is not the stream a capability belongs on.
    const note = decided.err.find((line) => line.startsWith('hand this to the agent: ')) ?? '';
    expect(note).toMatch(/hand this to the agent: /);
    // The seal is the *result* of the decision, so it belongs on stdout — `jq -r
    // .approvalToken` is how the next command gets it — and the stderr line is the delivery
    // note that tells a human who to give it to.
    const token = String(decided.body.approvalToken);
    expect(token.length).toBeGreaterThan(20);

    writeFileSync(
      path,
      JSON.stringify({ ...payload, approvalToken: token }, null, 2),
      'utf8',
    );
    const completed = await ari('--token', state.token, 'tx', 'authorize', '--file', path, '--agent-token', state.agentToken);
    expect(completed.exit, completed.err.join(' ')).toBe(0);
    // `SIGNING_PENDING` because the stub in this file reports what the signer's mock reports:
    // the ticket was accepted and the signature is in flight. The same loop run against the
    // real two processes answers `COMPLETE` — recorded in AGENTS.md rather than asserted here,
    // because a suite cannot be the authority on a provider it replaced with a stub.
    expect(completed.body.state).toBe('SIGNING_PENDING');
    expect(completed.body.requestId).toBe(state.requestId);
    expect(delivered).toHaveLength(1);
  });

  it('exports the chain, and verifies it against the head the API reports', async () => {
    const path = join(dir, 'audit.json');
    const exported = await ari('--token', state.token, 'audit', 'export', '--out', path);
    expect(exported.exit, exported.err.join(' ')).toBe(0);
    expect(Number(exported.body.events)).toBeGreaterThan(8);

    const checked = await ari('--token', state.token, 'verify', 'chain', '--in', path, '--head', String(exported.body.head));
    expect(checked.exit, checked.err.join(' ')).toBe(0);
    expect(checked.body.ok).toBe(true);
    expect(checked.body.externalHeadMatches).toBe(true);

    // One word changed in the file, and the same command that just accepted it now refuses.
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { events: { seq: string; actor: string }[] };
    const target = raw.events.find((event) => event.seq === raw.events[4]?.seq);
    if (target !== undefined) target.actor = 'not-who-wrote-this';
    writeFileSync(path, JSON.stringify(raw), 'utf8');

    const refused = await ari('--token', state.token, 'verify', 'chain', '--in', path, '--head', String(exported.body.head));
    expect(refused.exit).toBe(1);
    expect(refused.err.join(' ')).toMatch(/CHAIN_BREAK/);
  });

  it('tails the same chain it exported, page by page, to the same head', async () => {
    // The paging test that matters is not "did it fetch twice" but "did the second page
    // verify against the first page's answer". `--limit 2` forces several windows over a
    // chain the export command read in one, and both must end on the same hash — which is
    // the only thing in this suite that says the cursor and the export are looking at one
    // chain rather than two views that happen to agree today.
    const exported = await ari('--token', state.token, 'audit', 'export');
    expect(exported.exit, exported.err.join(' ')).toBe(0);
    const total = (exported.body.events as unknown[]).length;
    expect(total).toBeGreaterThan(8);

    const lines: string[] = [];
    const tailed = await run(
      ['--url', url, '--token', state.token, 'audit', 'tail', '--limit', '5', '--interval-ms', '1'],
      (line) => lines.push(line),
      (line) => errors.push(line),
    );
    expect(tailed.exit, errors.join(' ')).toBe(0);
    const pages = lines.map((line) => JSON.parse(line) as { ok: boolean; verified: number; head: string; events: unknown[] });
    // No `--once`: the run ends because the cursor caught up with the chain, which is the
    // only way this suite can tell a working `after=` from a page that was refetched.
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.every((page) => page.ok)).toBe(true);
    expect(pages.reduce((sum, page) => sum + page.events.length, 0)).toBe(total);
    expect(pages.at(-1)?.verified).toBe(total);
    expect(pages.at(-1)?.head).toBe(String(exported.body.head));
  });

  it('previews a decision it is not allowed to act on', async () => {
    const payload = {
      candidate: {
        kind: 'transfer',
        chain: 'ethereum',
        requestId: newId('req'),
        agentId: state.agentId,
        walletId: state.walletId,
        deadline: new Date(Date.now() + 300_000).toISOString(),
        idempotencyKey: 'cli-preview',
        usdEstimate: null,
        asset: { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 },
        amount: { raw: '2000000000', unit: 'usdc-6dp' },
        recipient: { chain: 'ethereum', address: RECIPIENT },
        replayProtection: { scheme: 'account_sequence', nonce: '9', chainId: '1', gasLimit: '21000', maxFeePerUnit: '20000000000', maxPriorityFeePerUnit: '1000000000' },
      },
      idempotencyKey: 'cli-preview',
    };
    const path = join(dir, 'preview.json');
    writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');

    const before = await ari('--token', state.token, 'audit', 'export');
    const previewed = await ari('--token', state.token, 'tx', 'evaluate', '--file', path, '--agent-token', state.agentToken);
    expect(previewed.exit, previewed.err.join(' ')).toBe(0);
    expect(previewed.body.state).toBe('DECIDED');
    expect(previewed.err.join(' ')).toMatch(/was a preview/);
    const after = await ari('--token', state.token, 'audit', 'export');
    // The count, not the shape: a preview that left one more row anywhere in the trail is a
    // preview that was an authorization wearing a shorter name.
    expect((after.body.events as unknown[]).length).toBe((before.body.events as unknown[]).length);
  });

  it('revokes an agent, and the secret stops working at the boundary', async () => {
    const agent = await ari('--token', state.token, 'agent', 'create', '--name', 'doomed');
    expect(agent.exit, agent.err.join(' ')).toBe(0);
    const agentId = String(agent.body.agentId);
    const credential = await ari(
      '--token', state.token,
      'agent', 'credential',
      '--agent', agentId,
      '--scopes', 'transaction:request',
    );
    expect(credential.exit, credential.err.join(' ')).toBe(0);
    const doomedToken = String(credential.body.bearer);

    // It works first. Without this line the test below only proves the secret was rejected,
    // which a typo, an expired ttl and a broken revoke all do equally well. Its own agent id
    // on the candidate, so nothing about *this* ask could fail for another reason: the point
    // is only that the boundary let it in.
    const payload = JSON.parse(readFileSync(join(dir, 'preview.json'), 'utf8')) as {
      candidate: Record<string, unknown>;
      idempotencyKey: string;
    };
    const own = join(dir, 'preview-doomed.json');
    writeFileSync(
      own,
      JSON.stringify({ ...payload, candidate: { ...payload.candidate, agentId, requestId: newId('req') } }, null, 2),
      'utf8',
    );
    expect((await ari('tx', 'evaluate', '--file', own, '--agent-token', doomedToken)).exit).toBe(0);

    const revoked = await ari('--token', state.token, 'agent', 'revoke', '--agent', agentId);
    expect(revoked.exit, revoked.err.join(' ')).toBe(0);
    expect(revoked.body.status).toBe('REVOKED');
    expect(revoked.body.credentialsRevoked).toBe(1);
    expect(revoked.err.join(' ')).toMatch(/1 credential\(s\) revoked with it/);

    const refused = await ari('tx', 'evaluate', '--file', own, '--agent-token', doomedToken);
    expect(refused.exit).toBe(1);
    // A revoked secret refuses exactly like a wrong one. The alternative — "that agent is
    // revoked" — tells whoever holds the secret that the id was real and which door to keep
    // pushing on, which is the same reason `crd_` and `ucrd_` refusals are interchangeable.
    expect(refused.err.join(' ')).toMatch(/401 UNAUTHENTICATED/);

    const again = await ari('--token', state.token, 'agent', 'revoke', '--agent', agentId);
    expect(again.exit, again.err.join(' ')).toBe(0);
    expect(again.body.alreadyRevoked).toBe(true);
    // The second call is not a second act, so it must not read as one in the trail.
    const trail = await ari('--token', state.token, 'audit', 'export');
    const revocations = (trail.body.events as { eventType: string; resourceId: string; actorType: string }[]).filter(
      (event) => event.eventType === 'agent.revoked' && event.resourceId === agentId,
    );
    expect(revocations).toHaveLength(1);
    expect(revocations[0]?.actorType).toBe('human');
  });

  it('reads another tenant’s agent as no agent at all', async () => {
    const other = await ari('--bootstrap', BOOTSTRAP, 'init', '--name', 'Rival Corp');
    expect(other.exit, other.err.join(' ')).toBe(0);
    const refused = await ari('--token', String(other.body.bearer), 'agent', 'revoke', '--agent', state.agentId);
    expect(refused.exit).toBe(1);
    expect(refused.err.join(' ')).toMatch(/404 NOT_FOUND/);
    // And the real agent is still standing: the refusal is a not-found, not a side effect.
    expect((await ari('--token', state.token, 'agent', 'list')).body.agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: state.agentId })]),
    );
  });

  it('does not let an agent secret open the operator’s gate', async () => {
    const approverOnly = await ari(
      '--token', state.token,
      'agent', 'credential',
      '--agent', state.agentId,
      '--scopes', 'transaction:request',
    );
    expect(approverOnly.exit).toBe(0);
    const refused = await ari('agent', 'revoke', '--agent', state.agentId, '--token', String(approverOnly.body.bearer));
    expect(refused.exit).toBe(1);
    // An agent secret does not parse at a human route, so this refusal is indistinguishable
    // from a wrong secret — which is `013`'s CHECK doing its job rather than a message that
    // explains which of the two the caller almost had.
    expect(refused.err.join(' ')).toMatch(/401 UNAUTHENTICATED/);
  });
});
