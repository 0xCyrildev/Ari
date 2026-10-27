/**
 * A strict RLP reader and the small writer the signing hash needs.
 *
 * RLP has no type tags and no lengths beyond byte counts, so the two ways a parser gets fooled here
 * are both canonical-encoding attacks, and both are refused rather than tolerated:
 *
 *   - **A short string in the long form.** `0xb8 0x01 0x41` and `0x41` both decode to `"A"`. An
 *     accept-both reader gives an attacker two byte strings for one decoded transaction — the same
 *     collision `@ari/chain-sui`'s BCS reader refuses on a non-minimal `uleb128`, and the reason a
 *     digest sealed over one encoding is not a digest over "the" transaction.
 *   - **A list whose stated length does not match its contents.** Under-stated and the following
 *     bytes are read as part of it; over-stated and the reader runs off the end. Both are checked
 *     against the remaining bytes before anything is allocated.
 *
 * The writer exists for one reason: an EVM signing hash is `keccak256(type ‖ rlp(fields))`, so
 * deriving the digest the signer must reproduce requires re-encoding. Unlike the Sui package, where
 * an encoder next to the parser would invite the two to disagree about a format this code only reads,
 * here the encoder and the decoder are *both* required to be right about the same payload, and they
 * are tested against each other for exactly that.
 */

export class RlpError extends Error {
  constructor(readonly kind: 'TRUNCATED' | 'NON_CANONICAL' | 'TRAILING_BYTES' | 'OUT_OF_RANGE' | 'NOT_A_LIST', message: string) {
    super(`rlp: ${message}`);
    this.name = 'RlpError';
  }
}

export type RlpItem = Uint8Array | readonly RlpItem[];

const isList = (item: RlpItem): item is readonly RlpItem[] => Array.isArray(item);

/** The bytes of an item that must be a string, or a refusal naming what it was. */
export function asBytes(item: RlpItem | undefined, what: string): Uint8Array {
  if (item === undefined) throw new RlpError('TRUNCATED', `${what} is missing from the envelope`);
  if (isList(item)) throw new RlpError('NOT_A_LIST', `${what} is a list where a byte string was expected`);
  return item;
}

export function asList(item: RlpItem | undefined, what: string): readonly RlpItem[] {
  if (item === undefined) throw new RlpError('TRUNCATED', `${what} is missing from the envelope`);
  if (!isList(item)) throw new RlpError('NOT_A_LIST', `${what} is a byte string where a list was expected`);
  return item;
}

/**
 * A big-endian unsigned integer with **no** leading zero bytes and no empty encoding. `0x00` and
 * `0x80` (empty) both mean zero to a lenient reader, and a transaction whose `value` was written two
 * ways is two transactions with one meaning.
 */
export function asQuantity(item: RlpItem | undefined, what: string): bigint {
  const bytes = asBytes(item, what);
  if (bytes.byteLength === 0) return 0n;
  if (bytes[0] === 0) throw new RlpError('NON_CANONICAL', `${what} has a leading zero byte: ${bytes.byteLength}-byte encoding`);
  if (bytes.byteLength > 32) throw new RlpError('OUT_OF_RANGE', `${what} is ${bytes.byteLength} bytes, wider than a 256-bit quantity`);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * RLP's five header ranges, in order. Getting a boundary wrong here is not a parse error, it is a
 * negative or absurd `length`: the first version of this function tested `first <= 0xf7` for the
 * short-form *list*, which also captured the long-form *string* range `0xb8..0xbf`, so a `0xb8`
 * header returned `0xb8 - 0xc0 = -8`. `payloadEnd` then sat **behind** `payloadStart`, the subarray
 * came back empty, the cursor moved backwards, and the enclosing list loop spun until the process
 * died of out-of-memory. A real ERC-20 calldata transaction from anvil triggered it.
 *
 *   0x00..0x7f  a single byte, which is its own encoding
 *   0x80..0xb7  short string,    length = first - 0x80
 *   0xb8..0xbf  long string,     the next (first - 0xb7) bytes are the length
 *   0xc0..0xf7  short list,      length = first - 0xc0
 *   0xf8..0xff  long list,       the next (first - 0xf7) bytes are the length
 */
function readLength(reader: { offset: number }, bytes: Uint8Array, first: number): { length: number; offsetAfter: number } {
  // `reader.offset` is already past the header byte at every call site, so the short forms advance
  // nothing further. Getting this wrong reads an empty string (`0x80`) as needing one more byte.
  //
  // The order of these tests is the whole function: `0xb8..0xbf` is a long-form **string** and must
  // be matched before the short-**list** range, because `0xb8 <= 0xf7` is true and testing the list
  // first is precisely the bug described above.
  if (first <= 0x7f) return { length: 1, offsetAfter: reader.offset };
  if (first <= 0xb7) return { length: first - 0x80, offsetAfter: reader.offset };
  if (first <= 0xbf) return readLongLength(reader, bytes, first - 0xb7, 'string');
  if (first <= 0xf7) return { length: first - 0xc0, offsetAfter: reader.offset };
  return readLongLength(reader, bytes, first - 0xf7, 'list');
}

/**
 * `lenOfLen` header bytes carry the payload length. The result is checked to be ≥ 56 (otherwise the
 * short form was available and two byte strings denote one item) and to fit in the buffer, so a
 * declared length can never drive an allocation or move a cursor past the end.
 */
function readLongLength(reader: { offset: number }, bytes: Uint8Array, lenOfLen: number, kind: 'list' | 'string'): { length: number; offsetAfter: number } {
  if (reader.offset + lenOfLen > bytes.byteLength) {
    throw new RlpError('TRUNCATED', `long-form ${kind} length prefix runs past the end`);
  }
  let length = 0;
  for (let i = 0; i < lenOfLen; i += 1) length = length * 0x100 + (bytes[reader.offset + i] as number);
  if (!Number.isSafeInteger(length) || length < 56) {
    throw new RlpError('NON_CANONICAL', `long form used for a ${length}-byte ${kind}`);
  }
  if (lenOfLen > 1 && (bytes[reader.offset] as number) === 0) {
    throw new RlpError('NON_CANONICAL', `long-form ${kind} length is zero-padded`);
  }
  return { length, offsetAfter: reader.offset + lenOfLen };
}

function readItem(bytes: Uint8Array, cursor: { offset: number }): RlpItem {
  if (cursor.offset >= bytes.byteLength) throw new RlpError('TRUNCATED', 'ran out of bytes mid-item');
  const first = bytes[cursor.offset] as number;
  cursor.offset += 1;

  if (first <= 0x7f) {
    // A single byte is its own encoding; the "string" is that byte, consumed inline.
    return new Uint8Array([first]);
  }

  const header = readLength(cursor, bytes, first);
  const isListHeader = first >= 0xc0;
  const payloadStart = header.offsetAfter;
  const payloadEnd = payloadStart + header.length;
  if (payloadEnd > bytes.byteLength) {
    throw new RlpError('TRUNCATED', `${isListHeader ? 'list' : 'string'} of ${header.length} byte(s) with ${bytes.byteLength - payloadStart} left`);
  }

  if (!isListHeader) {
    // A one-byte string arriving in the short form (`0x81 0x41`) is the non-canonical twin of the
    // single-byte encoding above, and only the reader can tell them apart.
    if (header.length === 1 && (bytes[payloadStart] as number) <= 0x7f) {
      throw new RlpError('NON_CANONICAL', 'a byte <= 0x7f must be encoded as itself, not as a one-byte string');
    }
    cursor.offset = payloadEnd;
    return bytes.subarray(payloadStart, payloadEnd);
  }

  const items: RlpItem[] = [];
  const listCursor = { offset: payloadStart };
  while (listCursor.offset < payloadEnd) {
    const before = listCursor.offset;
    items.push(readItem(bytes, listCursor));
    // Defense in depth, and it is what turned the bug above from a hang into an answer: an item that
    // does not advance the cursor means a header was read with a negative or zero span, and looping
    // on it is an unbounded allocation rather than a refusal. The range fix is the real repair; this
    // guard is the reason a future off-by-one cannot be a denial of service.
    if (listCursor.offset <= before) {
      throw new RlpError('NON_CANONICAL', `list item at offset ${before} consumed no bytes`);
    }
  }
  // A list whose members stop short of `payloadEnd` claims more than it contains; one that runs past
  // it swallowed a sibling. Both are checked against the declared span, not against the buffer end.
  if (listCursor.offset !== payloadEnd) throw new RlpError('OUT_OF_RANGE', 'list members do not fill the declared list');
  cursor.offset = payloadEnd;
  return items;
}

/** Decode one RLP item covering the whole buffer. Trailing bytes are an error, never ignored. */
export function decodeRlp(bytes: Uint8Array): RlpItem {
  const cursor = { offset: 0 };
  const item = readItem(bytes, cursor);
  if (cursor.offset !== bytes.byteLength) {
    throw new RlpError('TRAILING_BYTES', `${bytes.byteLength - cursor.offset} byte(s) after the top-level item`);
  }
  return item;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function encodeLength(length: number, offset: number): number[] {
  if (length < 56) return [length + offset];
  const hex = length.toString(16);
  const padded = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out: number[] = [offset + 55 + padded.length / 2];
  for (let i = 0; i < padded.length; i += 2) out.push(Number.parseInt(padded.slice(i, i + 2), 16));
  return out;
}

/** A byte string, canonical: single bytes as themselves, no padded lengths, no long form for < 56. */
export function encodeBytes(value: Uint8Array): number[] {
  if (value.byteLength === 1 && value[0]! <= 0x7f) return [value[0]!];
  return [...encodeLength(value.byteLength, 0x80), ...value];
}

export function encodeList(items: readonly number[][]): number[] {
  const payload = items.flat();
  return [...encodeLength(payload.length, 0xc0), ...payload];
}

/** A non-negative integer, big-endian, minimal — the form `asQuantity` will read back. */
export function encodeQuantity(value: bigint): number[] {
  if (value < 0n) throw new RlpError('OUT_OF_RANGE', `cannot RLP-encode the negative quantity ${value}`);
  if (value === 0n) return encodeBytes(new Uint8Array(0));
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0n) {
    bytes.unshift(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return encodeBytes(new Uint8Array(bytes));
}
