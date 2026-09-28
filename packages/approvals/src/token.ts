/**
 * The approval token (§8).
 *
 * ARCHITECTURE §8 specifies the HMAC input as
 * `request_id ‖ canonical_digest ‖ policy_version ‖ agent_id ‖ wallet_id ‖ amount ‖ expiry ‖ nonce`.
 * Written literally, that concatenation is ambiguous: it is the same byte string
 * for a request id of `"ab"` and an agent of `"c"` as for `"a"` and `"bc"`, so
 * without separators or length prefixes an approval granted over one tuple of
 * values is valid over others that concatenate the same way — the exact T12 failure
 * mode this file exists to prevent, and the reason Phase 11's checklist says to
 * "re-derive the HMAC input from scratch and compare it to the docs".
 *
 * So the input is `canonicalEncode` of a named-field object: every field the spec
 * lists, each with its key and type tag, in sorted order. Same fields, same
 * commitment, no boundary between two of them that a value could hide in.
 */

import { ApprovalToken, CanonicalDigest, type CanonicalDigest as Digest } from '@ari/schemas';
import { headOf, keysOf, type Seal } from '@ari/signing';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The bound fields. Note what is absent: any way to express "approve anything else". */
export interface ApprovalClaims {
  readonly approvalId: string;
  readonly requestId: string;
  readonly digest: Digest;
  readonly policyVersionId: string;
  readonly agentId: string;
  readonly walletId: string;
  readonly amountRaw: bigint;
  readonly currencyUnit: string;
  readonly expiresAtMs: bigint;
  readonly nonce: string;
}

export class ApprovalKey {
  constructor(readonly secret: string, readonly id = 'v1') {
    if (secret.length < 32) {
      throw new RangeError('approval key must be at least 32 characters; generate with `openssl rand -base64 48`');
    }
  }

  seal(payload: string): string {
    return base64url(createHmac('sha256', this.secret).update(`${this.id}:`).update(payload).digest());
  }
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/**
 * The exact bytes the HMAC covers.
 *
 * Written out field by field, in the order §8 lists them, with every big integer as
 * a decimal string. Two things this buys and one it deliberately gives up: the
 * quotes and key names are what remove the concatenation ambiguity described in this
 * module's header, the field list is visible in one place rather than implied by an
 * object's insertion order, and — the give-up — the payload is *not* re-encoded to
 * verify. Verification HMACs the bytes it received, so a re-encoding step would be a
 * second canonicaliser, and a second canonicaliser is the substitution bug (T10).
 */
export function approvalPayload(claims: ApprovalClaims): string {
  return JSON.stringify({
    requestId: claims.requestId,
    digest: claims.digest,
    policyVersionId: claims.policyVersionId,
    agentId: claims.agentId,
    walletId: claims.walletId,
    amountRaw: claims.amountRaw.toString(),
    currencyUnit: claims.currencyUnit,
    expiresAtMs: claims.expiresAtMs.toString(),
    nonce: claims.nonce,
    approvalId: claims.approvalId,
  });
}

export function sealApproval(claims: ApprovalClaims, seal: Seal<ApprovalKey>): ApprovalToken {
  const payload = base64url(Buffer.from(approvalPayload(claims), 'utf8'));
  // The head, always — a ring exists so an outstanding token still verifies during a
  // rotation, not so new authority is minted under a seal somebody is retiring.
  return ApprovalToken.parse(`${payload}.${headOf(seal).seal(payload)}`);
}

export type OpenFailure = 'MALFORMED' | 'BAD_SIGNATURE' | 'BAD_CLAIMS';

export type OpenResult =
  | { readonly ok: true; readonly claims: ApprovalClaims; readonly keyId: string }
  | { readonly ok: false; readonly reason: OpenFailure };

/**
 * Verify the seal. Checks nothing else — expiry and single use need a clock and a row.
 *
 * A ring is accepted for the same reason the ticket seal takes one, and for the same
 * price: the token carries no key id, so verification is "does any key here reproduce this
 * MAC", and a refusal cannot tell an operator "sealed with a key you dropped" from
 * "sealed by an impostor". See `docs/OPERATIONS.md` for the order that avoids that
 * ambiguity while rotating.
 */
export function openApproval(token: string, seal: Seal<ApprovalKey>): OpenResult {
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const [payload, signature] = parts;
  const presented = Buffer.from(signature!, 'base64url');
  let keyId: string | null = null;
  for (const key of keysOf(seal)) {
    const expected = Buffer.from(key.seal(payload!), 'base64url');
    if (expected.byteLength !== presented.byteLength || !timingSafeEqual(expected, presented)) {
      continue;
    }
    keyId = key.id;
    break;
  }
  if (keyId === null) return { ok: false, reason: 'BAD_SIGNATURE' };

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as unknown;
  } catch {
    return { ok: false, reason: 'BAD_CLAIMS' };
  }
  const record = raw as Record<string, unknown>;
  const strings = ['approvalId', 'requestId', 'digest', 'policyVersionId', 'agentId', 'walletId', 'currencyUnit', 'nonce'] as const;
  for (const field of strings) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) return { ok: false, reason: 'BAD_CLAIMS' };
  }
  if (typeof record.amountRaw !== 'string' || typeof record.expiresAtMs !== 'string') {
    return { ok: false, reason: 'BAD_CLAIMS' };
  }
  // The digest is re-validated by the same schema that gates every other digest in
  // the system, rather than by a local pattern: two definitions of "looks like a
  // canon/v1 digest" is how one of them stops agreeing with the other.
  const digest = CanonicalDigest.safeParse(record.digest);
  if (!digest.success) return { ok: false, reason: 'BAD_CLAIMS' };

  try {
    return {
      ok: true,
      claims: {
        approvalId: record.approvalId as string,
        requestId: record.requestId as string,
        digest: digest.data,
        policyVersionId: record.policyVersionId as string,
        agentId: record.agentId as string,
        walletId: record.walletId as string,
        amountRaw: BigInt(record.amountRaw as string),
        currencyUnit: record.currencyUnit as string,
        expiresAtMs: BigInt(record.expiresAtMs as string),
        nonce: record.nonce as string,
      },
      keyId,
    };
  } catch {
    // `BigInt('1.5')` is the realistic case: a value that round-tripped through a
    // float somewhere on the way back, which is exactly what must not be honoured.
    return { ok: false, reason: 'BAD_CLAIMS' };
  }
}
