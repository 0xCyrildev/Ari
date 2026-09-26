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
 *
 * Two commands are `local`, and the distinction is not about convenience. A local command
 * is one that must keep working with no deployment in reach — `policy validate` because an
 * author should learn what the compiler refuses while holding the document, and `verify
 * chain` because the person holding an export may be an auditor with no business querying
 * a tenant's tables. Both read the *same* compiler and the *same* chain walk the server
 * runs, imported rather than re-expressed, and neither is allowed to hold a token: `run()`
 * does not even resolve one for them.
 */

import { readFileSync } from 'node:fs';
import { GENESIS, verifyEventLog } from '@ari/audit';
import { Api } from './http.js';
import { Invalid } from './errors.js';
import { documentFrom, validatePolicy } from './policy.js';
import { parseEventList, parseExport, verifyExport } from './verify.js';
import {
  commaList,
  count,
  isBooleanFlag,
  optional,
  optionalCommaList,
  text,
  UsageError,
  type Flags,
} from './args.js';
import type { Json } from './http.js';

export interface Base {
  readonly flags: Flags;
  /** The result: JSON on stdout, so a script can read it. */
  readonly out: (value: unknown) => void;
  /** Anything that is a *delivery instruction* rather than a result — and any secret that
   * has to be shown at all. Never stdout, which is where the next command is reading. */
  readonly err: (line: string) => void;
}

export interface Context extends Base {
  readonly api: Api;
}

export interface CommandFields {
  readonly summary: string;
  /**
   * Every flag this command reads, declared, so `run()` can refuse one it does not find
   * here. A list nobody maintains is worse than no list, so the maintenance is a test:
   * `apps/cli/test/cli.test.ts` calls every command with a flag no command reads and
   * demands exit 2.
   */
  readonly takes: readonly string[];
}

export interface ApiCommand extends CommandFields {
  readonly local?: undefined;
  readonly run: (context: Context) => Promise<unknown>;
}

export interface LocalCommand extends CommandFields {
  readonly local: true;
  readonly run: (context: Base) => Promise<unknown>;
}

export type Command = ApiCommand | LocalCommand;

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

/** The candidate payload both `tx` commands read, checked once. */
function candidateFile(flags: Flags): Json {
  const file = jsonFile(text(flags, 'file'));
  if (typeof file.candidate !== 'object' || file.candidate === null) {
    throw new UsageError('the payload file must hold { "candidate": … , "idempotencyKey": "…" }');
  }
  return file;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const commands: Record<string, Command> = {
  'init': {
    summary: 'create an organisation, its first human, and that human’s credential (bootstrap token)',
    takes: ['bootstrap', 'name', 'email', 'display-name', 'scopes', 'ttl-ms'],
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
    takes: ['name'],
    async run({ api, flags }) {
      return api.call({ method: 'POST', path: '/v1/agents', body: { name: text(flags, 'name') } });
    },
  },

  'agent list': {
    summary: 'list this organisation’s agents',
    takes: [],
    async run({ api }) {
      return api.call({ method: 'GET', path: '/v1/agents' });
    },
  },

  'agent revoke': {
    summary: 'retire an agent and every credential it holds (terminal)',
    takes: ['agent'],
    async run({ api, flags, err }) {
      const agentId = text(flags, 'agent');
      const result = await api.call({ method: 'POST', path: `/v1/agents/${agentId}/revoke` });
      if (result.alreadyRevoked === true) {
        err(`ari: ${agentId} was already revoked — nothing changed, and nothing needed to`);
      } else {
        // The number is the point of the message. "Revoked" without "and two secrets stopped
        // working" is the half an operator cannot verify any other way, because a bearer
        // secret that is gone leaves no list behind it.
        err(`ari: revoked, and ${String(result.credentialsRevoked ?? 0)} credential(s) revoked with it`);
      }
      return result;
    },
  },

  'agent credential': {
    summary: 'issue an agent its bearer credential (printed once)',
    takes: ['agent', 'scopes', 'ttl-ms'],
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
    takes: ['name', 'mode', 'triple', 'provider', 'address'],
    async run({ api, flags }) {
      return api.call({
        method: 'POST',
        path: '/v1/wallets',
        body: {
          displayName: text(flags, 'name'),
          mode: text(flags, 'mode'),
          signatureTriple: text(flags, 'triple'),
          provider: optional(flags, 'provider') ?? 'mock',
          // Absent rather than empty: a wallet whose chain address is not known yet is a
          // real state (a dWallet being created does not mean its address is), and `''`
          // would be stored and then read back as an address.
          ...(optional(flags, 'address') === undefined ? {} : { address: text(flags, 'address') }),
        },
      });
    },
  },

  'wallet grant': {
    summary: 'let an agent spend a wallet under one policy version',
    takes: ['agent', 'wallet', 'policy-version'],
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
    takes: ['file', 'name', 'activate', 'justification'],
    async run({ api, flags }) {
      const file = jsonFile(text(flags, 'file'));
      const { name, document } = documentFrom(file);
      return api.call({
        method: 'POST',
        path: '/v1/policies',
        body: {
          // The document's own `meta.name` is the default, because a policy whose stored name
          // and printed name can differ is a support thread about which one was activated.
          name: name ?? 'applied',
          document,
          activate: isBooleanFlag(flags, 'activate'),
          ...(optional(flags, 'justification') === undefined ? {} : { justification: text(flags, 'justification') }),
        },
      });
    },
  },

  'policy validate': {
    local: true,
    summary: 'check a policy document with no server: schema, compiler, and what it permits',
    takes: ['file'],
    async run({ flags, out }) {
      const file = jsonFile(text(flags, 'file'));
      const report = validatePolicy(documentFrom(file).document);
      // Printed by the command rather than returned, because the refusal *is* the output: a
      // caller that got exit 1 and no list of fields would have to guess which of the forty
      // lines it wrote is the one the compiler objects to.
      out(report);
      if (!report.ok) {
        throw new Invalid(
          'POLICY_INVALID',
          `${report.refusals.length} refusal(s) — the document was not applied, and cannot be`,
        );
      }
      return undefined;
    },
  },

  'tx authorize': {
    summary: 'ask Ari to authorise a candidate transaction',
    takes: ['file', 'agent-token'],
    async run({ api, flags }) {
      const file = candidateFile(flags);
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

  'tx evaluate': {
    summary: 'ask what the policy would decide, and commit nothing',
    takes: ['file', 'agent-token'],
    async run({ api, flags, err }) {
      const file = candidateFile(flags);
      const agentToken = optional(flags, 'agent-token');
      const result = await api.call({
        method: 'POST',
        path: '/v1/transactions/evaluate',
        ...(agentToken === undefined ? {} : { token: agentToken }),
        body: file,
      });
      // A preview that answers `{"state":"DENIED"}` and nothing else invites the question
      // "but would it really", and the answer is the one thing this route cannot give: it
      // reserves nothing, so a preview of a limit is a preview against the counter *now*.
      err('ari: this was a preview — no reservation, no ticket, no audit row for the decision');
      return result;
    },
  },

  'approvals list': {
    summary: 'what is waiting on you',
    takes: [],
    async run({ api }) {
      return api.call({ method: 'GET', path: '/v1/approvals' });
    },
  },

  'approvals decide': {
    summary: 'approve or refuse one pending approval',
    takes: ['id', 'decision'],
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
    takes: ['out'],
    async run({ api, flags }) {
      // No `after`/`limit`: this is the whole chain, and the whole chain is the only thing
      // that may be called a `head`.
      const log = await api.call({ method: 'GET', path: '/v1/audit/events' });
      const path = optional(flags, 'out');
      if (path === undefined) return log;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
      return { written: path, events: (log.events as unknown[]).length, head: log.head };
    },
  },

  'audit tail': {
    summary: 'follow the chain, re-verifying every link as it arrives',
    takes: ['once', 'interval-ms', 'limit', 'from', 'head'],
    async run({ api, flags, out }) {
      const intervalMs = count(flags, 'interval-ms', 1_000, 600_000);
      const limit = count(flags, 'limit', 200, 5_000);
      const once = isBooleanFlag(flags, 'once');
      const from = optional(flags, 'from');
      const head = optional(flags, 'head');

      if (head !== undefined && head !== GENESIS && !/^[0-9a-f]{64}$/.test(head)) {
        throw new UsageError(`--head must be a chain hash (64 hex) or the word "${GENESIS}"`);
      }
      if (from !== undefined && head === undefined) {
        // The refusal is the feature. A window that starts at seq 5,000 with no anchor checks
        // every link *after* the first and has nothing to check the first against, so it
        // proves the file is internally consistent — which is exactly the claim a rebuilt
        // chain can fake. Either walk from genesis or bring the hash you already trust.
        throw new UsageError('--from needs --head: a window that starts mid-chain proves nothing about its own first link');
      }
      if (head !== undefined && from === undefined && head !== GENESIS) {
        throw new UsageError('--head is an anchor for a window; pair it with --from, or use `verify chain --head` for a whole export');
      }

      let expectedPrev = head ?? GENESIS;
      let cursor = from;
      let verified = 0;
      for (;;) {
        const query = `/v1/audit/events?limit=${limit}${cursor === undefined ? '' : `&after=${cursor}`}`;
        const page = await api.call({ method: 'GET', path: query });
        const events = parseEventList(page.events);
        const report = verifyEventLog(events, expectedPrev);
        if (!report.ok) {
          out({ ok: false, verified, through: cursor ?? null, breaks: report.breaks });
          throw new Invalid('CHAIN_BREAK', 'the chain parted — the breaks above name the seq that failed');
        }
        expectedPrev = report.head;
        verified += events.length;
        const nextCursor = typeof page.nextCursor === 'string' ? page.nextCursor : cursor;
        cursor = nextCursor;
        // One object per poll, events nested: a stream of loose JSON values is what `jq`
        // reads, and a tail that emitted a bare object per event would be indistinguishable
        // from the export command's output to anything parsing the pipe.
        out({
          ok: true,
          events: events.map((event) => ({
            seq: event.seq,
            madeAt: event.madeAt,
            eventType: event.eventType,
            actorType: event.actorType,
            actor: event.actor,
            resource: event.resource,
            resourceId: event.resourceId,
            request: event.request,
            decision: event.decision,
            reasons: event.reasons,
          })),
          verified,
          through: cursor,
          // The hash worth writing down, at the moment the operator is watching. This is the
          // value that turns a later export from a story into evidence.
          head: report.head,
        });
        if (once || events.length === 0) return undefined;
        await sleep(intervalMs);
      }
    },
  },

  'verify chain': {
    local: true,
    summary: 'check an exported chain, optionally against a head hash held elsewhere',
    takes: ['in', 'head'],
    async run({ flags, out }) {
      const raw = JSON.parse(readFileSync(text(flags, 'in'), 'utf8')) as unknown;
      const verdict = verifyExport(parseExport(raw), optional(flags, 'head'));
      // Printed by the command rather than returned, because the failure case *is* the
      // output: a refusal that hid the break list would tell an auditor "no" and nothing
      // about where the chain parted.
      out(verdict);
      if (!verdict.ok) {
        // `Invalid`, not `Refusal` — and the difference is that this no was never an HTTP
        // status. `Refusal(1, …)` used to borrow the field for the exit code, so the tool
        // printed `refused (1 CHAIN_BREAK)`, a number that meant one thing to the runner and
        // read as another to everyone else.
        throw new Invalid('CHAIN_BREAK', 'the export does not verify — see the breaks above');
      }
      return undefined;
    },
  },
};

const OPERATOR_SCOPES = ['approval:decide', 'agent:manage', 'wallet:manage', 'policy:activate', 'audit:read', 'transaction:read'];

/** The default is not a licence to be vague: an omitted flag takes the operator set. */
function scopesFrom(flags: Flags): string[] {
  return optionalCommaList(flags, 'scopes') ?? OPERATOR_SCOPES;
}

export const usage = Object.entries(commands).map(
  ([name, command]) => `  ${name.padEnd(18)}${command.summary}${command.local === true ? ' [no server]' : ''}`,
);
