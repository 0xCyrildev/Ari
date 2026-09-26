/**
 * Argument parsing, with the two failure modes this kind of tool usually gets wrong.
 *
 * First, an unknown flag is an error rather than something to ignore: `ari approvals decide
 * --desicion APPROVED` that quietly does nothing is a person who believes they approved
 * something. Second, a missing value is not a default. Every value below is required by the
 * command that asks for it, and the refusal names the flag.
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
