/**
 * A seal, and the keys allowed to make one.
 *
 * `TicketKey` folds its `id` into the HMAC input (`${id}:` then the payload), so a ring of
 * keys can be *verified* against without any change to the ticket's wire format: the
 * payload is still `base64url(claims).base64url(mac)`, and nothing names which key signed
 * it. That is deliberate. Putting a `kid` in the ticket would mean a second format for the
 * same object, and the only thing a ring needs to answer is "does any key I trust reproduce
 * this MAC" — which is a question about the MAC, not about a header.
 *
 * The cost of that choice is worth naming, because it is the reason rotation is a
 * two-deployment operation and not a one-line change: a ticket that fails to verify says
 * `BAD_SIGNATURE` whether it was sealed with a key this process no longer holds or by
 * somebody who has your key. Nothing in the string distinguishes them. `docs/OPERATIONS.md`
 * is where the order of operations is written down.
 */
export class KeyRing<Key> {
  readonly head: Key;
  readonly all: readonly Key[];

  constructor(head: Key, previous: readonly Key[] = [], idOf: (key: Key) => string = () => '') {
    const ids = [idOf(head), ...previous.map(idOf)];
    // Two keys with one id is not a ring, it is an ambiguity: the id exists so an operator
    // can say which seal is being retired, and a duplicate makes that sentence false.
    const seen = new Set<string>();
    for (const id of ids) {
      if (id.length > 0 && seen.has(id)) {
        throw new RangeError(`two keys in the ring carry the id "${id}"; retire one before adding the other`);
      }
      seen.add(id);
    }
    this.head = head;
    this.all = [head, ...previous];
  }

  static of<Key>(head: Key): KeyRing<Key> {
    return new KeyRing(head, []);
  }
}

/** Every key in a ring carries a name, because a seal that cannot be named cannot be retired. */
export interface Keyed {
  readonly id: string;
}

/**
 * The two-key shape a rotation actually needs: a head that signs, and optionally one
 * previous key still honoured.
 *
 * Not a list. A window is one generation wide — you move everyone onto the new seal, then
 * you drop the old one — and an N-deep ring is how a deployment ends up carrying secrets
 * nobody remembers why they trust.
 */
export function ringOf<Key extends Keyed>(head: Key, previous?: Key): Seal<Key> {
  return previous === undefined ? head : new KeyRing(head, [previous], (key) => key.id);
}

/** What every seal in this repository is: one key, or a head with keys still honoured. */
export type Seal<Key> = Key | KeyRing<Key>;

export function headOf<Key>(seal: Seal<Key>): Key {
  return seal instanceof KeyRing ? seal.head : seal;
}

/** Every key whose MAC must be tried before a presented seal is refused. */
export function keysOf<Key>(seal: Seal<Key>): readonly Key[] {
  return seal instanceof KeyRing ? seal.all : [seal];
}
