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
const srcDir = join(root, 'src');

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(tsx?|css|html)$/.test(entry)) files.push(full);
  }
})(srcDir);

const read = files.map((file) => ({ file: relative(root, file), text: readFileSync(file, 'utf8'), lines: readFileSync(file, 'utf8').split('\n') }));

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
  if (countIn(pattern).total === 0) failures.push(`${label}: not found anywhere in src/`);
  else console.log(`  ok   ${label}`);
};

console.log('preflight: apps/dashboard/src');

// --- Typography tells -------------------------------------------------------
forbid('em dash in source (use a comma, colon or full stop)', /—/g);
forbid('en dash in source', /–/g);
forbid('small-caps micro-labels (uppercase + tracking on one element)', /uppercase[^"]*tracking-|tracking-[^"]*uppercase/g);
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
