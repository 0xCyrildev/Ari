/**
 * A seal with more than one key behind it — which is what "rotate the ticket key" has to
 * mean before anyone tries to do it under time pressure.
 *
 * The property worth defending here is the narrow one: a ring *verifies* two generations
 * and *signs* with one. The wider claim — that rotation is safe — is not in this file,
 * because it is not true of a seal whose format carries no key id: a ticket that fails to
 * verify is indistinguishable from a forgery, so the order the two processes are updated in
 * is the control, and it lives in `docs/OPERATIONS.md`.
 */

import type { AuthorizationTicket, TicketClaims } from '@ari/schemas';
import { describe, expect, it } from 'vitest';
import { claimsForTest } from './fixtures.js';
import { KeyRing, openTicket, ringOf, sealTicket, TicketKey } from '../src/index.js';

const OLD = new TicketKey('o'.repeat(48), 'v1');
const NEW = new TicketKey('n'.repeat(48), 'v2');

/** A fresh ticket each call, so no test can pass by comparing two seals of one row. */
function ticket(claims: TicketClaims, key: TicketKey): AuthorizationTicket {
  const sealed = sealTicket(claims, key);
  if (!sealed.ok) throw new Error(sealed.reason);
  return sealed.ticket;
}

describe('a ring of ticket keys', () => {
  it('verifies the seal it was given and the one before it', () => {
    const ring = ringOf(NEW, OLD);
    const fromBefore = ticket(claimsForTest(), OLD);
    const fromHead = ticket(claimsForTest(), NEW);

    const old = openTicket(fromBefore, ring);
    expect(old.ok).toBe(true);
    // The id is the whole point of naming a key: an operator mid-rotation can see that
    // traffic is still arriving under the seal they intend to retire.
    expect(old.ok && old.keyId).toBe('v1');

    const head = openTicket(fromHead, ring);
    expect(head.ok).toBe(true);
    expect(head.ok && head.keyId).toBe('v2');
  });

  it('refuses the retired seal once it is out of the ring', () => {
    const retired = ticket(claimsForTest(), OLD);
    expect(openTicket(retired, NEW).ok).toBe(false);
    expect(openTicket(retired, NEW)).toMatchObject({ reason: 'BAD_SIGNATURE' });
    // …and the refusal is the same one a *wrong secret* gets, because the format carries no
    // key id to distinguish them: "you dropped the key this was sealed with" and "somebody
    // who does not have your key tried this" look identical here. Stated as an assertion so
    // nobody "fixes" the ambiguity by adding a detail that tells a stranger which secrets
    // this process trusts. (A tampered payload is a different refusal — the claims no
    // longer parse — and `ticket.test.ts` already covers that path.)
    const wrongSecret = ticket(claimsForTest(), new TicketKey('w'.repeat(48), 'v2'));
    expect(openTicket(retired, NEW)).toEqual(openTicket(wrongSecret, NEW));
  });

  it('signs with the head and never with the key being retired', () => {
    const ring = ringOf(NEW, OLD);
    const sealed = sealTicket(claimsForTest(), ring);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    // Verified against the head alone, it must hold: if a ring ever sealed with `previous`,
    // a deployment that had already dropped the old key would mint tickets it could not
    // redeem, and the failure would surface at first payment rather than at deploy.
    expect(openTicket(sealed.ticket, NEW)).toMatchObject({ ok: true, keyId: 'v2' });
  });

  it('is the same object as a lone key when there is nothing to retire', () => {
    const plain = ticket(claimsForTest(), OLD);
    expect(openTicket(plain, ringOf(OLD))).toMatchObject({ ok: true, keyId: 'v1' });
    expect(openTicket(plain, OLD)).toMatchObject({ ok: true, keyId: 'v1' });
  });

  it('refuses two keys with one id', () => {
    // The id exists so an operator can say which seal is being retired. A duplicate makes
    // that sentence false, and the ring is the only place it could still be caught.
    expect(() => new KeyRing(NEW, [new TicketKey('z'.repeat(48), 'v2')], (key) => key.id)).toThrow(/two keys in the ring/);
    // The same secret under two ids is not an ambiguity — it is a rename, and it verifies
    // identically — so the guard is on the id, not on the bytes.
    expect(() => new KeyRing(NEW, [new TicketKey('n'.repeat(48), 'v0')], (key) => key.id)).not.toThrow();
  });
});
