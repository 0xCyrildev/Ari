/**
 * Policy validation, with no server and no database.
 *
 * This is the same two checks `POST /v1/policies` makes, in the same order, imported
 * rather than re-expressed: `PolicyDocument.parse` is what `parseDocument` calls, and
 * `compilePolicy` is what `createPolicy` calls before it inserts a row. Both live in
 * packages that perform no I/O at all (A4), which is *why* an operator can validate a
 * document on a laptop with no deployment to point at — and the reason a validator that
 * reached for a connection would be wrong here is not performance, it would be that the
 * second copy of the rule is the thing that drifts.
 *
 * What a green report does **not** mean is listed in `notChecked`, and that list is not
 * decoration. Activation additionally compares this document's breadth against the
 * version currently live, and asks whether the actor owns a widening — `ari policy
 * validate` cannot see either, and an operator who read `ok: true` as "this will go
 * live" would be surprised by exactly the check that stops a policy getting looser while
 * nobody is looking.
 */

import { PolicyCompilationError, compilePolicy } from '@ari/policy-engine';
import { PolicyDocument } from '@ari/schemas';

export interface Refusal {
  readonly stage: 'SCHEMA' | 'COMPILE';
  readonly field: string;
  readonly message: string;
}

export interface PermitReport {
  readonly transfers: boolean;
  readonly chains: readonly string[];
  readonly assets: readonly string[];
  readonly recipients: number;
  readonly perTransactionRaw: string;
  readonly perDayRaw: string;
  readonly perMonthRaw: string | null;
  readonly unit: string;
  readonly maxTransactionsPerHour: number;
  readonly contractCalls: boolean;
  readonly contracts: number;
  readonly newRecipients: { readonly allowed: boolean; readonly requireApproval: boolean };
}

export interface Report {
  readonly ok: boolean;
  readonly name: string;
  readonly refusals: readonly Refusal[];
  readonly walletId: string | null;
  readonly authorityMode: string | null;
  readonly permits: PermitReport | null;
  readonly escalatesWhen: readonly string[];
  readonly quorum: { readonly needed: number; readonly roles: readonly string[] } | null;
  readonly fallback: Record<string, string> | null;
  readonly notChecked: readonly string[];
}

/** The fields this command cannot possibly know, printed so nobody infers them. */
const NOT_CHECKED = [
  'whether the wallet, chain or asset named here exists on any deployment',
  'whether this version is a widening of the one currently active, which is what activation asks',
  'whether the person activating holds the authority a widening requires',
  'whether any of the escalations will fire, which depends on usage history this document cannot see',
] as const;

/**
 * A policy file is either the document itself or `{ name, document }`, which is the shape
 * `policy apply` sends. One function decides, because two would mean `validate` and
 * `apply` disagreeing about what a file is — and the day they do, a document that validates
 * is a document that refuses to apply, for a reason no error message names.
 */
export function documentFrom(file: Record<string, unknown>): {
  readonly name: string | undefined;
  readonly document: unknown;
} {
  const document = typeof file.document === 'object' && file.document !== null ? file.document : file;
  const name = typeof file.name === 'string' ? file.name : undefined;
  const meta = (document as { meta?: unknown }).meta;
  const metaName =
    typeof meta === 'object' && meta !== null && typeof (meta as { name?: unknown }).name === 'string'
      ? (meta as { name: string }).name
      : undefined;
  return { name: name ?? metaName, document };
}

function topLevelName(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const name = (raw as { name?: unknown }).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function describe(condition: { op: string } & Record<string, unknown>): string {
  const detail = Object.entries(condition)
    .filter(([key]) => key !== 'op')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  return detail.length === 0 ? condition.op : `${condition.op} ${detail}`;
}

export function validatePolicy(raw: unknown): Report {
  const parsed = PolicyDocument.safeParse(raw);

  const name = parsed.success ? parsed.data.meta.name : (topLevelName(raw) ?? '(unparsed)');

  if (!parsed.success) {
    return {
      ok: false,
      name,
      refusals: parsed.error.issues.map((issue) => ({
        stage: 'SCHEMA',
        field: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
      walletId: null,
      authorityMode: null,
      permits: null,
      escalatesWhen: [],
      quorum: null,
      fallback: null,
      notChecked: NOT_CHECKED,
    };
  }

  const document = parsed.data;
  // Placeholder identifiers, and they have to be: `compilePolicy` takes the ids it stamps
  // into the compiled form, and a validator has none. They are not printed, because a
  // version id that looked real would be the one thing an operator could copy into a
  // grant — and `005`/`010`'s whole design is that a version is a row, not a string.
  let compiled;
  try {
    compiled = compilePolicy(document, { policyId: 'pol_unvalidated', versionId: 'ppv_unvalidated', versionNumber: 1 });
  } catch (error) {
    if (!(error instanceof PolicyCompilationError)) throw error;
    return {
      ok: false,
      name: document.meta.name,
      refusals: [{ stage: 'COMPILE', field: error.field, message: error.message }],
      walletId: document.target.walletId,
      authorityMode: document.target.authorityMode,
      permits: null,
      escalatesWhen: [],
      quorum: null,
      fallback: null,
      notChecked: NOT_CHECKED,
    };
  }

  return {
    ok: true,
    name: document.meta.name,
    refusals: [],
    walletId: document.target.walletId,
    authorityMode: document.target.authorityMode,
    permits: {
      transfers: compiled.transfers.enabled,
      chains: [...compiled.transfers.chains].sort(),
      assets: [...compiled.transfers.assets].sort(),
      recipients: compiled.transfers.recipients.size,
      // Bigints are printed as decimal strings — the same boundary rule the wire and the
      // ledger follow, and the reason `raw` is in the field name. A JSON number cannot hold
      // 10^30 wei, and a report that rounded one would be a report that lied about a cap.
      perTransactionRaw: compiled.transfers.perTransactionRaw.toString(),
      perDayRaw: compiled.transfers.perDayRaw.toString(),
      perMonthRaw: compiled.transfers.perMonthRaw === null ? null : compiled.transfers.perMonthRaw.toString(),
      unit: compiled.transfers.amountUnit,
      maxTransactionsPerHour: compiled.transfers.maxTransactionsPerHour,
      contractCalls: compiled.contractCalls.enabled,
      contracts: compiled.contractCalls.contracts.size,
      newRecipients: {
        allowed: document.permissions.newRecipients.allowed,
        requireApproval: document.permissions.newRecipients.requireApproval,
      },
    },
    escalatesWhen: document.escalation.humanApproval.requiredWhen.map(describe),
    quorum: {
      needed: document.escalation.humanApproval.quorum,
      roles: document.escalation.humanApproval.approverRoles,
    },
    fallback: { ...document.fallback },
    notChecked: NOT_CHECKED,
  };
}
