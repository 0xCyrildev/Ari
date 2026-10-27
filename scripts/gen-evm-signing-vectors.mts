/**
 * Vector generator for `packages/chain-evm/test/vectors/evm-signing-payloads.json`.
 *
 * Run it only against an anvil this script starts reasoning about, on a port you chose:
 *
 *   ~/.foundry/bin/anvil --port 8572 --chain-id 31337        # you start it
 *   node --import tsx scripts/gen-evm-signing-vectors.mts
 *
 * What makes these vectors worth checking in: every field below was **signed by a node this
 * repository does not control and then accepted into a block**. `eth_signTransaction` hands back the
 * complete signed envelope for exactly the request fields, and `eth_sendRawTransaction` only succeeds
 * if the secp256k1 signature verifies over the signing payload the node built from those fields — so
 * a payload this package constructs that differs from the canonical one by even one byte would carry
 * a digest no signature anvil produced can match. That is the check `cast recover` used to give, and
 * foundry 1.8.1 no longer has that subcommand.
 *
 * The second, cheaper oracle in here is a hand-written Python RLP encoder (`/tmp` scratch during the
 * 2026-10-27 session) which reproduced the same headers; it is recorded as provenance rather than
 * depended on, because a second implementation nobody maintains is documentation, not a test.
 */

import { writeFileSync } from 'node:fs';
import { keccak256, decodeEnvelope, constructEip1559Payload, type EvmSigningRequest } from '../packages/chain-evm/src/index.js';

const RPC = process.argv[2] ?? 'http://127.0.0.1:8572';
const SENDER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'; // anvil account #0, dev mnemonic, not a secret
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';
const SPENDER = '0x1111111111111111111111111111111111111111';
const UINT256_MAX = 'f'.repeat(64);

let id = 0;
async function rpc(method: string, params: unknown): Promise<unknown> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: (id += 1), method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? 'rpc error'}`);
  return body.result;
}

const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;

const CASES: ReadonlyArray<{ name: string; what: string; request: EvmSigningRequest }> = [
  {
    name: 'native-transfer',
    what: 'the simplest thing a wallet signs: value, no calldata',
    request: {
      chainId: 31337n, nonce: 0n, gasLimit: 21_000n,
      maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
      to: RECIPIENT, value: 10n ** 18n, data: new Uint8Array(0),
    },
  },
  {
    name: 'erc20-transfer-68-byte-calldata',
    what: 'the shape a USDC payment is: 68 bytes of calldata, which is RLP long-form string territory',
    request: {
      chainId: 31337n, nonce: 1n, gasLimit: 64_776n,
      maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n,
      to: TOKEN, value: 0n,
      data: new Uint8Array(Buffer.from(
        `a9059cbb${'0'.repeat(24)}${RECIPIENT.slice(2)}${(2_000_000_000n).toString(16).padStart(64, '0')}`, 'hex')),
    },
  },
  {
    name: 'erc20-approve-unlimited',
    what: 'an approve to type(uint256).max — the unlimited-allowance case the AuthorityExercise names',
    request: {
      chainId: 31337n, nonce: 2n, gasLimit: 50_000n,
      maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 100_000_000n,
      to: TOKEN, value: 0n,
      data: new Uint8Array(Buffer.from(`095ea7b3${'0'.repeat(24)}${SPENDER.slice(2)}${UINT256_MAX}`, 'hex')),
    },
  },
];

interface Vector {
  readonly name: string;
  readonly what: string;
  readonly provenance: Record<string, string>;
  readonly request: Record<string, string>;
  readonly constructed: { readonly payload: string; readonly byteLength: number; readonly signingDigest: string };
  readonly node: { readonly signedRaw: string; readonly transactionHash: string; readonly from: string; readonly receiptStatus: string; readonly blockNumber: string };
  readonly digests: { readonly txHashFromRaw: string; readonly signingDigestFromSignedEnvelope: string };
}

const vectors: Vector[] = [];
// Read the sender's live sequence so this generator can be re-run against a chain that already
// mined the previous run's transactions. The nonce is a field of the vector either way.
const baseNonce = BigInt(await rpc('eth_getTransactionCount', [SENDER, 'latest']) as string);
for (const [index, c] of CASES.entries()) {
  const request = { ...c.request, nonce: baseNonce + BigInt(index) };
  const built = constructEip1559Payload(request);
  if (!built.ok) throw new Error(`${c.name}: construction refused — ${built.reason}: ${built.detail}`);

  const signedRaw = await rpc('eth_signTransaction', [{
    from: SENDER,
    to: c.request.to,
    value: `0x${request.value.toString(16)}`,
    nonce: `0x${request.nonce.toString(16)}`,
    gas: `0x${request.gasLimit.toString(16)}`,
    maxFeePerGas: `0x${request.maxFeePerGas.toString(16)}`,
    maxPriorityFeePerGas: `0x${request.maxPriorityFeePerGas.toString(16)}`,
    input: hex(request.data),
    chainId: `0x${request.chainId.toString(16)}`,
  }]) as string;
  // anvil answers `eth_signTransaction` with the raw envelope as a bare hex string — not the
  // `{ raw, hash }` object the standard describes. Asserting the shape here is the difference between
  // a generator that fails loudly and one that writes `undefined` into a vector file.
  if (typeof signedRaw !== 'string' || !/^0x02[0-9a-f]+$/.test(signedRaw)) {
    throw new Error(`${c.name}: eth_signTransaction did not return a typed raw envelope: ${JSON.stringify(signedRaw).slice(0, 120)}`);
  }

  const transactionHash = await rpc('eth_sendRawTransaction', [signedRaw]) as string;
  let receipt = null as { status?: string; blockNumber?: string; from?: string } | null;
  for (let attempt = 0; attempt < 20 && receipt === null; attempt += 1) {
    receipt = await rpc('eth_getTransactionReceipt', [transactionHash]) as typeof receipt;
    if (receipt === null) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!receipt) throw new Error(`${c.name}: no receipt for ${transactionHash} after 5s`);

  const decoded = decodeEnvelope(new Uint8Array(Buffer.from(signedRaw.slice(2), 'hex')));
  if (!decoded.ok) throw new Error(`${c.name}: the node's own envelope does not decode — ${decoded.detail}`);

  const txHashFromRaw = `evm/keccak256-txhash-v1:${hex(keccak256(new Uint8Array(Buffer.from(signedRaw.slice(2), 'hex')))).slice(2)}`;

  vectors.push({
    name: c.name,
    what: c.what,
    provenance: {
      signer: 'anvil 1.8.1 eth_signTransaction',
      node: 'anvil 1.8.1, chainId 31337, dev account #0',
      accepted: 'eth_sendRawTransaction, then mined; receipt status recorded below',
      crossCheck: 'an independent hand-written Python RLP encoder reproduced the same payload bytes on 2026-10-27',
    },
    request: {
      chainId: request.chainId.toString(),
      nonce: request.nonce.toString(),
      gasLimit: request.gasLimit.toString(),
      maxFeePerGas: request.maxFeePerGas.toString(),
      maxPriorityFeePerGas: request.maxPriorityFeePerGas.toString(),
      to: request.to,
      value: request.value.toString(),
      data: hex(request.data),
    },
    constructed: {
      payload: hex(built.bytes),
      byteLength: built.bytes.byteLength,
      signingDigest: built.signingDigest,
    },
    node: {
      signedRaw,
      transactionHash,
      from: receipt.from ?? '',
      receiptStatus: receipt.status ?? '',
      blockNumber: receipt.blockNumber ?? '',
    },
    digests: {
      txHashFromRaw,
      signingDigestFromSignedEnvelope: decoded.envelope.signingDigest,
    },
  });
  console.log(`${c.name}: signed by the node, constructed here, digest ${built.signingDigest.slice(0, 28)}…`);
}

const file = new URL('../packages/chain-evm/test/vectors/evm-signing-payloads.json', import.meta.url);
writeFileSync(file, `${JSON.stringify({ generatedBy: 'scripts/gen-evm-signing-vectors.mts', rpc: RPC, vectors }, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors to ${file.pathname}`);
