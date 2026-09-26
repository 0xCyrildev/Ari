/**
 * Argument parsing, with the two failure modes this kind of tool usually gets wrong.
 *
 * First, an unknown flag is an error rather than something to ignore — which is a claim
 * about `unknownFlags` below being *called*, and `index.ts` calls it for every command,
 * against that command's own declared list. Second, a value a command cannot proceed
 * without is not defaulted: `text()` refuses and names the flag. What *is* defaulted here
 * is bounded counts (`--interval-ms`), where an omitted value has one obvious meaning and a
 * mistyped one has none.
 */

export class UsageError extends Error {}

export type Flags = Record<string, string | boolean>;

export interface Parsed {
  readonly command: readonly string[];
  readonly flags: Flags;
}

export function parseArgs(argv: readonly string[]): Parsed {
  const command: string[] = [];
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('--')) {
      command.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
      continue;
    }
    flags[name] = next;
    index += 1;
  }
  return { command, flags };
}

export function text(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}

/** Optional, but only in the sense that a caller may leave it out — never truncated. */
export function optional(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Optional, but a value present and empty is a mistake, not an absence. */
export function optionalCommaList(flags: Flags, name: string): string[] | undefined {
  const value = optional(flags, name);
  if (value === undefined) return undefined;
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new UsageError(`--${name} was given with no values in it`);
  return entries;
}

export function commaList(flags: Flags, name: string): string[] {
  return text(flags, name)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function isBooleanFlag(flags: Flags, name: string): boolean {
  return flags[name] === true;
}

/**
 * A bounded integer with a default, and no silent coercion.
 *
 * `--interval-ms fast` and `--limit -1` are refusals rather than `NaN` and `-1` reaching
 * the poll loop, because a loop that sleeps for `NaN` milliseconds spins, and a spin loop
 * pointed at a production API is a self-inflicted denial of service with a friendly flag
 * name on it.
 */
export function count(flags: Flags, name: string, fallback: number, max: number): number {
  const value = optional(flags, name);
  if (value === undefined) return fallback;
  if (!/^\d{1,9}$/.test(value)) {
    throw new UsageError(`--${name} must be a whole number between 1 and ${max}`);
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > max) {
    throw new UsageError(`--${name} must be between 1 and ${max}, got ${value}`);
  }
  return parsed;
}

/**
 * The flags a caller passed that this command never reads.
 *
 * `args.ts` has claimed since its first draft that "an unknown flag is an error rather than
 * something to ignore", and until this function existed the claim was false: every flag
 * went into one bag, and a command read the keys it wanted. `--desicion APPROVED` was
 * therefore *absent* rather than *wrong*, and the operator saw a refusal about a missing
 * `--decision` while the typo stayed in their history for next time.
 */
export function unknownFlags(flags: Flags, allowed: readonly string[]): string[] {
  return Object.keys(flags).filter((name) => !allowed.includes(name));
}
