/**
 * One line of JSON per event, on stdout, from a process that has no framework to do it
 * for it.
 *
 * `ari-api` gets this from Fastify's own pino. `ari-signer` is a `node:http` server with
 * three log statements in it, and adding a logger dependency to a signing process to
 * match formats is a larger supply-chain decision than twenty lines that cannot fail.
 *
 * Everything goes to stdout, including errors, because that is what pino does: a drain
 * that reads one stream gets both services in one order, and a `console.error` left
 * behind would arrive out of sequence with the request it describes.
 */

/**
 * The same seven words `ari-api` accepts, and that is the whole reason they are copied
 * rather than invented: one `LOG_LEVEL` in a deployment's environment has to mean one thing
 * to both processes. A vocabulary that only one of the two understands is the drift this
 * repository keeps having to write tests against.
 */
const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type SignerLogLevel = (typeof LEVELS)[number];

const RANK: Record<SignerLogLevel, number> = { fatal: -1, error: 0, warn: 1, info: 2, debug: 3, trace: 4, silent: 9 };

export type LogLevel = SignerLogLevel;

/** Anything unrecognised becomes `info`: a typo in a log level must not stop a signing process. */
export function logLevelOf(env: NodeJS.ProcessEnv): SignerLogLevel {
  // The shared `LOG_LEVEL` first, because `.env.example` has named it since before either
  // process read anything; `SIGNER_LOG_LEVEL` overrides it for the case where one of the two
  // needs to be louder than the other.
  const named = env.SIGNER_LOG_LEVEL ?? env.LOG_LEVEL ?? 'info';
  return (LEVELS as readonly string[]).includes(named) ? (named as SignerLogLevel) : 'info';
}

export interface SignerLog {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export const silentLog: SignerLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createSignerLog(level: SignerLogLevel, service = 'ari-signer'): SignerLog {
  const write = (name: SignerLogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void => {
    if (RANK[name] > RANK[level]) return;
    // `JSON.stringify` on a field this process did not construct can throw on a cycle, and
    // a signer that dies while reporting an error is worse than a signer that drops the
    // line. The fallback keeps the message and loses the shape.
    try {
      process.stdout.write(`${JSON.stringify({ level: name, time: new Date().toISOString(), service, message, ...fields })}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({ level: name, time: new Date().toISOString(), service, message })}\n`);
    }
  };
  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
