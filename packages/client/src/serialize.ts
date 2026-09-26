/**
 * Turning a parsed value into something that may go on a wire.
 *
 * `@ari/schemas` says every big integer crosses a boundary as a decimal *string* and
 * becomes a `bigint` exactly once, in the parser. That sentence has an outbound half,
 * and this file is it: a parsed `CandidateTransaction` holds `bigint`s — by decision,
 * because a wei amount that fits in `numeric(80,0)` does not fit in a JSON number —
 * and `JSON.stringify` throws on one.
 *
 * The tempting alternative is a replacer, `(_, v) => typeof v === 'bigint' ? v.toString() : v`.
 * It is shorter and it is worse. A replacer cannot see a missing key, cannot name the
 * path that went wrong, and turns `NaN` into `null` without a word — which is how an
 * amount becomes zero on the way to being refused. So this walks the value and says
 * where it stopped.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Integers only, and only those a JSON number can actually represent.
 *
 * Money can never arrive here as a number — `RawBigInt` accepts a bigint or a digit
 * string and nothing else, so an amount that reached this function as a `number` was
 * already the wrong type. The guard is for everything *around* the money: a
 * `decimals` field, a count, a timestamp. A float that quietly rounds is a bug worth
 * naming at the path it happened on, and `9007199254740993` is a real integer that
 * JSON cannot hold.
 */
function checkNumber(path: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${path} is ${String(value)}, which JSON has no way to say`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${path} is not an integer JSON can carry (${String(value)}); use a decimal string`);
  }
  return value;
}

export function toWire(value: unknown, path = '$'): JsonValue {
  if (value === null) return null;

  switch (typeof value) {
    case 'bigint':
      return value.toString();
    case 'number':
      return checkNumber(path, value);
    case 'string':
    case 'boolean':
      return value;
    case 'undefined':
      // Reachable from the top level and from inside an array. `JSON.stringify` gives
      // `undefined` for the first — not a string, so a request body would go out as
      // the four characters `undefined` — and `null` for the second, which changes an
      // element's type on the way to being refused. An absent *property* is different
      // and is handled where properties are handled.
      throw new TypeError(`${path} is undefined, which has no JSON form`);
    default:
      break;
  }

  if (Array.isArray(value)) {
    // `Array.from` first, because `map` skips holes: `[,1]` would come back as a hole
    // too and `JSON.stringify` renders a hole as `null`. An omitted element becoming a
    // null is the same silent type change as an `undefined` scalar, and an array of
    // amounts is exactly where a caller would never think to look for it.
    return Array.from(value).map((entry, index) => toWire(entry, `${path}[${index}]`));
  }

  if (typeof value === 'object') {
    // Class instances, `Date`, `ObjectId`, a pg `QueryResult`: none of them have own
    // enumerable data properties that mean what their author meant, and `JSON` turns
    // a `Date` into a string by a rule of its own while turning most others into `{}`.
    // A timestamp silently becoming `{}` on the way to a limit check is the kind of
    // thing worth a thrown TypeError at the path.
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `${path} is a ${((prototype as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'non-plain')} instance; serialise it to a string or a plain object`,
      );
    }
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // An own property set to `undefined` is dropped, which is what an optional
      // field means: `exactOptionalPropertyTypes` is why callers write
      // `...(token ? { approvalToken: token } : {})` rather than passing undefined, and
      // a client that turned the two into different requests would be inventing a
      // distinction the type system already refused to express.
      if (entry === undefined) continue;
      out[key] = toWire(entry, `${path}.${key}`);
    }
    return out;
  }

  throw new TypeError(`${path} is ${typeof value}, which cannot go on the wire`);
}

export function wireStringify(value: unknown): string {
  return JSON.stringify(toWire(value));
}
