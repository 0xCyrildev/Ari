/**
 * The command line's own behaviour: what it refuses before it ever opens a socket.
 *
 * These are the failures that would otherwise be discovered by a person at 2am with a
 * production credential in their shell history — a mistyped flag quietly ignored, a bearer
 * secret sent in plain text to a host that is not this machine, an export file whose shape
 * changed under a verifier that then reports "no breaks" for an empty chain.
 */

import { GENESIS, eventHash, type EventLogEntry } from '@ari/audit';
import { describe, expect, it } from 'vitest';
import { commaList, parseArgs, text, UsageError } from '../src/args.js';
import { Api } from '../src/http.js';
import { parseExport, verifyExport } from "../src/verify.js";

describe('argument parsing', () => {
  it('keeps a command of two words and its flags apart', () => {
    const parsed = parseArgs(['approvals', 'decide', '--id', 'apr_1', '--decision', 'APPROVED']);
    expect(parsed.command).toEqual(['approvals', 'decide']);
    expect(parsed.flags.id).toBe('apr_1');
    expect(parsed.flags.decision).toBe('APPROVED');
  });

  it('treats a flag with no value as a flag, not as the next value', () => {
    const parsed = parseArgs(['policy', 'apply', '--activate', '--file', 'p.json']);
    expect(parsed.flags.activate).toBe(true);
    expect(parsed.flags.file).toBe('p.json');
  });

  it('refuses a missing value rather than defaulting it', () => {
    const { flags } = parseArgs(['approvals', 'decide', '--decision']);
    expect(() => text(flags, 'decision')).toThrow(UsageError);
    expect(() => text(flags, 'decision')).toThrow(/--decision is required/);
  });

  it('splits a scope list without inventing empty scopes', () => {
    const { flags } = parseArgs(['--scopes', 'approval:decide,,agent:manage , ']);
    expect(commaList(flags, 'scopes')).toEqual(['approval:decide', 'agent:manage']);
  });
});

describe('the deployment an operator may point at', () => {
  it('refuses to send a bearer secret over plain HTTP to anyone but localhost', () => {
    expect(() => new Api('http://ari.example.com')).toThrow('must be https:// or http://127.0.0.1');
    expect(() => new Api('http://127.0.0.1:4000')).not.toThrow();
    expect(() => new Api('https://ari.example.com/')).not.toThrow();
    // The trailing slash is trimmed, or every path becomes `//v1/agents`.
    expect(new Api('https://ari.example.com/').base).toBe('https://ari.example.com');
  });
});

/** One event, hashed the way `@ari/audit` hashes it, so the fixture cannot drift. */
function event(
  index: number,
  prev: string,
  overrides: Partial<{ actor: string; eventType: string; meta: Record<string, unknown> }> = {},
): EventLogEntry {
  const parts = {
    id: `aud_${index}`,
    org: 'org_test',
    actor: overrides.actor ?? 'system',
    actorType: 'system',
    eventType: overrides.eventType ?? 'agent.created',
    resource: null,
    resourceId: null,
    request: null,
    correlation: null,
    policyVersion: null,
    decision: null,
    reasons: [],
    severity: 'info',
    meta: overrides.meta ?? {},
    prev,
  };
  return {
    ...parts,
    seq: String(index),
    madeAt: new Date(Date.UTC(2026, 8, 25, 12, 0, index)).toISOString(),
    storedHash: eventHash(parts),
  };
}

function chain(length: number): EventLogEntry[] {
  const entries: EventLogEntry[] = [];
  let prev = GENESIS;
  for (let index = 1; index <= length; index += 1) {
    const next = event(index, prev);
    entries.push(next);
    prev = next.storedHash;
  }
  return entries;
}

function exportOf(entries: readonly EventLogEntry[], head?: string) {
  return {
    organizationId: 'org_test',
    exportedAt: new Date().toISOString(),
    head: head ?? verifyExport(parseExport(entriesToExport(entries)), undefined).recomputedHead,
    events: entries,
  };
}

function entriesToExport(entries: readonly EventLogEntry[]) {
  return {
    organizationId: 'org_test',
    exportedAt: '2026-09-25T12:00:00.000Z',
    head: 'unset',
    events: entries,
  };
}

describe('the chain verifier', () => {
  it('accepts a chain that has not been touched', () => {
    const entries = chain(6);
    const file = exportOf(entries);
    const verdict = verifyExport(parseExport(file));
    expect(verdict.ok).toBe(true);
    expect(verdict.events).toBe(6);
    expect(verdict.breaks).toEqual([]);
    expect(verdict.recomputedHead).toBe(entries.at(-1)?.storedHash);
  });

  it('notices an edit to one event, without the file noticing itself', () => {
    // The point of the whole exercise: a row whose content and claimed hash have parted
    // company. The stored hash in the file still "looks" like a hash, and a verifier that
    // trusted it would agree with the forgery.
    const entries = chain(6);
    const tampered = entries.map((entry) =>
      entry.seq === '3' ? { ...entry, actor: 'someone-else', actorType: 'human' } : entry,
    );
    // The hash column is left exactly as it was, which is the whole point: the forger who
    // edits a row cannot recompute what it was hashed under without the pepper, and a file
    // whose content disagrees with its own claimed hash is what an edit looks like.
    const verdict = verifyExport(parseExport(exportOf(tampered, tampered.at(-1)?.storedHash)));
    expect(verdict.breaks.map((b) => b.kind)).toContain('HASH');
    expect(verdict.ok).toBe(false);
  });

  it('notices an event removed from the middle', () => {
    const entries = chain(6);
    const head = entries.at(-1)?.storedHash ?? '';
    const removed = entries.filter((entry) => entry.seq !== '3');
    const verdict = verifyExport(parseExport({ ...exportOf(entries, head), events: removed }));
    expect(verdict.events).toBe(5);
    expect(verdict.breaks.map((b) => b.kind)).toContain('LINK');
  });

  it('separates a self-consistent file from a chain anchored elsewhere', () => {
    const entries = chain(4);
    const head = entries.at(-1)?.storedHash ?? '';
    // Somebody rebuilds a shorter chain correctly — every link holds — and hands it over as
    // "the history". Only a head held somewhere else can tell, which is why `--head` exists
    // and why a truncated chain reports as fewer events rather than as a break.
    const truncated = chain(3);
    const verdict = verifyExport(parseExport({ ...exportOf(truncated), head: truncated.at(-1)?.storedHash ?? '' }), head);
    expect(verdict.breaks).toEqual([]);
    expect(verdict.ok).toBe(false);
    expect(verdict.externalHeadMatches).toBe(false);
    expect(verdict.events).toBe(3);
  });

  it('refuses a file that is not an export, rather than verifying nothing', () => {
    expect(() => parseExport({ events: [] })).toThrow(/not an Ari audit export/);
    expect(() => parseExport({ organizationId: 'o', exportedAt: 'e', head: 'h', events: [], extra: 1 })).toThrow(
      /not an Ari audit export/,
    );
  });
});
