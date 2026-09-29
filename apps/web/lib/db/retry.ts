/**
 * The retry policy, alone in a file so it can be tested without a database.
 *
 * `lib/db/tls.ts` is the precedent: a rule this small does not need a pool to be checked, and
 * importing the module that builds one would make the test depend on everything the test is not
 * about.
 */

export interface RetryBudget {
  /** How many times to try in total, including the first. */
  readonly attempts?: number;
  /** Pause before the second attempt; each later pause is `growth` times the one before it. */
  readonly firstDelayMs?: number;
  readonly growth?: number;
  /** Stop rather than start another attempt that could not finish inside this. */
  readonly deadlineMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) });

/** Anything shaped like an email address, which is never allowed into a log line. */
const ADDRESS = /[^\s@,;'"<>]+@[^\s@,;'"<>]+/g;

/**
 * What a failed signup actually looked like, minus anything that could identify who tried.
 *
 * The structural fields alone were not enough: measured against a waking Neon endpoint the failure
 * carried no `code` and no `syscall`, so the line this wrote was `name=Error` — true, and useless
 * to whoever has to decide whether the database is down or merely slow. The message is the part
 * that says, and it is also the part that can carry a query fragment.
 *
 * So the message is truncated and every address-shaped run inside it is replaced before it
 * reaches the line. Bound parameters travel separately from the SQL text in this driver, so an
 * email should not be in there at all — that is a reason to expect it, not a reason to rely on it.
 */
export function safeErrorSummary(error: unknown, limit = 160): string {
  const described = (error ?? {}) as { code?: string; name?: string; syscall?: string; message?: string };
  const message = typeof described.message === 'string'
    ? described.message.slice(0, limit).replace(ADDRESS, '[address redacted]')
    : '-';
  return `code=${described.code ?? '-'} name=${described.name ?? '-'} syscall=${described.syscall ?? '-'} message=${message}`;
}

/**
 * Run an idempotent write again and again until it works or the budget says stop.
 *
 * The pause is the whole point, and it is what a measured failure taught: retrying immediately
 * against a database that is waking up fails the same way two seconds later, because the thing
 * that was missing was time, not another attempt. The first attempt and its instant retry both
 * failed inside 4.7 s; a request a few seconds after that succeeded.
 *
 * The deadline exists because the opposite failure mode is worse. A hosted endpoint that is not
 * waking at all must produce a refusal a visitor can read, not a request that hangs until the
 * platform kills it — and a retry that cannot give up turns a database outage into every form on
 * the page timing out together.
 */
export async function retryWithinBudget<T>(
  attempt: () => Promise<T>,
  describe: (error: unknown) => string,
  budget: RetryBudget = {},
): Promise<T> {
  const attempts = budget.attempts ?? 4;
  const firstDelayMs = budget.firstDelayMs ?? 1_500;
  const growth = budget.growth ?? 2;
  const deadlineMs = budget.deadlineMs ?? 12_000;
  const sleep = budget.sleep ?? wait;
  const now = budget.now ?? Date.now;
  const log = budget.log ?? ((line: string) => process.stderr.write(line));
  const startedAt = now();

  let tries = 0;
  let lastError: unknown = null;
  for (let tryNumber = 1; tryNumber <= attempts; tryNumber += 1) {
    tries = tryNumber;
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const delay = firstDelayMs * growth ** (tryNumber - 1);
      if (tryNumber === attempts || now() - startedAt + delay > deadlineMs) break;
      log(`attempt ${String(tryNumber)} of up to ${String(attempts)} failed (${describe(error)}); waiting ${String(delay)}ms\n`);
      await sleep(delay);
    }
  }
  log(`waitlist: giving up after ${String(tries)} attempt(s) in ${String(now() - startedAt)}ms\n`);
  throw lastError;
}
