/**
 * The signup retry, on its own.
 *
 * The behaviour it exists for was measured, not imagined, and the measurement is what shaped it:
 * against this project's own waitlist database, the first request after the hosted compute had
 * scaled to zero failed, an **immediate** retry failed the same way inside 4.7 s, and a request a
 * few seconds later succeeded. A retry that does not wait is a second attempt at the thing that
 * was never the problem.
 *
 * So the properties worth pinning are the pause, the ceiling, and what is allowed into a log line.
 * The last one is why the helper takes a `describe` function rather than logging the error.
 */

import { describe, expect, it } from 'vitest';
import { retryWithinBudget, safeErrorSummary } from '../../apps/web/lib/db/retry.js';

const describeCode = (error: unknown): string => {
  const described = error as { code?: string; syscall?: string };
  return `code=${described.code ?? '-'} syscall=${described.syscall ?? '-'}`;
};

/** A clock and a sleeper that report rather than wait, so the budget is observable in milliseconds. */
const fakeWorld = () => {
  let clock = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => clock,
    sleep: async (ms: number) => { slept.push(ms); clock += ms },
  };
};

describe('the signup retry', () => {
  it('answers from the first attempt when nothing fails, without waiting or writing anything', async () => {
    let calls = 0;
    const logged: string[] = [];
    const world = fakeWorld();
    const result = await retryWithinBudget(async () => { calls += 1; return 'ok' }, describeCode, { ...world, log: (line) => logged.push(line) });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(world.slept).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('waits before the second attempt, because a retry against a waking database must not be instant', async () => {
    const world = fakeWorld();
    let calls = 0;
    const result = await retryWithinBudget(async () => {
      calls += 1;
      if (calls < 2) throw Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'ETIMEDOUT' });
      return 'filed';
    }, describeCode, { ...world, log: () => {} });
    expect(result).toBe('filed');
    expect(calls).toBe(2);
    // The assertion that the old version of this helper would have failed: there has to be a
    // pause, and it has to be long enough for a compute to wake.
    expect(world.slept).toEqual([1_500]);
  });

  it('grows the pause and stops at the attempt ceiling rather than looping forever', async () => {
    const world = fakeWorld();
    let calls = 0;
    await expect(retryWithinBudget(async () => {
      calls += 1;
      throw Object.assign(new Error('connection terminated'), { code: '57P01' });
    }, describeCode, { ...world, log: () => {} })).rejects.toThrow('connection terminated');
    expect(calls).toBe(4);
    expect(world.slept).toEqual([1_500, 3_000, 6_000]);
  });

  it('refuses to start an attempt that cannot finish inside the deadline', async () => {
    const world = fakeWorld();
    let calls = 0;
    await expect(retryWithinBudget(async () => {
      calls += 1;
      // Each attempt burns eleven seconds of a twelve-second budget.
      throw Object.assign(new Error('slow failure'), { code: 'ETIMEDOUT' });
    }, describeCode, { ...world, now: () => calls * 11_000, log: () => {} })).rejects.toThrow('slow failure');
    // One attempt, because the next pause would already be past the deadline: a database that is
    // not waking has to produce a readable refusal, not a request the platform kills.
    expect(calls).toBe(1);
    expect(world.slept).toEqual([]);
  });

  it('names the failure without naming the address', async () => {
    const logged: string[] = [];
    const secret = 'a.person@their-own-domain.example';
    const world = fakeWorld();
    await expect(retryWithinBudget(async () => {
      throw Object.assign(new Error(`insert into "waitlist_signups" values (${secret}) failed`), { code: 'ETIMEDOUT', syscall: 'read' });
    }, describeCode, { ...world, log: (line) => logged.push(line) })).rejects.toThrow();
    expect(logged.length).toBeGreaterThan(0);
    const all = logged.join('');
    expect(all).toContain('code=ETIMEDOUT');
    expect(all).not.toContain(secret);
    expect(all).not.toContain('waitlist_signups');
    // The control that keeps this from passing by accident: the syscall is in there, so the
    // absence above is the field list being narrow, not the logger being silent.
    expect(all).toContain('syscall=read');
  });
});

describe('the error summary a signup logs', () => {
  it('carries the message, because a line that says only "Error" diagnoses nothing', () => {
    // This is the shape the real cold start produced: no pg code, no syscall, just a message. The
    // first version of this helper logged `name=Error` and was useless at 3 a.m.
    const error = Object.assign(new Error('connection terminated unexpectedly'), {});
    expect(safeErrorSummary(error)).toContain('connection terminated unexpectedly');
  });

  it('redacts anything address-shaped inside it', () => {
    const error = new Error('duplicate key value `a.person@their-own-domain.example` violates the unique rule');
    const summary = safeErrorSummary(error);
    expect(summary).not.toContain('a.person@their-own-domain.example');
    expect(summary).not.toContain('their-own-domain');
    expect(summary).toContain('[address redacted]');
    // The rest of the sentence survives, which is what makes the line worth writing.
    expect(summary).toContain('duplicate key value');
    expect(summary).toContain('violates the unique rule');
  });

  it('truncates, so a driver that echoes a whole statement cannot fill a log', () => {
    const summary = safeErrorSummary(new Error(`x`.repeat(400)), 40);
    const message = summary.slice(summary.indexOf('message=') + 'message='.length);
    expect(message.length).toBeLessThanOrEqual(40 + '[address redacted]'.length);
  });

  it('answers something for the things that are not errors at all', () => {
    for (const notAnError of [null, undefined, {}, 'a string']) {
      expect(safeErrorSummary(notAnError)).toContain('code=-');
    }
  });
});
