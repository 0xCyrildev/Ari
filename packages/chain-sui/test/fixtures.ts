/**
 * Test-only BCS *writer* and transaction fixtures.
 *
 * `src/bcs.ts` deliberately has no encoder: encoding belongs to a builder inside the authority
 * plane, and a second encoder next to the parser invites the two to disagree. This is a third one,
 * in `test/`, pointed only at the parser it was written against — which is why it lives here and not
 * in `src/`, and why every fixture below is asserted component-by-component rather than as one long
 * array literal. A mis-parenthesized `[cmdA, cmdB]` collapsing into one flat command produced 81
 * "unparsed trailing bytes" and read exactly like a decoder bug; it was a fixture bug. The named
 * builders exist so that mistake is a type error instead of a mystery.
 *
 * NOT PROVED by anything in this file: that the layout matches what Sui emits. See the header of
 * `decoder.test.ts`.
 */

export const u8 = (n: number): number[] => [n & 0xff];

export const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];

export const u64 = (value: bigint): number[] => {
  const out: number[] = [];
  for (let i = 0; i < 8; i += 1) out.push(Number((value >> BigInt(8 * i)) & 0xffn));
  return out;
};

export const uleb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
};

/** `Vec<T>` = a uleb128 count, then each element's bytes. */
export const vec = (items: readonly number[][]): number[] => [...uleb(items.length), ...items.flat()];

/** `Vec<u8>`, i.e. the length-prefixed body of a `Pure` argument or a string. */
export const vecBytes = (bytes: readonly number[]): number[] => [...uleb(bytes.length), ...bytes];

/**
 * A 32-byte address in *wire* order, which `decode.ts` reads as display order for the fields it
 * takes through `hexOf` (sender, owner, object ids) and as little-endian for a `Pure` address —
 * `pureAddress` reverses those. Two conventions, one length, so the two builders are named apart.
 *
 * The length is checked rather than padded: an over-long literal silently loses its last nibble,
 * and a fixture that quietly decodes to a different address than the one the test names produces a
 * "decoder bug" that is really a typo. A 65-digit address constant did exactly that here.
 */
export const addrWire = (display: string): number[] => {
  const digits = display.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digits)) {
    throw new Error(`address "${display}" is ${digits.length} hex digits, not 64 — fix the fixture, do not pad it`);
  }
  const out: number[] = [];
  for (let i = 0; i < 32; i += 1) out.push(Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16));
  return out;
};

/** The same address as it appears inside a `Pure` argument of Move type `address`. */
export const addrPure = (display: string): number[] => [...addrWire(display)].reverse();

export const argGas = (): number[] => [0];
export const argInput = (index: number): number[] => [1, ...u16(index)];
export const argResult = (command: number): number[] => [2, ...u16(command)];
export const argNested = (command: number, index: number): number[] => [3, ...u16(command), ...u16(index)];

/** A bare `ObjectRef` = `(Address, u64, Digest)` — 72 bytes, no variant tags. */
export const objectRef = (objectId: string, version: bigint, digest: string): number[] =>
  [...addrWire(objectId), ...u64(version), ...addrWire(digest)];

/** `CallArg::Object(ObjectArg::ImmOrOwned(ref))` — the ref behind two variant bytes. */
export const callArgImm = (objectId: string, version: bigint, digest: string): number[] =>
  [1, 0, ...objectRef(objectId, version, digest)];

export const callArgShared = (objectId: string, initialSharedVersion: bigint): number[] =>
  [1, 1, ...addrWire(objectId), ...u64(initialSharedVersion), ...u8(0)];

export const callArgReceiving = (objectId: string, version: bigint, digest: string): number[] =>
  [1, 2, ...objectRef(objectId, version, digest)];

/** `CallArg::Pure(bytes)` — a u64 amount, or a 32-byte address, arrives this way. */
export const callArgPure = (bytes: readonly number[]): number[] => [0, ...vecBytes(bytes)];

/** `Command::SplitCoins(coin, amounts)` */
export const cmdSplitCoins = (coin: number[], amounts: readonly number[][]): number[] =>
  [2, ...coin, ...vec(amounts)];

/** `Command::TransferObjects(objects, address)` */
export const cmdTransferObjects = (objects: readonly number[][], address: number[]): number[] =>
  [1, ...vec(objects), ...address];

/** `Command::MergeCoins(coin, sources)` */
export const cmdMergeCoins = (coin: number[], sources: readonly number[][]): number[] =>
  [3, ...coin, ...vec(sources)];

/** `Command::MoveCall(package, module, function, typeArguments, arguments)` */
export const cmdMoveCall = (
  pkg: string,
  mod: string,
  fn: string,
  typeArgs: readonly number[][] = [],
  args: readonly number[][] = [],
): number[] => [
  0,
  ...addrWire(pkg),
  ...vecBytes([...Buffer.from(mod, 'utf8')]),
  ...vecBytes([...Buffer.from(fn, 'utf8')]),
  ...vec(typeArgs),
  ...vec(args),
];

/** `Command::Publish` / `Upgrade` stand-ins, sized so the reader stays aligned. */
export const cmdPublish = (modules: readonly number[][] = [[0]]): number[] =>
  [4, ...vec(modules), ...vec([])];

export const cmdMakeMoveVec = (elements: readonly number[][]): number[] =>
  [5, ...u8(0), ...uleb(elements.length), ...elements.flat()];

export const expNone = (): number[] => [0];
export const expEpoch = (maxEpoch: bigint): number[] => [1, ...u64(maxEpoch)];

export const txVersionV1 = (): number[] => [0];
export const kindProgrammableTransaction = (): number[] => [0];

/**
 * Gas fields a fixture may leave unset. `| undefined` is written out on purpose: this repository
 * compiles with `exactOptionalPropertyTypes`, and a fixture that passes `options.gas?.price`
 * straight through *is* supplying an explicit undefined to mean "take the default", which the
 * bare optional form forbids. Silently re-building the object per-field would have hidden that.
 */
export interface GasFields {
  readonly payment?: readonly number[][] | undefined;
  readonly owner?: string | undefined;
  readonly price?: bigint | undefined;
  readonly budget?: bigint | undefined;
}

/**
 * `TransactionData::V1(PTB{inputs, commands}, sender, gas, expiration)` in that order — the field
 * order `decode.ts` declares, and the reason the pieces are passed in rather than a blob: a fixture
 * that assembled one opaque buffer could not be checked against the decoder's own reading of it.
 */
export function transactionData(
  inputs: readonly number[][],
  commands: readonly number[][],
  sender: string,
  gas: GasFields,
  expiration: number[],
): Uint8Array {
  return new Uint8Array([
    ...txVersionV1(),
    ...kindProgrammableTransaction(),
    ...vec(inputs),
    ...vec(commands),
    ...addrWire(sender),
    ...vec(gas.payment ?? []),
    ...addrWire(gas.owner ?? sender),
    ...u64(gas.price ?? 1_000n),
    ...u64(gas.budget ?? 5_000_000n),
    ...expiration,
  ]);
}

/**
 * A 64-digit address from a two-digit marker, right-aligned. Built rather than typed, because a
 * hand-typed literal is one digit off more often than it is right, and `addrWire` now says so.
 */
export const mkAddress = (marker: string): string => `0x${marker.padStart(64, '0').toLowerCase()}`;

export const SENDER = mkAddress('aa01');
export const RECIPIENT = mkAddress('bb02');
export const COIN = mkAddress('cc03');
export const COIN_DIGEST = mkAddress('dd04');
export const OTHER = mkAddress('ee05');

export const DEFAULT_AMOUNT = 1_000_000n;

export interface SupportedOptions {
  readonly amountRaw?: bigint;
  readonly recipient?: string;
  readonly sender?: string;
  readonly fromGasCoin?: boolean;
  readonly inputs?: readonly number[][];
  readonly commands?: readonly number[][];
  readonly gas?: GasFields;
  readonly expiration?: number[];
}

/**
 * The only shape the adapter supports:
 * `[SplitCoins(coin, [amount]), TransferObjects([Result(0)], recipient)]`.
 *
 * `fromGasCoin` swaps the coin to `Argument::GasCoin`, which is the native-SUI path and needs no
 * object evidence; otherwise the coin is input index 2, an `ImmOrOwned` object whose state the
 * caller must supply.
 */
export function supportedTransaction(options: SupportedOptions = {}): Uint8Array {
  const amountRaw = options.amountRaw ?? DEFAULT_AMOUNT;
  const recipient = options.recipient ?? RECIPIENT;
  const fromGasCoin = options.fromGasCoin ?? false;

  const inputs = options.inputs ?? (fromGasCoin
    ? [callArgPure(u64(amountRaw)), callArgPure(addrPure(recipient))]
    : [
        callArgPure(u64(amountRaw)),
        callArgPure(addrPure(recipient)),
        callArgImm(COIN, 4n, COIN_DIGEST),
      ]);

  const commands = options.commands ?? [
    cmdSplitCoins(fromGasCoin ? argGas() : argInput(2), [argInput(0)]),
    cmdTransferObjects([argResult(0)], argInput(1)),
  ];

  return transactionData(
    inputs,
    commands,
    options.sender ?? SENDER,
    {
      payment: options.gas?.payment ?? [objectRef(COIN, 4n, COIN_DIGEST)],
      owner: options.gas?.owner,
      price: options.gas?.price,
      budget: options.gas?.budget,
    },
    options.expiration ?? expEpoch(500n),
  );
}

/** The coin state the object-input path requires, as `StateEvidence` entries. */
export function coinEvidence(typeTag = '0x2::coin::Coin<0x2::sui::SUI>', owner = SENDER, balance = '9000000', objectId = COIN) {
  const payload = Buffer.from(JSON.stringify({ typeTag, owner, balance, version: '4' })).toString('base64');
  return {
    entries: [{ id: objectId, contentBase64: payload, contentHash: '0'.repeat(64), readAtSlotOrEpoch: 1n }],
    readBy: 'fixture',
  };
}

export const NO_EVIDENCE = { entries: [], readBy: 'none' };
