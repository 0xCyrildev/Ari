/**
 * The commands, one table.
 *
 * Nothing here holds policy logic, checks a limit, or decides anything about a payment.
 * Every command is a thin call to `ari-api` and a print of what came back — which is the
 * point. An operator's tool that could authorise a transaction locally would be a second
 * decision plane with a second copy of the rules, and this repository has already learned
 * twice what two copies of a state machine get you. The CLI holds a bearer secret and
 * nothing else: it has exactly the power the API gives it, and no database credentials at
 * all.
 */

import { readFileSync } from 'node:fs';
import { Api, Refusal } from './http.js';
import { commaList, isBooleanFlag, optional, optionalCommaList, text, UsageError, type Flags } from './args.js';
import { parseExport, verifyExport } from './verify.js';
import type { Json } from './http.js';

export interface Context {
  readonly api: Api;
  readonly flags: Flags;
  /** The result: JSON on stdout, so a script can read it. */
  readonly out: (value: unknown) => void;
  /** Anything that is a *delivery instruction* rather than a result — and any secret that
   * has to be shown at all. Never stdout, which is where the next command is reading. */
  readonly err: (line: string) => void;
}

export interface Command {
  readonly summary: string;
  readonly run: (context: Context) => Promise<unknown>;
}

function jsonFile(path: string): Json {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new UsageError(`--file ${path} could not be read: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw) as Json;
  } catch {
    throw new UsageError(`${path} is not JSON`);
  }
}

export const commands: Record<string, Command> = {
  'init': {
    summary: 'create an organisation, its first human, and that human’s credential (bootstrap token)',
    async run({ api, flags }) {
      const bootstrap = text(flags, 'bootstrap');
      const name = optional(flags, 'name') ?? 'Ari tenant';
      const email = optional(flags, 'email') ?? `owner@${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.test`;
      const org = await api.call({
        method: 'POST',
        path: '/v1/organizations',
        token: bootstrap,
        body: { name, ownerEmail: email, ownerDisplayName: optional(flags, 'display-name') ?? 'Owner' },
      });
      // `POST /v1/organizations` already creates the owner — a user who cannot be pointed at
      // anything is a tenant nobody can administer — so `init` uses the identifier that came
      // back rather than minting a second person with the same email, which the unique index
      // on `(org_id, email)` refuses. `POST /v1/users` is for the *next* human.
      const organizationId = String(org.organizationId);
      const userId = String(org.ownerId);
      const withBootstrap = new Api(api.base, bootstrap);
      const credential = await withBootstrap.call({
        method: 'POST',
        path: `/v1/users/${userId}/credentials`,
        body: {
          organizationId,
          // `--scopes` if given, and otherwise the operator set — deliberately not
          // `transaction:request`. The person who runs this command can manage agents,
          // activate policies, decide approvals and read the trail, and cannot propose a
          // payment: that is `013`'s CHECK, and the reason one credential is not enough for
          // a working tenant.
          scopes: scopesFrom(flags),
          ttlMs: optional(flags, 'ttl-ms') ?? '86400000',
        },
      });
      return {
        organizationId,
        userId,
        credentialId: credential.credentialId,
        bearer: credential.bearer,
        expiresAt: credential.expiresAt,
        note: 'the bearer above is printed once and cannot be read back; store it now',
      };
    },
  },

  'agent create': {
    summary: 'register an agent',
    async run({ api, flags }) {
      return api.call({ method: 'POST', path: '/v1/agents', body: { name: text(flags, 'name') } });
    },
  },

  'agent list': {
    summary: 'list this organisation’s agents',
    async run({ api }) {
      return api.call({ method: 'GET', path: '/v1/agents' });
    },
  },

  'agent credential': {
    summary: 'issue an agent its bearer credential (printed once)',
    async run({ api, flags }) {
      return api.call({
        method: 'POST',
        path: `/v1/agents/${text(flags, 'agent')}/credentials`,
        body: { scopes: commaList(flags, 'scopes'), ttlMs: optional(flags, 'ttl-ms') ?? '86400000' },
      });
    },
  },

  'wallet create': {
    summary: 'register a wallet and the guarantee it offers',
    async run({ api, flags }) {
      return api.call({
        method: 'POST',
        path: '/v1/wallets',
        body: {
          displayName: text(flags, 'name'),
          mode: text(flags, 'mode'),
          signatureTriple: text(flags, 'triple'),
          provider: optional(flags, 'provider') ?? 'mock',
        },
      });
    },
  },

  'wallet grant': {
    summary: 'let an agent spend a wallet under one policy version',
    async run({ api, flags }) {
      return api.call({
        method: 'POST',
        path: `/v1/agents/${text(flags, 'agent')}/wallets/${text(flags, 'wallet')}`,
        body: { policyVersionId: text(flags, 'policy-version') },
      });
    },
  },

  'policy apply': {
    summary: 'create a policy from a document, and activate it (--activate)',
    async run({ api, flags }) {
      const file = jsonFile(text(flags, 'file'));
      return api.call({
        method: 'POST',
        path: '/v1/policies',
        body: {
          name: optional(flags, 'name') ?? String(file.name ?? 'applied'),
          document: file.document ?? file,
          activate: isBooleanFlag(flags, 'activate'),
          ...(optional(flags, 'justification') === undefined ? {} : { justification: text(flags, 'justification') }),
        },
      });
    },
  },

  'tx authorize': {
    summary: 'ask Ari to authorise a candidate transaction',
    async run({ api, flags }) {
      const file = jsonFile(text(flags, 'file'));
      if (typeof file.candidate !== 'object' || file.candidate === null) {
        throw new UsageError('the payload file must hold { "candidate": … , "idempotencyKey": "…" }');
      }
      const agentToken = optional(flags, 'agent-token');
      return api.call({
        method: 'POST',
        path: '/v1/transactions/authorize',
        // An agent's credential, not the operator's: the payment is proposed by the subject
        // whose caps and approvers the policy is written against, and `ARI_TOKEN` here is the
        // operator's. `--agent-token` is what makes the ask *be* the agent's ask.
        ...(agentToken === undefined ? {} : { token: agentToken }),
        body: file,
      });
    },
  },

  'approvals list': {
    summary: 'what is waiting on you',
    async run({ api }) {
      return api.call({ method: 'GET', path: '/v1/approvals' });
    },
  },

  'approvals decide': {
    summary: 'approve or refuse one pending approval',
    async run({ api, flags, err }) {
      const decision = text(flags, 'decision');
      if (decision !== 'APPROVED' && decision !== 'REJECTED') {
        throw new UsageError('--decision must be APPROVED or REJECTED');
      }
      const result = await api.call({
        method: 'POST',
        path: `/v1/approvals/${text(flags, 'id')}/decisions`,
        body: { decision },
      });
      if (typeof result.approvalToken === 'string') {
        // The seal is printed for the human who decided, and this is the one place in the
        // tool where a capability is written to a terminal on purpose. It authorises one
        // signature for one digest, and it is what the agent needs to finish.
        err(`hand this to the agent: ${String(result.approvalToken)}`);
      }
      return result;
    },
  },

  'audit export': {
    summary: 'write this organisation’s audit chain to a file',
    async run({ api, flags }) {
      const log = await api.call({ method: 'GET', path: '/v1/audit/events' });
      const path = optional(flags, 'out');
      if (path === undefined) return log;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
      return { written: path, events: (log.events as unknown[]).length, head: log.head };
    },
  },

  'verify chain': {
    summary: 'check an exported chain, optionally against a head hash held elsewhere',
    async run({ flags, out }) {
      const raw = JSON.parse(readFileSync(text(flags, 'in'), 'utf8')) as unknown;
      const verdict = verifyExport(parseExport(raw), optional(flags, 'head'));
      // Printed by the command rather than returned, because the failure case *is* the
      // output: a refusal that hid the break list would tell an auditor "no" and nothing
      // about where the chain parted.
      out(verdict);
      if (!verdict.ok) throw new Refusal(1, 'CHAIN_BREAK', 'the export does not verify — see the breaks above');
    },
  },
};

const OPERATOR_SCOPES = ['approval:decide', 'agent:manage', 'wallet:manage', 'policy:activate', 'audit:read', 'transaction:read'];

/** The default is not a licence to be vague: an omitted flag takes the operator set. */
function scopesFrom(flags: Flags): string[] {
  return optionalCommaList(flags, 'scopes') ?? OPERATOR_SCOPES;
}

export const usage = Object.entries(commands).map(([name, command]) => `  ${name.padEnd(18)}${command.summary}`);
