import { describe, expect, it } from 'vitest';
import { ringOf } from '@ari/signing';
import { ApprovalKey, approvalPayload, openApproval, sealApproval, type ApprovalClaims } from '../src/token.js';

const KEY = new ApprovalKey('a'.repeat(48));
const OTHER = new ApprovalKey('b'.repeat(48));
const DIGEST = `canon/v1:${'a'.repeat(64)}` as ApprovalClaims['digest'];

function claims(overrides: Partial<ApprovalClaims> = {}): ApprovalClaims {
  return {
    approvalId: 'apr_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    requestId: 'req_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    digest: DIGEST,
    policyVersionId: 'ppv_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    agentId: 'agt_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    walletId: 'wal_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
    amountRaw: 2000000000n,
    currencyUnit: 'usdc-6dp',
    expiresAtMs: 1761400060000n,
    nonce: 'nonce-00000000-0000-7000-8000-000000000000',
    ...overrides,
  };
}

describe('the sealing key', () => {
  it('refuses a secret too short to seal with', () => {
    expect(() => new ApprovalKey('hunter2')).toThrow(RangeError);
  });
});

describe('sealing and opening', () => {
  it('round-trips every bound field, big integers intact', () => {
    const original = claims();
    const opened = openApproval(sealApproval(original, KEY), KEY);
    if (!opened.ok) throw new Error('round trip failed');
    expect(opened.claims).toEqual(original);
    expect(typeof opened.claims.amountRaw).toBe('bigint');
  });

  it('refuses a token sealed by another key', () => {
    const token = sealApproval(claims(), KEY);
    expect(openApproval(token, OTHER)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('refuses a payload edited under a preserved signature', () => {
    const signature = sealApproval(claims(), KEY).split('.')[1];
    const tampered = Buffer.from(
      approvalPayload(claims({ amountRaw: 99n * 1_000_000_000n })),
      'utf8',
    ).toString('base64url');
    expect(openApproval(`${tampered}.${signature}`, KEY)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('does not let a shorter field absorb a longer one', () => {
    // §8 writes the HMAC input as `request_id ‖ canonical_digest ‖ …`. Taken
    // literally that concatenation is ambiguous: two different tuples of fields can
    // produce identical bytes, and an approval over one would then be valid over the
    // other. Canonical encoding tags every field with its name and length, so the
    // two below cannot collide.
    const a = claims({ requestId: 'req_aaaaaaaa', agentId: 'agt_bbbbbbbb' });
    const b = claims({ requestId: 'req_aaaa', agentId: 'aaaaagt_bbbbbbbb' });
    expect(approvalPayload(a)).not.toBe(approvalPayload(b));
    expect(a.requestId + a.agentId).toBe('req_aaaaaaaaagt_bbbbbbbb');
    expect(b.requestId + b.agentId).toBe('req_aaaaaaaaagt_bbbbbbbb');
  });

  it('refuses a digest that is not a digest', () => {
    const forged = { ...claims(), digest: 'sha256:deadbeef' } as unknown as ApprovalClaims;
    const token = sealApproval(forged, KEY);
    expect(openApproval(token, KEY)).toEqual({ ok: false, reason: 'BAD_CLAIMS' });
  });

  it('refuses an amount that arrived as a float, even behind a valid seal', () => {
    // Not a nicety: `2000000000.5` in a money comparison is the bug the bigint rule
    // exists to prevent. Sealed here deliberately — a correctly-signed token whose
    // body cannot be read as an integer still has to be refused, because the
    // signature proves who wrote it, not what it says.
    const floaty = { ...claims(), amountRaw: '2000000000.5' } as unknown as ApprovalClaims;
    expect(openApproval(sealApproval(floaty, KEY), KEY)).toEqual({ ok: false, reason: 'BAD_CLAIMS' });
  });

  it('rejects nonsense without throwing', () => {
    for (const junk of ['', 'x', 'x.y', 'a.b.c', `${'~'.repeat(40)}.${'~'.repeat(43)}`]) {
      expect(() => openApproval(junk, KEY)).not.toThrow();
      expect(openApproval(junk, KEY).ok).toBe(false);
    }
  });

  it('verifies the seal only, and leaves liveness to the claim', () => {
    // Deliberate separation: whether a token has expired is a question about a clock
    // and a row, and a pure verify function that read either could not be tested
    // reproducibly. `claimApproval` is where expiry is enforced.
    const stale = claims({ expiresAtMs: 1n });
    const opened = openApproval(sealApproval(stale, KEY), KEY);
    expect(opened.ok).toBe(true);
  });
});

describe('rotating the approval seal', () => {
  const OLD = new ApprovalKey('a'.repeat(48), 'v1');
  const NEW = new ApprovalKey('n'.repeat(48), 'v2');

  it('honours a token sealed before the rotation while the window is open', () => {
    // An approval token outlives a deploy: it is minted when a human votes and spent when
    // the agent retries, which can be minutes later. A ring that verified only the head
    // would refuse a vote that was honestly cast, and the agent would be told its own
    // approval does not exist.
    const outstanding = sealApproval(claims(), OLD);
    const opened = openApproval(outstanding, ringOf(NEW, OLD));
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(opened.keyId).toBe('v1');
  });

  it('seals with the head, so a closed window does not silently stay open', () => {
    const fresh = sealApproval(claims(), ringOf(NEW, OLD));
    // Verifiable by the new key alone: if a ring ever sealed with `previous`, retiring it
    // would strand tokens this process had minted after the retirement decision.
    expect(openApproval(fresh, NEW)).toMatchObject({ ok: true, keyId: 'v2' });
  });

  it('refuses the retired seal once it is out of the ring, in the same words as a wrong secret', () => {
    const retired = sealApproval(claims(), OLD);
    const wrongSecret = sealApproval(claims(), new ApprovalKey('w'.repeat(48), 'v2'));
    expect(openApproval(retired, NEW)).toEqual(openApproval(wrongSecret, NEW));
  });
});
