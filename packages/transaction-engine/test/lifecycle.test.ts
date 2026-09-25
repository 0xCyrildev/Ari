import { describe, expect, it } from 'vitest';
import {
  LifecycleState,
  allowedTransitions,
  canTransition,
  isTerminal,
  releasesReservation,
  type LifecycleState as State,
} from '../src/index.js';

const ALL = LifecycleState.options as readonly State[];

const SIGNING_STATES: readonly State[] = [
  'TICKET_MINTED',
  'SIGNING_PENDING',
  'SIGNING_COMPLETE',
  'BROADCAST',
  'BROADCAST_CONFIRMED',
];

/** Everything reachable from `from` in any number of hops, excluding `from` itself. */
function reachable(from: State): Set<State> {
  const seen = new Set<State>();
  const queue: State[] = [from];
  while (queue.length > 0) {
    for (const next of allowedTransitions(queue.shift()!)) {
      if (next !== from && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe('lifecycle table — well-formedness', () => {
  it('covers every state the enum admits, with no undefined row', () => {
    for (const state of ALL) {
      expect(Array.isArray(allowedTransitions(state)), state).toBe(true);
    }
  });

  it('names only states that exist', () => {
    for (const state of ALL) {
      for (const next of allowedTransitions(state)) {
        expect(ALL.includes(next), `${state} -> ${next}`).toBe(true);
      }
    }
  });

  it('has no self-loops, so no state is re-entered and re-decided', () => {
    for (const state of ALL) {
      expect(allowedTransitions(state).includes(state), state).toBe(false);
    }
  });

  it('lets nothing re-enter the early states, so a request cannot be re-decided', () => {
    // Re-running evaluation until it says yes is the retry loop ARCHITECTURE §4
    // forbids. The way it comes back is someone adding an edge into EVALUATING,
    // so the incoming set is asserted exactly rather than sampled.
    const incoming: Record<'DRAFT' | 'VALIDATED' | 'EVALUATING', readonly State[]> = {
      DRAFT: [],
      VALIDATED: ['DRAFT'],
      EVALUATING: ['VALIDATED'],
    };
    for (const [target, expected] of Object.entries(incoming)) {
      const actual = ALL.filter((state) => canTransition(state, target as State));
      expect([...actual].sort(), `incoming edges to ${target}`).toEqual([...expected].sort());
    }
  });
});

describe('lifecycle table — the absorbing refusals', () => {
  it('DENIED is terminal and can never reach a signing state', () => {
    expect(isTerminal('DENIED')).toBe(true);
    const forward = reachable('DENIED');
    expect(forward.size).toBe(0);
    for (const state of SIGNING_STATES) {
      expect(forward.has(state), `DENIED reaches ${state}`).toBe(false);
    }
  });

  it('approval refusals are terminal too', () => {
    expect(isTerminal('APPROVAL_REJECTED')).toBe(true);
    expect(isTerminal('APPROVAL_EXPIRED')).toBe(true);
  });

  it('nothing after a refusal can be reached from DENIED, by any path', () => {
    for (const state of ALL.filter((s) => s !== 'DENIED' && s !== 'ABANDONED')) {
      // The only legitimate way a denied request moves again is a *new* request,
      // which starts at DRAFT with its own audit chain.
      expect(reachable('DENIED').has(state), state).toBe(false);
    }
  });
});

describe('lifecycle table — where money becomes movable', () => {
  it('makes TICKET_MINTED the single gate in front of every signing state', () => {
    // ARCHITECTURE §5: TICKET_MINTED -> SIGNING_PENDING is "the one edge where
    // money can still become movable". If RESERVED ever grows a direct edge to
    // SIGNING_PENDING the ticket has become bypassable, and this is the test that
    // catches it.
    expect(allowedTransitions('RESERVED')).toEqual(['TICKET_MINTED', 'DENIED', 'ABANDONED']);
    for (const state of SIGNING_STATES) {
      expect(reachable('RESERVED').has(state), `RESERVED cannot reach ${state}`).toBe(true);
    }
  });

  it('lets a timed-out sign be retried, but only back into signing', () => {
    // Reconciliation must be idempotent against a signer whose response was
    // lost, so SIGNING_TIMEOUT -> SIGNING_PENDING is the retry edge. It must not
    // be able to reach a *decision* again — that would be re-authorisation.
    expect(canTransition('SIGNING_TIMEOUT', 'SIGNING_PENDING')).toBe(true);
    expect(reachable('SIGNING_TIMEOUT').has('EVALUATING')).toBe(false);
    expect(reachable('SIGNING_TIMEOUT').has('TICKET_MINTED')).toBe(false);
  });
});

describe('releasesReservation — every branch that forgets is a self-inflicted lockout', () => {
  it('releases exactly the failure states that can follow a reservation', () => {
    // T13/T23: an unreleased reservation on a failed sign spends the daily cap
    // for a transaction that never happened. The list is the spec, so it is
    // asserted as a set rather than sampled.
    const expected = new Set<State>([
      'DENIED',
      'ABANDONED',
      'APPROVAL_REJECTED',
      'APPROVAL_EXPIRED',
      'SIGNING_FAILED',
      'SIGNING_TIMEOUT',
    ]);
    const actual = ALL.filter((state) => releasesReservation(state));
    expect(new Set(actual)).toEqual(expected);
  });

  it('never releases on a settled or in-flight success', () => {
    for (const state of ['SIGNING_COMPLETE', 'BROADCAST', 'BROADCAST_CONFIRMED', 'TICKET_MINTED'] as const) {
      expect(releasesReservation(state), state).toBe(false);
    }
  });

  it('releases on every terminal state except a confirmed payment', () => {
    for (const state of ALL) {
      if (!isTerminal(state) || state === 'BROADCAST_CONFIRMED') continue;
      expect(releasesReservation(state), `${state} is terminal but holds a reservation`).toBe(true);
    }
  });
});
