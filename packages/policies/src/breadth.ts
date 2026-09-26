/**
 * How wide a policy is, and what it means for that to change.
 *
 * §7.3's guard is "activation is rejected if the new version is strictly broader
 * than the active one in any monetary or recipient dimension and the actor is not
 * `owner`". Implementing that needs a comparison that does not depend on how the
 * document happened to be written: two documents that grant the same authority in
 * different field orders must compare equal, and one that adds a single recipient
 * must not.
 *
 * So breadth is measured on the *granted sets and ceilings*, and a widening names
 * the dimension it came from. Naming it is not politeness — the dashboard's
 * broadening banner and the audit reader both need "the daily cap went from X to Y",
 * not "something got looser".
 */

import { compilePolicy, type CompiledPolicy } from '@ari/policy-engine';
import { PolicyDocument, type PolicyDocument as Document } from '@ari/schemas';

export interface Breadth {
  readonly transfersEnabled: boolean;
  readonly contractCallsEnabled: boolean;
  readonly perTransactionRaw: bigint;
  readonly perDayRaw: bigint;
  /** null means "not bounded", which is wider than any number. */
  readonly perMonthRaw: bigint | null;
  readonly maxTransactionsPerHour: number;
  readonly chains: readonly string[];
  readonly assets: readonly string[];
  readonly recipients: readonly string[];
  readonly contracts: readonly string[];
  readonly newRecipientsAllowed: boolean;
  readonly escalationRules: number;
  readonly signingBudgetRaw: bigint;
}

export interface Widening {
  readonly dimension: string;
  readonly from: string;
  readonly to: string;
}

export function breadthOf(compiled: CompiledPolicy): Breadth {
  return {
    transfersEnabled: compiled.transfers.enabled,
    contractCallsEnabled: compiled.contractCalls.enabled,
    perTransactionRaw: compiled.transfers.perTransactionRaw,
    perDayRaw: compiled.transfers.perDayRaw,
    perMonthRaw: compiled.transfers.perMonthRaw,
    maxTransactionsPerHour: compiled.transfers.maxTransactionsPerHour,
    chains: [...compiled.transfers.chains].sort(),
    assets: [...compiled.transfers.assets].sort(),
    recipients: [...compiled.transfers.recipients].sort(),
    contracts: [...compiled.contractCalls.contracts].sort(),
    newRecipientsAllowed: compiled.newRecipients.allowed,
    escalationRules: compiled.escalation.length,
    signingBudgetRaw: compiled.validity.maxIkaRawPerDay,
  };
}

export function compileToBreadth(document: Document): Breadth {
  return breadthOf(
    compilePolicy(document, {
      policyId: 'pol_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
      versionId: 'ppv_0194a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b',
      versionNumber: 1,
    }),
  );
}

function added(before: readonly string[], after: readonly string[]): string[] {
  const have = new Set(before);
  return after.filter((entry) => !have.has(entry));
}

/** Bigint or null rendered for an audit reader who has to compare two values. */
function show(value: bigint | number | null | boolean): string {
  if (value === null) return 'unbounded';
  return String(value);
}

/**
 * Every way `after` grants more than `before`.
 *
 * An empty array means the change is neutral or narrowing and needs no owner to
 * make it. Anything in the array means someone with less authority than an owner is
 * asking to move money's boundaries, which is the attack this exists to stop.
 */
export function widenings(before: Breadth, after: Breadth): Widening[] {
  const found: Widening[] = [];
  const ceiling = (name: string, from: bigint | null, to: bigint | null): void => {
    if (from === null) return;
    if (to === null || to > from) found.push({ dimension: name, from: show(from), to: show(to) });
  };

  ceiling('permissions.transfers.perTransaction', before.perTransactionRaw, after.perTransactionRaw);
  ceiling('permissions.transfers.perDay', before.perDayRaw, after.perDayRaw);
  ceiling('permissions.transfers.perMonth', before.perMonthRaw, after.perMonthRaw);

  if (after.maxTransactionsPerHour > before.maxTransactionsPerHour) {
    found.push({
      dimension: 'permissions.transfers.maxTransactionsPerHour',
      from: show(before.maxTransactionsPerHour),
      to: show(after.maxTransactionsPerHour),
    });
  }
  if (after.signingBudgetRaw > before.signingBudgetRaw) {
    found.push({
      dimension: 'validity.signingBudget.maxIkaRawPerDay',
      from: show(before.signingBudgetRaw),
      to: show(after.signingBudgetRaw),
    });
  }
  if (!before.transfersEnabled && after.transfersEnabled) {
    found.push({ dimension: 'permissions.transfers.enabled', from: 'false', to: 'true' });
  }
  if (!before.contractCallsEnabled && after.contractCallsEnabled) {
    found.push({ dimension: 'permissions.contractCalls.enabled', from: 'false', to: 'true' });
  }
  if (!before.newRecipientsAllowed && after.newRecipientsAllowed) {
    found.push({ dimension: 'permissions.newRecipients.allowed', from: 'false', to: 'true' });
  }
  if (before.escalationRules > 0 && after.escalationRules < before.escalationRules) {
    found.push({
      dimension: 'escalation.humanApproval.requiredWhen',
      from: `${before.escalationRules} rules`,
      to: `${after.escalationRules} rules`,
    });
  }

  for (const [dimension, entries] of [
    ['permissions.transfers.recipients', added(before.recipients, after.recipients)],
    ['permissions.transfers.assets', added(before.assets, after.assets)],
    ['permissions.transfers.chains', added(before.chains, after.chains)],
    ['permissions.contractCalls.contracts', added(before.contracts, after.contracts)],
  ] as const) {
    if (entries.length > 0) {
      found.push({
        dimension,
        from: `${entries.length} new: ${entries.slice(0, 3).join(', ')}`,
        to: 'requested',
      });
    }
  }

  return found;
}

export function parseDocument(stored: unknown): Document {
  return PolicyDocument.parse(stored);
}

/** JSON with big integers as decimal strings — the same boundary rule as the wire. */
export function serializeDocument(document: Document): string {
  return JSON.stringify(document, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}
