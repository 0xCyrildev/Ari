/**
 * Sui's two digests, which share a name and must not be confused.
 *
 * Reading the source is unambiguous and the docs are not, so this file states the difference once:
 *
 *   - `TransactionData::digest()` is `blake2b-256` over the **Rust type-name prefix**
 *     `"TransactionData::"` followed by the BCS body. It is the value Sui prints as a transaction
 *     id, indexes effects by, and uses for replay retention. It is **not** what the signature
 *     covers.
 *   - The signature covers `blake2b-256(bcs(IntentMessage))` — a three-byte intent
 *     `[scope, version, app_id]` followed by the same BCS body, with **no** type-name prefix. An
 *     authority (sponsor) signature appends the epoch to those bytes before hashing.
 *
 * A signer that verified the first would be signing the second without checking it, and a policy
 * engine that sealed the second could not look up the outcome by the first. Both are recorded on
 * the validated transaction, and the signer is given the one it actually needs.
 */

import { blake2b } from '@noble/hashes/blake2b';
import { ChainDigestAlgorithm, chainDigestOf, type ChainTransactionDigest } from '@ari/chain-core';

const SUI_TYPE_NAME_PREFIX = 'TransactionData::';

export const BCS_INTENT = { scope: 0, version: 0, appId: 0 } as const;

function blake2b256(bytes: Uint8Array): Uint8Array {
  return blake2b(bytes, { dkLen: 32 });
}

/** Base58 (Bitcoin alphabet). Sui's transaction identifiers and `ChainIdentifier` are printed this way. */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: string[] = [];
  while (value > 0n) {
    const mod = Number(value % 58n);
    value /= 58n;
    digits.push(B58_ALPHABET[mod] as string);
  }
  return `${'1'.repeat(zeros)}${digits.reverse().join('')}`;
}

export function base58Decode(value: string): Uint8Array {
  let value58 = 0n;
  for (const char of value) {
    const index = B58_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`base58: "${char}" is not in the alphabet`);
    value58 = value58 * 58n + BigInt(index);
  }
  const bytes: number[] = [];
  while (value58 > 0n) {
    bytes.unshift(Number(value58 & 0xffn));
    value58 >>= 8n;
  }
  let zeros = 0;
  while (zeros < value.length && value[zeros] === '1') zeros += 1;
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes]);
}

/** The identifier Sui will know this transaction by: type-name-prefixed BCS, Blake2b-256, base58. */
export function transactionDigestOf(serializedData: Uint8Array): ChainTransactionDigest {
  const prefixed = new Uint8Array([...new TextEncoder().encode(SUI_TYPE_NAME_PREFIX), ...serializedData]);
  return chainDigestOf('sui/blake2b256-txdata-v1', blake2b256(prefixed));
}

/**
 * The bytes a Sui signature covers. `authorityEpoch` is supplied only for a gas-sponsor signature.
 * Total: blake2b-256 always yields 32 bytes, so there is no failure to report here, and a `| null`
 * on this signature would be a promise the caller has to handle for no reason.
 */
export function signingDigestOf(serializedData: Uint8Array, authorityEpoch?: bigint): ChainTransactionDigest {
  const intent = new Uint8Array([BCS_INTENT.scope, BCS_INTENT.version, BCS_INTENT.appId]);
  if (authorityEpoch === undefined) {
    return chainDigestOf('sui/blake2b256-intent-v1', blake2b256(new Uint8Array([...intent, ...serializedData])));
  }
  const epoch = new Uint8Array(8);
  new DataView(epoch.buffer).setBigUint64(0, authorityEpoch, true);
  return chainDigestOf('sui/blake2b256-intent-v1', blake2b256(new Uint8Array([...intent, ...serializedData, ...epoch])));
}

/**
 * The 32-byte `ChainIdentifier` is itself a base58 digest of the network's genesis checkpoint.
 * Ari binds the decoded bytes rather than the string, because the string is a rendering and the
 * bytes are what the transaction's `expiration.chain` field carries.
 */
export function chainIdentifierBytes(base58: string): Uint8Array {
  const bytes = base58Decode(base58);
  if (bytes.byteLength !== 32) {
    throw new Error(`chain identifier decodes to ${bytes.byteLength} byte(s), not 32: "${base58}"`);
  }
  return bytes;
}

/**
 * The `0x…` hex of the digest payload — which is stored as hex, so this is a re-label, not a
 * decoding. Kept as a function because callers compare against a tool's output and must not have
 * to know where the tag ends.
 */
export function digestHex(digest: ChainTransactionDigest): string {
  return `0x${hexOfDigest(digest)}`;
}

/** How Sui itself prints this digest: base58 of the same 32 bytes. A rendering, never a key. */
export function digestBase58(digest: ChainTransactionDigest): string {
  return base58Encode(new Uint8Array(Buffer.from(hexOfDigest(digest), 'hex')));
}

function hexOfDigest(digest: ChainTransactionDigest): string {
  // `chain/algorithm:value` — exactly one colon, because the algorithm tag contains a `/` and
  // never a `:`. Indexing a fixed position instead of searching for the delimiter is what made the
  // original version of this throw on every digest it was handed.
  const separator = digest.indexOf(':');
  const hex = separator === -1 ? '' : digest.slice(separator + 1);
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`digest "${digest}" does not carry a 64-character lowercase hex payload`);
  }
  return hex;
}

export const SUI_DIGEST_ALGORITHMS = [
  ChainDigestAlgorithm.enum['sui/blake2b256-txdata-v1'],
  ChainDigestAlgorithm.enum['sui/blake2b256-intent-v1'],
] as const;
