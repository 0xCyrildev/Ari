<p align="center">
  <img src="docs/assets/ari-logo.svg" alt="Ari" width="128" height="128">
</p>

# Ari

Permission infrastructure for autonomous money.

An AI agent asks to move funds. Ari decides whether it may, and the answer is
enforced by a boundary the agent cannot cross rather than by instructions it is
asked to follow.

```
Human intent → AI agent → Ari → Signing infrastructure → Blockchain
                              │
                policy · risk · simulation · approval · audit
```

The claim: **an agent can be autonomous without being unrestricted.**

The claim Ari does not make, and never documents: that the chain or the signer
enforces Ari's policy. They do not. Ari refuses deterministically and can prove
that it refused. That is a different product, and the difference matters
([`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md) §8.4, invariant **S12**).

## Why it exists

A prompt is not an access-control mechanism. So the boundary is drawn at the type
level and at the process boundary instead of at review time:

```
AI decides   what might be intended
Policy       decides what is permitted
Risk         decides what looks dangerous
Simulation   reports what the transaction appears to do
Authorization decides whether execution may proceed
Signer       signs
Chain        executes
```

No path exists in the type system from a model's output to a private key or a
signing call. The signer is a separate process that accepts only a sealed,
short-lived, single-use ticket, and it re-verifies that ticket against its own
key, its own clock and its own record of what has already been spent.

## Status

Built and tested: the policy engine, canonicalisation, the ledger's atomic
limit reservations, the ticket and the signer, policy versioning with the
broadening guard, human approvals, the risk plane (deterministic behavioural
baselines over Ari's own history — statistics, not a model), the pipeline that
joins them, the HTTP edge in front of it — organisation bootstrap behind a
deployment token, bearer credential authentication, `authorize`, an `evaluate`
preview that writes nothing, and request status — and the agent-side client that
calls it.

```ts
import { CandidateTransaction, createClient } from '@ari/client';

const ari = createClient({ baseUrl: 'http://127.0.0.1:4000', credential: agentCredential });
const candidate = CandidateTransaction.parse(/* … */);

const preview = await ari.evaluate(candidate);            // a preview: nothing is reserved
if (preview.ok && preview.value.decision.outcome === 'ALLOW') {
  const result = await ari.authorize({ candidate, idempotencyKey: 'invoice-42' });
  // 'COMPLETE' | 'SIGNING_PENDING' | 'DENIED' | 'APPROVAL_PENDING' | …
  // There is no `ari.sign()`, and no answer carries a ticket.
}
```

Built since that paragraph was written: the operator's and the approver's HTTP
surface (create an agent, issue its credential, register a wallet, activate a
policy, decide an approval, revoke an agent, read the trail — each gated on a
scope read from the credential row, not from what authentication returned), the
`ari` command line that drives it, a simulation plane that asks a real node, and the
reads a human surface needs to see a tenant at all: `GET /v1/transactions`,
`/v1/transactions/:id/record` (the row, its canonical bytes, the governing evaluation
and its own slice of the chain), `/v1/summary`, `/v1/wallets`, `/v1/policies`. Two of
their scopes had been mintable vocabulary with no route requiring them since before
there was a route that could ask.
No user-session model was invented to get there: an approver and an operator are
bearer credentials, the same shape an agent already had.

Still not built: the AI-assisted *explanation* of a risk score (the
score is computed; nothing here asks a model to justify it), Ika itself, and any
settlement or reconciliation of a signature against a chain. The signing provider
that works today is a mock; the simulation provider that works today answers about
a local chain. The console is built and wired to a deployment, with seven of its
screens refusing rather than faking.

The signing provider that works today is a mock, and it reports
`trustworthy: false` on its results rather than presenting a signature as chain
truth.

Read [`docs/ROADMAP.md`](docs/ROADMAP.md) for phase status and the command that
proves each one.

## Running it

```bash
pnpm install
pnpm db:up            # Postgres on 127.0.0.1:5435, Redis on 6381
pnpm typecheck
pnpm test             # everything: 680 tests / 43 files
pnpm test:unit        # the 415 that need no database
pnpm test:security    # the 265 that need Postgres, and do not skip without it
pnpm test:coverage
```

```bash
cp .env.example .env  # then fill in the secrets it names
pnpm seed             # org + owner + agent + wallet + policy, and two bearer credentials
pnpm --filter @ari/api start        # ari-api  → 127.0.0.1:4000
pnpm --filter @ari/signer start     # ari-signer → 127.0.0.1:4100
```

```bash
pnpm web:dev                         # the console → 127.0.0.1:3100 (port 3000 belongs to another project here)
pnpm web:build && pnpm --dir apps/web start   # the same app, served from a complete asset graph
pnpm web:typecheck && pnpm web:preflight      # the two gates over it, plus web:build
```

`apps/web` is the operator's, approver's and auditor's screen, and it is outside the pnpm
workspace on purpose: a Next/React/Tailwind toolchain inside `apps/*` would pull its resolution and
its build into `pnpm install`, `pnpm typecheck` and `pnpm test`, which are the three commands every
other gate here starts from. It keeps its own lockfile and its own `node_modules`.

The console reads a real deployment. The browser never talks to `ari-api`: it calls `/api/ari/*` on
its own origin and a Next route handler forwards to `ARI_API_URL`, so the payment API's
authentication surface gained no `Origin` concept for a frontend's benefit. That handler holds an
allowlist of method *and* path, which is what makes it a control rather than a tunnel — the two
routes that spend (`/v1/transactions/authorize`, `/evaluate`) and the three that mint human
authority behind the deployment token are refused there, so no browser tab can reach them even with
a credential pasted in.

What you paste is a bearer credential, not a password: `013` has no session model and none was
invented here. It lives in `sessionStorage`, so it dies with the tab. With it, the overview, the
transaction list, the approval queue, the audit trail and one request's own trace are live;
approve and reject send a real decision. Seven screens refuse instead of rendering sample rows
under a banner that names a real tenant, and each says what read it is waiting for.

Serve the build, not the dev server, when you are checking it in a browser: under Turbopack this
box races the browser ahead of the chunks it has not finished writing, hydration dies on a 403 for
a file that returns 200 a second later, and the page becomes a static picture of the sample tenant
that no credential can move.

`pnpm seed` is the one-command version of what `pnpm ari` now does route by route: an
empty database to the two credentials a working tenant needs — one an agent can ask for
money with, one a human can say yes with — through the same packages, as the same
unprivileged role, as the service itself. Each prints its secret once. Both are hashed
with Argon2id under a pepper that does not live in the database, so nothing — including
Ari — can read them back afterwards.

```bash
pnpm ari help                     # the operator's and the approver's command line
pnpm ari --bootstrap "$TOKEN" init --name "Acme Treasury"
```

`ari` is the operator surface: it holds a bearer secret and nothing else — no database
credentials, and no local path to authorise anything, because a tool that could decide a
payment offline would be a second decision plane with a second copy of the rules. Two of
its commands (`policy validate`, `verify chain`) are given no HTTP client at all, so they
work with no deployment in reach and cannot be pointed at one by a stale `ARI_URL`.

The two are different kinds of secret on purpose. `013` puts the separation in a CHECK: a
human credential cannot carry `transaction:request` and an agent credential cannot carry
`approval:decide`, so the subject that proposes a payment and the subject that approves it
are distinct in the row rather than in a route handler's good intentions. The live loop,
with both processes up:

```bash
# a $2,000 ask against a policy that escalates above $1,000
curl -X POST localhost:4000/v1/transactions/authorize -H "authorization: Bearer $AGENT" \
     -d '{"candidate":{…},"idempotencyKey":"live-2000"}'
# → {"state":"APPROVAL_PENDING","requestId":"txr_…","approvalId":"apr_…}

curl localhost:4000/v1/approvals -H "authorization: Bearer $APPROVER"
# → apr_…  2000000000 usdc-6dp  votes 0/1  digest canon/v1:7ff418…

curl -X POST localhost:4000/v1/approvals/apr_…/decisions -H "authorization: Bearer $APPROVER" \
     -d '{"decision":"APPROVED"}'
# → {"state":"GRANTED","votes":1,"approvalToken":"eyJ…"}     the seal goes to the human

# the same ask, once more, carrying that seal
# → {"state":"COMPLETE","requestId":"txr_…"}   same request id; nothing was re-decided
```

The agent's own credential gets `401` at the approver gate, and the token appears in no
response the agent can read: it authorises a signature, so it arrives from the person who
decided or not at all.

`ari-api` opens its database pool as the `ari_app` role (`DATABASE_ROLE`, which
defaults to it) and refuses to start if the connection does not come up as that
role. That is not tidiness: `ari` owns the tables, and an owner is outside row
security, so a service that "works" while connected as the owner is a service
whose tenant isolation rests entirely on its own `WHERE` clauses. The login role
needs `GRANT ari_app TO <login role>`.

The signing provider must be `mock` until the Ika adapter exists; `ari-signer`
exits rather than falling back to a mock when it is told otherwise, because a
config typo must not silently produce signatures that mean nothing.

## How to read this repository

| Document | What it is |
| --- | --- |
| [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md) | What is known, what is assumed, and what is not known yet. Read first. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The two planes, the invariants, and the ADRs |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | 25 threats, each with the mechanism that answers it |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases, each with an exit gate that is a command |

Every claim in the docs and in the code carries one of four labels: **VERIFIED**
(read from a file or command on this machine, re-derivable), **DOC-ONLY** (stated
by a vendor, unchecked), **ASSUMED** (our engineering choice), **NOT FOUND**
(looked, did not find). A test that does not exist is not described as one.

## Layout

```
apps/
  api/        the decision plane: HTTP edge, gateway, pipeline, signer delivery
  signer/     the authority plane: verifies tickets independently
  cli/        `ari`: the operator's and the approver's command line
  web/        the console: Next 16, outside the workspace, proxying to the API
packages/
  schemas/  policy-engine/  transaction-engine/  ledger/
  signing/  audit/  identity/  policies/  approvals/
  client/   risk-engine/  simulation/
migrations/ numbered SQL, 001–015, applied in order and idempotent by rule
tests/
  security/   suites that require real Postgres and do not skip without it
```

`policy-engine` and `transaction-engine` import nothing from `identity`,
`ledger`, `signing`, or any AI-adjacent package. That import graph is not
housekeeping: it is the statement "the model is not the security boundary",
written in a form the build system checks.

## Contributing

The invariants are in `docs/ARCHITECTURE.md` §10 and each one is enforced by a
type, a database constraint, or a named test. A "should" with no mechanism behind
it is not an invariant, and a README line that asserts a security property the
code does not hold is a defect — marketing copy is part of the threat model here.

## Licence

Business Source License 1.1, in `LICENSE`. Source is public; production use is
reserved to the licensor except as the Additional Use Grant allows, and every
version converts to an open licence on its Change Date.

The grant withholds one thing specifically, because it is the thing this
repository is for: running Ari as somebody else's permission infrastructure. A
deployment that evaluates payments and holds keys on behalf of third parties is
a commercial licence, not a self-host. Non-production use, internal use, and
running it for your own agents are all permitted, so evaluating this properly
does not require asking anyone.

If you want a different Change Date, a broader grant, or a licence that survives
being the authorization layer for a payment product, open an issue on this
repository. There is no domain yet, so there is deliberately no mailbox here to
point at — an address that bounces is worse than no address.
