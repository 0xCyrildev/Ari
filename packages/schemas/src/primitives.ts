/**
 * Identifiers, money and chain primitives.
 *
 * Two rules govern this file, and both are about refusals rather than formats:
 *   1. Money is a `bigint` with an explicit unit. There is no `number` anywhere
 *      in the authorization path — a float comparison against a spending limit
 *      decides whether $4,999.999… is under $5,000, and both answers are wrong
 *      in ways someone will eventually have to explain to a customer.
 *   2. Unsupported is a *parsed* value, never an exception. `chain: 'sui'` must
 *      reach the policy engine so it can be denied with a reason code and an
 *      audit record, not explode in a route handler (ARCHITECTURE S2/S3).
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Externally visible ids are prefixed UUIDv7: time-ordered for indexing,
 * non-enumerable for authorization, self-describing in logs (ASSUMPTIONS A8).
 * Sequential ids are not used for anything a client can see.
 */
const ID_PREFIXES = [
  'org',
  'usr',
  'agt',
  'crd',
  'wal',
  'pol',
  'ppv',
  'txr',
  'apr',
  'tkt',
  'req',
  'rsv',
  'dec',
  'aud',
] as const;

const UUID_V7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

function prefixedId(prefix: (typeof ID_PREFIXES)[number]) {
  return z.string().regex(
    new RegExp(`^${prefix}_${UUID_V7}$`),
    `expected ${prefix}_<uuidv7>`,
  );
}

export const OrganizationId = prefixedId('org');
export const UserId = prefixedId('usr');
export const AgentId = prefixedId('agt');
export const CredentialId = prefixedId('crd');
export const WalletId = prefixedId('wal');
export const PolicyId = prefixedId('pol');
export const PolicyVersionId = prefixedId('ppv');
export const TransactionRequestId = prefixedId('txr');
export const ApprovalRequestId = prefixedId('apr');
export const TicketId = prefixedId('tkt');
export const RequestId = prefixedId('req');

export type OrganizationId = z.infer<typeof OrganizationId>;
export type AgentId = z.infer<typeof AgentId>;
export type WalletId = z.infer<typeof WalletId>;
export type PolicyId = z.infer<typeof PolicyId>;
export type TransactionRequestId = z.infer<typeof TransactionRequestId>;

/**
 * Mint a prefixed UUIDv7.
 *
 * The version nibble and the variant bits are not decoration: `7` makes the id
 * sort by creation time, which is what makes an index on `created_at` redundant
 * and a range scan over "this agent's requests since Tuesday" a prefix scan. The
 * variant nibble is what tells a reader the value is RFC 9562 rather than a
 * hand-rolled string that happens to have dashes in the right places.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Math.trunc(nowMs), 0, 6);
  bytes.writeUInt8(0x70 | (bytes.readUInt8(6) & 0x0f), 6);
  bytes.writeUInt8(0x80 | (bytes.readUInt8(8) & 0x3f), 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * `newId('agt')` — the only sanctioned way to produce an externally visible
 * identifier, so the format the schemas accept is the format the code emits
 * rather than two conventions that have to be kept in step by hand.
 */
export function newId(prefix: (typeof ID_PREFIXES)[number], nowMs?: number): string {
  return `${prefix}_${uuidv7(nowMs)}`;
}

export const ReservationId = prefixedId('rsv');
export type ReservationId = z.infer<typeof ReservationId>;

// ---------------------------------------------------------------------------
// Chains, assets, addresses
// ---------------------------------------------------------------------------

/**
 * The supported set is narrower than "chains that exist", and for a reason
 * recorded in ASSUMPTIONS.md:
 *   - `ethereum`, `bitcoin`: directly traceable to Ika's documented
 *     (curve, signatureAlgorithm, hash) triples and a live mainnet path.
 *   - `solana`: the triple exists, but Ika labels Solana **pre-alpha** and
 *     warns of "many risks". Shipping an agent-facing feature on a vendor's
 *     pre-alpha path moves someone else's unfinished work onto a customer's
 *     funds, so it is `unsupported` for now, not `unknown` forever.
 *   - `sui`: Ika's own coordination chain, and NOT a documented dWallet
 *     signing target. Rejected by default; reopens only if someone actually
 *     signs a Sui transaction on testnet (ASSUMPTIONS §5.1).
 *
 * `unsupported` is deliberately part of the parsed union rather than a
 * validation failure. See the module header, rule 2.
 */
export const SupportedChain = z.enum(['ethereum', 'bitcoin']);
export type SupportedChain = z.infer<typeof SupportedChain>;

export const UnsupportedChainReason = z.enum([
  'CHAIN_NOT_SUPPORTED',
  'CHAIN_PRE_ALPHA',
  'CURVE_TRIPLE_UNAVAILABLE',
]);

/** Ika's legal (curve, signatureAlgorithm, hash) triples (ASSUMPTIONS I10). */
export const SignatureTriple = z.enum([
  'SECP256K1/ECDSASecp256k1/KECCAK256', // ethereum
  'SECP256K1/ECDSASecp256k1/DoubleSHA256', // bitcoin legacy
  'SECP256K1/Taproot/SHA256', // bitcoin taproot
  'ED25519/EdDSA/SHA512', // solana (pre-alpha)
  'SECP256R1/ECDSASecp256r1/SHA256', // webauthn
  'RISTRETTO/SchnorrkelSubstrate/Merlin', // substrate
]);
export type SignatureTriple = z.infer<typeof SignatureTriple>;

/**
 * Chain addresses are normalised **once**, at VALIDATED, and every later
 * comparison is against these normalised bytes. Re-normalising at signing time
 * is how a checksum-casing or 0x-prefix difference becomes a recipient
 * substitution (THREAT_MODEL T11).
 */
export const EvmAddress = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, 'EVM address must be lowercase 0x + 40 hex');

export const BitcoinAddress = z
  .string()
  .min(14)
  .max(90)
  .regex(/^[13bc][a-zA-Z0-9]+$/, 'unsupported bitcoin address encoding');

export const RecipientAddress = z.discriminatedUnion('chain', [
  z.object({ chain: z.literal('ethereum'), address: EvmAddress }).strict(),
  z.object({ chain: z.literal('bitcoin'), address: BitcoinAddress }).strict(),
]);
export type RecipientAddress = z.infer<typeof RecipientAddress>;

/**
 * A small count that arrives as a JSON integer — token decimals today.
 *
 * Parsed to `bigint` for one reason: everything inside a candidate transaction
 * reaches the canonical encoder, and that encoder refuses `number` outright
 * because it cannot tell a float in a money field from a harmless integer.
 * Weakening the refusal to let `decimals` through would mean a future
 * `amount: 5000.0` encodes silently instead of throwing — so the integer is
 * widened, and the refusal stays absolute.
 */
export const SmallCount = z
  .union([z.bigint(), z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((value) => (typeof value === 'bigint' ? value : BigInt(value)));

export const AssetRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native'), chain: SupportedChain }).strict(),
  z
    .object({
      kind: z.literal('erc20'),
      chain: z.literal('ethereum'),
      /** The contract is part of the asset identity. Two USDCs are not one asset. */
      contract: EvmAddress,
      symbol: z.string().min(1).max(16),
      decimals: SmallCount.pipe(z.bigint().min(0n).max(36n)),
    })
    .strict(),
]);
export type AssetRef = z.infer<typeof AssetRef>;

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Wire format for big integers.
 *
 * JSON numbers cannot represent 2^64-1, and a wei or satoshi amount routinely
 * exceeds that range, so every big integer on a wire or DB boundary is a
 * decimal *string* and becomes a `bigint` exactly here. Accepting a JSON number
 * anywhere in the money path would quietly round it.
 */
export const RawBigInt = z
  .union([z.bigint(), z.string().regex(/^\d+$/)])
  .transform((value) => (typeof value === 'bigint' ? value : BigInt(value)));

/** Same, for quantities that must never be negative. */
export const RawBigIntNonNeg = RawBigInt.pipe(z.bigint().min(0n));

/**
 * An amount is never a bare number: `2000000000` means nothing without its
 * unit, and the difference between 2000 USDC and 2000 * 10^6 USDC is the
 * difference between a typo and a wire transfer.
 */
export const Money = z
  .object({
    raw: RawBigIntNonNeg,
    /** Stable asset-unit id, e.g. `usdc-6dp`. Limits must name the same unit. */
    unit: z.string().min(1).max(32),
  })
  .strict();
export type Money = z.infer<typeof Money>;

/** Convenience for building a Money from a raw bigint at a call site. */
export function money(raw: bigint, unit: string): { raw: bigint; unit: string } {
  if (raw < 0n) throw new RangeError('negative amounts are not representable');
  return { raw, unit };
}

/** USD estimate used only for escalation decisions; always conservative. */
export const UsdEstimate = z
  .object({
    cents: RawBigIntNonNeg,
    /** Missing evidence is not good evidence: staleness refuses, not guesses. */
    asOf: z.iso.datetime(),
    source: z.string().min(1).max(64),
  })
  .strict();
export type UsdEstimate = z.infer<typeof UsdEstimate>;
