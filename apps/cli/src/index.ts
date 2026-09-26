/**
 * `ari` — the operator's and the approver's command line.
 *
 * Exported as a function rather than only as a `main.ts` side effect, so the contract
 * between this tool and the API can be tested against the real routes instead of against a
 * mock of itself. A CLI that has only ever been run by hand is a CLI whose every flag is a
 * claim.
 */

import { Api, Refusal } from './http.js';
import { UsageError, parseArgs, type Flags } from './args.js';
import { commands, usage } from './commands.js';

export interface RunResult {
  readonly exit: number;
  readonly printed: readonly string[];
}

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
      'the credential. ARI_TOKEN is the bearer secret of a human credential; the one',
      'command that does not use it is `init`, which takes --bootstrap instead.',
    ].join('\n');
    say(help);
    return { exit: command.length === 0 ? 2 : 0, printed: [] };
  }

  const found = commands[name];
  if (found === undefined) {
    say(`ari: unknown command "${name}". Try \`ari help\`.`);
    return { exit: 2, printed: [] };
  }

  const base = flag(flags, 'url', 'ARI_URL');
  if (base === undefined) {
    say('ari: --url is required (or set ARI_URL). This tool never guesses a deployment: a wrong one means a real payment asked of the wrong place.');
    return { exit: 2, printed: [] };
  }
  const token = flag(flags, 'token', 'ARI_TOKEN');
  const printed: string[] = [];
  const out = (value: unknown): void => {
    const line = JSON.stringify(value, null, 2);
    printed.push(line);
    write(line);
  };

  try {
    // A command's return value *is* its output. Several of them used to answer by returning
    // and never printing, which is how `ari agent create` could exit 0 and leave the operator
    // with no agent id to use for the next command — a tool that cannot be read is a tool that
    // cannot be scripted, and a command that already printed for itself returns undefined
    // rather than being printed twice.
    const result = await found.run({ api: new Api(base, token), flags, out, err: errorWrite });
    if (result !== undefined) out(result);
    return { exit: 0, printed };
  } catch (error) {
    if (error instanceof UsageError) {
      say(`ari: ${error.message}`);
      return { exit: 2, printed };
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
