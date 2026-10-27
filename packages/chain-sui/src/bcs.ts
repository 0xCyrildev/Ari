/**
 * A strict BCS reader — enough of the format to decode a Sui `TransactionData`, and no more.
 *
 * BCS is small, but the places where a lenient reader becomes a security hole are specific and
 * well known, so this file's rules are not style:
 *
 *   - **Sequence lengths are bounded before they are trusted.** A `Vec<Command>` may open with a
 *     `uleb128` claiming two billion items. The bound is applied against the *remaining bytes*,
 *     so a claim bigger than the payload is a refusal at the header rather than an allocation.
 *   - **Non-minimal integer encodings are refused.** A `uleb128` with a redundant continuation
 *     byte encodes the same number as a shorter one, and a decoder that accepts both gives an
 *     attacker two byte strings for one decoded value — the canonicalization collision Ari's own
 *     `canonicalEncode` exists to avoid, arriving from the wire format instead of the JSON.
 *   - **Trailing bytes are an error.** Left unparsed, they are invisible to a policy that read
 *     every field it knows about.
 *   - **Booleans are 0 or 1.** Anything else is a decode failure, not "truthy".
 *   - **Fixed-width integers are little-endian and returned as `bigint`.** A `u64` amount that
 *     becomes a JS `number` is a rounding error on the money path.
 *
 * This is a reader, not a general codec: there is deliberately no `encode`. Encoding a
 * transaction is the job of a builder inside the authority plane, and putting it next to the
 * parser invites the two to disagree.
 */

/** The largest `uleb128` this reader will decode: u128 needs at most 18 bytes. */
const MAX_ULEB_BYTES = 18;

export class BcsError extends Error {
  constructor(readonly kind: 'TRUNCATED' | 'OVERLONG' | 'NON_MINIMAL' | 'OUT_OF_RANGE' | 'TRAILING_BYTES' | 'BAD_BOOL', message: string) {
    super(`bcs: ${message}`);
    this.name = 'BcsError';
  }
}

export class BcsReader {
  readonly #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array, private readonly maxSequenceLength: number = 4096) {
    this.#bytes = bytes;
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  get done(): boolean {
    return this.#offset === this.#bytes.length;
  }

  /** Nothing may be left over. Call this once at the end of a top-level decode. */
  expectEnd(): void {
    if (!this.done) {
      throw new BcsError('TRAILING_BYTES', `${this.remaining} byte(s) unparsed after the transaction ended`);
    }
  }

  take(n: number): Uint8Array {
    if (n < 0 || n > this.remaining) throw new BcsError('TRUNCATED', `needs ${n} byte(s), ${this.remaining} left`);
    const out = this.#bytes.subarray(this.#offset, this.#offset + n);
    this.#offset += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0] as number;
  }

  u16(): number {
    const b = this.take(2);
    return b[0]! | (b[1]! << 8);
  }

  u32(): number {
    const b = this.take(4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  u64(): bigint {
    return this.leInt(8);
  }

  u128(): bigint {
    return this.leInt(16);
  }

  private leInt(width: number): bigint {
    let value = 0n;
    const bytes = this.take(width);
    for (let i = width - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]!);
    return value;
  }

  bool(): boolean {
    const byte = this.u8();
    if (byte > 1) throw new BcsError('BAD_BOOL', `${byte} is not a boolean`);
    return byte === 1;
  }

  /**
   * `uleb128`, with the non-minimality check BCS requires. The last group must fit in 7 bits —
   * a trailing byte of `0x81` after a full value would otherwise say "more bits are coming" and
   * silently extend a number that was already complete.
   */
  uleb128(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let read = 0; read < MAX_ULEB_BYTES; read += 1) {
      const byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        // Non-minimal: a final zero group that still carried a continuation byte.
        if (read > 0 && byte === 0 && result < 1n << shift) {
          throw new BcsError('NON_MINIMAL', `uleb128 ends with a redundant continuation group`);
        }
        return result;
      }
      shift += 7n;
    }
    throw new BcsError('OVERLONG', `uleb128 longer than ${MAX_ULEB_BYTES} bytes`);
  }

  /** A sequence length, bounded against what could actually be present. */
  length(): number {
    const raw = this.uleb128();
    if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new BcsError('OUT_OF_RANGE', `sequence length ${raw}`);
    const n = Number(raw);
    // Even a sequence of zero-width items cannot exceed the remaining byte count by much, and
    // every element this decoder handles costs at least one byte, so this bound is sound.
    if (n > this.maxSequenceLength) {
      throw new BcsError('OUT_OF_RANGE', `sequence of ${n} exceeds the ${this.maxSequenceLength} element cap`);
    }
    if (n > this.remaining) {
      throw new BcsError('OUT_OF_RANGE', `sequence of ${n} declared with only ${this.remaining} byte(s) left`);
    }
    return n;
  }

  bytes(): Uint8Array {
    return this.take(this.length());
  }

  fixedBytes(n: number): Uint8Array {
    return this.take(n);
  }

  string(): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes());
  }

  /** `Option<T>` in BCS is a one-byte tag, not a length. */
  optional<T>(read: () => T): T | null {
    return this.bool() ? read() : null;
  }

  vec<T>(read: () => T): T[] {
    const n = this.length();
    const out: T[] = [];
    for (let i = 0; i < n; i += 1) out.push(read());
    return out;
  }

  /** The variant index of an enum, which BCS encodes as a `uleb128`. */
  variant(): number {
    const raw = this.uleb128();
    if (raw > 255n) throw new BcsError('OUT_OF_RANGE', `enum variant index ${raw}`);
    return Number(raw);
  }

  hex(): string {
    return Buffer.from(this.bytes()).toString('hex');
  }
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function base64ToBytes(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64');
  // Round-trip check: `Buffer` discards characters a strict decoder must refuse, and a
  // transaction that does not really base64-decode is not a transaction.
  if (bytes.toString('base64') !== value.trim()) {
    throw new BcsError('OUT_OF_RANGE', 'input is not canonical base64');
  }
  return bytes;
}
