# ARI — project memory

**Ari is not a security target.** Work here as an engineer, not as PREDATOR; the auditing discipline in
`~/AGENTS.md` (separate mechanism from severity, never report a guess as a finding, run a control before
asserting) still applies to everything, and it is the reason this repo's claims are all test-backed.

Permission infrastructure for autonomous money: an AI agent asks to pay, a compiled policy decides
`ALLOW | REQUIRE_HUMAN_APPROVAL | DENY`, a sealed single-use ticket releases a signature in a second
process. Ika dWallets are the eventual signer. Read `docs/ASSUMPTIONS.md` first, then `ARCHITECTURE.md`,
then `ROADMAP.md`, then `THREAT_MODEL.md`.

## State — 2026-09-26 (second pass)

| Phase | Status | Evidence |
|---|---|---|
| 0 discovery | done | four docs, 1,750 lines, every claim labelled VERIFIED / DOC-ONLY / ASSUMED / NOT-FOUND |
| 1 core domain | done | migrations `001–009`, `@ari/identity` (tenancy, credentials, wallets, grants, requests), `@ari/audit` (chain + role grants), RLS on every tenant table |
| 2 policy engine | done | 76 tests + `tests/security/` on real Postgres; 98.75 % branch on the kernel |
| 3 signing boundary | done | `packages/signing`, `apps/signer`, `002` ALLOW-before-ticket trigger |
| 3.5 policy lifecycle | done | `@ari/policies`: draft→activate, breadth comparison, owner-only widening, justification on rollback |
| 6 approvals | done | `@ari/approvals` + `006`/`009`; 21 DB tests on the bound token, quorum, replay and T19 |
| spine | done | `apps/api/src/authorize.ts` + `tests/security/pipeline.test.ts`: evaluate→reserve→decide→ticket→sign, 11 tests walking the brief's own scenarios |
| 4–5, 7–11 | not started | intent, risk, simulation, HTTP routes + SDK/CLI, Ika, dashboard |

`pnpm test` is **302 tests / 18 files**; `pnpm test:unit` runs the no-database half;
`pnpm test:security` is the 108 tests that need Postgres and do not skip without it.

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

## Open threads

1. **No HTTP surface yet.** `apps/api` holds the authorization pipeline and nothing else: no Fastify
   routes, no gateway auth middleware, no `POST /v1/organizations` behind the bootstrap token (§5.6), no
   SDK. The pipeline is reachable only as a function today, and it is fully tested as one.
2. **Prisma is gone, by ADR-10.** The schema is hand-written SQL in `migrations/` and the three doc lines
   that named Prisma now say so with the reason. Do not reintroduce an ORM schema without settling that ADR:
   the gates here are row-security policies, refusal triggers and role grants, none of which a generated
   client expresses.
3. **Phase 6 human approvals** — the bound-token flow (`§8`: HMAC over digest ‖ policy version ‖ agent ‖
   wallet ‖ amount ‖ expiry ‖ nonce), quorum enforced by Ari's database, `approval_reuse_attempted` as a
   first-class event, and an actor who cannot second-approve a change to their own authority (T19). It
   completes the decision set; Phase 4/5 escalate into it.
4. `ASSUMPTIONS.md` §6 U-IKA-1/2/3/5/7 gate any real Ika work; each has a named experiment, none is
   answerable by reading harder. `~/ika` has the SDK source at a pinned version — guessing when the source is
   present is not acceptable here.
5. `tests/security/` applies all migrations **once**, in `global-setup.ts`, before any worker starts. DDL
   inside a suite deadlocked against another suite's in-flight INSERT (access-exclusive vs row-exclusive on
   the same table) — advisory locks do not help with that. Keep DDL out of the test files.
6. **A `SET ROLE` connection must never share a pool with privileged ones.** `packages/policies`'s suite and
   `tests/security/identity.test.ts` each keep a dedicated pool for the `ari_app` half; a released client
   comes back still holding the role and the next owner query quietly returns zero rows.
7. `docs/ARCHITECTURE.md` §13's `IntentInterpreter` names `AMBIGUOUS` while the schema and every doc call it
   `NEEDS_CLARIFICATION`. `ASSUMPTIONS.md` A5 has the old name too. Fix when Phase 4 starts.
