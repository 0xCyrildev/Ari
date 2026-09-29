/**
 * `pnpm ui:preflight`
 *
 * A mechanical gate over the dashboard source. Every check here is a signature the first pass
 * of this frontend had too much of, found by counting rather than by looking: 52 em dashes, 46
 * small-caps micro-labels, three files of hand-drawn SVG icons, ten identical metric cards.
 *
 * None of these checks proves the interface is good design. They prove it is not carrying the
 * default output of a model, which is the floor, not the ceiling. Everything that needs a human
 * judgement (is this screen readable, does this row earn its border) is left to the screenshots.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// The Next app has no src/: the route tree, the components and the domain layer are the tree.
// Scoped to the console. The marketing page is v0's, generated and kept as it was written; the
// console is this repository's own design, so the gate runs over it and only reports the rest.
const srcDirs = ['app/console', 'components/console', 'lib/ari'];


const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(tsx?|css|html)$/.test(entry)) files.push(full);
  }
}
for (const dir of srcDirs) walk(join(root, dir));

/** Blank a comment's content, keep its line count, so a failure names the right line. */
const maskComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, '')).replace(/^\s*\/\/.*$/gm, '');

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// The dash rule is about copy a visitor reads. `apps/api` and this app's own modules are written
// in the repository's prose, which uses em dashes constantly, and counting them would turn a
// typographic rule into a ban on writing comments in the house style.
const read = files.map((file) => {
  const text = readFileSync(file, 'utf8');
  const copy = /\.css$/.test(file) ? text : stripComments(text);
  return { file: relative(root, file), text: copy, lines: copy.split('\n') };
});

const failures = [];
const warns = [];

const countIn = (needle) => {
  const re = needle instanceof RegExp ? needle : new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  let total = 0;
  const where = [];
  for (const { file, text } of read) {
    const hits = text.match(re);
    if (hits === null) continue;
    total += hits.length;
    where.push(`${file} (${hits.length})`);
  }
  return { total, where };
};

const forbid = (label, pattern, budget = 0) => {
  const { total, where } = countIn(pattern);
  if (total > budget) failures.push(`${label}: ${total} occurrence${total === 1 ? '' : 's'} over a budget of ${budget}. ${where.join(', ')}`);
  else console.log(`  ok   ${label} (${total})`);
};

console.log('preflight: apps/web');

// --- Typography tells -------------------------------------------------------
forbid('em dash in source (use a comma, colon or full stop)', /—/g);
forbid('en dash in source', /–/g);
// Raw small-caps utilities are banned outright. Data labels use the `.micro`
// component class instead, which is the only place this project allows
// uppercase plus tracking, and the check below is what keeps `.micro` from
// quietly becoming the eyebrow garnish it replaced.
forbid('small-caps micro-labels (uppercase + tracking on one element)', /uppercase[^"]*tracking-|tracking-[^"]*uppercase/g);

const microAboveHeading = read.filter(({ text }) =>
  /micro[^"]*"[^>]*>[^<]*<\/(span|p|div)>\s*<h[12]/s.test(text),
);
if (microAboveHeading.length > 0) {
  failures.push(`eyebrow: a .micro label sits directly above a heading in ${microAboveHeading.map(({ file }) => file).join(', ')}. Labels carry data; headings stand alone.`);
} else console.log('  ok   no micro-label used as an eyebrow');
forbid('template company names', /\b(?:Acme|Northwind|Globex|Initech|Umbrella|Lorem|John Doe|Jane Doe)\b/g);
forbid('UI copy written as TODO or placeholder text', /\b(?:TODO|FIXME|XXX|lorem ipsum)\b/gi);

// --- Shape and depth locks --------------------------------------------------
forbid('box shadows (depth comes from the surface ramp and one hairline)', /shadow-\[/g);
forbid('corner radii from the deleted token set', /rounded-\[var\(/g);
forbid('named corner radii other than the control radius', /rounded-(?:xs|sm|md|lg|xl|2xl|3xl)\b/g);
forbid('arbitrary corner radii (rounded-control, rounded-full and 1px bars only)', /rounded-\[(?!1px)/g);

// --- Icons ------------------------------------------------------------------
forbid('hand-drawn svg elements (Phosphor only)', /<svg[\s>]/g);
forbid('hand-drawn icon paths', /<path\s+d=/g);

// --- Layout and scroll ------------------------------------------------------
forbid('h-screen (use min-h-screen or a dvh value)', /(?:^|[^-])\bh-screen\b/g);
forbid('scroll or wheel listeners (framer-motion whileInView only)', /addEventListener\(\s*['"](scroll|wheel|resize)['"]/g);
forbid('CSS font imports from a CDN (fonts are self-hosted)', /fonts\.(googleapis|gstatic)\.com/g);

// --- Motion discipline ------------------------------------------------------
// The two reduced-motion checks used to sit here and report "not judged here", because this
// function's file set is the console tree and the media query lives in the marketing stylesheet.
// A scoping artifact that reads like an absence is worse than no check: it invites someone to
// conclude the rule is missing. They moved below, to the claims set, where they can see the truth.
forbid('infinite CSS animation loops (console screens stay still)', /animation:\s*\w+\s+[^;]*infinite/g);

// --- Honesty ----------------------------------------------------------------
const fakeStats = countIn(/\b(?:10,000|1,000,000|99\.9|4 \+ stars|200\+|10x|500%) (?:teams|transactions|users|customers|tps|faster)\b/g);
if (fakeStats.total > 0) failures.push(`unsourced marketing counters: ${fakeStats.where.join(', ')}`);
else console.log('  ok   no unsourced marketing counters');

const sampleLabel = countIn(/[Ss]ample/);
if (sampleLabel.total === 0) warns.push('nothing in src/ says "sample": a fixture tenant must be labelled as one');
else console.log(`  ok   sample data is labelled (${sampleLabel.total} mentions)`);

// --- Claims ------------------------------------------------------------------
/**
 * The honesty gate over the copy a visitor reads, as distinct from the design gate above.
 *
 * The rules above are scoped to the console on purpose; this one is scoped to the *marketing*
 * and documentation surfaces, which is where every claim that can rot lives. It exists because
 * an outside audit found the site claiming `SUPPORTED TODAY` for a chain nothing settles,
 * naming Sui and Solana in a marquee, printing `2PC-MPC` for a sealing scheme with no provider,
 * and a test count of 548 on a day the suite held 664 — all of it true once, none of it checked
 * afterwards. A claim that cannot be re-checked is a claim that will quietly become false, so
 * the check runs on every build.
 */
const claimDirs = ['app', 'components'];
const claimFiles = [];
function walkClaims(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (entry !== 'console') walkClaims(full); }
    else if (/\.tsx?$/.test(entry)) claimFiles.push(full);
  }
}
for (const dir of claimDirs) walkClaims(join(root, dir));
// The console's copy is checked too — it was skipped above only because `app/console` is a
// directory named `console`, which the marketing walk excludes.
for (const dir of ['app/console', 'components/console']) walkClaims(join(root, dir));

const claims = [...new Set(claimFiles)].map((file) => {
  // Comments masked rather than removed: a note explaining why the page no longer says
  // `2PC-MPC` must not trip the rule that bans the phrase, and blanking the comment out
  // entirely shifts every later line so the failure names the wrong place. Keeping the
  // newlines costs the check nothing and keeps its line numbers honest.
  const text = maskComments(readFileSync(file, 'utf8'));
  return { file: relative(root, file), text, lines: text.split('\n') };
});

/** A claim rule: name the pattern, the reason, and the file set it applies to. */
const claimFailures = [];
const forbidClaim = (label, pattern, files = claims) => {
  const hits = [];
  for (const { file, lines } of files) {
    lines.forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${file}:${index + 1}`);
    });
  }
  if (hits.length > 0) claimFailures.push(`${label} — ${hits.join(', ')}`);
  else console.log(`  ok   ${label}`);
};

/**
 * Nothing in this build settles anything, so no page may say it does — with three
 * distinctions, because a blunt word ban would either lie or get ignored.
 *
 * `settledRaw` and `reservation.settled` are code and a ledger status: the lookaround excludes
 * an identifier character on either side. `SETTLED` in all caps is the reservation status the
 * schema itself uses (`010`), and the tone map that colours it is copy about a row, not a claim
 * about money — so only the prose forms `[Ss]ettled` are matched. And a sentence that *refuses*
 * the claim ("will not dress a mock signature up as a settled payment", "None of it says a
 * payment settled", "nothing here claims a provider settled it" — `nothing` is in the list because
 * it is the plainest way this page refuses the claim, and a gate that only recognises "no" teaches
 * people to write "no" where "nothing" reads better).
 * payment settled") is the honest use, which is why the check looks backwards 60 characters for
 * a negation instead of banning the word.
 */
const NEGATION = /\b(not|never|none|nothing|without|refuse|refused|stops? at|cannot|no)\b/i;
const settledHits = [];
for (const { file, lines } of claims) {
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/(?<![A-Za-z_])[Ss]ettled(?![A-Za-z_])/g)) {
      const before = line.slice(Math.max(0, (match.index ?? 0) - 60), match.index ?? 0);
      const after = line.slice((match.index ?? 0) + 7, (match.index ?? 0) + 37);
      if (!NEGATION.test(before) && !NEGATION.test(after)) settledHits.push(`${file}:${index + 1}`);
    }
  });
}
if (settledHits.length > 0) claimFailures.push(`copy claims a payment is settled — ${settledHits.join(', ')}`);
else console.log('  ok   nothing claims a settled payment');
forbidClaim('a chain sold as supported today', /SUPPORTED TODAY/);
forbidClaim('a sealing scheme named that no provider implements', /2PC-MPC|\bMPC\b/);
forbidClaim('a hardcoded test count (it rots the day anyone commits a test)', /\b\d{2,4}\s+tests\b/);
// Scoped to the marketing tree: a connected console saying LIVE about a live tenant is a
// fact, and the badge this rule exists to stop is the one on a fixture card.
const marketing = claims.filter((c) => !c.file.startsWith('app/console') && !c.file.startsWith('components/console'));
forbidClaim('a marketing card labelled LIVE', /aria-label="[^"]*LIVE|>\s*LIVE\s*</, marketing);

/**
 * The unsupported-chain rule cannot be a pattern ban, because the honest sentence that names
 * them is the one place they *should* appear: "Solana, Sui, Aptos … are not supported". So the
 * check is on the line's meaning — a chain name is allowed only where the same line says it is
 * not supported, and a line that names it without that qualifier is the defect.
 */
const UNSUPPORTED_CHAINS = /\b(Sui|Solana|Aptos|Cardano|XRP Ledger|XRPL|TON)\b/;
const NEAR_LINE = /(not supported|no simulation adapter|does not exist|not shipped|needs an address grammar|unsupported)/i;
const chainHits = [];
for (const { file, lines } of claims) {
  lines.forEach((line, index) => {
    if (UNSUPPORTED_CHAINS.test(line) && !NEAR_LINE.test(line)) chainHits.push(`${file}:${index + 1}`);
  });
}
if (chainHits.length > 0) claimFailures.push(`an unsupported chain is named without saying it is unsupported — ${chainHits.join(', ')}`);
else console.log('  ok   every unsupported chain is named alongside its refusal');

/**
 * A reveal that starts with no visible area can never be revealed by a thing that measures area.
 * `clip-path: inset(0 100% 0 0)` and `scaleX(0)` leave an element with a zero intersection rect,
 * so `IntersectionObserver` reports "not in view" forever: the wipe needs the observer and the
 * observer needs the wipe. This is how the control-plane diagram shipped invisible to every
 * motion-enabled visitor while the reduced-motion CSS — which un-clips — made it look fine.
 *
 * `opacity: 0` is deliberately absent: it costs no area, which is why the `Reveal` wrapper that
 * uses it has never had this problem.
 */
const ZERO_AREA = /clipPath:\s*['"]inset\([^)]*100%|scaleX\(0\)|scale:\s*0[,\s}]/;
const areaHits = [];
for (const { file, lines } of claims) {
  lines.forEach((line, index) => {
    if (/whileInView/.test(line) && ZERO_AREA.test(line)) areaHits.push(`${file}:${index + 1}`);
  });
}
if (areaHits.length > 0) claimFailures.push(`a whileInView reveal starts with zero visible area, so no observer can ever fire it — ${areaHits.join(', ')}`);
else console.log('  ok   no reveal gates on an area it zeroes itself');

/**
 * Reduced motion, over the tree that actually carries it.
 *
 * The CSS half is a hard requirement: the marketing stylesheet's `@media
 * (prefers-reduced-motion: reduce)` block is what un-clips and un-transforms the reveals for a
 * visitor who asked for stillness, and it is also the reason the `.architecture` deadlock stayed
 * invisible — the reduce path forced the element visible while the motion path never revealed it.
 * So the block must exist, and a rule that removes it fails the build.
 */
const motionTexts = claims.map((c) => c.text);
try { motionTexts.push(readFileSync(join(root, 'app/globals.css'), 'utf8')) } catch { /* the check below fails honestly if it is gone */ }
if (motionTexts.some((text) => /@media[^{]*prefers-reduced-motion/.test(text))) console.log('  ok   reduced motion is honoured in CSS');
else failures.push('reduced motion: no @media (prefers-reduced-motion) rule in the app tree — the reveals hold content at opacity 0 until an observer fires, so without it a visitor who asked for stillness gets a page that animates at them');
if (motionTexts.some((text) => /useReducedMotion|reducedMotion=|MotionConfig/.test(text))) console.log('  ok   reduced motion is honoured in JS');
else warns.push('reduced motion in JS is not explicit: the marketing animations rely on framer-motion\'s own default (`reducedMotion: "user"`, which drops transforms and keeps opacity), and the CSS block is the only stated honour. Worth knowing if a reveal ever depends on a transform alone.');

if (claimFailures.length === 0) console.log(`  ok   claims checked over ${claims.length} files`);
else failures.push(...claimFailures.map((failure) => `claim: ${failure}`));

// --- Report -----------------------------------------------------------------
const accentUses = countIn(/text-brand\b|bg-brand\b|border-brand-|text-allow\b|text-caution\b|text-deny\b|bg-hair\b|border-hair\b|text-ink-mute\b|bg-surface\b/g);
if (accentUses.total > 0) failures.push(`classes from the deleted token set are still in use: ${accentUses.where.join(', ')}`);
else console.log('  ok   only the current token set is referenced');

console.log('');
if (warns.length > 0) for (const warn of warns) console.log(`  warn ${warn}`);
// Two scopes, and the report says so: the design rules run over the console tree this repository
// owns, the claims over marketing and docs too. One number would read as coverage of everything by
// everything, which is the mistake the last audit made about this gate.
const scope = `${read.length} files over the design rules, ${claims.length} over the claims`;
if (failures.length === 0) {
  console.log(`preflight passed: ${scope}.`);
  process.exit(0);
}
for (const failure of failures) console.log(`  FAIL ${failure}`);
console.log(`\npreflight failed: ${failures.length} check${failures.length === 1 ? '' : 's'} — ${scope}.`);
process.exit(1);
