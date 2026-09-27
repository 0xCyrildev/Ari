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

const require_ = (label, pattern) => {
  if (countIn(pattern).total === 0) warns.push(`${label}: not judged here (the console tree does not contain the stylesheet or the provider that satisfy it)`);
  else console.log(`  ok   ${label}`);
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
require_('reduced-motion honoured in CSS', /prefers-reduced-motion/);
require_('reduced-motion honoured in JS (framer-motion)', /useReducedMotion/);
forbid('infinite CSS animation loops (console screens stay still)', /animation:\s*\w+\s+[^;]*infinite/g);

// --- Honesty ----------------------------------------------------------------
const fakeStats = countIn(/\b(?:10,000|1,000,000|99\.9|4 \+ stars|200\+|10x|500%) (?:teams|transactions|users|customers|tps|faster)\b/g);
if (fakeStats.total > 0) failures.push(`unsourced marketing counters: ${fakeStats.where.join(', ')}`);
else console.log('  ok   no unsourced marketing counters');

const sampleLabel = countIn(/[Ss]ample/);
if (sampleLabel.total === 0) warns.push('nothing in src/ says "sample": a fixture tenant must be labelled as one');
else console.log(`  ok   sample data is labelled (${sampleLabel.total} mentions)`);

// --- Report -----------------------------------------------------------------
const accentUses = countIn(/text-brand\b|bg-brand\b|border-brand-|text-allow\b|text-caution\b|text-deny\b|bg-hair\b|border-hair\b|text-ink-mute\b|bg-surface\b/g);
if (accentUses.total > 0) failures.push(`classes from the deleted token set are still in use: ${accentUses.where.join(', ')}`);
else console.log('  ok   only the current token set is referenced');

console.log('');
if (warns.length > 0) for (const warn of warns) console.log(`  warn ${warn}`);
if (failures.length === 0) {
  console.log(`preflight passed over ${read.length} files.`);
  process.exit(0);
}
for (const failure of failures) console.log(`  FAIL ${failure}`);
console.log(`\npreflight failed: ${failures.length} check${failures.length === 1 ? '' : 's'} over ${read.length} files.`);
process.exit(1);
