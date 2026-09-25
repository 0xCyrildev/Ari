import { readFileSync } from 'node:fs';
import { CandidateTransaction } from '@ari/schemas';
import { describe, expect, it } from 'vitest';
import { CANONICAL_VERSION, canonicalize, computeDigest } from '../src/index.js';

interface Vector {
  name: string;
  policyVersionId: string;
  input: unknown;
  canonical: string;
  digest: string;
}

/**
 * Frozen bytes, checked in as data rather than as expectations written by hand.
 *
 * The reason a fixed vector file exists: `canon/v1` will eventually have a second
 * implementation — a signer in another language, a CLI verifying a digest offline —
 * and the day the two disagree about how `{amount: 10n}` encodes, the transaction a
 * human approved is not the transaction that gets signed. That failure is invisible
 * to a test suite that only ever compares one implementation against itself, so the
 * commitment is recorded here as bytes any implementation has to reproduce.
 *
 * Regenerate deliberately, never to make a test pass: changing these values is
 * changing what every historical approval and ticket in a database refers to, and
 * `algorithm` says so.
 */
const vectors: Vector[] = (
  JSON.parse(readFileSync(new URL('./vectors/canon-v1.json', import.meta.url), 'utf8')) as {
    algorithm: string;
    vectors: Vector[];
  }
).vectors;

describe(`${CANONICAL_VERSION} fixed vectors`, () => {
  it('has vectors to check against', () => {
    expect(vectors.length).toBeGreaterThan(3);
  });

  for (const vector of vectors) {
    it(`${vector.name} encodes and digests to the recorded bytes`, () => {
      const parsed = CandidateTransaction.safeParse(vector.input);
      if (!parsed.success) throw new Error(`${vector.name} is no longer a valid candidate: ${parsed.error.message}`);
      const context = { policyVersionId: vector.policyVersionId };
      expect(canonicalize(parsed.data, context)).toBe(vector.canonical);
      expect(computeDigest(parsed.data, context)).toBe(vector.digest);
    });
  }

  it('does not let one vector stand in for another', () => {
    expect(new Set(vectors.map((vector) => vector.digest)).size).toBe(vectors.length);
  });
});
