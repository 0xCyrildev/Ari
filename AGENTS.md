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
| 1 core domain | done | migrations `001–009`, `@ari/identity` (tenancy, credentials, wallets, grants, requests), `@ari/audit` (chain + role grants), RLS on every tenant table |
| 2 policy engine | done | 76 tests + `tests/security/` on real Postgres; 98.75 % branch on the kernel |
| 3 signing boundary | done | `packages/signing`, `apps/signer`, `002` ALLOW-before-ticket trigger |
| 3.5 policy lifecycle | done | `@ari/policies`: draft→activate, breadth comparison, owner-only widening, justification on rollback |
| 6 approvals | done | `@ari/approvals` + `006`/`009`; 21 DB tests on the bound token, quorum, replay and T19 |
| spine | done | `apps/api/src/authorize.ts` + `tests/security/pipeline.test.ts`: evaluate→reserve→decide→ticket→sign, 11 tests walking the brief's own scenarios |
| HTTP edge | done | `apps/api/src/{gateway,routes,signer-client,server}.ts` + `tests/security/api.test.ts`: 16 tests through `inject`, and both processes run for real (see "Ran for real" below) |
| 4–5, 7–11 | not started | intent, risk, simulation, SDK/CLI, Ika, dashboard |

`pnpm test` is **318 tests / 19 files**; `pnpm test:unit` is the 184 that need no
database; `pnpm test:security` is the 134 that need Postgres and do not skip without it.

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

## Ran for real (2026-09-26)

`pnpm --filter @ari/api start` and `pnpm --filter @ari/signer start`, both against Postgres on 5435, seeded
a tenant through the packages (there is no HTTP route for it yet), and every state was observed over a real
socket: `DECIDED` preview, `COMPLETE` end to end with the ticket crossing the process boundary and never
appearing in the caller's response, `DENIED [RECIPIENT_NOT_IN_ALLOWLIST]`, `APPROVAL_PENDING` with an expiry
15 minutes out, `TICKET_ISSUED_NOT_DELIVERED` with the signer stopped, and a retry of a spent request
returning the same `requestId` with the signer's own `TICKET_ALREADY_USED` — single use held across two
processes. Un-scope a `requestId` to a non-uuidv7 string and the parser refuses it with a 400. The seeding
script was deleted afterwards on purpose: it duplicates what the test fixtures do, and Phase 9's CLI is the
version of it worth keeping.

## Open threads

1. **The agent-facing surface exists; the human-facing one does not.** `POST /v1/organizations` (bootstrap
   token) and the four agent routes are built and tested. Creating an agent, issuing its credential, deciding
   an approval, activating a policy — all of those need a *user session*, Ari has no session model, and
   inventing one inside a route handler is a security decision taken as a side effect. Until it is taken
   deliberately, operators work through `@ari/identity` and `@ari/policies` directly, which is what the test
   suites do. Consequence worth knowing: there is currently no way to seed a working tenant without writing a
   script against the packages. `approvalId` is returned by `APPROVAL_PENDING` but nothing can consume it over
   HTTP.
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
   services get their own pools and their own role.
8. **Cross-suite test assertions must be scoped to the tenant they own.** `api.test.ts` once counted
   `transaction_requests` globally to prove a preview wrote nothing; the suites run as parallel workers
   against one database, so the control was another file's traffic and it failed about 1 run in 8. Count
   `WHERE org_id = …`, or count nothing.
9. `docs/ARCHITECTURE.md` §13's `IntentInterpreter` names `AMBIGUOUS` while the schema and every doc call it
   `NEEDS_CLARIFICATION`. `ASSUMPTIONS.md` A5 has the old name too. Fix when Phase 4 starts.
