import { describe, expect, it } from 'vitest';
import { acceptsBearerSecret, bearerToken } from '../src/index.js';

describe('the bearer grammar', () => {
  it('reads a scheme it names, and nothing else', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('bearer abc123')).toBe(null);
    expect(bearerToken('Basic abc123')).toBe(null);
    expect(bearerToken('Bearer')).toBe(null);
    expect(bearerToken('Bearer    ')).toBe(null);
    expect(bearerToken(undefined)).toBe(null);
  });
});

describe('acceptsBearerSecret', () => {
  const secret = 'd'.repeat(48);

  it('accepts the exact secret and refuses a longer one with the same prefix', () => {
    expect(acceptsBearerSecret(secret, secret)).toBe(true);
    expect(acceptsBearerSecret(secret, `${secret}x`)).toBe(false);
  });

  it('refuses an equal-length secret one byte from being right', () => {
    // The case that a length guard alone would pass, and the one timingSafeEqual exists
    // for: the comparison must not exit at the first differing byte.
    const wrong = `${secret.slice(0, -1)}z`;
    expect(wrong.length).toBe(secret.length);
    expect(acceptsBearerSecret(secret, wrong)).toBe(false);
  });

  it('refuses a missing presentation without throwing, at any length', () => {
    expect(acceptsBearerSecret(secret, null)).toBe(false);
    expect(acceptsBearerSecret(secret, '')).toBe(false);
    expect(acceptsBearerSecret(secret, 'short')).toBe(false);
    expect(acceptsBearerSecret(secret, secret.slice(0, 20))).toBe(false);
    // A configured secret of nothing accepts nothing, rather than matching an empty
    // token that some client sent by accident.
    expect(acceptsBearerSecret('', null)).toBe(false);
    expect(acceptsBearerSecret('', '')).toBe(false);
  });

  it('compares bytes, not characters', () => {
    // Same character count, nearly double the UTF-8 length. A guard written against
    // `string.length` would call these comparable and hand the difference to
    // `timingSafeEqual`, which throws — and a throw inside a refusal path is a 500
    // where a denial belongs.
    const unicode = `${'é'.repeat(47)}x`;
    expect(unicode.length).toBe(secret.length);
    expect(Buffer.byteLength(unicode, 'utf8')).not.toBe(Buffer.byteLength(secret, 'utf8'));
    expect(acceptsBearerSecret(secret, unicode)).toBe(false);
  });
});
