/**
 * Post-emit step for the publishable client: point the type references at the vendored
 * declarations, then prove nothing at runtime still reaches for a workspace package.
 *
 * Why this exists at all: `@ari/client` is published on its own, so a declaration file that
 * says `from '@ari/schemas'` is a broken install for anyone who does not have that package —
 * and it *should* not have it, because `@ari/schemas` is BUSL-1.1 platform code. The build
 * therefore emits the schema **declarations** into `dist/vendor/schemas/` and rewires the
 * specifiers here, mechanically, from the same source the platform compiles. Nobody retypes
 * the shapes by hand, which is what would let the SDK's view of a candidate drift from the
 * server's (`packages/client/test/client.test.ts`'s two contract tests are the other guard).
 *
 * It fails loudly rather than shipping a package that installs but cannot be type-checked.
 */

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const VENDORED = 'vendor/schemas/index.js';
const problems = [];

if (!existsSync(join(dist, 'vendor/schemas/index.d.ts'))) {
  console.error(`vendor.mjs: no ${dist}vendor/schemas/index.d.ts — run the schemas declaration emit first`);
  process.exit(1);
}

/** Every `.d.ts` that belongs to the client (not the vendored tree). */
function clientDeclarationFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'vendor') continue;
    if (statSync(full).isDirectory()) found.push(...clientDeclarationFiles(full));
    else if (entry.endsWith('.d.ts')) found.push(full);
  }
  return found;
}

let rewritten = 0;
for (const file of clientDeclarationFiles(dist)) {
  const before = readFileSync(file, 'utf8');
  // Only the *specifier position* is rewritten — a quoted module reference. The first version matched
  // the bare string '@ari/schemas' anywhere, so it also rewrote the prose in a doc comment and left
  // index.d.ts explaining that './vendor/schemas/index.js' carries DIGEST_FIELD_ALLOWLIST.
  const SPECIFIER = /(['\"])@ari\/schemas\1/g;
  if (!SPECIFIER.test(before)) continue;
  SPECIFIER.lastIndex = 0;
  const depth = relative(dist, file).split('/').length - 1;
  const specifier = `${depth === 0 ? './' : '../'.repeat(depth)}${VENDORED}`;
  const after = before.replace(SPECIFIER, `$1${specifier}$1`);
  process.stdout.write(`${relative(dist, file)}: '@ari/schemas' -> '${specifier}'\n`);
  writeFileSync(file, after);
  if (/(['\"])@ari\/schemas\1/.test(readFileSync(file, 'utf8'))) {
    problems.push(`${relative(dist, file)} still references @ari/schemas as a module after the rewrite`);
  }
  rewritten += 1;
}

const runtimeFiles = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'vendor') continue;
      walk(full);
    } else if (entry.endsWith('.js')) runtimeFiles.push(full);
  }
})(dist);

for (const file of runtimeFiles) {
  const text = readFileSync(file, 'utf8');
  // An import position, not a mention: serialize.js's header comment describes the decimal-string rule
  // by naming the package that states it, and that prose is not a dependency.
  if (/(?:from|import\s*\(|require\s*\()\s*['\"]@ari\//.test(text)) {
    problems.push(`${relative(dist, file)} has a runtime import of a workspace package — the published package would not install`);
  }
}

if (rewritten === 0) problems.push('no declaration file referenced @ari/schemas: the candidate type may have vanished from the public surface');
if (!readFileSync(join(dist, 'index.d.ts'), 'utf8').includes('CandidateTransaction')) {
  problems.push('dist/index.d.ts does not export CandidateTransaction — the public surface lost its input shape');
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`vendor.mjs: ${problem}`);
  process.exit(1);
}

console.log(`vendor.mjs: ${rewritten} declaration file(s) rewired, ${runtimeFiles.length} runtime file(s) clean of @ari/*`);
