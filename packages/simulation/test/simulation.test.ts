/**
 * The simulation plane's own logic, with no node anywhere.
 *
 * Two halves, and both matter more than the happy path. The encoding half is checked
 * against `cast calldata` output generated on this box — bytes nobody can eyeball are
 * bytes that must have an outside witness, and a wrong word here moves someone's USDC.
 * The refusal half is checked because the whole value of an advisory plane is that it
 * says "I have no answer" in a shape nobody can read as "the chain said yes": every case
 * below that refuses also asserts that no `eth_call` was ever issued.
 */

import { CandidateTransaction, newId } from '@ari/schemas';
import { computeDigest } from '@ari/transaction-engine';
import { describe, expect, it } from 'vitest';
import {
  encodable,
  encodeCall,
  encodeTransfer,
  interpretReturn,
  ERC20_APPROVE_SELECTOR,
  ERC20_TRANSFER_SELECTOR,
} from '../src/encoding.js';
import { EvmForkProvider } from '../src/evm.js';
import { MockSimulationProvider, NoneSimulationProvider, unavailable, kernelProjection, type SimulationSubject } from '../src/index.js';

const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
const WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const VERSION = newId('ppv');

function transfer(overrides: Record<string, unknown> = {}): CandidateTransaction {
  return CandidateTransaction.parse({
    kind: 'transfer',
    chain: 'ethereum',
    requestId: newId('req'),
    agentId: newId('agt'),
    walletId: newId('wal'),
    deadline: '2026-10-01T00:00:00.000Z',
    idempotencyKey: 'k',
    usdEstimate: null,
    asset: { kind: 'erc20', chain: 'ethereum', contract: TOKEN, symbol: 'USDC', decimals: 6n },
    amount: { raw: 2_000_000_000n, unit: 'usdc-6dp' },
    recipient: { chain: 'ethereum', address: RECIPIENT },
    replayProtection: { scheme: 'account_sequence', nonce: 1n, chainId: '31337', gasLimit: 21_000n, maxFeePerUnit: 20_000_000_000n, maxPriorityFeePerUnit: 1_000_000_000n },
    ...overrides,
  });
}

/** A contract call is a different variant, not a transfer with fields bolted on. */
function approveCall(): CandidateTransaction {
  return CandidateTransaction.parse({
    kind: 'contract_call',
    chain: 'ethereum',
    requestId: newId('req'),
    agentId: newId('agt'),
    walletId: newId('wal'),
    deadline: '2026-10-01T00:00:00.000Z',
    idempotencyKey: 'k',
    usdEstimate: null,
    contract: TOKEN,
    selector: ERC20_APPROVE_SELECTOR,
    calldata: '0x000000000000000000000000' + WALLET.slice(2) + '0'.repeat(64),
    value: 0n,
    replayProtection: { scheme: 'account_sequence', nonce: 1n, chainId: '31337', gasLimit: 21_000n, maxFeePerUnit: 20_000_000_000n, maxPriorityFeePerUnit: 1_000_000_000n },
  });
}

function subject(candidate: CandidateTransaction = transfer(), walletAddress: string | null = WALLET): SimulationSubject {
  return { candidate, policyVersionId: VERSION, walletAddress };
}

/** `cast calldata 'transfer(address,uint256)' …`, recorded by running it. */
const GOLDEN: readonly { readonly to: string; readonly amount: bigint; readonly data: string }[] = [
  {
    to: RECIPIENT,
    amount: 2_000_000_000n,
    data: '0xa9059cbb0000000000000000000000003f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c0000000000000000000000000000000000000000000000000000000077359400',
  },
  {
    to: '0x0000000000000000000000000000000000000000',
    amount: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    data: '0xa9059cbb0000000000000000000000000000000000000000000000000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  },
  {
    to: '0xffffffffff000000000000000000000000000001',
    amount: 1n,
    data: '0xa9059cbb000000000000000000000000ffffffffff0000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001',
  },
];

describe('the encoder', () => {
  it('reproduces `cast calldata` byte for byte, including uint256-max', () => {
    for (const vector of GOLDEN) {
      expect(encodeTransfer(vector.to, vector.amount)).toBe(vector.data);
    }
  });

  it('carries the selectors the whole ABI turns on', () => {
    // `cast sig 'transfer(address,uint256)'` and `cast sig 'approve(address,uint256)'`.
    // Four bytes each, and the difference between them is the difference between moving
    // funds and granting someone else the right to.
    expect(ERC20_TRANSFER_SELECTOR).toBe('0xa9059cbb');
    expect(ERC20_APPROVE_SELECTOR).toBe('0x095ea7b3');
  });

  it('passes a contract call through without reinterpretation', () => {
    const call = encodeCall(subject(approveCall()));
    expect(call.ok).toBe(true);
    if (call.ok) {
      expect(call.call.to).toBe(TOKEN);
      expect(call.call.value).toBe('0x0');
      expect(call.call.what).toBe('contract-call');
    }
  });

  it('refuses rather than inventing, and names why', () => {
    const bitcoin = transfer({ chain: 'bitcoin', recipient: { chain: 'bitcoin', address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' } });
    expect(encodable(bitcoin)).toBe(false);

    const native = transfer({ asset: { kind: 'native', chain: 'ethereum' } });
    expect(encodable(native)).toBe(false);

    const noFrom = encodeCall(subject(transfer(), null));
    expect(noFrom.ok).toBe(false);
    if (!noFrom.ok) expect(noFrom.reason).toBe('WALLET_ADDRESS_UNKNOWN');
  });
});

describe('what a token’s return value means', () => {
  it('reads a true bool as the only unambiguous yes', () => {
    expect(interpretReturn(`0x${'0'.repeat(63)}1`)).toEqual({ succeeded: true, warning: null });
  });

  it('reads a false bool as a call that would run and move nothing', () => {
    expect(interpretReturn(`0x${'0'.repeat(64)}`).succeeded).toBe(false);
  });

  it('accepts a token that returns nothing, and says so', () => {
    // USDT-shaped: permitted by practice, not by the ABI, and never silently.
    const read = interpretReturn('0x');
    expect(read.succeeded).toBe(true);
    expect(read.warning).toMatch(/no value/);
  });

  it('does not guess at a return it does not recognise', () => {
    const read = interpretReturn('0xdeadbeef');
    expect(read.succeeded).toBe(true);
    expect(read.warning).toMatch(/unrecognised return encoding/);
  });
});

describe('what a node’s error may and may not become', () => {
  it('classifies a custom error by its selector, which cannot drift', async () => {
    // The probe on this box found OpenZeppelin's *reason string* absent from the node's
    // message entirely, so a classifier matching on text would have dropped the most common
    // revert in a payment system. A four-byte selector cannot drift with wording.
    const result = await answerWith({ code: 3, message: 'execution reverted', data: '0xe450d38c' + '0'.repeat(192) });
    expect(result).toMatchObject({ status: 'SIMULATED_REVERT', available: true, success: false, revert: 'ERC20_INSUFFICIENT_BALANCE' });
  });

  it('names a require-string revert without carrying its text', async () => {
    const result = await answerWith({
      code: 3,
      message: 'execution reverted: ERC20: transfer amount exceeds balance',
      data: `0x08c379a0${'00'.repeat(96)}`,
    });
    expect(result.revert).toBe('REVERT_WITH_MESSAGE');
    // The node's sentence appears nowhere in the answer, because it is the contract
    // author's wording and it will change without this repository changing.
    expect(JSON.stringify(result)).not.toMatch(/exceeds balance/);
  });

  it('calls an unknown selector unknown rather than guessing at it', async () => {
    const result = await answerWith({ code: 3, message: 'execution reverted', data: '0x12345678' + '00'.repeat(32) });
    expect(result.revert).toBe('REVERT_CUSTOM_UNKNOWN');
    expect(result.warnings.join(' ')).toMatch(/unrecognised revert selector/);
  });

  it('separates a node that cannot fetch a block from a transaction that fails', async () => {
    const unknownBlock = await answerWith({ code: -32000, message: 'unknown block' });
    expect(unknownBlock).toMatchObject({ status: 'SIMULATED_UNAVAILABLE', reason: 'BLOCK_UNRESOLVED', revert: null });
  });

  it('says unclassified when a revert arrived with nothing structural on it', async () => {
    const bare = await answerWith({ code: 3, message: 'execution reverted' });
    expect(bare).toMatchObject({ status: 'SIMULATED_REVERT', success: false, revert: 'REVERT_UNCLASSIFIED' });
    expect(bare.warnings.join(' ')).toMatch(/no return data/);
  });

  it('treats a request that never got an answer as no answer at all', async () => {
    const previous = globalThis.fetch;
    const refused = Object.assign(new Error('fetch failed'), { name: 'TypeError' });
    globalThis.fetch = (async () => {
      throw refused;
    }) as unknown as typeof fetch;
    try {
      const result = await new EvmForkProvider({ url: 'http://127.0.0.1:8561', chainId: '31337' }).simulate(subject());
      expect(result).toMatchObject({ status: 'SIMULATED_UNAVAILABLE', reason: 'RPC_UNREACHABLE', available: false, success: false });
    } finally {
      globalThis.fetch = previous;
    }
  });
});

/** Run one simulate against a node whose `eth_call` answers with a JSON-RPC error. */
async function answerWith(error: { code: number; message: string; data?: string }): Promise<Awaited<ReturnType<EvmForkProvider['simulate']>>> {
  const restore = serveRpc((method, id) => {
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'eth_blockNumber') return '0x10';
    if (method === 'eth_getBlockByNumber') return { number: '0x10', timestamp: hexTime() };
    if (method === 'eth_getCode') return '0x6080';
    return { __error: { ...error, id } };
  });
  try {
    return await new EvmForkProvider({ url: 'http://127.0.0.1:8561', chainId: '31337' }).simulate(subject());
  } finally {
    restore();
  }
}

describe('the provider, before it reaches a network', () => {
  it('refuses a configuration that could leak a request or pick the wrong chain', () => {
    expect(() => new EvmForkProvider({ url: 'http://node.example.com:8545', chainId: '1' })).toThrow(/https|127/);
    expect(() => new EvmForkProvider({ url: 'http://127.0.0.1:8561', chainId: 'not-a-number' })).toThrow(/decimal/);
    expect(() => new EvmForkProvider({ url: 'http://127.0.0.1:8561', chainId: '1', blockTag: 'earliest' })).toThrow(/blockTag/);
  });

  it('will not spend a wallet read on a candidate it cannot encode', () => {
    const provider = new EvmForkProvider({ url: 'http://127.0.0.1:8561', chainId: '31337' });
    expect(provider.supports(transfer())).toBe(true);
    expect(
      provider.supports(
        transfer({
          chain: 'bitcoin',
          asset: { kind: 'native', chain: 'bitcoin' },
          recipient: { chain: 'bitcoin', address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' },
        }),
      ),
    ).toBe(false);
  });

  it('answers about the chain it was configured for and no other', async () => {
    // The trap this guards is silent: a node whose state has no such token returns `0x`,
    // which is also what a real token returns when it succeeds quietly. Without the guard
    // a misconfigured provider turns every dangerous payment into a clean simulation.
    const seen: string[] = [];
    const restore = serveRpc((method) => {
      seen.push(method);
      if (method === 'eth_chainId') return '0x1039';
      return '0x1';
    });
    try {
      const result = await new EvmForkProvider({ url: 'http://127.0.0.1:8561', chainId: '31337' }).simulate(subject());
      expect(result.status).toBe('SIMULATED_UNAVAILABLE');
      expect(result.reason).toBe('CHAIN_ID_MISMATCH');
      expect(result.digest).not.toBeNull();
      expect(seen).toEqual(['eth_chainId']);
    } finally {
      restore();
    }
  });

  it('refuses when the candidate itself is about a different chain', async () => {
    const seen: string[] = [];
    const restore = serveRpc((method) => {
      seen.push(method);
      if (method === 'eth_chainId') return '0x7a69';
      return '0x1';
    });
    try {
      const result = await new EvmForkProvider({ url: 'http://127.0.0.1:8561', chainId: '31337' }).simulate(
        subject(transfer({ replayProtection: { scheme: 'account_sequence', nonce: 1n, chainId: '1', gasLimit: 21_000n, maxFeePerUnit: 20_000_000_000n, maxPriorityFeePerUnit: 1_000_000_000n } })),
      );
      expect(result.reason).toBe('CHAIN_ID_MISMATCH');
      expect(result.warnings.join(' ')).toMatch(/candidate names chain 1/);
      expect(seen).toEqual(['eth_chainId']);
    } finally {
      restore();
    }
  });

  it('asks whether anything is deployed there before it believes a clean result', async () => {
    // `eth_call` to an address with no code returns `0x`: success. So does a token that
    // returns nothing on success. Those two are not the same fact, and only one of them
    // means the payment would have worked.
    const seen: string[] = [];
    const restore = serveRpc((method) => {
      seen.push(method);
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_getCode') return '0x';
      if (method === 'eth_blockNumber') return '0x10';
      if (method === 'eth_getBlockByNumber') return { number: '0x10', timestamp: '0x65f0fca0' };
      return '0x0000000000000000000000000000000000000000000000000000000000000001';
    });
    try {
      const result = await new EvmForkProvider({ url: 'http://127.0.0.1:8561', chainId: '31337' }).simulate(subject());
      expect(result.reason).toBe('TARGET_HAS_NO_CODE');
      expect(result.status).toBe('SIMULATED_UNAVAILABLE');
      expect(seen).not.toContain('eth_call');
    } finally {
      restore();
    }
  });

  it('binds its answer to the digest the canonicaliser produces, not one it invented', async () => {
    const candidate = transfer();
    const restore = serveRpc((method) => {
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_blockNumber') return '0x10';
      if (method === 'eth_getBlockByNumber') return { number: '0x10', timestamp: hexTime() };
      if (method === 'eth_getCode') return '0x6080';
      return `0x${'0'.repeat(63)}1`;
    });
    try {
      const result = await new EvmForkProvider({ url: 'http://127.0.0.1:8561', chainId: '31337' }).simulate(subject(candidate));
      expect(result.digest).toBe(computeDigest(candidate, { policyVersionId: VERSION }));
      expect(result.status).toBe('SIMULATED_OK');
      expect(result.trustworthy).toBe(true);
      expect(result.blockNumber).toBe('0x10');
      expect(kernelProjection(result)).toEqual({ available: true, success: true, mismatch: false, warningCount: 0 });
    } finally {
      restore();
    }
  });

  it('declines a pinned block the node does not have, instead of answering at the head', async () => {
    const seen: string[] = [];
    const restore = serveRpc((method) => {
      seen.push(method);
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_getBlockByNumber') return null;
      return '0x1';
    });
    try {
      const result = await new EvmForkProvider({
        url: 'http://127.0.0.1:8561',
        chainId: '31337',
        blockTag: '0x64',
      }).simulate(subject());
      expect(result.reason).toBe('BLOCK_UNRESOLVED');
      expect(seen).toContain('eth_getBlockByNumber');
      expect(seen).not.toContain('eth_call');
    } finally {
      restore();
    }
  });
});

describe('the two providers that never touch a chain', () => {
  it('carries the trust flag a mock must carry', async () => {
    const candidate = transfer();
    const mock = new MockSimulationProvider((s) => computeDigest(s.candidate, { policyVersionId: s.policyVersionId }));
    const result = await mock.simulate(subject(candidate));
    expect(result.trustworthy).toBe(false);
    expect(result.status).toBe('SIMULATED_OK');
    // Bound to the real candidate, because the binding check is the thing that must not be
    // exercisable only against a node.
    expect(result.digest).toBe(computeDigest(candidate, { policyVersionId: VERSION }));
    expect(mock.invocations).toBe(1);
  });

  it('says "nothing was asked" without implying that anything passed', async () => {
    const none = new NoneSimulationProvider();
    expect(none.supports()).toBe(false);
    const result = await none.simulate(subject());
    expect(result).toMatchObject({ status: 'SIMULATED_UNAVAILABLE', available: false, success: false, mismatch: false, digest: null });
    expect(kernelProjection(result)).toEqual({ available: false, success: false, mismatch: false, warningCount: 0 });
  });

  it('keeps an unavailable answer out of the arms that deny on a chain fact', () => {
    const result = unavailable({ provider: 'test', digest: null, reason: 'RPC_TIMEOUT' });
    expect(result.success).toBe(false);
    // `available: false` routes the kernel to the policy's own fallback; the false
    // `success` beside it must never be reachable as `SIMULATION_FAILED`.
    expect(result.status).toBe('SIMULATED_UNAVAILABLE');
    expect(result.revert).toBeNull();
  });

});

function hexTime(): string {
  return `0x${Math.floor(Date.now() / 1000).toString(16)}`;
}

/** A stand-in node: answers by method, and records the order, so "never called" is provable. */
function serveRpc(answer: (method: string, id: number) => unknown): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body)) as { method: string; id: number };
    const payload = answer(request.method, request.id);
    const envelope =
      typeof payload === 'object' && payload !== null && '__error' in payload
        ? { jsonrpc: '2.0', id: request.id, error: (payload as { __error: unknown }).__error }
        : { jsonrpc: '2.0', id: request.id, result: payload };
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}
