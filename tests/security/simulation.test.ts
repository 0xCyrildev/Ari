/**
 * Simulation against a chain that exists, and a decision plane that has to read it.
 *
 * Postgres for the pipeline, `anvil` for the chain. Nothing here is stubbed at the RPC
 * boundary, because the interesting failures are all on that boundary: the node that
 * answers `0x` for an address with no code and makes a bad payment look clean, the pinned
 * block that quietly becomes the head, the revert whose selector is a protocol fact and
 * whose message is somebody else's prose. A fake could not lie about those in the right
 * way.
 *
 * The node is *ours*, on 127.0.0.1:8561, and the suite refuses to run if the port is
 * already taken rather than testing against whatever is there — which happened once
 * during development, against an orphaned anvil from a crashed run, and produced green
 * assertions about a chain that was not the one this file set up.
 */

import { authorize, type PipelineDeps } from '@ari/api';
import { ApprovalKey } from '@ari/approvals';
import { readEventLog } from '@ari/audit';
import {
  asTenant,
  createAgent,
  createOrganization,
  createUser,
  createWallet,
  grantWalletToAgent,
  issueCredential,
  type Connector,
  type Scope,
} from '@ari/identity';
import { activateVersion, createPolicy } from '@ari/policies';
import { behaviouralProvider } from '@ari/risk-engine';
import { TicketKey } from '@ari/signing';
import {
  NoneSimulationProvider,
  EvmForkProvider,
  type SimulationProvider,
  type SimulationResult,
} from '@ari/simulation';
import { CandidateTransaction, newId, PolicyDocument, type CanonicalDigest } from '@ari/schemas';
import { computeDigest } from '@ari/transaction-engine';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect as connectPool } from './database.js';

const PORT = 8561;
const HOST = '127.0.0.1';
const RPC = `http://${HOST}:${PORT}`;
const CHAIN_ID = '31337';
/** Anvil's well-known account #0 (the deployer, and the funded holder) and #1 (empty). */
const DEPLOYER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const SOMEONE_ELSE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const UNIT = 'usdc-6dp';
const VERSION = newId('ppv');
const PEPPER = 'simulation-test-pepper-0123456789abcdef';
const ZERO_WORD = '0'.repeat(64);

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/minierc20.json', import.meta.url), 'utf8'),
) as { creationBytecode: string; runtimeBytecode: string };

let pool: Pool;
let appPool: Pool;
const app: Connector = {
  async connect(): Promise<PoolClient> {
    const client = await appPool.connect();
    await client.query(`SET ROLE ari_app`);
    return client;
  },
};

let anvil: ChildProcess | null = null;
let stderr = '';
const reaper = (): void => {
  // A worker that dies takes its child with it, or the next run finds an orphan holding
  // the port and every assertion in this file silently describes a chain nobody set up.
  anvil?.kill('SIGKILL');
};
process.on('exit', reaper);

let token = '';
let deployBlock = '';
let fundedFromBlock = '';
let provider: EvmForkProvider;

async function portFree(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port: PORT });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(true);
    });
  });
}

let rpcId = 0;
async function rpc<T>(method: string, params: readonly unknown[] = []): Promise<T> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function mined(hash: string): Promise<{ contractAddress: string | null; blockNumber: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipt = await rpc<{ contractAddress: string | null; blockNumber: string } | null>('eth_getTransactionReceipt', [hash]);
    // `eth_sendTransaction` returns before the transaction is in a block, and on a dev
    // node the first receipt read is always null.
    if (receipt !== null) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no receipt for ${hash}`);
}

beforeAll(async () => {
  pool = await connectPool();
  appPool = await connectPool(4);

  if (!(await portFree())) {
    throw new Error(
      `anvil is already listening on ${HOST}:${PORT}. This suite will not run against a node it did not ` +
        `start — a stale one answers every question with the wrong state and every assertion still passes.`,
    );
  }
  const found = process.env.ANVIL_BIN ?? 'anvil';
  anvil = spawn(found, ['--host', HOST, '--port', String(PORT), '--chain-id', CHAIN_ID, '--silent'], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Drained even with `--silent`: a full stdout pipe hangs anvil with the port still
  // accepting connections, which surfaces as a timeout with nothing to explain it.
  anvil.stdout?.resume();
  anvil.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8').slice(0, 2_000);
  });
  const exited = new Promise<never>((_, reject) => {
    anvil?.once('exit', (code) => reject(new Error(`anvil exited early (code ${String(code)}): ${stderr || 'no stderr'}`)));
  });
  await Promise.race([exited, (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await rpc('eth_blockNumber');
        return true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`anvil never answered on ${RPC}: ${stderr || 'no stderr'}`);
  })()]);

  // Deploy empty, then fund in a later block: the pair is what makes the pinned-block test
  // mean something, because a token minted at genesis is present at every block you can
  // reasonably pin to.
  const deployHash = await rpc<string>('eth_sendTransaction', [
    { from: DEPLOYER, to: null, input: `${FIXTURE.creationBytecode}${ZERO_WORD}` },
  ]);
  const deployed = await mined(deployHash);
  token = deployed.contractAddress ?? '';
  deployBlock = deployed.blockNumber;
  if (!/^0x[0-9a-f]{40}$/.test(token)) throw new Error('the fixture contract did not deploy');

  const mintHash = await rpc<string>('eth_sendTransaction', [
    { from: DEPLOYER, to: token, data: `0x449a52f8${DEPLOYER.slice(2).padStart(64, '0')}${(1_000_000_000_000n).toString(16).padStart(64, '0')}` },
  ]);
  fundedFromBlock = (await mined(mintHash)).blockNumber;

  provider = new EvmForkProvider({ url: RPC, chainId: CHAIN_ID });
}, 60_000);

afterAll(async () => {
  reaper();
  process.off('exit', reaper);
  await appPool?.end();
  await pool?.end();
});

function documentFor(cap: bigint, simulationFallback: 'allow_advisory' | 'deny'): PolicyDocument {
  return {
    meta: { name: 'simulation-fixture', description: null },
    target: { walletId: 'unset', authorityMode: 'delegated', signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256' },
    permissions: {
      transfers: {
        enabled: true,
        chains: ['ethereum'],
        assets: [{ kind: 'erc20', chain: 'ethereum', contract: token, symbol: 'mUSD', decimals: 6n }],
        recipients: { mode: 'allowlist', addresses: [SOMEONE_ELSE] },
        perTransaction: { maxRaw: cap.toString(), unit: UNIT },
        perDay: { maxRaw: cap.toString(), unit: UNIT },
        perMonth: null,
        maxTransactionsPerHour: 20,
      },
      contractCalls: { enabled: false, contracts: [] },
      newRecipients: { allowed: false, requireApproval: false },
    },
    escalation: {
      humanApproval: {
        requiredWhen: [],
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
      onSimulationUnavailable: simulationFallback,
    },
    limits: { maxUsdEstimateAgeSeconds: 300, maxDeadlineSkewSeconds: 60 },
  };
}

interface World {
  readonly orgId: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly credentialId: string;
}

async function world(cap: bigint, simulationFallback: 'allow_advisory' | 'deny', address: string | null): Promise<World> {
  const orgId = await createOrganization(app, { name: 'Sim Co', bootstrapActor: 'bootstrap' });
  const owner = await asTenant(app, orgId, (tx) =>
    createUser(tx, { email: `o${orgId.slice(4, 10)}@sim.test`, displayName: 'O', role: 'owner', grantedBy: 'bootstrap' }),
  );
  return asTenant(app, orgId, async (tx) => {
    const agentId = await createAgent(tx, { name: 'payer', createdBy: owner });
    const walletId = await createWallet(tx, {
      displayName: 'ops',
      mode: 'delegated',
      signatureTriple: 'SECP256K1/ECDSASecp256k1/KECCAK256',
      provider: 'mock',
      actor: owner,
      ...(address === null ? {} : { address }),
    });
    const created = await createPolicy(tx, { name: 'simulation-fixture', document: documentFor(cap, simulationFallback), actor: owner });
    await activateVersion(tx, { policyId: created.policyId, versionId: created.versionId, actor: owner });
    await grantWalletToAgent(tx, { agentId, walletId, policyVersionId: created.versionId, actor: owner });
    const issued = await issueCredential(tx, {
      agentId,
      scopes: ['transaction:request'] as Scope[],
      ttlMs: 3_600_000n,
      masterPepper: PEPPER,
      actor: owner,
    });
    return { orgId, agentId, walletId, credentialId: issued.credentialId };
  });
}

function candidateFor(world: World, amount: bigint, overrides: Record<string, unknown> = {}): CandidateTransaction {
  return CandidateTransaction.parse({
    kind: 'transfer',
    chain: 'ethereum',
    requestId: newId('req'),
    agentId: world.agentId,
    walletId: world.walletId,
    deadline: new Date(Date.now() + 300_000).toISOString(),
    idempotencyKey: `sim-${newId('req')}`,
    usdEstimate: null,
    asset: { kind: 'erc20', chain: 'ethereum', contract: token, symbol: 'mUSD', decimals: 6n },
    amount: { raw: amount, unit: UNIT },
    recipient: { chain: 'ethereum', address: SOMEONE_ELSE },
    replayProtection: { scheme: 'account_sequence', nonce: 1n, chainId: CHAIN_ID, gasLimit: 21_000n, maxFeePerUnit: 20_000_000_000n, maxPriorityFeePerUnit: 1_000_000_000n },
    ...overrides,
  });
}

function depsWith(simulation: PipelineDeps['simulation']): PipelineDeps {
  return {
    pool: app,
    ticketKey: new TicketKey('k'.repeat(48)),
    approvalKey: new ApprovalKey('a'.repeat(48)),
    masterPepper: PEPPER,
    // The real clock, not a fixture instant: a fixed `now` in a deadline is a time bomb that
    // goes off on schedule with no code change, and this repository has already been bitten.
    nowMs: () => BigInt(Date.now()),
    risk: behaviouralProvider(),
    simulation,
  };
}

describe('the provider against a node that is really there', () => {
  it('simulates a transfer the chain would accept, and binds the answer to this candidate', async () => {
    const world_ = await world(10n ** 18n, 'allow_advisory', DEPLOYER);
    const candidate = candidateFor(world_, 1_000_000n);
    const result = await provider.simulate({ candidate, policyVersionId: VERSION, walletAddress: DEPLOYER });
    expect(result).toMatchObject({ status: 'SIMULATED_OK', available: true, success: true, trustworthy: true, revert: null });
    expect(result.returnData).toBe(`0x${ZERO_WORD.slice(0, 63)}1`);
    // The answer is bound to *this* candidate under *this* policy version, by the same
    // canonicaliser the kernel uses — which is what makes the binding check in the pipeline
    // below a comparison of like things rather than two hashes that happen to look alike.
    expect(result.digest).toBe(computeDigest(candidate, { policyVersionId: VERSION }));
  }, 30_000);

  it('reads a revert the chain would make, and names it by its selector', async () => {
    const world_ = await world(10n ** 30n, 'allow_advisory', DEPLOYER);
    const moreThanHolds = 2_000_000_000_000n;
    const result = await provider.simulate({
      candidate: candidateFor(world_, moreThanHolds),
      policyVersionId: newId('ppv'),
      walletAddress: DEPLOYER,
    });
    expect(result).toMatchObject({
      status: 'SIMULATED_REVERT',
      available: true,
      success: false,
      revert: 'ERC20_INSUFFICIENT_BALANCE',
    });
    // The node's message is the fixture's text. Carrying it would mean the trail records
    // somebody's wording as though it were a classification.
    expect(JSON.stringify(result)).not.toMatch(/exceeds balance|zero destination/);
  }, 30_000);

  it('sees the state it was told to see, not the state that happens to be current', async () => {
    // The fork-head comparison in the only form this box can produce: the deploy block has
    // no balance, the next one does. Same candidate, same provider, same node — a different
    // pinned block, and the answers differ. If they did not, "simulated" would be a claim
    // about whoever answered last.
    const world_ = await world(10n ** 18n, 'allow_advisory', DEPLOYER);
    const subject = {
      candidate: candidateFor(world_, 1_000_000n),
      policyVersionId: newId('ppv'),
      walletAddress: DEPLOYER,
    };
    const atHead = await provider.simulate(subject);
    const pinned = await new EvmForkProvider({ url: RPC, chainId: CHAIN_ID, blockTag: deployBlock }).simulate(subject);

    expect(atHead).toMatchObject({ status: 'SIMULATED_OK', blockNumber: fundedFromBlock });
    expect(pinned).toMatchObject({ status: 'SIMULATED_REVERT', revert: 'ERC20_INSUFFICIENT_BALANCE', blockNumber: deployBlock });
  }, 30_000);

  it('refuses to answer rather than reporting a clean result about a chain it is not', async () => {
    const world_ = await world(10n ** 18n, 'allow_advisory', DEPLOYER);
    const subject = { candidate: candidateFor(world_, 1_000_000n), policyVersionId: newId('ppv'), walletAddress: DEPLOYER };
    // Configured for mainnet, pointed at this node: the answer it would get is about a
    // state root where `token` is an address with no code, and `eth_call` answers that with
    // `0x`, which reads as success.
    const misconfigured = new EvmForkProvider({ url: RPC, chainId: '1' });
    expect((await misconfigured.simulate(subject)).reason).toBe('CHAIN_ID_MISMATCH');

    // And the candidate that disagrees with its own node: the guard runs in both directions.
    const wrongCandidateChain = new EvmForkProvider({ url: RPC, chainId: CHAIN_ID });
    const offChain = { ...subject, candidate: candidateFor(world_, 1_000_000n, { replayProtection: { scheme: 'account_sequence', nonce: 1n, chainId: '1', gasLimit: 21_000n, maxFeePerUnit: 20_000_000_000n, maxPriorityFeePerUnit: 1_000_000_000n } }) };
    expect((await wrongCandidateChain.simulate(offChain)).reason).toBe('CHAIN_ID_MISMATCH');
  }, 30_000);

  it('will not call a clean result on an address where nothing is deployed', async () => {
    const world_ = await world(10n ** 18n, 'allow_advisory', DEPLOYER);
    // A wallet whose recorded address is an ordinary account: the token exists, the caller
    // does not, and `eth_call` is perfectly happy to say nothing went wrong.
    const result = await new EvmForkProvider({ url: RPC, chainId: CHAIN_ID }).simulate({
      candidate: candidateFor(world_, 1_000_000n, {
        asset: { kind: 'erc20', chain: 'ethereum', contract: SOMEONE_ELSE, symbol: 'NOTA TOKEN', decimals: 6n },
      }),
      policyVersionId: newId('ppv'),
      walletAddress: DEPLOYER,
    });
    expect(result).toMatchObject({ status: 'SIMULATED_UNAVAILABLE', reason: 'TARGET_HAS_NO_CODE', available: false });
    // The runtime answer is the whole point of the check: `eth_call` to that address
    // succeeds with empty data.
    const direct = await rpc<string>('eth_call', [{ from: DEPLOYER, to: SOMEONE_ELSE, data: '0xa9059cbb' + ZERO_WORD + ZERO_WORD, value: '0x0' }, 'latest']);
    expect(direct).toBe('0x');
  }, 30_000);

  it('says it has no answer when the node has gone away', async () => {
    const world_ = await world(10n ** 18n, 'allow_advisory', DEPLOYER);
    const dead = new EvmForkProvider({ url: 'http://127.0.0.1:8577', chainId: CHAIN_ID, timeoutMs: 500 });
    const candidate = candidateFor(world_, 1_000_000n);
    const result = await dead.simulate({ candidate, policyVersionId: VERSION, walletAddress: DEPLOYER });
    expect(result).toMatchObject({ status: 'SIMULATED_UNAVAILABLE', reason: 'RPC_UNREACHABLE', available: false });
    // A refusal still says *which request* it refused. That is not a detail: the trail line
    // for a denied payment is read by someone asking "was this the one the node was down
    // for", and an unbound refusal cannot answer it. A refusal that never encoded anything
    // (a bitcoin candidate, a wallet with no address) carries no digest, deliberately —
    // there was no transaction in question yet.
    expect(result.digest).toBe(computeDigest(candidate, { policyVersionId: VERSION }));
  }, 30_000);
});

describe('the decision plane reading it', () => {
  it('pays what the chain would accept, and records which block it asked about', async () => {
    const world_ = await world(10n ** 18n, 'allow_advisory', DEPLOYER);
    const outcome = await authorize(depsWith(provider), world_.orgId, {
      credentialId: world_.credentialId,
      agentId: world_.agentId,
      candidate: candidateFor(world_, 1_000_000n),
      idempotencyKey: `pay-${newId('req')}`,
    });
    expect(outcome.status).toBe('TICKET_ISSUED');

    const events = await asTenant(app, world_.orgId, (tx) => readEventLog(tx.client, world_.orgId));
    const simulated = events.filter((event) => event.eventType === 'simulation.evaluated');
    expect(simulated).toHaveLength(1);
    expect(simulated[0]?.meta).toMatchObject({
      simStatus: 'SIMULATED_OK',
      simTrustworthy: 'true',
      simChainId: CHAIN_ID,
      simBound: 'true',
    });
    expect(String(simulated[0]?.meta.simBlock)).toMatch(/^0x[0-9a-f]+$/);
  }, 30_000);

  it('refuses what the chain would refuse, before a ticket exists to refuse it with', async () => {
    const world_ = await world(10n ** 30n, 'allow_advisory', DEPLOYER);
    const outcome = await authorize(depsWith(provider), world_.orgId, {
      credentialId: world_.credentialId,
      agentId: world_.agentId,
      candidate: candidateFor(world_, 5_000_000_000_000n),
      idempotencyKey: `nope-${newId('req')}`,
    });
    expect(outcome.status).toBe('DENIED');
    if (outcome.status === 'DENIED') expect(outcome.codes).toContain('SIMULATION_FAILED');
  }, 30_000);

  it('leaves an absent answer to the policy that named one', async () => {
    // Two tenants, two fallbacks, one dead node. This is the whole of A10 in one test: a
    // missing simulation is a decision the human made in advance, not a hole the engine
    // fills in at runtime — and not the same decision whichever way the policy points.
    const dead = new EvmForkProvider({ url: 'http://127.0.0.1:8577', chainId: CHAIN_ID, timeoutMs: 500 });
    const escalate = await world(10n ** 18n, 'allow_advisory', DEPLOYER);
    const strict = await world(10n ** 18n, 'deny', DEPLOYER);

    const advisory = await authorize(depsWith(dead), escalate.orgId, {
      credentialId: escalate.credentialId,
      agentId: escalate.agentId,
      candidate: candidateFor(escalate, 1_000_000n),
      idempotencyKey: `advisory-${newId('req')}`,
    });
    const refusing = await authorize(depsWith(dead), strict.orgId, {
      credentialId: strict.credentialId,
      agentId: strict.agentId,
      candidate: candidateFor(strict, 1_000_000n),
      idempotencyKey: `strict-${newId('req')}`,
    });

    expect(advisory.status).toBe('TICKET_ISSUED');
    expect(refusing.status).toBe('DENIED');
    if (refusing.status === 'DENIED') expect(refusing.codes).toEqual(['SIMULATION_UNAVAILABLE']);

    const events = await asTenant(app, strict.orgId, (tx) => readEventLog(tx.client, strict.orgId));
    expect(events.some((event) => event.eventType === 'simulation.unavailable')).toBe(true);
    expect(events.some((event) => event.eventType === 'simulation.evaluated')).toBe(false);
  }, 30_000);

  it('will not act on an answer about some other transaction', async () => {
    // The Phase 7 gate, with a witness. The wrapper answers `SIMULATED_OK` for everything —
    // the most favourable answer a provider can give — and stamps it with the digest of a
    // *different* candidate. If the binding were not checked, this is precisely the case
    // that pays the wrong bytes: T10 with a network call in the middle.
    const rogue: SimulationProvider = {
      name: 'rogue',
      supports: () => true,
      async simulate(subject): Promise<SimulationResult> {
        const other = { ...subject.candidate, recipient: { chain: 'ethereum', address: DEPLOYER } } as CandidateTransaction;
        const real = await provider.simulate(subject);
        return { ...real, digest: computeDigest(other, { policyVersionId: subject.policyVersionId }) as CanonicalDigest };
      },
    };
    const world_ = await world(10n ** 18n, 'allow_advisory', DEPLOYER);
    const outcome = await authorize(depsWith(rogue), world_.orgId, {
      credentialId: world_.credentialId,
      agentId: world_.agentId,
      candidate: candidateFor(world_, 1_000_000n),
      idempotencyKey: `rogue-${newId('req')}`,
    });
    expect(outcome.status).toBe('DENIED');
    if (outcome.status === 'DENIED') expect(outcome.codes).toEqual(['SIMULATION_MISMATCH']);
  }, 30_000);

  it('asks nothing of a provider that cannot answer, and spends no wallet read doing it', async () => {
    const none = new NoneSimulationProvider();
    const world_ = await world(10n ** 18n, 'deny', DEPLOYER);
    const outcome = await authorize(depsWith(none), world_.orgId, {
      credentialId: world_.credentialId,
      agentId: world_.agentId,
      candidate: candidateFor(world_, 1_000_000n),
      idempotencyKey: `none-${newId('req')}`,
    });
    // `supports()` false means the pipeline never opened a wallet read or a socket for it,
    // and the policy's own fallback is what decides — here, deny.
    expect(none.invocations).toBe(0);
    expect(outcome.status).toBe('DENIED');
    if (outcome.status === 'DENIED') expect(outcome.codes).toEqual(['SIMULATION_UNAVAILABLE']);
  }, 30_000);
});
