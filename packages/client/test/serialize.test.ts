import { CandidateTransaction } from '@ari/schemas';
import { describe, expect, it } from 'vitest';
import { toWire, wireStringify } from '../src/serialize.js';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RECIPIENT = '0x3f2a1b0c4d5e6f708192a3b4c5d6e7f8091a2b3c';

function wireInput(amount: string) {
  return {
    kind: 'transfer',
    chain: 'ethereum',
    requestId: 'req_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    agentId: 'agt_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    walletId: 'wal_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    deadline: '2026-09-26T12:00:00.000Z',
    idempotencyKey: 'sdk-1',
    usdEstimate: null,
    asset: { kind: 'erc20', chain: 'ethereum', contract: USDC, symbol: 'USDC', decimals: 6 },
    amount: { raw: amount, unit: 'usdc-6dp' },
    recipient: { chain: 'ethereum', address: RECIPIENT },
    replayProtection: { scheme: 'account_sequence', nonce: '1', chainId: '1', gasLimit: null, maxFeePerUnit: null },
  };
}

describe('the outbound half of the decimal-string rule', () => {
  it('writes a bigint as a decimal string, not a JSON number', () => {
    // 2^64 + 1 is the case that decides the format: it is a plausible wei amount, it
    // is past what a JSON number can carry, and `JSON.stringify` refuses it outright.
    const huge = 18_446_744_073_709_551_617n;
    expect(toWire({ raw: huge })).toEqual({ raw: '18446744073709551617' });
    expect(wireStringify({ raw: huge })).toBe('{"raw":"18446744073709551617"}');
  });

  it('carries a parsed candidate, which is the object JSON.stringify refuses', () => {
    const parsed = CandidateTransaction.parse(wireInput('2000000000'));
    expect(() => JSON.stringify(parsed)).toThrow(TypeError);
    expect(wireStringify(parsed)).toContain('"raw":"2000000000"');
  });

  it('survives the round trip: wire, parsed again, equal to the first parse', () => {
    const parsed = CandidateTransaction.parse(wireInput('2000000000'));
    const again = CandidateTransaction.parse(JSON.parse(wireStringify(parsed)) as unknown);
    expect(again).toEqual(parsed);
  });

  it('is the same request an agent wrote, byte for byte where it matters', () => {
    // The canonical digest is taken over what the server re-parses, so a client that
    // re-serialises loosely is a client whose approval screen describes a different
    // transaction than the one that gets paid.
    const parsed = CandidateTransaction.parse(wireInput('99000000'));
    const body = JSON.parse(wireStringify(parsed)) as Record<string, unknown>;
    const amount = body['amount'] as Record<string, unknown>;
    expect(amount).toEqual({ raw: '99000000', unit: 'usdc-6dp' });
    expect(typeof amount['raw']).toBe('string');
  });
});

describe('what the serialiser refuses', () => {
  it('names the path a number cannot travel down', () => {
    expect(() => toWire({ amount: { raw: 1.5 } })).toThrow(/amount.raw/);
    // `9007199254740993` is 2^53 + 1, and the JavaScript literal had already become
    // `…992` before this function was called — the loss happens upstream of anything
    // Ari does, which is the whole argument for amounts arriving as strings.
    expect(() => toWire({ a: { b: [9007199254740993] } })).toThrow(/is not an integer JSON can carry/);
    expect(() => toWire({ a: { b: [12345678901234567890] } })).toThrow(/a\.b\[0]/);
  });

  it('refuses the numbers JSON has no word for', () => {
    // `NaN` becoming `null` becoming "not a positive amount" is three silent steps to
    // a refusal nobody can explain to a customer.
    expect(() => toWire({ total: Number.NaN })).toThrow(/is NaN/);
    expect(() => toWire({ total: Number.POSITIVE_INFINITY })).toThrow(/Infinity/);
  });

  it('refuses an object whose fields are not its own', () => {
    // A `Date` would otherwise go out as a string by JSON's rule rather than this
    // one, and a class instance would go out as `{}`.
    expect(() => toWire({ expiresAt: new Date() })).toThrow(/Date instance/);
    class Money {
      readonly raw = 5n;
    }
    expect(() => toWire(new Money())).toThrow(/Money instance/);
  });

  it('distinguishes "absent" from "no JSON form"', () => {
    expect(toWire({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(() => toWire(undefined)).toThrow(/undefined/);
    expect(() => toWire([undefined])).toThrow(/undefined/);
  });

  it('leaves a boolean false alone', () => {
    // The trap this guards against is the ordinary one: a writer that treats falsy as
    // missing drops `false`, and `false` is the answer to a question the server asked.
    expect(toWire({ enabled: false, count: 0, label: '', nothing: null })).toEqual({
      enabled: false,
      count: 0,
      label: '',
      nothing: null,
    });
  });
});
