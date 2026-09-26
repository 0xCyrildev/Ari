/**
 * No value ever reaches a SQL string by interpolation (T8).
 *
 * The mitigation the threat model names is "parameterised queries everywhere, no
 * string SQL on any auth path", and that is the kind of claim a codebase drifts out
 * of one query at a time, because nothing fails when someone writes
 * `WHERE id = '${id}'` — it works, right up until it doesn't.
 *
 * So this is a lint shaped like a test. It reads the shipped source, finds SQL
 * literals, and refuses any interpolation that is not an upper-case module constant.
 * Identifiers (`ari.limit_counters`) have to be written into a query — placeholders
 * cannot stand in for a table name — so they are permitted, but only from a name the
 * reader can see is fixed at the top of the file. Anything else is a value, and a
 * value has exactly one correct place to go: the parameters array.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TARGETS = [...sourcesUnder('packages'), ...sourcesUnder('apps')];

function sourcesUnder(directory: string): string[] {
  const base = `${ROOT}${directory}`;
  const found: string[] = [];
  for (const entry of readdirSync(base)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'test') continue;
    const full = `${base}/${entry}`;
    if (statSync(full).isDirectory()) found.push(...sourcesUnder(`${directory}/${entry}`));
    else if (full.endsWith('.ts')) found.push(full);
  }
  return found;
}

const SQL_KEYWORD = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE|ALTER|GRANT|REVOKE)\b/;
/** `${SOMETHING_UPPERCASE}` — a module constant, not a caller's string. */
const SAFE_INTERPOLATION = /^\$\{[A-Z][A-Z0-9_]*\}$/;

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function offencesIn(file: string): Offence[] {
  const text = readFileSync(file, 'utf8');
  const found: Offence[] = [];
  // Backtick-delimited literals, one template expression at a time.
  const literal = /`(?:[^`\\]|\\.)*`/g;
  for (const match of text.matchAll(literal)) {
    const body = match[0];
    if (!SQL_KEYWORD.test(body)) continue;
    for (const interpolation of body.matchAll(/\$\{[^}]*\}/g)) {
      if (SAFE_INTERPOLATION.test(interpolation[0])) continue;
      const line = text.slice(0, match.index).split('\n').length;
      found.push({ file: file.replace(ROOT, ''), line, text: interpolation[0] });
    }
  }
  return found;
}

describe('SQL hygiene', () => {
  it('finds source to check', () => {
    // A guard that silently matches no files is worse than no guard: it reports
    // success while the codebase drifts.
    expect(TARGETS.length).toBeGreaterThan(10);
  });

  it('interpolates only upper-case module constants into SQL', () => {
    const offences = TARGETS.flatMap(offencesIn);
    expect(
      offences.map((offence) => `${offence.file}:${offence.line} ${offence.text}`),
    ).toEqual([]);
  });

  it('would catch the thing it exists to catch', () => {
    // Self-test. Without this, a bug in the scanner looks identical to clean code.
    const bad = 'await client.query(`SELECT id FROM ari.users WHERE email = ${email}`);';
    const sql = /`(?:[^`\\]|\\.)*`/g.exec(bad);
    expect(sql?.[0]).toBeDefined();
    const interpolation = /\$\{[^}]*\}/.exec(sql?.[0] ?? '');
    expect(interpolation?.[0]).toBeDefined();
    expect(SAFE_INTERPOLATION.test(interpolation?.[0] ?? '')).toBe(false);
  });
});
