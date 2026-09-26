/**
 * The command line's own behaviour: what it refuses before it ever opens a socket.
 *
 * These are the failures that would otherwise be discovered by a person at 2am with a
 * production credential in their shell history — a mistyped flag quietly ignored, a bearer
 * secret sent in plain text to a host that is not this machine, an export file whose shape
 * changed under a verifier that then reports "no breaks" for an empty chain.
 */

import { GENESIS, eventHash, verifyEventLog, type EventLogEntry } from '@ari/audit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commaList, parseArgs, text, UsageError } from '../src/args.js';
import { commands } from '../src/commands.js';
import { Api } from '../src/http.js';
import { run } from '../src/index.js';
import { parseExport, verifyExport } from "../src/verify.js";

/** Drives the real entry point, with both streams captured instead of printed. */
async function cli(argv: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const result = await run([...argv], (line) => out.push(line), (line) => err.push(line));
  return { ...result, out, err };
}

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

  it('declares a content type only when it has a body to declare it about', async () => {
    // `agent revoke` is a POST with nothing to send, and the client used to claim
    // `content-type: application/json` while sending zero bytes. Fastify then refused the
    // request in its body parser — before authentication, before the scope check, before the
    // route had seen anything — and the command could not run at all. `app.inject()` never
    // reproduced that, because inject does not apply the framework's own default.
    const seen: { headers?: Record<string, string> }[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: unknown) => {
      seen.push((init ?? {}) as { headers?: Record<string, string> });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    try {
      const api = new Api('http://127.0.0.1:4000', 'ucrd_token-never-echoed');
      await api.call({ method: 'POST', path: '/v1/agents/agt_1/revoke' });
      await api.call({ method: 'POST', path: '/v1/agents', body: { name: 'payer' } });

      expect(seen[0]?.headers?.['content-type']).toBeUndefined();
      expect(seen[1]?.headers?.['content-type']).toBe('application/json');
      // Both still carry the credential — the guard is about the body, not the auth.
      expect(seen[0]?.headers?.authorization).toBe('Bearer ucrd_token-never-echoed');
    } finally {
      globalThis.fetch = previous;
    }
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

  it('walks forward from an anchor that is not genesis, which is what a tail needs', () => {
    // The window case: events 4-6 of a longer chain. From genesis they are three broken
    // links; from the head of event 3 they are three good ones. Same rows, same function —
    // the difference is whether the reader knows where it started, which is why `--from`
    // without `--head` is refused below rather than assumed.
    const entries = chain(6);
    const window = entries.slice(3);
    const fromGenesis = verifyExport(parseExport(exportOf(window)));
    expect(fromGenesis.breaks.map((b) => b.kind)).toContain('LINK');

    const anchor = entries[2]?.storedHash ?? '';
    const report = verifyEventLog(window, anchor);
    expect(report.ok).toBe(true);
    expect(report.breaks).toEqual([]);
    expect(report.head).toBe(entries.at(-1)?.storedHash);
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

// ---------------------------------------------------------------------------
// The command line itself: which flags it reads, which files it needs no server
// to look at, and what it refuses before it opens a socket.
// ---------------------------------------------------------------------------

/** A page of the shape `GET /v1/audit/events?after=…` answers with — no `head`, by design. */
function pageOf(entries: readonly EventLogEntry[]): Record<string, unknown> {
  return {
    organizationId: 'org_test',
    readAt: new Date().toISOString(),
    events: entries,
    nextCursor: entries.at(-1)?.seq ?? '0',
  };
}

function serveFetch(...pages: readonly Record<string, unknown>[]): {
  readonly urls: readonly string[];
  readonly restore: () => void;
} {
  const previous = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const body = pages[Math.min(urls.length - 1, pages.length - 1)] as object;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = previous; } };
}

const TAIL_URL = ['--url', 'http://127.0.0.1:4000'];

describe('ari audit tail', () => {
  it('verifies every link it is given and reports the head to write down', async () => {
    const entries = chain(4);
    const served = serveFetch(pageOf(entries));
    try {
      const result = await cli(['audit', 'tail', ...TAIL_URL, '--once']);
      expect(result.exit).toBe(0);
      const report = JSON.parse(result.out[0] ?? '{}') as Record<string, unknown>;
      expect(report.ok).toBe(true);
      expect(report.verified).toBe(4);
      expect(report.head).toBe(entries.at(-1)?.storedHash);
      // The event lines are a projection: a tail that echoed `storedHash` and `prev` for
      // every row would be inviting a reader to eyeball the hashes instead of the decisions.
      expect(JSON.stringify(report.events)).not.toContain('storedHash');
    } finally {
      served.restore();
    }
  });

  it('carries the anchor across polls, so page two starts where page one ended', async () => {
    const entries = chain(5);
    const served = serveFetch(
      { ...pageOf(entries.slice(0, 2)), nextCursor: '2' },
      { ...pageOf(entries.slice(2)), nextCursor: '5' },
      // The third page is empty, which is what ends the run. Two pages would make the fake
      // repeat its last answer forever, and a test that passes against a server stuck on one
      // response is testing the stub.
      pageOf([]),
    );
    try {
      const result = await cli(['audit', 'tail', ...TAIL_URL, '--interval-ms', '1', '--limit', '3']);
      // No `--once`: two pages, then an empty third that ends the run. That is the loop's
      // own exit condition, and the test is the only place it is asserted.
      expect(served.urls).toHaveLength(3);
      expect(served.urls[1]).toContain('after=2');
      expect(result.exit).toBe(0);
      const last = JSON.parse(result.out.at(-1) ?? '{}') as Record<string, unknown>;
      expect(last.verified).toBe(5);
      expect(last.head).toBe(entries.at(-1)?.storedHash);
    } finally {
      served.restore();
    }
  });

  it('stops rather than continues when a link does not hold', async () => {
    const entries = chain(4);
    const broken = entries.map((entry) => (entry.seq === '3' ? { ...entry, prev: 'not-the-head' } : entry));
    const served = serveFetch(pageOf(broken));
    try {
      const result = await cli(['audit', 'tail', ...TAIL_URL, '--once']);
      expect(result.exit).toBe(1);
      const report = JSON.parse(result.out[0] ?? '{}') as { ok: boolean; breaks: { seq: string; kind: string }[] };
      expect(report.ok).toBe(false);
      expect(report.breaks).toContainEqual({ seq: '3', kind: 'LINK' });
      // Exit 1 with the break list, and not exit 0: a tail that followed a forged chain
      // happily to the end would be the one tool in this repository that a tampered audit
      // trail passes.
    } finally {
      served.restore();
    }
  });

  it('refuses a window with no anchor, because it would prove nothing', async () => {
    const served = serveFetch(pageOf(chain(2)));
    try {
      const result = await cli(['audit', 'tail', ...TAIL_URL, '--once', '--from', '5']);
      expect(result.exit).toBe(2);
      expect(result.err.join('\n')).toMatch(/--from needs --head/);
      // Refused before the request: the point is that there is no honest version of this
      // call, not that the answer is unreliable.
      expect(served.urls).toHaveLength(0);
    } finally {
      served.restore();
    }
  });

  it('refuses a row it does not recognise rather than verifying zero events', async () => {
    // An empty array verifies — every walk over no rows returns "ok, genesis". So a server
    // that renamed one column would otherwise turn this command into a tool that reports
    // "no breaks" about rows it silently dropped.
    const served = serveFetch({ organizationId: 'o', readAt: 'x', events: [{ seq: 1, type: 'agent.created' }], nextCursor: '1' });
    try {
      const result = await cli(['audit', 'tail', ...TAIL_URL, '--once']);
      expect(result.exit).toBe(1);
      expect(result.err.join('\n')).toMatch(/not a row this tool knows/);
    } finally {
      served.restore();
    }
  });

  it('refuses a count that is not a count', async () => {
    const served = serveFetch(pageOf(chain(1)));
    try {
      expect((await cli(['audit', 'tail', ...TAIL_URL, '--once', '--limit', '0'])).exit).toBe(2);
      expect((await cli(['audit', 'tail', ...TAIL_URL, '--once', '--limit', 'fast'])).exit).toBe(2);
      expect(served.urls).toHaveLength(0);
    } finally {
      served.restore();
    }
  });
});

describe('flags a command never reads', () => {
  it('refuses one on every command, before anything runs', async () => {
    // `args.ts` claimed this from its first draft and nothing enforced it, which is the
    // shape of every "validated on both sides" comment in this repository: the claim was
    // true of the *parser's* values and false of the tool's behaviour.
    const served = serveFetch({ code: 'UNAUTHENTICATED', detail: 'never reached' });
    try {
      for (const name of Object.keys(commands)) {
        const result = await cli([...name.split(' '), '--zzz-not-a-flag']);
        expect(result.exit, `ari ${name}`).toBe(2);
        expect(result.err.join(' ')).toContain('--zzz-not-a-flag');
      }
      expect(served.urls).toHaveLength(0);
    } finally {
      served.restore();
    }
  });
});

describe('the policy corpus', () => {
  interface CorpusCase {
    readonly name: string;
    readonly expect: 'accept' | 'refuse';
    readonly stage?: 'SCHEMA' | 'COMPILE';
    readonly field?: string;
    readonly reason?: string;
    readonly reasonAlone?: boolean;
    readonly set?: Record<string, unknown>;
    readonly remove?: string[];
    readonly wrap?: boolean;
    readonly expectPermits?: Record<string, unknown>;
    readonly expectEscalates?: readonly string[];
    readonly expectName?: string;
  }

  const corpus = JSON.parse(
    readFileSync(new URL('./fixtures/policy-corpus.json', import.meta.url), 'utf8'),
  ) as { baseline: Record<string, unknown>; cases: CorpusCase[] };

  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ari-policy-corpus-'));
  });

  afterAll(() => {
    if (dir.length > 0) rmSync(dir, { recursive: true, force: true });
  });

  function documentFor(testCase: CorpusCase): Record<string, unknown> {
    const document = structuredClone(corpus.baseline);
    const at = (path: string): Record<string, unknown> => {
      let node: Record<string, unknown> = document;
      for (const part of path.split('.').slice(0, -1)) node = node[part] as Record<string, unknown>;
      return node;
    };
    for (const [path, value] of Object.entries(testCase.set ?? {})) {
      at(path)[path.split('.').at(-1) as string] = structuredClone(value);
    }
    for (const path of testCase.remove ?? []) {
      delete at(path)[path.split('.').at(-1) as string];
    }
    return testCase.wrap === true ? { name: 'wrapped-in-a-file', document } : document;
  }

  it('every case chose one of the two assertions it can make', () => {
    // A meta-check, and the reason it exists: `reason` is asserted only where this
    // repository wrote the sentence. Where the wording belongs to zod the case says
    // `reasonAlone` and pins the field instead. A case with neither would pass on any
    // refusal at all — which is how a corpus quietly stops testing anything.
    for (const testCase of corpus.cases) {
      if (testCase.expect !== 'refuse') continue;
      expect(testCase.field, testCase.name).toBeTruthy();
      expect(testCase.reason !== undefined || testCase.reasonAlone === true, testCase.name).toBe(true);
      expect(testCase.reason === undefined || testCase.reasonAlone !== true, testCase.name).toBe(true);
    }
  });

  for (const testCase of corpus.cases) {
    it(`${testCase.name}: ${testCase.expect === 'accept' ? 'validates' : `refused at ${testCase.field}`}`, async () => {
      const path = join(dir, `${testCase.name}.json`);
      writeFileSync(path, `${JSON.stringify(documentFor(testCase), null, 2)}\n`, 'utf8');
      const result = await cli(['policy', 'validate', '--file', path]);
      const report = JSON.parse(result.out[0] ?? '{}') as {
        ok: boolean;
        name: string;
        refusals: { stage: string; field: string; message: string }[];
        permits: Record<string, unknown> | null;
        escalatesWhen: string[];
        notChecked: string[];
      };

      if (testCase.expect === 'accept') {
        // Exit 2 would mean the *invocation* was wrong, which is a bug in this test.
        expect(result.exit, `${testCase.name} should validate`).toBe(0);
        expect(report.ok).toBe(true);
        expect(report.refusals).toEqual([]);
        if (testCase.expectPermits !== undefined) {
          for (const [field, value] of Object.entries(testCase.expectPermits)) {
            expect(report.permits, `${testCase.name}.${field}`).toMatchObject({ [field]: value });
          }
        }
        if (testCase.expectEscalates !== undefined) expect(report.escalatesWhen).toEqual([...testCase.expectEscalates]);
        if (testCase.expectName !== undefined) expect(report.name).toBe(testCase.expectName);
        return;
      }

      expect(result.exit, `${testCase.name} should be refused`).toBe(1);
      const refusal = report.refusals.find((r) => r.field === testCase.field);
      expect(refusal, `${testCase.name}: expected a refusal naming ${testCase.field}, got ${JSON.stringify(report.refusals)}`).toBeTruthy();
      expect(refusal?.stage).toBe(testCase.stage);
      // The message is a prefix-match, not an equality: these are zod's sentences about a
      // field and they are allowed to be reworded. The *field* is the assertion.
      if (testCase.reason !== undefined) expect(refusal?.message).toContain(testCase.reason);
    });
  }

  it('needs no deployment to point at, and ignores one that is set', async () => {
    // The claim in `commands.ts` is that a local command is given no client at all. Stale
    // `ARI_URL`/`ARI_TOKEN` in an operator's environment must not be able to make
    // `policy validate` reach out — or send a bearer secret to a host they forgot about.
    const previousUrl = process.env.ARI_URL;
    const previousToken = process.env.ARI_TOKEN;
    process.env.ARI_URL = 'http://127.0.0.1:1';
    process.env.ARI_TOKEN = 'ucrd_this_should_never_leave_the_process';
    try {
      const good = join(dir, 'local-baseline.json');
      writeFileSync(good, `${JSON.stringify(corpus.baseline)}\n`, 'utf8');
      const accepted = await cli(['policy', 'validate', '--file', good]);
      expect(accepted.exit).toBe(0);

      const broken = join(dir, 'local-broken.json');
      const bad = structuredClone(corpus.baseline);
      // `limits` at the root, not inside `permissions`: the first draft of this line wrote
      // `bad.permissions.limits`, which the strict schema refused as an *unrecognised key*
      // and left the real omission untested. A case that passes for the wrong reason is
      // worse than one that fails.
      bad.limits = { maxUsdEstimateAgeSeconds: 300 };
      writeFileSync(broken, `${JSON.stringify(bad)}\n`, 'utf8');
      const refused = await cli(['policy', 'validate', '--file', broken]);
      expect(refused.exit).toBe(1);
      expect(refused.out[0]).toContain('maxDeadlineSkewSeconds');
    } finally {
      if (previousUrl === undefined) delete process.env.ARI_URL;
      else process.env.ARI_URL = previousUrl;
      if (previousToken === undefined) delete process.env.ARI_TOKEN;
      else process.env.ARI_TOKEN = previousToken;
    }
  });

  it('refuses a file that cannot be read, rather than validating nothing', async () => {
    const result = await cli(['policy', 'validate', '--file', join(dir, 'not-here.json')]);
    expect(result.exit).toBe(2);
    expect(result.err.join(' ')).toMatch(/could not be read/);
  });
});
