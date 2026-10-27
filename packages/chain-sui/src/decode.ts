/**
 * Sui `TransactionData` → a structure Ari can reason about, and nothing else.
 *
 * The rule that governs this file: an unrecognised variant index is a refusal that *names the
 * index*, never a default. BCS enums are positional — the integer is the variant's index in the
 * Rust source — so a decoder that guesses what index 7 means will, on the day Sui inserts a
 * variant ahead of it, read a `FundsWithdrawal` as a `Coin` and be confidently wrong. Refusing
 * costs one authorization; guessing costs the property the package exists to provide.
 *
 * What is parsed here is the wire structure only. Whether the transaction *means* anything Ari can
 * bound is `validate.ts`'s question, and the two are separate because a parse succeeds on far more
 * transactions than can safely be authorized.
 */

import { BcsReader } from './bcs.js';

export type Bytes = Uint8Array;

export interface ObjectRef {
  readonly objectId: string;
  readonly version: bigint;
  readonly digest: string;
}

export type CallArg =
  | { readonly kind: 'pure'; readonly bytes: Bytes }
  | { readonly kind: 'object'; readonly arg: ObjectArg }
  /**
   * Captured so the validator can refuse it by name. `FundsWithdrawal` (SIP-58) is the third
   * variant of `CallArg` and the one a two-variant parser mis-reads: a fake `Coin<T>` *object*
   * argument is reinterpreted by validators as a withdrawal from an address balance, so bytes
   * that look like an object transfer spend money the sender does not hold in an object.
   */
  | { readonly kind: 'funds_withdrawal'; readonly variant: number };

export type ObjectArg =
  | { readonly kind: 'imm_or_owned'; readonly ref: ObjectRef }
  | { readonly kind: 'shared'; readonly objectId: string; readonly initialSharedVersion: bigint; readonly mutability: number }
  | { readonly kind: 'receiving'; readonly ref: ObjectRef };

export type Argument =
  | { readonly kind: 'gas_coin' }
  | { readonly kind: 'input'; readonly index: number }
  /** A previous command's whole result vector. */
  | { readonly kind: 'result'; readonly command: number }
  /** A field of a previous command's result — the mechanism by which an object the sender never
   *  named can be transferred, because a third-party `MoveCall` may have created or unwrapped it. */
  | { readonly kind: 'nested_result'; readonly command: number; readonly index: number };

export type TypeInput =
  | { readonly kind: 'primitive'; readonly name: string }
  | { readonly kind: 'vector'; readonly inner: TypeInput }
  | { readonly kind: 'struct'; readonly address: string; readonly module: string; readonly name: string; readonly typeParams: readonly TypeInput[] };

export type Command =
  | {
      readonly kind: 'move_call';
      readonly package: string;
      readonly module: string;
      readonly function: string;
      readonly typeArguments: readonly TypeInput[];
      readonly arguments: readonly Argument[];
    }
  | { readonly kind: 'transfer_objects'; readonly objects: readonly Argument[]; readonly address: Argument }
  | { readonly kind: 'split_coins'; readonly coin: Argument; readonly amounts: readonly Argument[] }
  | { readonly kind: 'merge_coins'; readonly coin: Argument; readonly sources: readonly Argument[] }
  | { readonly kind: 'publish'; readonly modules: number; readonly dependencies: number }
  | { readonly kind: 'make_move_vec'; readonly type: TypeInput | null; readonly elements: number }
  | { readonly kind: 'upgrade' }
  | { readonly kind: 'unsupported'; readonly variant: number; readonly detail: string };

export type TransactionExpiration =
  | { readonly domain: 'none' }
  | { readonly domain: 'epoch'; readonly maxEpoch: bigint }
  | { readonly domain: 'valid_during'; readonly minEpoch: bigint | null; readonly maxEpoch: bigint | null; readonly chain: string; readonly nonce: bigint }
  | { readonly domain: 'validity'; readonly minEpoch: bigint | null; readonly maxEpoch: bigint | null; readonly chain: string; readonly nonce: bigint }
  | { readonly domain: 'unknown'; readonly variant: number };

export interface ParsedTransactionData {
  readonly dataVersion: number;
  readonly kindName: 'programmable_transaction' | 'unsupported';
  readonly sender: string;
  readonly gas: {
    readonly payment: readonly ObjectRef[];
    readonly owner: string;
    readonly price: bigint;
    readonly budget: bigint;
  };
  readonly expiration: TransactionExpiration;
  readonly inputs: readonly CallArg[];
  readonly commands: readonly Command[];
}

/**
 * Variant indices, as read from `crates/sui-types/src/transaction.rs` during this research pass.
 * They are *declared* rather than derived, so that a mismatch with a real transaction is visible
 * as a refusal naming an index rather than as a silent misread. Unverified against on-chain bytes
 * until `test/vectors.test.ts` has run against tool-produced transactions.
 */
export const KNOWN_VARIANTS = {
  transactionData: { v1: 0 },
  transactionKind: { programmableTransaction: 0 },
  callArg: { pure: 0, object: 1, fundsWithdrawal: 2 },
  objectArg: { immOrOwned: 0, shared: 1, receiving: 2 },
  argument: { gasCoin: 0, input: 1, result: 2, nestedResult: 3 },
  command: { moveCall: 0, transferObjects: 1, splitCoins: 2, mergeCoins: 3, publish: 4, makeMoveVec: 5, upgrade: 6 },
  expiration: { none: 0, epoch: 1, validDuring: 2, validity: 3 },
  typeInput: { bool: 0, u8: 1, u64: 2, u128: 3, address: 4, signer: 5, vector: 6, struct: 7, u16: 8, u32: 9, u256: 10 },
} as const;

export type DecodeFailure =
  | { readonly ok: false; readonly kind: 'MALFORMED' | 'FORMAT_UNSUPPORTED'; readonly detail: string }
  | { readonly ok: true; readonly parsed: ParsedTransactionData };

const ADDRESS_LEN = 32;
const DIGEST_LEN = 32;

function hexOf(reader: BcsReader, length: number): string {
  return `0x${Buffer.from(reader.fixedBytes(length)).toString('hex')}`;
}

function readObjectRef(reader: BcsReader): ObjectRef {
  return { objectId: hexOf(reader, ADDRESS_LEN), version: reader.u64(), digest: hexOf(reader, DIGEST_LEN) };
}

function readArgument(reader: BcsReader): Argument {
  const v = reader.variant();
  switch (v) {
    case KNOWN_VARIANTS.argument.gasCoin:
      return { kind: 'gas_coin' };
    case KNOWN_VARIANTS.argument.input:
      return { kind: 'input', index: reader.u16() };
    case KNOWN_VARIANTS.argument.result:
      return { kind: 'result', command: reader.u16() };
    case KNOWN_VARIANTS.argument.nestedResult: {
      const command = reader.u16();
      const index = reader.u16();
      return { kind: 'nested_result', command, index };
    }
    default:
      throw new UnknownVariant('Argument', v);
  }
}

/** Thrown rather than returned: every call site is inside a decode that converts it to a refusal. */
class UnknownVariant extends Error {
  constructor(readonly what: string, readonly index: number) {
    super(`${what} variant index ${index} is not one this decoder knows`);
    this.name = 'UnknownVariant';
  }
}

function readTypeInput(reader: BcsReader): TypeInput {
  const v = reader.variant();
  const K = KNOWN_VARIANTS.typeInput;
  if (v === K.vector) return { kind: 'vector', inner: readTypeInput(reader) };
  if (v === K.struct) {
    const address = hexOf(reader, ADDRESS_LEN);
    const module = reader.string();
    const name = reader.string();
    const typeParams = reader.vec(() => readTypeInput(reader));
    return { kind: 'struct', address, module, name, typeParams };
  }
  const primitive: Record<number, string> = {
    [K.bool]: 'bool', [K.u8]: 'u8', [K.u16]: 'u16', [K.u32]: 'u32', [K.u64]: 'u64',
    [K.u128]: 'u128', [K.u256]: 'u256', [K.address]: 'address', [K.signer]: 'signer',
  };
  const name = primitive[v];
  if (name === undefined) throw new UnknownVariant('TypeInput', v);
  return { kind: 'primitive', name };
}

function readCallArg(reader: BcsReader): CallArg {
  const v = reader.variant();
  if (v === KNOWN_VARIANTS.callArg.pure) return { kind: 'pure', bytes: reader.bytes() };
  if (v === KNOWN_VARIANTS.callArg.object) return { kind: 'object', arg: readObjectArg(reader) };
  if (v === KNOWN_VARIANTS.callArg.fundsWithdrawal) return { kind: 'funds_withdrawal', variant: v };
  throw new UnknownVariant('CallArg', v);
}

function readObjectArg(reader: BcsReader): ObjectArg {
  const v = reader.variant();
  const K = KNOWN_VARIANTS.objectArg;
  if (v === K.immOrOwned) return { kind: 'imm_or_owned', ref: readObjectRef(reader) };
  if (v === K.receiving) return { kind: 'receiving', ref: readObjectRef(reader) };
  if (v === K.shared) {
    const objectId = hexOf(reader, ADDRESS_LEN);
    const initialSharedVersion = reader.u64();
    const mutability = reader.variant();
    return { kind: 'shared', objectId, initialSharedVersion, mutability };
  }
  throw new UnknownVariant('ObjectArg', v);
}

function readCommand(reader: BcsReader): Command {
  const v = reader.variant();
  const K = KNOWN_VARIANTS.command;
  switch (v) {
    case K.moveCall: {
      const packageId = hexOf(reader, ADDRESS_LEN);
      const module = reader.string();
      const fn = reader.string();
      const typeArguments = reader.vec(() => readTypeInput(reader));
      const args = reader.vec(() => readArgument(reader));
      return { kind: 'move_call', package: packageId, module, function: fn, typeArguments, arguments: args };
    }
    case K.transferObjects: {
      const objects = reader.vec(() => readArgument(reader));
      const address = readArgument(reader);
      return { kind: 'transfer_objects', objects, address };
    }
    case K.splitCoins: {
      const coin = readArgument(reader);
      const amounts = reader.vec(() => readArgument(reader));
      return { kind: 'split_coins', coin, amounts };
    }
    case K.mergeCoins: {
      const coin = readArgument(reader);
      const sources = reader.vec(() => readArgument(reader));
      return { kind: 'merge_coins', coin, sources };
    }
    case K.publish: {
      // Module *contents* — arbitrary new code. Counted and refused by the validator; parsed only
      // far enough to stay byte-aligned for the fields that follow.
      const modules = reader.length();
      for (let i = 0; i < modules; i += 1) reader.bytes();
      const dependencies = reader.length();
      for (let i = 0; i < dependencies; i += 1) reader.fixedBytes(ADDRESS_LEN);
      return { kind: 'publish', modules, dependencies };
    }
    case K.makeMoveVec: {
      const type = reader.optional(() => readTypeInput(reader));
      const elements = reader.length();
      for (let i = 0; i < elements; i += 1) readArgument(reader);
      return { kind: 'make_move_vec', type, elements };
    }
    case K.upgrade:
      // modules, dependencies, package, upgrade_ticket — a package mutation. Refused wholesale,
      // so the payload is skipped rather than decoded by guessing at it.
      return { kind: 'upgrade' };
    default:
      throw new UnknownVariant('Command', v);
  }
}

function readExpiration(reader: BcsReader): TransactionExpiration {
  const v = reader.variant();
  const K = KNOWN_VARIANTS.expiration;
  if (v === K.none) return { domain: 'none' };
  if (v === K.epoch) return { domain: 'epoch', maxEpoch: reader.u64() };
  const minEpoch = reader.optional(() => reader.u64());
  const maxEpoch = reader.optional(() => reader.u64());
  const minTimestamp = reader.optional(() => reader.u64());
  const maxTimestamp = reader.optional(() => reader.u64());
  const chain = hexOf(reader, ADDRESS_LEN);
  const nonce = BigInt(reader.u32());
  void minTimestamp;
  void maxTimestamp;
  if (v === K.validDuring) return { domain: 'valid_during', minEpoch, maxEpoch, chain, nonce };
  if (v === K.validity) {
    const allowedProposers = reader.optional(() => 0);
    void allowedProposers;
    return { domain: 'validity', minEpoch, maxEpoch, chain, nonce };
  }
  return { domain: 'unknown', variant: v };
}

/**
 * Decode a serialized `TransactionData`. Never throws: a malformed byte string is an answer Ari
 * has to be able to record and refuse with, not an exception that a route handler may read as
 * "no decision was made".
 */
export function decodeTransactionData(bytes: Uint8Array): DecodeFailure | { readonly ok: true; readonly parsed: ParsedTransactionData } {
  try {
    const reader = new BcsReader(bytes);
    const dataVersion = reader.variant();
    if (dataVersion !== KNOWN_VARIANTS.transactionData.v1) {
      return { ok: false, kind: 'FORMAT_UNSUPPORTED', detail: `TransactionData version ${dataVersion} is not V1; this decoder handles only V1` };
    }

    const kindVariant = reader.variant();
    if (kindVariant !== KNOWN_VARIANTS.transactionKind.programmableTransaction) {
      return {
        ok: false,
        kind: 'FORMAT_UNSUPPORTED',
        detail: `TransactionKind variant ${kindVariant} is not a ProgrammableTransaction; system transaction kinds are not something an agent should be proposing`,
      };
    }

    const inputs = reader.vec(() => readCallArg(reader));
    const commands = reader.vec(() => readCommand(reader));

    const sender = hexOf(reader, ADDRESS_LEN);
    const payment = reader.vec(() => readObjectRef(reader));
    const owner = hexOf(reader, ADDRESS_LEN);
    const price = reader.u64();
    const budget = reader.u64();
    const expiration = readExpiration(reader);

    reader.expectEnd();

    return {
      ok: true,
      parsed: {
        dataVersion,
        kindName: 'programmable_transaction',
        sender,
        gas: { payment, owner, price, budget },
        expiration,
        inputs,
        commands,
      },
    };
  } catch (error) {
    if (error instanceof UnknownVariant) {
      return { ok: false, kind: 'FORMAT_UNSUPPORTED', detail: error.message };
    }
    const message = error instanceof Error ? error.message : 'non-error thrown while decoding';
    return { ok: false, kind: 'MALFORMED', detail: message };
  }
}
