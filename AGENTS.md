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
| 1 core domain | done | migrations `001–012`, `@ari/identity` (tenancy, credentials, wallets, grants, requests), `@ari/audit` (chain + role grants), RLS on every tenant table — and `tests/security/schema.test.ts` asks the catalogue, not the code |
| 2 policy engine | done | 76 tests + `tests/security/` on real Postgres; 98.75 % branch on the kernel |
| 3 signing boundary | done | `packages/signing`, `apps/signer`, `002` ALLOW-before-ticket trigger |
| 3.5 policy lifecycle | done | `@ari/policies`: draft→activate, breadth comparison, owner-only widening, justification on rollback |
| 6 approvals | done | `@ari/approvals` + `006`/`009`/`013`; 21 DB tests on the bound token, quorum, replay and T19, and the approver's half over HTTP — queue, decision, seal — in `tests/security/api.test.ts` |
| 5 risk engine | done | `packages/risk-engine`: deterministic baselines over `transaction_requests`, nine signals, 10 property/unit tests + 17 DB tests including both halves of the Phase 5 gate |
| spine | done | `apps/api/src/authorize.ts` + `tests/security/pipeline.test.ts`: evaluate→reserve→decide→ticket→sign, 11 tests walking the brief's own scenarios |
| HTTP edge | done | `apps/api/src/{gateway,routes,signer-client,server}.ts` + `tests/security/api.test.ts`: 22 tests through `inject`, and both processes run for real (see "Ran for real" below) |
| agent SDK | started | `packages/client`: the outbound half of the decimal-string rule, three methods, 19 tests, and 2 contract tests that run the client's transport against the real routes |
| 4–5, 7–11 | not started | intent, risk, simulation, the CLI, Ika, dashboard |

`pnpm test` is **423 tests / 25 files**, in two halves that add up to it: `pnpm test:unit` is the
**235** that need no database (`packages`, `tests/unit`, `apps`), `pnpm test:security` is the **188** that
need Postgres and do not skip without it. They did not always add up: `test:security` was
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
- **The cost of a request is a test.** `tests/security/pipeline.test.ts` counts statements through a
  proxy client: 29 for a payment that mints a ticket, 20 for a refusal, bounded at 34, with the preview
  strictly cheaper and leaving no row. Every optimisation in the two bullets above is invisible to a
  correctness test and obvious to that one; it is the ratchet that stops the next feature adding a query
  per rule.
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
  `bigint | null` and the column is nullable now (`011`); `NULL` is what distinguishes a valueless contract
  call from a payment whose amount was computed as zero — which the kernel refuses separately as
  `AMOUNT_ZERO`, and which the reservation path skips rather than holding for a figure that does not exist.
  The sealed token still always binds a number: making *it* nullable would change the payload bytes of every
  outstanding token, and the payload is what the HMAC covers.
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

## Open threads

1. **The agent-facing and approver-facing surfaces exist; the operator's does not.** `POST
   /v1/organizations`, `POST /v1/users`, `POST /v1/users/:id/credentials` (all three bootstrap-gated), the
   four agent routes and the approver's three — `GET /v1/approvals`, `GET /v1/approvals/:id`, `POST
   /v1/approvals/:id/decisions` — are built and tested, and the escalation loop closes end to end over real
   sockets (see "Ran for real"). Still missing: creating an agent, issuing *its* credential, and activating a
   policy over HTTP. Those need the same treatment `013` gave approvals — a user credential with the right
   scope and a route that reads it from the row — not a session, and Phase 10's dashboard is where a signed-in
   person should be minting credentials rather than being handed one by an operator. `scripts/seed-tenant.mts`
   remains the path today: `pnpm seed` prints an agent bearer credential *and* an approver's, and can read
   neither back, which is also why `ROADMAP` moved the CLI (Phase 9) up — the CLI's first command is the same
   question that script answers.
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
   `WHERE org_id = …`, or count nothing.
9. `docs/ARCHITECTURE.md` §13's `IntentInterpreter` names `AMBIGUOUS` while the schema and every doc call it
   `NEEDS_CLARIFICATION`. `ASSUMPTIONS.md` A5 has the old name too. Fix when Phase 4 starts.
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

11. **Simulation (Phase 7) is the next phase with a hole already cut for it.** `state.simulation` is still
    `null` in every path, the kernel's simulation arms (`SIMULATION_MISMATCH`, `SIMULATION_UNAVAILABLE`,
    `fallback.onSimulationUnavailable`) are written and tested against hand-built states, and
    `ASSUMPTIONS.md` §1 says anvil is already running on this box — so `EvmForkProvider` is the cheapest real
    thing left. `packages/simulation` does not exist yet; the `@ari/simulation` entry in the root `tsconfig`
    paths is a placeholder for it and currently points at nothing.
