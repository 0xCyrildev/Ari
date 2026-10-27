/**
 * The Sui supported set, and the refusals that define it.
 *
 * A PTB is a small program: commands read each other's results, `Pure` arguments carry no type
 * until resolved against a package that can be upgraded, `NestedResult` can hand `TransferObjects`
 * an object that a third-party call created or unwrapped, and a capability object moved between
 * addresses changes supply without moving an amount. Establishing "what this transaction does" for
 * an arbitrary PTB is establishing the semantics of arbitrary Move code, which is not a
 * decidable thing to ask of a payment policy at request time.
 *
 * So this adapter supports exactly one shape, and refuses everything else by naming the construct
 * it saw:
 *
 *   `[SplitCoins(coin, [amount]), TransferObjects([Result(0)], recipient)]`
 *
 * — one coin, one amount, one recipient, no result feeding anything else, no shared objects, no
 * capability, no address-balance withdrawal. That is a coin transfer, which is the only Sui
 * transaction whose outflow can be stated as `(asset, amount, recipient)` without executing it.
 *
 * Everything the research found that would break a naive decoder has a named refusal below: the
 * third `CallArg` variant that lets object-shaped bytes spend an address balance; a `Receiving`
 * reference to an object the sender never held; a wrapped object whose contents are whatever the
 * container holds at execution; expiry with no network binding; a gas budget the policy cannot
 * bound. Each refusal is a `DecodeResult`, not an exception, because the audit trail has to carry
 * the reason and a thrown error does not.
 */

import {
  notSupported,
  type DecodeResult,
  type NetworkId,
  type StateEvidence,
  type ValidatedTransaction,
} from '@ari/chain-core';
import { signingDigestOf, transactionDigestOf, chainIdentifierBytes } from './digest.js';
import { toHex } from './bcs.js';
import { createHash } from 'node:crypto';
import type { Argument, ParsedTransactionData, CallArg } from './decode.js';

export const SUI_DECODER_VERSION = 'sui-decode/v1' as const;
export const SUI_ADAPTER_NAME = 'chain-sui' as const;

/** Largest transaction this adapter will look at. A Sui tx is bounded by protocol limits near 130 KiB. */
export const MAX_SUI_TX_BYTES = 131_072;

export interface SuiValidationPolicy {
  readonly allowedPackages: ReadonlySet<string>;
  /** Upper bound on `gas_data.budget`, in MIST. A transaction with no bounded cost is refused. */
  readonly maxGasBudget: bigint;
  readonly minGasPrice: bigint;
  /**
   * Accept `expiration: None`. Off by default, and the reason matters: with no expiry the bytes
   * carry no network identifier at all, so the same transaction is valid on mainnet, testnet and a
   * local net, and the only thing separating those cases is this deployment's configuration.
   * Turning it on trades a chain-level binding for an application-level one, and should be a
   * policy decision a human made rather than a default a decoder chose.
   */
  readonly allowUnboundExpiry: boolean;
  readonly maxCommands: number;
}

const SUI_COIN_TYPE_SUFFIX = '::coin::Coin<';
const SUI_BALANCE_TYPE = '0x2::balance::Balance<';

/**
 * The object shape the supported pattern needs. The pipeline reads it and passes it in —
 * a decoder that fetched from the network inside a decision would make the policy engine depend
 * on a resource it cannot pin, version, or replay.
 */
export interface SuiCoinEvidence {
  readonly objectId: string;
  readonly typeTag: string;
  readonly ownerAddress: string;
  readonly balanceRaw: bigint;
  readonly version: bigint;
}

function coinEvidence(evidence: StateEvidence, objectId: string): SuiCoinEvidence | null {
  const entry = evidence.entries.find((candidate) => candidate.id === objectId);
  if (entry === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(entry.contentBase64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const shape = parsed as Record<string, unknown>;
  const { typeTag, owner, balance, version } = shape;
  if (typeof typeTag !== 'string' || typeof owner !== 'string' || typeof version !== 'string') return null;
  if (typeof balance !== 'string' && typeof balance !== 'number') return null;
  try {
    return {
      objectId,
      typeTag,
      ownerAddress: owner,
      balanceRaw: BigInt(String(balance)),
      version: BigInt(version),
    };
  } catch {
    return null;
  }
}

/** A `Pure` argument holding a `u64`, which is how an amount arrives in the supported shape. */
function pureU64(arg: CallArg | undefined): bigint | null {
  if (arg === undefined || arg.kind !== 'pure') return null;
  if (arg.bytes.byteLength !== 8) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(arg.bytes[i] as number);
  return value;
}

/** A `Pure` argument holding an `address`, which is 32 bytes little-endian on the wire and hex on display. */
function pureAddress(arg: CallArg | undefined): string | null {
  if (arg === undefined || arg.kind !== 'pure') return null;
  if (arg.bytes.byteLength !== 32) return null;
  // Reverse for display: Sui's textual address is big-endian, its BCS is little-endian. A decoder
  // that skips this produces an address that looks valid, is the right length, and is someone else.
  const reversed = new Uint8Array([...arg.bytes].reverse());
  return `0x${toHex(reversed)}`;
}

function isGasCoin(argument: Argument | undefined): boolean {
  return argument !== undefined && argument.kind === 'gas_coin';
}

/** The type parameter inside `Coin<T>` / `Balance<T>`, which is the asset identity that survives an upgrade. */
function extractCoinType(typeTag: string): string | null {
  const wrapped = typeTag.match(/<\s*(0x[0-9a-fA-F]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+)\s*>/);
  if (wrapped?.[1] === undefined) return null;
  return normalizeTypeTag(wrapped[1]);
}

/**
 * `0x0000…0002::sui::SUI` and `0x2::sui::SUI` are the same asset, and Sui's own
 * `to_canonical_string` emits the short form. Left un-normalized, a policy that allowlists the
 * canonical name never matches a resolved type tag, and the failure looks like a policy denial
 * rather than the string comparison it is.
 *
 * Only the *address* components are rewritten, and only by dropping leading zeros and lower-casing
 * hex digits. The module and struct names are kept byte-for-byte, because Move identifiers are
 * case-sensitive and two of them may differ only by case: the previous version of this path ran
 * `toLowerCase()` over the whole tag, which folds `0x3::USDC` and `0x3::usdc` into one asset — the
 * collision Ari's canonical encoding exists to prevent, arriving through asset identity instead of
 * JSON key order.
 */
export function normalizeTypeTag(typeTag: string): string {
  return typeTag.replace(/0x[0-9a-fA-F]+/g, (match) => {
    const digits = match.slice(2).replace(/^0+/, '').toLowerCase();
    return `0x${digits === '' ? '0' : digits}`;
  });
}

export function validateSuiTransaction(
  parsed: ParsedTransactionData,
  serializedBytes: Uint8Array,
  network: NetworkId,
  evidence: StateEvidence,
  policy: SuiValidationPolicy,
): DecodeResult {
  if (serializedBytes.byteLength > MAX_SUI_TX_BYTES) {
    return notSupported('FORMAT_UNSUPPORTED', `${serializedBytes.byteLength} bytes exceeds the ${MAX_SUI_TX_BYTES} byte cap`, false);
  }

  // A gasless transaction is a different authorization problem: `price == 0` means someone else
  // pays, and `gas_data.owner` then names a sponsor whose consent Ari has no part in.
  if (parsed.gas.price < policy.minGasPrice) {
    return notSupported('ARGUMENT_UNRESOLVED', `gas price ${parsed.gas.price} is below the minimum ${policy.minGasPrice}; a zero gas price is a sponsored or gasless transaction`, true);
  }
  if (parsed.gas.budget > policy.maxGasBudget) {
    return notSupported('AUTHORITY_EXERCISED', `gas budget ${parsed.gas.budget} exceeds the policy maximum ${policy.maxGasBudget}`, false);
  }
  if (parsed.gas.payment.length === 0) {
    return notSupported('ARGUMENT_UNRESOLVED', 'no gas payment objects: the transaction relies on an address balance or a sponsor', true);
  }

  if (parsed.expiration.domain === 'none' && !policy.allowUnboundExpiry) {
    return notSupported(
      'EXPIRY_UNBOUNDED',
      'expiration is None: these bytes carry no network identifier and are valid on every Sui network the same key can reach',
      true,
    );
  }
  if (parsed.expiration.domain === 'unknown') {
    return notSupported('FORMAT_UNSUPPORTED', `TransactionExpiration variant ${parsed.expiration.variant} is not implemented by this decoder`, true);
  }
  if (parsed.expiration.domain === 'valid_during' || parsed.expiration.domain === 'validity') {
    // The chain field is the network binding. Compare it to the network this deployment believes
    // it is on — a mismatch is a decision issued for one cluster being spent on another.
    const bound = parsed.expiration.chain.toLowerCase();
    const expected = `0x${toHex(chainIdentifierBytes(network.identifier))}`;
    if (bound !== expected) {
      return notSupported('NETWORK_UNSUPPORTED', `transaction is bound to chain ${bound}, this deployment is ${expected}`, false);
    }
  }

  if (parsed.commands.length > policy.maxCommands || parsed.commands.length !== 2) {
    return notSupported(
      'OPERATION_UNSUPPORTED',
      `${parsed.commands.length} command(s): this adapter supports exactly [SplitCoins, TransferObjects]. `
        + 'A block with any other shape cannot have its outflows enumerated from its inputs',
      parsed.commands.length > 0,
    );
  }

  for (const arg of parsed.inputs) {
    if (arg.kind === 'funds_withdrawal') {
      return notSupported('OPERATION_UNSUPPORTED', 'a FundsWithdrawal (SIP-58 address-balance) argument is present; this adapter does not decode it', true);
    }
  }

  const [split, transfer] = parsed.commands as [
    ParsedTransactionData['commands'][number],
    ParsedTransactionData['commands'][number],
  ];

  if (split.kind !== 'split_coins' || transfer.kind !== 'transfer_objects') {
    const saw = [split.kind, transfer.kind].join(', ');
    return notSupported('OPERATION_UNSUPPORTED', `command pair is [${saw}], not [split_coins, transfer_objects]`, true);
  }

  if (transfer.objects.length !== 1) {
    return notSupported('OPERATION_UNSUPPORTED', `TransferObjects moves ${transfer.objects.length} object(s); a policy bounding one amount cannot bound ${transfer.objects.length}`, true);
  }
  const moved = transfer.objects[0];
  if (moved === undefined || moved.kind !== 'result' || moved.command !== 0) {
    return notSupported(
      'OPERATION_UNSUPPORTED',
      'the transferred object is not the immediate result of the preceding SplitCoins. A NestedResult or an Input here means an object this adapter did not create — possibly one a third-party call unwrapped, or a wrapped object whose contents are decided at execution',
      true,
    );
  }

  if (transfer.address.kind !== 'input') {
    return notSupported('OPERATION_UNSUPPORTED', 'the recipient is not a Pure input', true);
  }
  const recipient = pureAddress(parsed.inputs[transfer.address.index]);
  if (recipient === null) {
    return notSupported('ARGUMENT_UNRESOLVED', 'the recipient argument is not 32 bytes, so it is not an address', true);
  }

  const amountArg = split.amounts[0];
  if (split.amounts.length !== 1 || amountArg === undefined || amountArg.kind !== 'input') {
    return notSupported('OPERATION_UNSUPPORTED', `SplitCoins with ${split.amounts.length} amount(s): multiple outputs cannot be attributed to one policy line`, true);
  }
  const amountRaw = pureU64(parsed.inputs[amountArg.index]);
  if (amountRaw === null) {
    return notSupported('ARGUMENT_UNRESOLVED', 'the amount argument is not a u64-shaped Pure value', true);
  }
  if (amountRaw === 0n) {
    return notSupported('OPERATION_UNSUPPORTED', 'a zero-amount transfer moves nothing', false);
  }

  // The coin being split: either the gas coin (native SUI) or one object input.
  let typeTag: string;
  /**
   * The coin whose chain state was actually read. `null` on the gas-coin path, where the asset type
   * is a fact about the framework rather than about an object this code looked up — and therefore a
   * dependency must NOT be recorded for it. Recording `sha256('')` as if it pinned an object would
   * let reconciliation compare a real object digest against a hash of nothing and call the
   * difference evidence of tampering, or worse, accept the absence as a pin.
   */
  let readCoinObject: string | null = null;
  let from: string;
  if (isGasCoin(split.coin)) {
    // `Balance<0x2::sui::SUI>` — the closing bracket belongs to `Balance`, not to the inner type.
    // This read `SUI)>` when it was written, which made `extractCoinType` fail to match and left
    // the padded literal standing as the asset identity.
    typeTag = `${SUI_BALANCE_TYPE}0x2::sui::SUI>`;
    from = parsed.sender;
  } else if (split.coin.kind === 'input') {
    const coinInput = split.coin.kind === 'input' ? parsed.inputs[split.coin.index] : undefined;
    if (coinInput === undefined || coinInput.kind !== 'object') {
      return notSupported('ARGUMENT_UNRESOLVED', 'the split target is not an object input', true);
    }
    if (coinInput.arg.kind !== 'imm_or_owned') {
      return notSupported(
        'OPERATION_UNSUPPORTED',
        `the coin is referenced as a ${coinInput.arg.kind} object. A shared object can be moved by concurrent execution, and a Receiving reference names an object the sender never fetched`,
        true,
      );
    }
    readCoinObject = coinInput.arg.ref.objectId;
    const coin = coinEvidence(evidence, readCoinObject);
    if (coin === null) {
      return notSupported('ARGUMENT_UNRESOLVED', `no state evidence for coin object ${readCoinObject}; its type and owner are not knowable from the bytes alone`, true);
    }
    if (coin.ownerAddress.toLowerCase() !== parsed.sender.toLowerCase()) {
      return notSupported('STATE_STALE', `object ${readCoinObject} is now owned by ${coin.ownerAddress}, not the sender ${parsed.sender}`, false);
    }
    if (coin.balanceRaw < amountRaw) {
      return notSupported('STATE_STALE', `object ${readCoinObject} holds ${coin.balanceRaw}, less than the ${amountRaw} being moved`, false);
    }
    const inner = extractCoinType(coin.typeTag);
    if (inner === null) {
      return notSupported('ARGUMENT_UNRESOLVED', `object type ${coin.typeTag} does not name a Coin<T>/Balance<T> inner type`, true);
    }
    typeTag = inner;
    from = coin.ownerAddress;
  } else {
    return notSupported('OPERATION_UNSUPPORTED', 'the split target is a result of another command, so it was created by code this adapter cannot analyse', true);
  }

  // Normalized here as well as inside `extractCoinType`: the two fallbacks below keep the tag as
  // read from evidence, and an un-normalized address in the asset identity is the mismatch this
  // function exists to remove.
  const inner = normalizeTypeTag(
    typeTag.includes(SUI_COIN_TYPE_SUFFIX) || typeTag.includes(SUI_BALANCE_TYPE)
      ? extractCoinType(typeTag) ?? typeTag
      : typeTag,
  );

  // Any MoveCall anywhere in the block is refused above by the command-shape check; this keeps the
  // allowlist honest for the day a call decoder is added, and refuses a block that smuggled one in
  // via a shape this file did not anticipate.
  for (const command of parsed.commands) {
    if (command.kind === 'move_call' && !policy.allowedPackages.has(command.package.toLowerCase())) {
      return notSupported('OPERATION_UNSUPPORTED', `MoveCall into package ${command.package} which is not on the allowlist`, true);
    }
    if (command.kind === 'publish' || command.kind === 'upgrade') {
      return notSupported('OPERATION_UNSUPPORTED', 'the block publishes or upgrades a package: arbitrary new code', true);
    }
    if (command.kind === 'make_move_vec') {
      return notSupported('OPERATION_UNSUPPORTED', 'MakeMoveVec assembles an object vector whose contents this adapter has not enumerated', true);
    }
  }

  const txDigest = transactionDigestOf(serializedBytes);
  const signing = signingDigestOf(serializedBytes);

  return {
    supported: true,
    chain: 'sui',
    network,
    txDigest,
    signingDigest: signing,
    bytesSha256: sha256Hex(serializedBytes),
    byteLength: BigInt(serializedBytes.byteLength),
    signer: parsed.sender,
    effects: [
      {
        kind: 'transfer',
        asset: { kind: 'sui_coin', chain: 'sui', typeTag: inner, unit: unitFor(inner), decimals: 0n },
        amountRaw,
        from,
        to: recipient,
      },
      {
        kind: 'fee',
        asset: { kind: 'native', chain: 'sui', unit: 'sui-mist' },
        maxAmountRaw: parsed.gas.budget,
        paidBy: parsed.gas.owner,
      },
    ],
    authorities: [],
    // Exactly one dependency, and only when a chain object was actually read. The gas-coin path
    // resolves its asset type from the framework, not from an lookup, so it pins nothing — see
    // `readCoinObject`.
    stateDependencies: readCoinObject === null
      ? []
      : [
        {
          kind: 'sui_object' as const,
          id: readCoinObject,
          contentHash: evidenceHash(evidence, readCoinObject),
          readAt: { slotOrEpoch: 0n, reportedBy: evidence.readBy },
        },
      ],
    expiry: expiryOf(parsed),
    producedBy: { adapter: SUI_ADAPTER_NAME, decoderVersion: SUI_DECODER_VERSION },
  };
}

function expiryOf(parsed: ParsedTransactionData): ValidatedTransaction['expiry'] {
  switch (parsed.expiration.domain) {
    case 'none':
      return { domain: 'none' };
    case 'epoch':
      // An `Epoch(n)` bound is a deadline with no network in it, so `chainBound` is false:
      // the same bytes are valid on any cluster, and that is a fact the policy may need to see.
      return { domain: 'sui_epoch', maxEpoch: parsed.expiration.maxEpoch, chainBound: false };
    case 'valid_during':
      return {
        domain: 'sui_validity',
        minEpoch: parsed.expiration.minEpoch ?? 0n,
        maxEpoch: parsed.expiration.maxEpoch ?? 0n,
        nonce: parsed.expiration.nonce,
        chainBound: true,
      };
    case 'validity':
      return {
        domain: 'sui_validity',
        minEpoch: parsed.expiration.minEpoch ?? 0n,
        maxEpoch: parsed.expiration.maxEpoch ?? 0n,
        nonce: parsed.expiration.nonce,
        chainBound: true,
      };
    case 'unknown':
      return { domain: 'none' };
  }
}

function unitFor(typeTag: string): string {
  const last = typeTag.split('::').pop() ?? 'unknown';
  return `${last.toLowerCase()}-raw`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function evidenceHash(evidence: StateEvidence, id: string): string {
  const entry = evidence.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    // Recomputed over the bytes rather than trusted from the caller's `contentHash`: the hash that
    // binds a decision has to be one this code produced from what it actually read.
    //
    // A missing entry is not "no content", and `sha256('')` was the old answer here. That value is
    // indistinguishable from a real hash of an empty object, so reconciliation would compare a live
    // object digest against a hash of nothing and report the difference as tampering — or accept the
    // absence as a pin. This throws, the adapter turns it into `DECODER_ERROR`, and no path from
    // here yields an ALLOW.
    throw new Error(`no evidence entry for ${id}: a state dependency cannot be recorded for state that was never read`);
  }
  return createHash('sha256').update(Buffer.from(entry.contentBase64, 'base64')).digest('hex');
}
