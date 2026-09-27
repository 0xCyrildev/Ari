# ARI — project memory

**Ari is not a security target.** Work here as an engineer, not as PREDATOR; the auditing discipline in
`~/AGENTS.md` (separate mechanism from severity, never report a guess as a finding, run a control before
asserting) still applies to everything, and it is the reason this repo's claims are all test-backed.

Permission infrastructure for autonomous money: an AI agent asks to pay, a compiled policy decides
`ALLOW | REQUIRE_HUMAN_APPROVAL | DENY`, a sealed single-use ticket releases a signature in a second
process. Ika dWallets are the eventual signer. Read `docs/ASSUMPTIONS.md` first, then `ARCHITECTURE.md`,
then `ROADMAP.md`, then `THREAT_MODEL.md`.

## State — 2026-09-26 (third pass)

| Phase | Status | Evidence |
|---|---|---|
| 0 discovery | done | four docs, 1,750 lines, every claim labelled VERIFIED / DOC-ONLY / ASSUMED / NOT-FOUND |
| 1 core domain | done | migrations `001–014`, `@ari/identity` (tenancy, credentials, wallets, grants, requests), `@ari/audit` (chain + role grants), RLS on every tenant table — and `tests/security/schema.test.ts` asks the catalogue, not the code |
| 2 policy engine | done | 76 tests + `tests/security/` on real Postgres; 98.75 % branch on the kernel |
| 3 signing boundary | done | `packages/signing`, `apps/signer`, `002` ALLOW-before-ticket trigger |
| 3.5 policy lifecycle | done | `@ari/policies`: draft→activate, breadth comparison, owner-only widening, justification on rollback |
| 6 approvals | done | `@ari/approvals` + `006`/`009`/`013`; 21 DB tests on the bound token, quorum, replay and T19, and the approver's half over HTTP — queue, decision, seal — in `tests/security/api.test.ts` |
| 5 risk engine | done | `packages/risk-engine`: deterministic baselines over `transaction_requests`, nine signals, 10 property/unit tests + 17 DB tests including both halves of the Phase 5 gate |
| spine | done | `apps/api/src/authorize.ts` + `tests/security/pipeline.test.ts`: evaluate→reserve→decide→ticket→sign, 11 tests walking the brief's own scenarios |
| HTTP edge | done | `apps/api/src/{gateway,routes,signer-client,server}.ts` + `tests/security/api.test.ts`: 22 tests through `inject`, and both processes run for real (see "Ran for real" below) |
| agent SDK | partial | `packages/client`: the outbound half of the decimal-string rule, three methods (evaluate, authorize, status), 19 tests, and 2 contract tests that run the client's transport against the real routes. The `agents.*`/`policies.*` half of `ROADMAP`'s Phase 9 is **not** in it, and is not planned to be: those became operator HTTP routes driven by `ari`, because an agent that could create an agent or activate a policy would be a second decision plane with a bearer secret |
| 7 simulation | done | `packages/simulation`: `eth_call` against a real anvil, advisory by A10, and the digest binding asserted from both sides — see "Ran against a chain" below |
| 9 CLI | done | `apps/cli`: the operator's and the approver's tool, 16 commands, `policy validate` against a 23-case corpus, and its own socket-level suite |
| 4, 8, 11 | not started | intent, Ika (blocked on §6), security review |
| 10 dashboard | built, not wired | `apps/dashboard`: React 19 + Vite 8 + Tailwind 4, 18 source files, landing page plus the ten control-center screens, rebuilt once against the design gate below. Gates: `pnpm typecheck:ui`, `pnpm ui:preflight`, `pnpm ui:build`. The vocabulary is the engine's own — every status, reason code, signal and event type is copied from a named package — and the data is one labelled sample tenant. No route is wired to `ari-api` yet. |

`pnpm test` is **536 tests / 30 files**, in two halves that add up to it: `pnpm test:unit` is the
**305** that need no database (`packages`, `tests/unit`, `apps`), `pnpm test:security` is the **231** that
need Postgres and do not skip without it. `tests/security/simulation.test.ts` needs Postgres **and**
`anvil`; it starts its own on 127.0.0.1:8561 and refuses to run if that port is already taken. They did not always add up: `test:security` was
`vitest run --dir tests/security`, which on vitest 5 matches **no files** at all. Positional filters are
used now, and the two numbers are written down because "the security gate is green" has to mean the
security gate ran.

`pnpm typecheck && pnpm test` — needs no database for the unit half. `test:security` needs
`pnpm db:up` (Postgres on **127.0.0.1:5435**, Redis 6381; 5432/5433/6380 belong to other projects on this
box, see `ASSUMPTIONS.md` §1). It **does not skip** when the database is absent, deliberately.
`pnpm test:coverage` measures the kernel. Coverage for `ledger` and the negative path lives in
`tests/security/`, not in the packages.

## Decisions made here, that a later session must not quietly reverse

- **The digest is derived inside the policy engine, never accepted from the caller.** `evaluate()` used to
  take `state.digest`, which let a composition root ALLOW against one candidate while sealing another's
  bytes. `ALLOW`/`REQUIRE_HUMAN_APPROVAL` now carry the digest they evaluated; `DENY` carries none, so a
  candidate the canonicaliser refuses stays deniable.
- **One digest allowlist**, in `@ari/schemas` (`DIGEST_FIELD_ALLOWLIST`), plus
  `DELIBERATELY_NOT_IN_DIGEST`. A test derives every candidate key from the Zod schemas and demands each be
  either digested or excluded — that is what fails when someone adds a field without deciding whether it is
  substitution-critical. Never reintroduce a second copy.
- **Money is `bigint`; the canonical encoder refuses `number` outright.** `decimals` parses to `bigint`
  through `SmallCount` rather than carving out an exception the money path could later fall into.
- **`@ari/ledger` owns Postgres; the kernel must never import it** (`ARCHITECTURE.md` §12 lists it among the
  forbidden imports). `reserve`/`mintTicket`/`claimTicket` take a `LedgerTx` handle only `withTransaction`
  can mint — a runtime marker on a `PoolClient` was tried first and failed, because a released client comes
  back out of the pool carrying a transaction that ended two requests ago.
- **Amounts cross the wire as `numeric(80,0)` decimal strings**, not int8: 10³⁰ raw wei is real and an
  int8 column would overflow it silently.
- **The signer's HMAC key is shared with the decision plane.** `ROADMAP` used to claim otherwise, which is
  not obtainable from an HMAC. The boundary's real claims are listed in that file's Phase 3 section; keep
  them at that precision. Asymmetric sealing is an open Phase 8 decision.
- **`ari-signer` exits rather than falling back to a mock** when `SIGNING_PROVIDER` is not `mock`, and
  `MockSigningProvider` results carry `trustworthy: false` on the type. An absent feature is a smaller error
  than a fake one presented as real (S12, A10).
- **Approval tokens are sealed as an explicit field-by-field JSON payload, and verification HMACs the bytes
  it received.** `canonicalEncode` is the *transaction* canonicaliser; a second one for tokens is the T10
  substitution bug, and §8's `a ‖ b ‖ c` is ambiguous as literally written. The payload is written out field
  by field in `packages/approvals/src/token.ts` — change it and every outstanding token is invalid, so
  `token.test.ts` asserts the round trip.
- **`approval_reuse_attempted` means replay, only.** A claim against an incomplete quorum records
  `approval.claim_refused`. Collapsing the two is what turns a support ticket into a false incident.
- `contract_not_in_allowlist` was removed from the escalation vocabulary: stage 2 already denies any
  contract outside the same list, so the condition could never fire. An option a human can write that does
  nothing is a policy that reads as protection.
- **Both processes open their database pools as `ari_app`** (`DATABASE_ROLE`, which defaults to it) and
  refuse to start if the connection does not come up as that role. `ari` owns the tables, and an owner sits
  outside row security — a pool connected as the owner makes every `WHERE org_id = …` in the codebase the
  *only* thing between tenants, and the service still starts, which is the silence that matters. Set at
  connect time with `options: '-c role=…'`, not by a `SET ROLE` on each checkout (pg deprecates querying a
  client that is already running one, and there is a window between checkout and statement). Session-wide,
  so neither pool goes behind a transaction-mode pooler. Requires `GRANT ari_app TO <login role>`.
- **Revocation is dated by the database, not the caller.** `revokeCredential` used to take a `nowMs` and
  write it into `revoked_at`, whose constraint `revoked_at > created_at` is stated in the *database's*
  clock: a service half a second behind could not revoke a credential it had just minted, and got a
  constraint error that named neither clock. `pipeline.test.ts` carried that as a time bomb — its fixed
  `NOW` was a wall-clock instant the real clock eventually passed, and the suite broke on schedule with no
  code change. Both revoke paths now write `now()`; `revokeCredential` has no time argument.
- **A route that hits an unexpected failure answers `{code:'INTERNAL'}` at 500.** Fastify's default
  serializer puts `message` in the body, and the messages here are real ones — an idempotency conflict
  naming two digests, a constraint, a fragment of SQL. `setErrorHandler` is why the test asserts the shape.
- **The lifecycle stops at `TICKET_MINTED`, and `GET /v1/transactions/:id` says exactly that.** The signer
  answers `COMPLETE` and the API does not settle the request on it, because today's `COMPLETE` came from a
  mock and a mock's word is not a chain fact (S12). Settling belongs to a provider-confirmed callback or a
  reconciliation pass, both of which are Phase 8/9 work. Do not "fix" the stale-looking state by wiring the
  two together.
- **A parsed `CandidateTransaction` cannot be `JSON.stringify`ed** — money is `bigint` by decision, and
  `light-my-request` threw on exactly that. HTTP bodies carry decimal strings; the server's parser turns
  them into bigints. Phase 9's SDK needs a serialiser for the parsed form, and it should not discover this
  by hand.
- **No dependency runs code at install time, including `tsx`'s `esbuild`** — `allowBuilds: {esbuild: false}`
  in `pnpm-workspace.yaml` records the decision rather than leaving it to whoever clears the warning. The
  TS entry points run under `node --import tsx` because this box's Node 24.18 has no type stripping at all
  (`--experimental-strip-types` → `ERR_NO_TYPESCRIPT`); `--env-file-if-exists` means a missing `.env` is a
  `readConfig` refusal rather than a crash about a file.

- **`@ari/client` parses every response with a `.strict()` schema, and the shapes live in
  `packages/client/src/client.ts`.** A 200 that carries a field the contract does not describe —
  a ticket, a signature, a provider reference — is `CONTRACT_MISMATCH`, not an ignored extra key.
  That is the same invariant as S16 read from the receiving end: the edge strips before it answers
  *and* the client refuses to be the place a capability finally lands. The refusal detail quotes the
  schema's complaint, never the body, so the failure path cannot echo a ticket into a log. Two tests
  in `tests/security/api.test.ts` run the client's `fetchImpl` through `app.inject()` against the real
  routes: that pair is where the two halves of the contract meet, and it is the only thing that will
  notice if either side drifts. `Delivered.state` is an enum for the same reason — an open `string`
  makes the union un-narrowable, so `if (value.state === 'DENIED')` would still not give a caller
  `reasonCodes`; the cost is that a provider inventing a fourth terminal state reads as a mismatch,
  which is the direction a payment system should fail in.
- **`toWire` in `@ari/client` is the outbound half of the decimal-string rule, and it is not a
  replacer.** `RawBigInt` turns a string into a `bigint` at the parser; a parsed candidate therefore
  *cannot* be `JSON.stringify`ed, and the first SDK call discovered that as a thrown TypeError
  inside `light-my-request`. The walk reports the path that went wrong (`$.amount.raw`), refuses
  floats and unsafe integers rather than rounding them, refuses a `Date` or a class instance rather
  than sending `{}`, and distinguishes an absent optional property (dropped, which is what
  `exactOptionalPropertyTypes` means) from a bare `undefined` (refused — `JSON.stringify(undefined)`
  is not a string, so the body would have gone out as the word `undefined`).
- There is **no `sign` on `AriClient`,** and `packages/client/test/client.test.ts` asserts it with
  `@ts-expect-error` lines that fail the build the day someone adds one. A gate that says "the SDK
  has no bypass method" is worth as much as the mechanism checking it.

- **A missing risk assessment is a decision, not a pass.** Stage 7 used to act on
  `fallback.onRiskUnavailable` only when it said `deny`, so a policy that chose `escalate` — which every
  fixture and every shipped policy does — fell straight through to ALLOW unless it also happened to write a
  `risk_gte` condition. The fallback a human picked was silently permissive for the common policy shape.
  Both arms now decide. Consequence for later sessions: the kernel's `state()` fixture supplies
  `risk: risk('NONE')` by default, and a test that means "nothing assessed this" has to say
  `{ risk: null }`. Do not restore the fall-through; it is the bug the Phase 5 gate names.
- **The spine parses its own kernel's output.** `evaluate` returns a structurally-typed object, and the
  first disagreement was invisible for exactly as long as nothing read it: `Decision.requestId` is the
  *caller's* `req_` id while the pipeline was handing it the row's `txr_` id. Both look like ids, only one
  satisfies the contract, and the field is read by whoever audits afterwards rather than by anything on the
  happy path. `authorize` now `safeParse`s the decision before acting on it, so a malformed decision rolls
  the transaction back instead of being paid for.
- **Decisions and risk assessments carry the caller's `req_` id; rows, tickets, reservations and audit
  events carry the `txr_` row id.** Same rule the ticket's `requestId` already follows; the two ids are
  minted by different code and only one of them is what a decision joins on.
- **Risk is consulted inside the same tenant transaction, before the kernel, and the provider is mandatory
  in `PipelineDeps`.** It needs no external service — the baselines are aggregates over Ari's own
  `transaction_requests` — so "we have no risk engine configured" is not available as an excuse, and an
  optional field would let a composition root default into escalating everything. The kernel still does not
  touch the database (A4): the assessment arrives as one more input in `state`.
- **`ComputedSignal` is the list of what the risk plane can actually support.** `NEW_ASSET`, `NEW_CHAIN`,
  `NEW_CONTRACT` and `UNUSUAL_APPROVAL_PATTERN` have no weight and no column to be computed from, so they
  cannot be named by the module at all — which is the enforcement; a policy option that silently evaluates
  to `false` is the shape §7.2 refuses. Adding one means adding the data it reads, in that order.
- **Two unit traps in that one query, both silent.** `to_timestamp` takes *seconds*: passing an epoch in
  milliseconds is not an error, it is a timestamp in the fifty-seventh millennium, and every real row is
  quietly outside the window — the first version reported "no history" for an agent with a page of payments.
  And `count(*)` is `bigint`, which the driver returns as a **string**, so `row.x === 0` never matched:
  every count in that SELECT is cast `::int` on purpose, and `query<T>` is an assertion, not a check.

- **The signer reads its own clock per attempt, and does not believe anyone else's.**
  `SignerDeps.nowMs` was a `bigint` and `startSigner` filled it with `BigInt(Date.now())` at process
  startup — so every ticket was compared against the clock at boot, a payment signed an hour later still
  looked four minutes from expiry, and the 60-second TTL that is the whole point of a short-lived
  capability was enforced in tests and not in the process that has to enforce it. It is
  `() => bigint` now, which is the fix *and* the enforcement. Alongside it: a ticket may not claim to have
  been issued more than `TICKET_CLOCK_SKEW_MS` (5s) in the future. Lifetime is bounded by the seal, but
  both of its endpoints are the decision plane's own assertion, and a ticket saying "issued next year"
  expires next year — inside its TTL and invisible to an expiry check that trusts it.
- **A route that cannot answer still answers.** `ari-signer`'s `route` wrapped nothing, and its caller
  discarded the promise: a provider that threw, or a client that hung up mid-body, left `res` unwritten
  (the decision plane sat on its 5s timeout) *and* raised an unhandled rejection, which on Node's default
  kills the signer. That is a signing outage from a malformed request. It now answers
  `SIGNING_PROVIDER_ERROR` at 500 and says in the log only the error's name.
- **A reservation is claimed, held, abandoned, settled or released — never deleted.** The over-limit path
  used to insert the idempotency claim as `HELD` and `DELETE` it when the cap refused; `008` gives
  `ari_app` no DELETE, on purpose, so a genuine race threw `permission denied` instead of returning
  `LIMIT_EXCEEDED`: a 500, a rolled-back audit row, and no refusal recorded for a refusal that happened.
  Every test was green because the suites that exercised it ran as the table owner. `010` adds the statuses
  and an update trigger that makes them progress one way.
- **A window's cap counts money that has already gone out.** `settled` leaves `current_reserved` when a
  hold settles, and both the kernel's `reservedDayRaw` and the ledger's guarded update compared only the
  first — five $1,000 payments against a $5,000 daily ceiling, each settling before the next was asked
  for, and the ceiling never binding. It was latent only because nothing called `settle` yet; the delivery
  step does now, so the fix had to land first. Live proof in "Ran for real" below.
- **Monthly limits are real now, and one request can hold two windows.** `reservedMonthRaw` was a constant
  `0n`, so `perMonth` was a policy sentence that checked against nothing. `010` keys the idempotency claim
  on `(agent_id, idempotency_key, dimension)` instead of `(agent_id, idempotency_key)`, which is what makes
  a second window expressible; `reserve` takes the day then the month and gives the day back if the month
  refuses. A policy that asks for a monthly cap should get one, or the schema should refuse to accept it.
- **The delivery answer moves the ledger, in a transaction of its own.** `recordDeliveryOutcome` settles
  the holds when the signer reports `COMPLETE`, leaves them parked for `SIGNING_PENDING`/`PENDING` (a
  `user_gated` handoff is not a signature, and settling on an intention is the same overclaim in the other
  direction), releases them on a *terminal* refusal the agent could never honour (`TICKET_ALREADY_USED`,
  a digest or key mismatch — that is T13 with Ari's own hand on the lever), and keeps them parked on a
  transient failure because a retry re-delivers the same ticket. It is a second transaction because the
  signing attempt is an outside event; holding the tenant's advisory lock across a network call would make
  a slow signer serialise other requests behind a signature. `reconciliation` owns whatever comes after —
  including the crash between commit and settle, which is a HELD row that no code here will ever move.
- **A published policy version cannot be walked back into DRAFT.** `005` freezes the content of any version
  that is not DRAFT, and `ari_app` holds UPDATE on the table, so the bypass was two statements: set it to
  DRAFT (the content trigger's own `WHEN` clause then excludes the row), edit the document, set it forward.
  `010` puts a state machine on `status`: DRAFT→ACTIVE, ACTIVE→SUPERSEDED, SUPERSEDED→ACTIVE (a justified
  reactivation, §7.3), either live state→RETIRED (terminal), and nothing into DRAFT.
- **Every lifecycle step is `transaction.state_changed`, and a proposal is its own event.** The lifecycle
  writer labelled *every* transition `transaction.proposed` — four to six rows per payment all saying an
  agent had proposed a transaction — while `recordRequest`, the place a proposal actually arrives, wrote
  nothing at all. A mislabelled trail reads as evidence and is not: an auditor chasing "who advanced this"
  would have been pointed at a person for steps taken by `system`. Now one `transaction.proposed` per new
  request row, and `actorType` on every transition says whether it was the agent or the pipeline.
- **The chain head is cached inside a transaction, and the org's advisory lock is why that is sound.**
  `appendEvent` used three statements (re-issue the lock `asTenant` already holds, read the head, insert);
  seven events per request made ~40 % of the request's round trips bookkeeping. `ChainCursor` skips the
  re-issue and trusts the last hash this transaction wrote, because while the transaction holds the
  org's advisory lock no other transaction can append to that chain. Keyed by org, so a caller writing for
  two tenants cannot carry a head from one into the other. A bare client with no cursor gets the old
  behaviour, which is what `createOrganization` still is.
- **The cost of a request is a test, and the numbers in this file are read off it.**
  `tests/security/pipeline.test.ts` counts statements through a proxy client: **30** for a payment that
  mints a ticket (bounded at ≤45 and >20 so a legitimate change is not a chore), **21** for a refusal,
  **10** for a preview that writes no row — the refusal and preview counts are asserted, not recalled, and
  the preview's "writes no row" is checked beside the control that the denial in the same tenant *did*.
  The simulated path is **36**, and the delta is bounded at ≤6: `authorize` asks the chain in its own short
  transaction rather than holding the organisation's advisory lock across an `eth_call`, so the price of
  not stalling a tenant behind a slow node is one extra BEGIN/lock/scope/grant/COMMIT. Every optimisation
  in the two bullets above is invisible to a correctness test and obvious to this one; it is the ratchet
  that stops the next feature adding a query per rule.
- **`scripts/seed-tenant.mts` is the operator's path, and it runs as `ari_app`.** Org, owner, agent,
  wallet, policy, activation, grant, credential — printed once, because the bearer secret cannot be read
  back afterwards. It exists because there is no human-facing API yet; Phase 9's CLI replaces it, and the
  script deliberately uses the same packages and the same unprivileged role the service uses, so a
  privilege it needs that the service does not have fails here first.

- **A value-bearing contract call is refused, not unbounded.** `contract_call.value` moves native
  currency and *nothing in the policy language can bound it*: every monetary limit is denominated in the
  token unit the transfers block names, so an ETH amount against a `usdc-6dp` ceiling is exactly the unit
  confusion `compilePolicy` exists to refuse at load time. The old answer was "no transfer limit applies",
  which is a permission nobody wrote — one allowlisted contract, and every cap in the policy is bypassable
  up to the wallet's balance. Stage 4b now denies it with `CONTRACT_VALUE_NOT_PERMITTED`. The way this
  becomes a capability is a `contractCalls` limit with its own unit; until then, do not let the comparison
  be reintroduced as a convenience.
- **A caller cannot supply the number a policy rule is about.** `usdEstimate` arrives on the candidate, is
  excluded from the digest, and is what `usd_gte` compares — so `{cents: "0", asOf: <fresh>}` cleared any
  threshold while the human approving the payment was shown bytes that never contained the figure that
  cleared it. There is no server-side price feed in this build, so the pipeline drops the estimate whenever
  the governing policy has a `usd_gte` rule, and the kernel's existing "missing evidence escalates" path is
  what the policy already chose. When a feed exists it is written *by Ari*, here, and digested.
- **The lifecycle is enforced where the rows are, and both copies are tested against each other.**
  `transaction_requests.lifecycle_state` was free text while two partial indexes, the risk plane's
  population and the audit trail's meaning were all defined over particular values of it, and
  `setRequestState` compared against whatever the caller claimed. `011` adds the value CHECK and the
  transition trigger mirroring `transaction-engine`'s table — which makes this the *third* copy of a state
  machine in the schema (with `005`'s policy versions and `010`'s reservations). The drift guard is
  `tests/security/lifecycle.test.ts`: it inserts one row per state, asks each for all seventeen targets
  inside one tenant transaction with a savepoint per attempt, and compares the database's verdict with
  `canTransition` — every pair, in both directions. Verified against a mutant migration that widened one
  SQL edge: the guard names the pair it disagrees about.
- **`signing_tickets.org_id` is derived from the decision, never passed.** The ticket row had no tenant
  column at all, so it could not be counted, reconciled or scoped per tenant; and a caller allowed to state
  the tenant could attach a ticket to one whose policy never authorised anything. The insert is now
  `SELECT … FROM ari.authorization_decisions`, which makes the FK, the ALLOW trigger and the org come from
  one row — and refuses a ticket against a decision that does not exist.
- **No unprivileged connection holds a cross-tenant read on money.** `reservations`, `limit_counters`,
  `authorization_decisions`, `audit_events` and `transaction_requests` carry `org_id` and are behind row
  security (`011`, following `004`/`005`). `signing_tickets` is the deliberate exception and the reason is
  in the migration: `ari-signer` redeems tickets for every tenant and has no `ari.org_id` to set, so a
  policy there would make each claim a silent no-op; what bounds a cross-tenant claim instead is that
  `claimTicket` needs the sealed digest and an unredeemed row. Two consequences a later session has to live
  with: *every* application-path write to those tables is inside `asTenant` (there is no "bootstrap
  connections skip the policy" carve-out — that is the hole, not the workaround), and the ledger's
  idempotency-claim lookup carries its tenant predicate even though `agent_id` is globally unique and RLS
  filters it anyway, because the alternative is that re-claiming another tenant's key rests on two facts
  nobody re-states when either changes.
- **`tests/security/schema.test.ts` is the shape gate, and it has been seen to bite.** A missing policy is
  invisible to every test that never queries that table, which is how the money tables carried an `org_id`
  *convention* for eight migrations. It asserts three things from the catalogue: the only tenant-bearing
  table outside row security is the one this file names; no policy on a secured table carries an unscoped
  predicate (permissive policies are OR-ed, so one `USING (true)` beside a correct `tenant_isolation`
  leaves the table wide open *and* reads as coverage in a diff); and an `ari_app` connection with no scope
  reads zero rows from each probed table — with the control that the same role, same table, same query, one
  `set_config` away, reads exactly its own row. Controls run against a scratch database with the
  migrations *not* re-applied: re-applying them repairs the mutation, so a control that goes through
  `pnpm test:security` proves nothing.
- **The chain lock is one derivation, in three places.** `asTenant`, `appendEvent` and
  `enforce_audit_chain` all take `pg_advisory_xact_lock(hashtextextended(orgId, 0))` — the trigger takes it
  too, so the head check is structural rather than dependent on every caller remembering. `hashtext` (the
  old form) returns a **32-bit integer**: with ids being generated constantly, two tenants share it within
  tens of thousands of organisations, and two transactions each believing they hold the chain alone is how
  a hash chain gets two events claiming one predecessor. `tests/security/audit.test.ts` *finds* a
  colliding pair in the old key space and appends 60 events for each through the new one.
- **An approval can record "no amount", which is not amount zero.** `requestApproval` takes
  `bigint | null` and the column is nullable as of `014`; `NULL` is what distinguishes a valueless contract
  call from a payment whose amount was computed as zero — which the kernel refuses separately as
  `AMOUNT_ZERO`, and which the reservation path skips rather than holding for a figure that does not exist.
  The sealed token still always binds a number: making *it* nullable would change the payload bytes of every
  outstanding token, and the payload is what the HMAC covers.
  **The correction is the lesson.** `011` dropped the `> 0` CHECK and added `IS NULL OR >= 0`, and
  wrote in its own header that the row was now nullable — while `006`'s `NOT NULL` sat on the line above
  it in the same table, and nothing re-read it. The type said `null`, `requestApproval` passed `null`,
  the CHECK permitted `null`, and the column refused it: escalating a valueless contract call to a human
  raised a not-null violation, rolled the decision back, and left no record that it had happened. A
  CHECK that allows a value the column cannot hold is not a relaxation, it is a promise nobody kept,
  and the only reason it stayed hidden is that no test had a reason to ask for a null amount until
  `tests/security/immutability.test.ts` did.

- **`014` is the rest of the same class, and `immutability.test.ts` is its witness.** Six rules the
  application believed and the schema did not hold: a revocation a second statement could undo
  (`revoked_at = NULL` on either credential table — S14 is a one-way door now, and the only forward
  writes are `revoked_at` and `last_used_at`); an approval request whose digest, amount, quorum and
  roles stayed editable *while humans were voting on it*, which is the one substitution that survives
  every check afterwards, because `spendApproval` matches the rewritten digest; a vote that named no
  authority the database could check (`approver_user_id` referenced nobody, `role` matched nothing, and
  `INSERT INTO ari.approvals` × `quorum_needed` reached `GRANTED` with no human involved — the trigger
  now validates role, membership, digest, openness and T19 at insert, in the shape `002` already uses
  for a ticket and its decision); `window_key` and `dimension` as two unrelated strings, where a
  `monthly_raw` counter keyed by a day is a parallel row that makes a monthly cap silently stop
  binding while `verifyCounterIntegrity` reports it healthy; `memberships` allowing a second role per
  person per organisation while every reader took `rows[0]` with no `ORDER BY` at all; and
  `SUPERSEDED → ACTIVE` needing no written reason whenever nothing was currently active — the least
  defensible activation in the set was the free one, so the TypeScript requires a justification for
  every reactivation and the database refuses one without. Each refusal is asserted *with the
  legitimate statement beside it*: a constraint that blocks everything would pass the same tests, and
  would be an outage rather than a control.
- **Addresses are validated by one grammar on both sides of a comparison.** A policy's recipient and
  contract allowlists were free strings while a candidate's address had to match the EVM/Bitcoin grammar,
  and the kernel's check is an exact string match — so a pasted checksummed `0xAbC…` allowlist entry
  compared unequal to every possible payment: a permanent deny that reads as a restriction. `contract` is
  `EvmAddress` now, selectors and calldata are hex and bounded, and an invalid allowlist entry is a parse
  error at authoring time.
- **A migration that ran and failed is not a database that is absent.** `global-setup.ts` wrapped the whole
  loop in one `try` and reported any throw as "unreachable — skipped", so a constraint that already existed
  made the suite pass against a half-migrated schema while printing a sentence about a container. It now
  distinguishes the two, fails the run on DDL, and names the file. Companion rule: every file in
  `migrations/` is re-applied on every test run, so each one has to be idempotent — including dropping a
  constraint by *both* the name it has now and the name it had before the edit.
- **A test transaction has to carry the scope its writes are filtered by.** Five `reservations` cases and
  the audit append-as-`ari_app` test were unscoped `withTransaction` calls that had been green for weeks and
  turned red the moment `011` covered those tables: `set_config` is transaction-local, `current_setting` is
  NULL without it, and `org_id = NULL` matches nothing — so the inserts were refused and the reads were
  empty. They now go through `asTenant`, which is the only shape the service itself uses, and
  `connect(max, 'ari_app')` in `tests/security/database.ts` sets the role where the connection opens (the
  same `-c role=` the two services use) instead of `SET ROLE`-ing a client that then returns to the pool
  still holding it.

- **A ticket's redemption is a one-way door in the schema, not just in a query.** `claimTicket`
  filtered on `redeemed_at IS NULL AND expires_at_ms > now`, which is a *read*; the write that makes
  a ticket spent is an ordinary UPDATE, `008` grants `ari_app` UPDATE on `signing_tickets`, and `011`
  deliberately gave that table no row security because the signer redeems across tenants. So
  `UPDATE ari.signing_tickets SET redeemed_at = NULL, expires_at_ms = <next year>` was one statement,
  from the role the service already holds, on the one tenant table with no policy — an untraceable
  second signature for a single authorisation. `012` adds a BEFORE UPDATE trigger that permits exactly
  one field change after minting: `redeemed_at`, from NULL to a timestamp. The columns that *define
  what was authorised* — digest, wallet, decision, org, expiry — are the ticket; editing one does not
  amend an authorisation, it forges a different one under an id that already cleared policy. Verified
  by removing the trigger: three tests in `decisions.test.ts` turn on the guard rather than passing
  around it.
- **A dead claim may be re-taken; money that moved never is.** `010`'s reservation machine permitted
  only `ABANDONED → PENDING`, while the ledger re-claimed any row that was not `HELD` or `SETTLED` —
  including `RELEASED`. That is not a cosmetic disagreement: `authorize` releases the daily hold when
  the *monthly* cap refuses (nothing left the account), and the agent's retry carries the same
  idempotency key, so it hit the released row, the trigger raised, and a cap refusal became a 500 with
  its audit row rolled back — the exact failure `010` exists to eliminate, arriving by another route.
  `012` widens the machine to `ABANDONED | RELEASED → PENDING` and the ledger now names the three
  re-claimable statuses instead of inferring them from "not a live one", so a fourth status added to
  the CHECK cannot silently become spendable. `SETTLED → PENDING` and `HELD → PENDING` both still
  raise, and both are tested.

- **An approver is a credential, not a session — and the two subjects are separated in the schema.**
  Phase 6 was "done" for several migrations while nothing could actually reach it: `authorize` returned an
  `approvalId`, `recordDecision` counted a vote from a user id, and no person outside the process had any way
  to present one, so `REQUIRE_HUMAN_APPROVAL` — the outcome the whole escalation vocabulary exists to produce
  — resolved to "stuck". `013` adds `ari.user_credentials`, and the decision worth recording is the one that
  got here instead of a login flow: no cookies, no browser state, no session model invented to fill out a
  route table. A bearer credential bound to a user, verified by the same Argon2id-over-pepper path agents
  already use, carries every property that makes the agent half defensible (expiry, revocation, rotation by
  superseding, one shape of refusal at the boundary) and nothing that a session would have had to be trusted
  for. Phase 10's dashboard will *mint* one of these on a signed-in person's behalf; it will not replace this.
  Two consequences a later session must not undo:
  - **The separation is a CHECK.** A user credential cannot carry `transaction:request` and an agent
    credential cannot carry `approval:decide`. The subject that proposes a payment and the subject that
    approves it are different *rows*, not different branches in a handler. `ucrd_` and `crd_` prefixes mean an
    agent secret does not parse at the approver gate and vice versa, so both refusals look exactly like a
    wrong secret (T8).
  - **The sealed token is minted from the row and handed to the human who decided.** Not stored
    (`requestApproval`'s own token was always discarded on the way out, deliberately — it would have reached
    the subject being restricted), and not present in any response the agent can read. `sealGrantedApproval`
    reads every field it binds from `approval_requests` under the same lock that counted the vote, so a caller
    cannot state the amount, the wallet or the digest it is claiming to have approved.
  - One thing this made visible on the way: `users.status` had no reader anywhere in the codebase.
    `004` gave it a CHECK on its values and nothing consulted them, so suspending a person was a database
    write with no security consequence and an operator who believed they had stopped someone. The credential
    lookup now joins on it, and a test proves both halves — suspended refuses, unsuspended works again.

- **A simulation that never answered is not a simulation that passed, and the kernel has to ask
  `available` before it looks at `success`.** The arm was `if (simulation !== null && !success) deny
  SIMULATION_FAILED`, and an unavailable answer arrives as `{available: false, success: false}` — so a policy
  that chose `onSimulationUnavailable: allow_advisory` denied anyway whenever a node was down, and the two
  values of that field meant the same sentence. It is the risk-fallback bug this file already records, in its
  other costume, and it was invisible for the same reason: nothing had ever produced a real `available: false`
  until a real node could be pointed at.
- **A provider that cannot encode a candidate answers, it does not shrug.** `authorize` used to return `null`
  when `supports()` was false, which silently turned a policy's `onSimulationUnavailable: deny` into an
  approval on a tenant whose chain cannot be simulated at all. It now returns an
  `unavailable(NOT_SUPPORTED_BY_PROVIDER)` *without calling the provider* — that is what `supports` is for:
  no wallet row read, no socket opened, and the policy's own fallback still gets to decide.
- **`eth_call` to an address with no code returns `0x`, and `0x` is also what some real tokens return on
  success.** So a payment to an ordinary account, or to a contract that was never deployed on this chain, is
  a *clean simulation* unless the provider calls `eth_getCode` itself and refuses. `eth_estimateGas` is no
  substitute: it answers 21 000, without error, for the same call. The chain guard runs both ways for the
  same reason — the node's `eth_chainId` against the configured one, and the candidate's own against the
  node's — and a pinned block the node has dropped is refused rather than quietly read at the head, because
  "the answer is about the state you asked for" is the only thing separating simulation from guesswork.
- **Reverts are classified by their 4-byte selector, never by a node's sentence — and every selector in the
  table was produced by `cast sig`, with the signature written beside it.** The first version of
  `CUSTOM_ERRORS` copied five values from a research probe and `ERC20InsufficientBalance` was not one of
  them (0x37e748ba is somebody else's error; the real value is 0xe450d38c). A wrong entry does not fail
  anything: it labels one revert as another, in an audit trail that will be read as evidence. OpenZeppelin's
  *reason string* was also absent from the node's message entirely, which is why text matching is not a
  fallback either.
- **`@ari/simulation` is plain `fetch` JSON-RPC, with no provider SDK.** `viem` and `ethers` both pull a
  dependency that runs code at install time, and `allowBuilds` exists to keep that out of this repository —
  including for `esbuild`. Five methods and an envelope is smaller than the supply-chain decision required
  to avoid writing them. Note for a later session: Node 24's global `fetch` on this box cannot reach *any*
  remote HTTPS host (raw TCP to the same addresses connects, `curl` returns 200), so a real-chain provider
  cannot be exercised here even in principle, and no test should assume it can.
- **The CLI's commands declare two things about themselves: whether they need a deployment, and every flag
  they read.** Both were claims without mechanisms before: `run()` resolved `--url` before dispatch, so
  `ari verify chain --in export.json` — a command that touches no network — could not run without a URL, and
  a local command was handed an `Api` it had no business holding; and `args.ts` had said since its first
  draft that an unknown flag is an error, while the real behaviour was that `--desicion APPROVED` was merely
  absent and the refusal named the wrong thing. Local commands are now given no client at all, which is the
  enforcement rather than the convention: a stale `ARI_URL`/`ARI_TOKEN` in an operator's environment cannot
  reach anything.
- **`ari` sends a `content-type` only when it has a body, and the bug it fixed was invisible to every test
  that passed.** `agent revoke` is the tool's first body-less POST; declaring JSON while sending no bytes
  made Fastify refuse in its body parser with a 400 — before the credential was read, before the scope,
  before the route existed to the server. `app.inject()` does not reproduce a framework default, so the
  suite that drives the routes that way stayed green. Worth remembering the next time a claim is made about
  the wire: the socket tests are the ones that can be wrong in this direction.
- **A window over the audit chain makes no head claim, and `verifyEventLog` takes its anchor.** The report's
  `head` is the hash the *whole* chain recomputes to, which is the value worth comparing against one written
  down elsewhere; a page of rows cannot honestly carry that name, so `GET /v1/audit/events?after=&limit=`
  answers with events and a cursor and no head at all. `verifyEventLog(entries, startAt)` is what lets the
  same walk continue from a known anchor, and `ari audit tail --from` without `--head` is refused — a window
  that starts mid-chain checks every link after its first and has nothing to check its first against, which
  is exactly what a rebuilt chain can satisfy.
- **An event type that does not exist is not a silent gap, it is a wrong sentence.** `setAgentStatus`
  labelled every non-revoke transition `agent.paused`, because that was the only word in `AuditEventType` —
  so resuming a paused agent wrote an event saying it had been paused again. `agent.resumed` now exists, the
  ternary names each transition, and the pair is asserted against the trail. `003` leaves `event_type` as
  plain `text` with no CHECK, so the type union is the only gate, and a missing member is what made the lie
  writable.
- **Revoking an agent is a route, and it answers 404 for a row that is not yours.** `setAgentStatus` already
  revoked the agent's credentials in the same transaction; nothing reached it over HTTP. The route reads the
  row first so a wrong id is a 404 rather than a thrown sentence turned into a 500, reports
  `credentialsRevoked` (the one part of "revoked" an operator cannot otherwise verify), and answers a second
  revoke as already-revoked at 200 because `REVOKED` is terminal and a second call is not a second act.
- **The wallet's chain address is on the grant read, and the simulation happens outside the tenant
  transaction.** `asTenant` holds the organisation's advisory lock to commit, so an `eth_call` inside it
  would serialise every other request that tenant makes behind a network round trip — the same reason the
  signing delivery is its own transaction. `resolveGrant` therefore also returns `address` (the row it
  already joins), and the pre-read costs one statement on the simulated path only. The digest binding is what
  makes the second, authoritative read's answer the one that counts.

- **The dashboard's vocabulary is imported from the engine, and its data is labelled as a fixture.**
  `apps/dashboard/src/domain/types.ts` names the file each union came from (`ReasonCode`, `RiskSignal`,
  `LifecycleState`, the audit event types, `PolicyDocument`), because a screen that displays a status the
  engine cannot produce teaches its users a false model of their own controls. The sample tenant is
  announced by a banner on every page and by a sidebar that reads *API not connected*, and the actions
  that would need a deployment — approve, revoke, activate, create an agent — refuse and say so rather
  than mutating local state and showing a success. A demo that pretends a button worked is not a demo, it
  is a false test of the contract. `src/api/client.ts` is the seam: one `AriApi` interface, each method
  naming the real route it maps to, two marked `no route yet`.
- **`apps/dashboard` is outside the pnpm workspace, and the reason is isolation, not the network.** An
  earlier note here claimed this box cannot reach the npm registry from Node, and that is **false**: it
  was measured with `--offline` probes and by reading the local store, never by running an install.
  Installs work (`pnpm add` resolves from `registry.npmjs.org` in seconds), so the app now has
  `@vitejs/plugin-react` (Fast Refresh is back), `framer-motion`, `@react-three/fiber` + `three`,
  `@phosphor-icons/react`, and self-hosted `@fontsource-variable/geist` + `geist-mono`. The app stays
  out of the workspace because a Vite/React/Tailwind toolchain inside `packages/*`/`apps/*` would put
  its resolution and its build into `pnpm typecheck` and `pnpm test`, the two gates every other phase
  here starts from. The exclusion in `pnpm-workspace.yaml` says that. Its `node_modules` is gitignored.
- **The console's design is token-locked and there is a mechanical gate over it.** The first pass looked
  generated, and the counts said why: 52 em dashes in visible copy, 46 small-caps micro-labels, three
  files of hand-drawn SVG icons, ten identical metric cards, one accent used in more hues than one.
  The rebuild put four rules in `src/styles/tokens.css` (one radius: sharp surfaces plus
  `--radius-control`, no others; one accent plus three desaturated state colours; `.label` for table
  heads and field keys only; no shadows) and enforced them in `pnpm ui:preflight`
  (`apps/dashboard/scripts/preflight.mjs`), which fails the tree on a dash, a shadow, a hand-drawn
  `<svg>`, a `uppercase tracking` garnish, an `h-screen`, an infinite animation, a CDN font, a
  `Acme`/`Northwind` placeholder, or a class from the deleted token set. Run it with the typecheck
  after any screen work; the check is mechanical precisely so that no future session has to remember
  the list. Landing-page motion is framer-motion plus a live WebGL hero (`components/hero.tsx`,
  faceted transmission prisms, no video file), and it stops for `prefers-reduced-motion` by rendering
  one still frame rather than removing the scene.
- **The mark is used as supplied, and painted through a mask.** `docs/assets/ari-logo.svg` is copied, not
  redrawn; because it is ink drawn for a light surface, the dark interface renders it with
  `mask-image` + a token colour so the geometry is byte-identical and only the paint is ours. The brand
  accent is the mark's own hue (208°) lifted to pass AA on near-black — not a new colour system, and not
  the violet every AI-adjacent product reaches for.

## Ran for real (2026-09-26)
`pnpm --filter @ari/api start` and `pnpm --filter @ari/signer start`, both against Postgres on 5435, seeded
a tenant through the packages (there is no HTTP route for it yet), and every state was observed over a real
socket: `DECIDED` preview, `COMPLETE` end to end with the ticket crossing the process boundary and never
appearing in the caller's response, `DENIED [RECIPIENT_NOT_IN_ALLOWLIST]`, `APPROVAL_PENDING` with an expiry
15 minutes out, `TICKET_ISSUED_NOT_DELIVERED` with the signer stopped, and a retry of a spent request
returning the same `requestId` with the signer's own `TICKET_ALREADY_USED` — single use held across two
processes. Un-scope a `requestId` to a non-uuidv7 string and the parser refuses it with a 400. The seeding path that
run needed on the spot became `scripts/seed-tenant.mts`, which is now the documented way to get from an
empty database to a bearer token; Phase 9's CLI is still the version of it worth shipping.

**Second run, after the reservation/cap/settle work — and this one is the proof, not a smoke test.**
`scripts/seed-tenant.mts`, both processes up, six $900 payments against the seeded $5,000 daily cap:

```
payment 1..5 ($900) -> {"state":"COMPLETE", ...}
payment 6  ($900)   -> {"state":"DENIED","reasonCodes":["AMOUNT_EXCEEDS_DAILY_LIMIT","LIMIT_RESERVATION_FAILED"]}
counters           -> daily_usdc-6dp current_reserved=0 settled=4500000000
reservations       -> SETTLED   request -> SIGNING_COMPLETE
audit mix          -> transaction.proposed/agent=6  transaction.state_changed/system=27
                      risk.assessed/system=6  reservation.settled/system=5  ticket.minted/agent=5
preview            -> DECIDED, and the request-row count did not move
```

Five settled payments are $4,500 of a $5,000 day, and the sixth is refused — which is the whole
"settled money still bounds the window" fix observed from outside, on the real path, with the real signer.
The same run replayed a completed request and got `REFUSED: request is already in SIGNING_COMPLETE; a
retry gets the original answer, not a new attempt` rather than a second signature or a 500, and the
reservation stayed SETTLED through it.

**Third run, after `013` — the approval loop, over two processes, with no test harness in the middle.**
`pnpm seed` printed an agent credential and an approver credential; `ari-signer` was started with
`SIGNER_WALLETS` holding only the seeded wallet; a $2,000 ask went against a policy that escalates above
$1,000 and caps the day at $5,000:

```
1. agent → authorize        {"state":"APPROVAL_PENDING","requestId":"txr_01a0de9b-ea6b…",
                             "approvalId":"apr_01a0de9b-ea80…","expiresAt":"…T17:00:55.160Z"}
2. agent → its own decision  http 401 {"code":"UNAUTHENTICATED"}          ← a crd_ secret does not parse there
3. approver → GET /v1/approvals   apr_01a0de9b-ea80…  2000000000 usdc-6dp  votes 0/1  digest canon/v1:7ff418df12a3ddc
4. approver → POST decision        {"state":"GRANTED","votes":1,"approvalToken":"eyJyZXF1ZXN0SWQiOiJ0eHJfMD…"}
5. agent → authorize + that seal   {"state":"COMPLETE","requestId":"txr_01a0de9b-ea6b…"}   ← the same id
6. in the database:
     request     SIGNING_COMPLETE        approval  CONSUMED  votes=1/1
     ticket      redeemed (single use)   reservation SETTLED 2000000000 daily_usdc-6dp
     audit       approval.requested/system=1  approval.granted/human=1  approval.granted/system=1
                 ticket.minted/agent=1  reservation.settled/system=1  transaction.state_changed/system=7
7. the token in any response the agent can read: 0 occurrences
```

`approval.granted/human=1` is the line to look at: the vote is witnessed as a *person's* act, in the
transaction that recorded it, and the seal the agent needed afterwards came from the row that row's quorum
set — not from the test process, which is what the previous version of this loop had to fake.

**Ran against a chain (2026-09-26) — Phase 7, and the first time anything in this repository spoke to a node.**
`anvil` on 127.0.0.1:8561 (its own, started by the suite), the fixture token in
`tests/security/fixtures/minierc20.json` deployed empty and then funded one block later, `mUSD` as the policy's
asset and anvil's account #0 as the wallet's address:

```
1e6 transfer, at the head        -> SIMULATED_OK    returnData 0x…01  block 2  chainId 31337  trustworthy true
1e6 transfer, pinned to block 1 -> SIMULATED_REVERT  ERC20_INSUFFICIENT_BALANCE  block 1
2e12 transfer (more than holds)  -> SIMULATED_REVERT  ERC20_INSUFFICIENT_BALANCE
configured for chain 1, same node-> CHAIN_ID_MISMATCH  and no eth_call was issued
token address that is an EOA     -> TARGET_HAS_NO_CODE (while `eth_call` on it answers 0x, i.e. "success")
node on a closed port            -> RPC_UNREACHABLE   and the refusal still carries the digest it is about
authorize() end to end            -> TICKET_ISSUED, and `simulation.evaluated` in the trail with
                                    simStatus/simChainId/simBlock/simBound/simTrustworthy all present
```

Two things were learned the hard way and are worth restating. The provider's revert classifier and the fixture's
contract had to agree on a real selector: `cast sig 'ERC20InsufficientBalance(address,uint256,uint256)'` is
**0xe450d38c**, not the 0x37e748ba a research probe had handed over — and the unit test passed either way, because
both copies of the wrong number were mine. And the suite's refusal to run against an anvil it did not start was
checked by squatting the port: it fails with the sentence in its header rather than producing eleven green
assertions about somebody else's chain.


## Open threads

1. **The operator's surface exists; what it does not do is verify itself.** `POST /v1/organizations`,
   `/v1/users`, `/v1/users/:id/credentials` (bootstrap-gated), the four agent routes, the approver's three, and
   now the operator's seven — create/list/revoke an agent, issue an agent credential, register a wallet, grant a
   wallet, apply+activate a policy, read the trail — are built, tested at the socket by
   `tests/security/cli.test.ts`, and drivable end to end by `pnpm ari`. `scripts/seed-tenant.mts` remains for
   nothing more than convenience. Two things are still open here, and neither is a route: a wallet's `address` is
   accepted because it matches a grammar, never because anything checked that the wallet *is* that address on the
   chain (a wrong one makes every simulation of that wallet a question about an account holding nothing, which the
   provider will refuse as `TARGET_HAS_NO_CODE` or answer as a revert — it will not say "you typed the wrong
   wallet"); and Phase 10's dashboard is still where a signed-in person should be *minting* a user credential
   rather than being handed one by an operator, which is the reason `013`'s shape was built to be minted
   server-side at all.
2. **A randomised test that has never failed is not evidence.** `properties.test.ts`'s "a HIGH threshold is
   never looser than a CRITICAL one" asserted that the stricter policy escalates on *every* input where the
   looser one allowed — false at once for any input below the threshold, and it had passed every run so far on
   seed luck (it failed 1 run in ~8). The claim is now the subset implication `strict ALLOW ⇒ loose ALLOW`,
   plus the bite at exactly `HIGH`. When touching a property: run its file ~15 times before believing it, and
   read a passing property as untested until it has been seen to fail on a real counterexample.
3. **Prisma is gone, by ADR-10.** The schema is hand-written SQL in `migrations/` and the three doc lines
   that named Prisma now say so with the reason. Do not reintroduce an ORM schema without settling that ADR:
   the gates here are row-security policies, refusal triggers and role grants, none of which a generated
   client expresses.
4. **Phase 6 human approvals** — the bound-token flow (`§8`: HMAC over digest ‖ policy version ‖ agent ‖
   wallet ‖ amount ‖ expiry ‖ nonce), quorum enforced by Ari's database, `approval_reuse_attempted` as a
   first-class event, and an actor who cannot second-approve a change to their own authority (T19). It
   completes the decision set; Phase 4/5 escalate into it.
5. `ASSUMPTIONS.md` §6 U-IKA-1/2/3/5/7 gate any real Ika work; each has a named experiment, none is
   answerable by reading harder. `~/ika` has the SDK source at a pinned version — guessing when the source is
   present is not acceptable here.
6. `tests/security/` applies all migrations **once**, in `global-setup.ts`, before any worker starts. DDL
   inside a suite deadlocked against another suite's in-flight INSERT (access-exclusive vs row-exclusive on
   the same table) — advisory locks do not help with that. Keep DDL out of the test files.
7. **A `SET ROLE` connection must never share a pool with privileged ones.** `packages/policies`'s suite and
   `tests/security/identity.test.ts` each keep a dedicated pool for the `ari_app` half; a released client
   comes back still holding the role and the next owner query quietly returns zero rows. Same reason the two
   services get their own pools and their own role. Prefer the newer form where a file can afford it:
   `connect(max, 'ari_app')` sets the role with `-c role=` *at the connection*, so no client in that pool
   ever has one, and a login that is not a member of the role fails at open rather than halfway through an
   assertion. The two files still using `SET ROLE` are correct — they just carry a hazard the parameter
   does not.
8. **Cross-suite test assertions must be scoped to the tenant they own.** `api.test.ts` once counted
   `transaction_requests` globally to prove a preview wrote nothing; the suites run as parallel workers
   against one database, so the control was another file's traffic and it failed about 1 run in 8. Count
   `WHERE org_id = …`, or count nothing. The rule is not historical: a test added to this suite today counted
   `idempotency_key = 'cost-denied'` globally and got **3**, which was three earlier runs of itself, and
   it would have passed silently forever except that the control next to it (expect exactly 1) was the
   thing that broke. Tenants are never truncated between runs, so any unscoped count is a count of
   history.
9. **Closed as of 2026-09-26, and worth the sentence.** `ARCHITECTURE.md` §13 and `ASSUMPTIONS.md` A5 named
   the intent boundary's second outcome `AMBIGUOUS` while `contracts.ts` and every other document call it
   `NEEDS_CLARIFICATION`. Both docs now say what the schema says. The reason it was worth carrying at all:
   Phase 4 is the phase that would have *implemented* the name in the wrong place, and a branch written
   against a state that does not exist is a branch that never runs.
10. **A tenant with no history always scores MEDIUM.** `NO_BEHAVIOUR_BASELINE` is deliberately not the
    quietest answer, so the first payment an agent ever makes is "unknown", not "clean" — and a policy that
    escalates at `risk_gte: LOW` will send every one of them to a human. That is a real operational
    consequence of the design, not a bug, but it is untested against reality: the weights and the bands are
    ASSUMED numbers with no corpus behind them. Revisit when there is traffic to look at, and change the
    weights in `scoring.ts` only with the monotonicity properties still passing.
10a. **One tenant, one request at a time — deliberately.** `asTenant` takes
   `pg_advisory_xact_lock(hashtextextended(orgId, 0))` as the transaction's first statement and holds it to
   commit, which is what fixed the audit-chain deadlock and what makes the chain head cache sound. It also
   means a single organisation's authorizations serialise for the length of a transaction (~29 statements
   plus Argon2id, which is measured at p50 ~30ms per request on this box). Cross-tenant traffic is
   unaffected. If per-tenant throughput ever becomes the constraint, the honest fix is to narrow the lock to
   the audit append rather than to add a second chain-writing scheme. The 32-bit problem the key used to
   have is closed — `hashtext` returned an `integer`, and `tests/security/audit.test.ts` finds a colliding
   pair in that space to prove the new key does not share it — but the throughput property above is still
   asserted by nothing, and the day it stops being true is a benchmark, not a test.
10b. **Two counters are placeholders and one of them is load-bearing in a policy field.**
   `usageOf` supplies `ikaSpentTodayRaw: 0n`, so `validity.signingBudget.maxIkaRawPerDay` cannot fire —
   correct for a system with no Ika provider, wrong the day one exists, and a policy that reads as cost
   guarded is not. `reservedMonthRaw` *was* the same shape of lie for the monthly cap and is now real; do
   not let the budget field follow it silently. Also `verifyCounterIntegrity` derives from `HELD` rows
   only, which matches `current_reserved` but not `settled` — extend it when the reconciliation pass learns
   to settle.
10c. **The last process-clock read that mattered is fixed; two TTL *computations* are not.**
   Both approval-expiry decisions are now made by the row (`expires_at <= now()` in
   `recordDecision`, `AND expires_at > now()` in the consumption update), and
   `listCredentials` no longer reads a future-stamped revocation as a live credential — a
   revocation is a fact, not a scheduled event. What still uses `tx.startedAtMs` is the
   *start time* of a newly computed expiry at issuance (`credentials.ts`, `approvals.ts`),
   which is a duration rather than a verdict. `verifyCredential` at the gateway reads the
   process clock by design; the divergence is bounded because `activeScopes`, inside the
   tenant transaction, asks Postgres — so a stale-clock authentication still lands on a
   denial. Say so if a later session changes that ordering: it is the reason two clocks are
   tolerable here at all.

11. **Simulation exists; two things about it are still open, and neither is a provider.**
   (a) *The bound is on the DB cost, not the latency.* The simulated path is now measured and priced — 36
   statements against 30, delta ≤6 — but what that number cannot see is wall clock: a configured provider's
   `timeoutMs` default of 3 000 is time an agent waits before it is told anything, and nothing asserts the
   end-to-end p50/p95 of a simulated request. If that ever matters, it is a benchmark, like the throughput
   claim in 10a, not a test.
   (b) *It answers about whatever chain it is pointed at.* This box cannot reach a remote RPC at all (Node's
   fetch, not the network — see `ASSUMPTIONS.md` §1), so `EvmForkProvider` has never seen a chain with real
   counterparty state on it. The gate that makes that safe is the recorded `chainId`/`blockNumber`/`timestamp`
   plus the two-directional chain guard; the thing that would make it *useful* is a deployment with a real
   endpoint, and A10's "blocking once a real provider lands" has **not** been reached — advisory is still the
   honest setting, because a local anvil's state root proves mechanics and nothing else.
   (c) *The Ika wallets have no address yet.* `wallet create --address` is the only way to give the simulation
   plane a `from`, and a dWallet's address is derived, not typed — Phase 8 needs to write it, and until then
   every Ika-backed wallet is `WALLET_ADDRESS_UNKNOWN`, which is a refusal and not a failure, by design.
