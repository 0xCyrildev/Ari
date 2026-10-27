/**
 * Agreement and throughput: does `ari-kdf` and `@node-rs/argon2` mean the same thing, and how many
 * derivations per second does each do on this box?
 *
 * Run it after `cargo build --release` in `rust/`:
 *
 *   node --import tsx rust/agreement.mts
 *
 * Why the shape of the check: these are two independent implementations of one primitive, written by
 * different people against the same RFC. The strong claim is not "both produce a 32-byte tag" — it is
 * that each verifies the other's output, which fails if either disagrees about the version marker, the
 * parameter encoding, the salt handling, or the tag length. A byte-for-byte equality test on the hash
 * alone would pass for two implementations that both wrote a wrong value; cross-verification cannot.
 *
 * What is NOT claimed here: that the Rust worker is wired into the credential gate. `packages/identity`
 * still calls `@node-rs/argon2` directly. This file establishes that a swap would be sound; the swap
 * itself needs the deployment to decide its cost parameters, which is the point the current code leaves
 * to a library default.
 */

import { hash, verify } from '@node-rs/argon2';
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const BIN = new URL('./target/release/ari-kdf', import.meta.url).pathname;
const SECRETS = ['crd_0123456789abcdef0123456789abcdef', 'ucrd_fedcba9876543210fedcba9876543210', 'a-third-secret-value-0000000000000000'];

let failures = 0;
/**
 * Synchronous writes, deliberately: this harness gets killed by a timeout when the worker misbehaves,
 * and Node buffers a piped stdout — so `console.log` loses every line it printed when SIGTERM lands.
 * That turned a partial failure into an empty log and sent me debugging the wrong thing.
 */
const emit = (text: string): void => {
  writeSync(1, `${text}\n`);
};

const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures += 1;
  emit(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

function startWorker(args: string[]): {
  ask: (line: string) => Promise<string>;
  close: () => Promise<void>;
} {
  const child = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<string, (line: string) => void>();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      // Recomputing the newline position inside the loop is the whole bug this line replaces: the first
      // version hoisted it, so after one line the condition stayed true forever, the loop consumed an
      // empty buffer forever, and the harness looked exactly like a worker that never answered.
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      // The key is the id **on the wire**, which is fields[1] of the request we sent and fields[1] of
      // the reply, because the worker echoes it. Keying on anything else — like a locally generated
      // sequence number — silently never matches, and every await hangs. That is what the first run of
      // this file did.
      const id = line.split('\t')[1];
      const resolve = id === undefined ? undefined : pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(line);
      }
    }
  });
  const stderr = readLine(child.stderr, `[worker ${args.join(' ')}] `);
  child.on('error', (error) => {
    for (const resolve of pending.values()) resolve(`E\t?\terr\t${(error as Error).message}`);
    pending.clear();
  });
  return {
    ask: (body: string) =>
      new Promise<string>((resolve, reject) => {
        const id = body.split('\t')[1];
        if (id === undefined) {
          reject(new Error(`request has no id field: ${body.slice(0, 20)}`));
          return;
        }
        pending.set(id, resolve);
        child.stdin.write(`${body}\n`);
        // A refusal to answer must become a failure, not a hung process nobody can diagnose.
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`worker never answered: ${body.slice(0, 40)}`));
        }, 90_000);
      }),
    close: () =>
      new Promise<void>((resolve) => {
        child.stdin.write('BYE\n');
        child.on('close', (code) => {
          if (code !== 0 && code !== null) emit(`worker exited ${code}, last line: ${stderr.peek()}`);
          void stderr;
          resolve();
        });
      }),
  };
}

/** Keeps the last line for a `peek()`, and with `echo` prefixes it is also printed live. */
function readLine(stream: NodeJS.ReadableStream, echo?: string): { peek: () => string } {
  let last = '';
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      last = line;
      if (echo !== undefined) emit(`${echo}${line}`);
    }
  });
  return { peek: () => last };
}

/** `H\t<id>\t…` — the worker echoes the id it was given, which is fields[1] of what we sent. */
const ask = async (worker: ReturnType<typeof startWorker>, verb: string, ...fields: string[]): Promise<string[]> => {
  const line = await worker.ask([verb, ...fields].join('\t'));
  return line.split('\t');
};

const worker = startWorker(['--match-node']);

const probe = await ask(worker, 'P', 'probe');
check('worker answers the parameter probe', probe[0] === 'P' && probe[2] !== undefined, probe.slice(2).join(' '));
check('worker runs at the Node floor so the comparison is apples-to-apples', String(probe[3]).includes('m=19456,t=2,p=1'), probe[3]);

// 1. Rust verifies what Node produced.
for (const [index, secret] of SECRETS.entries()) {
  const nodePhc = await hash(secret);
  const verified = await ask(worker, 'V', `v${index}`, nodePhc, secret);
  check(`rust verifies node's hash #${index}`, verified[2] === 'ok', verified.slice(2).join(' '));
  const wrong = await ask(worker, 'V', `w${index}`, nodePhc, `${secret}-tampered`);
  check(`rust rejects a wrong secret #${index}`, wrong[2] === 'bad', wrong.slice(2).join(' '));
}

// 2. Node verifies what Rust produced — the direction that would break if the PHC header, the version
//    marker, or the tag length disagreed.
for (const [index, secret] of SECRETS.entries()) {
  const produced = await ask(worker, 'H', `h${index}`, secret);
  check(`rust minted a hash #${index}`, produced[2]?.startsWith('$argon2id$') === true, produced[2]?.slice(0, 40));
  const nodeVerifies = await verify(produced[2]!, secret).catch(() => false);
  check(`node verifies rust's hash #${index}`, nodeVerifies === true);
}

// 3. The migration signal: at --match-node nothing is weaker; at the stronger default everything is.
const atDefault = startWorker([]);
const defaultProbe = await ask(atDefault, 'P', 'p');
check(
  'the default cost is the OWASP upper band, not the inherited one',
  String(defaultProbe[3]).includes('m=65536,t=3,p=4'),
  defaultProbe[3],
);
const nodePhc = await hash(SECRETS[0]!);
const migrate = await ask(atDefault, 'V', 'm0', nodePhc, SECRETS[0]!);
check('a Node-minted credential still authenticates and is flagged for re-mint', migrate[2] === 'ok' && migrate[3] === 'migrate=true', migrate.slice(2).join(' '));
await atDefault.close();

// 4. Refusals that must be refusals, not silent weakenings.
const below = await ask(worker, 'H', 'b0', SECRETS[0]!, '8192', '1', '1');
check('refuses to mint below the floor', below[2] === 'err' || String(below[2]).includes('refusing'), below.slice(2).join(' '));
const garbage = await ask(worker, 'V', 'g0', 'not-a-phc-string', SECRETS[0]!);
check('a malformed stored hash is err, not bad', garbage[2] === 'err', garbage.slice(2).join(' '));
const other = await ask(worker, 'V', 'g1', '$argon2i$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', SECRETS[0]!);
check('argon2i (not id) is refused rather than verified', other[2] === 'err', other.slice(2).join(' '));

// 5. Throughput. Same secret, N operations, wall clock.
const secretForLoad = SECRETS[0]!;
const phcForLoad = await hash(secretForLoad);
const N = 64;

const nodeStart = performance.now();
await Promise.all(Array.from({ length: N }, () => verify(phcForLoad, secretForLoad)));
const nodeMs = performance.now() - nodeStart;

const rustStart = performance.now();
await Promise.all(Array.from({ length: N }, (_unused, index) => ask(worker, 'V', `L${index}`, phcForLoad, secretForLoad)));
const rustMs = performance.now() - rustStart;

emit(`\n${N} concurrent verifies of the same hash:`);
emit(`  node  (libuv pool, default 4) : ${nodeMs.toFixed(0)} ms   ${(N / (nodeMs / 1000)).toFixed(1)}/s`);
emit(`  rust  (workers=${probe[2]})            : ${rustMs.toFixed(0)} ms   ${(N / (rustMs / 1000)).toFixed(1)}/s`);
emit(`  note: the Rust number on ONE connection is serialised by one process; a deployment opens several,`);
emit(`        and the point of the worker is that its ceiling is threads, not UV_THREADPOOL_SIZE.`);

await worker.close();
emit(`\n${failures === 0 ? 'AGREEMENT GREEN' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
