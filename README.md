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
broadening guard, human approvals, the pipeline that joins them, the HTTP edge in
front of it — organisation bootstrap behind a deployment token, bearer credential
authentication, `authorize`, an `evaluate` preview that writes nothing, and
request status — and the agent-side client that calls it.

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

Not built: the CLI, the intent and risk engines, simulation, the dashboard, and
any real chain integration. The endpoints a *human* needs — create an agent,
issue its credential, decide an approval, activate a policy — are not there
either, because Ari has no user-session model yet and inventing one inside a
route handler would be a security decision made as a side effect. Until then
those are performed against the packages directly, which is what the test suites
do.

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
pnpm test             # everything, including the suites that need Postgres
pnpm test:unit        # the half that needs no database
pnpm test:security    # transactions, triggers, grants, row security
pnpm test:coverage
```

```bash
cp .env.example .env  # then fill in the secrets it names
pnpm --filter @ari/api start        # ari-api  → 127.0.0.1:4000
pnpm --filter @ari/signer start     # ari-signer → 127.0.0.1:4100
```

`ari-api` opens its database pool as the `ari_app` role (`DATABASE_ROLE`, which
defaults to it) and refuses to start if the connection does not come up as that
role. That is not tidiness: `ari` owns the tables, and an owner is outside row
security, so a service that "works" while connected as the owner is a service
whose tenant isolation rests entirely on its own `WHERE` clauses.

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
packages/
  schemas/  policy-engine/  transaction-engine/  ledger/
  signing/  audit/  identity/  policies/  approvals/  client/
migrations/ numbered SQL, applied in order
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

No licence file. All rights reserved pending a commercial decision.
