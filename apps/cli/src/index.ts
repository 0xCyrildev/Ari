/**
 * `ari` — the operator's and the approver's command line.
 *
 * Exported as a function rather than only as a `main.ts` side effect, so the contract
 * between this tool and the API can be tested against the real routes instead of against a
 * mock of itself. A CLI that has only ever been run by hand is a CLI whose every flag is a
 * claim.
 */

import { Api, Refusal } from './http.js';
import { UsageError, unknownFlags, parseArgs, type Flags } from './args.js';
import { Invalid } from './errors.js';
import { commands, usage, type Base } from './commands.js';

export interface RunResult {
  readonly exit: number;
  readonly printed: readonly string[];
}

/** Read by every command, so they are never listed as `takes` and never refused. */
const GLOBAL_FLAGS = ['url', 'token', 'help'];

function flag(flags: Flags, name: string, fromEnv: string): string | undefined {
  const value = flags[name];
  if (typeof value === 'string' && value.length > 0) return value;
  const fromEnvironment = process.env[fromEnv];
  return fromEnvironment === undefined || fromEnvironment.length === 0 ? undefined : fromEnvironment;
}

export interface Writers {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * `write` is stdout — the result, as JSON, so the next command can read it. Everything that
 * is not a result (the delivery note carrying an approval seal) goes to `err`, which a test
 * can capture and a script can redirect without parsing two shapes out of one stream.
 */
export async function run(
  argv: readonly string[],
  write: (line: string) => void,
  errorWrite: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<RunResult> {
  const { command, flags } = parseArgs(argv);
  const name = command.join(' ');
  // Everything that is *not* a result goes to stderr, so `ari … | jq` is always reading
  // JSON. A tool that mixes prose into the stdout stream is a tool whose own output has to
  // be eyeballed by a person, and the reason this one exists is to be scripted.
  const say = (line: string): void => {
    errorWrite(line);
  };
  if (command.length === 0 || name === 'help' || flags.help === true) {
    const help = [
      'ari — permission infrastructure for autonomous money',
      '',
      'usage: ari <command> [--flag value …]',
      '',
      usage.join('\n'),
      '',
      '--url (default ARI_URL) and --token (default ARI_TOKEN) select the deployment and',
      'the credential. ARI_TOKEN is the bearer secret of a human credential; `init` is the',
      'route that takes --bootstrap instead, and the two commands marked [no server] take',
      'neither — they are given no client at all, so they cannot reach a deployment by',
      'accident and cannot be pointed at one by a stale ARI_URL in the environment.',
    ].join('\n');
    say(help);
    return { exit: command.length === 0 ? 2 : 0, printed: [] };
  }

  const found = commands[name];
  if (found === undefined) {
    say(`ari: unknown command "${name}". Try \`ari help\`.`);
    return { exit: 2, printed: [] };
  }

  // A flag this command never reads is refused before anything runs. `args.ts` has claimed
  // this since its first draft and nothing enforced it: the practical failure was that
  // `--desicion APPROVED` produced a refusal about a *missing* `--decision`, which is a true
  // statement about the wrong problem, and the typo went back into the shell history.
  const unexpected = unknownFlags(flags, [...GLOBAL_FLAGS, ...found.takes]);
  if (unexpected.length > 0) {
    say(
      `ari: ${unexpected.map((flagName) => `--${flagName}`).join(', ')} ${unexpected.length === 1 ? 'is' : 'are'} not a ` +
        `flag of \`ari ${name}\`. It takes: ${found.takes.length === 0 ? 'none' : found.takes.map((f) => `--${f}`).join(' ')}.`,
    );
    return { exit: 2, printed: [] };
  }

  const printed: string[] = [];
  const out = (value: unknown): void => {
    const line = JSON.stringify(value, null, 2);
    printed.push(line);
    write(line);
  };
  const context: Base = { flags, out, err: errorWrite };

  try {
    // A command's return value *is* its output. Several of them used to answer by returning
    // and never printing, which is how `ari agent create` could exit 0 and leave the operator
    // with no agent id to use for the next command — a tool that cannot be read is a tool that
    // cannot be scripted, and a command that already printed for itself returns undefined
    // rather than being printed twice.
    let result: unknown;
    if (found.local === true) {
      // A local command gets no `Api` at all, which is the enforcement rather than the
      // convention: it cannot be handed the deployment URL, and it cannot be handed the
      // bearer secret either. `verify chain` runs in a directory with no `.env` and no
      // network, and that is a property of the tool worth having in the type.
      result = await found.run(context);
    } else {
      const base = flag(flags, 'url', 'ARI_URL');
      if (base === undefined) {
        say('ari: --url is required (or set ARI_URL). This tool never guesses a deployment: a wrong one means a real payment asked of the wrong place.');
        return { exit: 2, printed };
      }
      const token = flag(flags, 'token', 'ARI_TOKEN');
      if (typeof flags.token === 'string' && flags.token.length > 0) {
        // The secret works from the flag, and this says once where it is visible: argv is
        // readable by any process on the machine, and a script launcher (`pnpm ari …`)
        // echoes the command line it is about to run before it runs it. `ARI_TOKEN` reaches
        // the same place without either.
        say('ari: --token is visible in the process list and in any launcher echo — prefer ARI_TOKEN for a secret that outlives this shell.');
      }
      result = await found.run({ ...context, api: new Api(base, token) });
    }
    if (result !== undefined) out(result);
    return { exit: 0, printed };
  } catch (error) {
    if (error instanceof UsageError) {
      say(`ari: ${error.message}`);
      return { exit: 2, printed };
    }
    if (error instanceof Invalid) {
      // The verdict has already been printed by the command that made it. This line is the
      // human-sized summary, and the exit code is the machine-sized one.
      say(`ari: refused (${error.code}): ${error.message}`);
      return { exit: 1, printed };
    }
    if (error instanceof Refusal) {
      // The server's own code, and its own sentence. A refusal is a decision Ari made, and
      // the operator needs to see which one — not a stack trace about a payment that was
      // correctly not made.
      say(`refused (${error.status} ${error.code}): ${error.message}`);
      return { exit: 1, printed };
    }
    say(`ari: ${(error as Error).message}`);
    return { exit: 1, printed };
  }
}
