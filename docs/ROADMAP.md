# ROADMAP — Ari

Each phase has an **exit gate**: a command that must pass, not a feeling of completeness. A phase whose gate
is "it works" has no gate.

Effort is given in relative units, not dates. Dates would be invented precision, and for the four items
blocked on `ASSUMPTIONS.md` §6 they would be wrong in the expensive direction.

---

## Order, and the one place I deviate from the brief

The brief's phase order is right about what matters first (kernel before chrome) and slightly wrong about one
dependency. **Human approval (Phase 6) is moved forward, ahead of the intent and risk engines.**

Reason: approval is *part of the authorization boundary* — `REQUIRE_HUMAN_APPROVAL` is one of the three values
the policy engine returns in Phase 2, so a policy that says `humanAbove: 5000` is untestable end-to-end until
approvals exist. Risk and intent are advisory overlays: they can only escalate, never grant (A6, S13).
Shipping them before the gate they escalate *into* means building the decoration before the door.

```
Phase 0  Discovery / architecture                ✅ this document set
Phase 1  Deterministic core domain               3 units   no AI
Phase 2  Policy engine + security suite          5 units   the security kernel
Phase 3  Signing boundary + ticket               2 units   ordering made structural
Phase 6→ Human approval (MOVED UP)               3 units   completes the decision set
Phase 4  Intent engine (AI enters)               3 units   first non-deterministic code
Phase 5  Risk engine                             ✅ built   advisory, never granting
Phase 7  Simulation abstraction                  2 units   advisory in MVP
Phase 9→ SDK + CLI (MOVED UP)                    2 units   needed to test the E2E path at all
Phase 8  Ika adapter                             4 units   BLOCKED on §6 items, see below
Phase 10 Dashboard                               5 units   trace visualisation, colony map
Phase 11 Security review + hardening              3 units   whole-repository
```

Everything before Phase 4 is deterministic and independent of Ika, which is what makes the first six weeks
immune to the unresolved questions in §6.

---

## Phase 1 — Core domain  *(no AI, all deterministic)*

Entities: `Organization`, `User`, `Agent`, `AgentCredential`, `Wallet`, `Policy`, `PolicyVersion`,
`TransactionRequest`, `AuditEvent`.

- Migrations under `migrations/`, applied in order (ADR-10: hand-written SQL, not an ORM schema); DB constraints carry the invariants, not app validation alone.
- UUIDv7 prefixed identifiers everywhere externally visible (A8). No sequential public ids.
- Credentials: Argon2id, scopes, expiry, revocation, rotation; **hashed-per-request lookup** with an
  org-scoped pepper (T8); no endpoint ever returns a secret.
- Audit outbox written in the same transaction as the state change it describes (S10).
- Org-scoped repository layer that takes `orgId` as a required argument, so cross-tenant reads fail to compile
  (T20).
- `POST /v1/organizations` behind a bootstrap admin credential (§5.6 correction).

**Gate:** `pnpm test` green · migration applies on a fresh DB · IDOR suite passes across every resource ·
revoked/expired credential tests return 401 with distinct reason codes · `audit_events` UPDATE attempt fails
at the DB role, not in the ORM.

---

## Phase 2 — Policy engine  *(the kernel)*

- `packages/schemas`: policy authoring schema → `compilePolicy()` → immutable normalised form (A4).
- `packages/policy-engine`: `evaluate(policy, request, state) → Decision`, pure, total, no I/O, no clock,
  no randomness.
- Reason codes + matched rule paths + `policy_version` on every decision, including ALLOW.
- **Atomic reservation** (CC3) with the daily/monthly/hour-count counters, released on every failure path.
- Immutable `PolicyVersion`; activation is a separately scoped operation; broadening requires `owner` and
  emits a high-severity event (§7.3, T7).
- Unknown chain/asset/contract/type → `DENY` before any other stage runs (S2, S3).

**Gate:** unit + **property-based** suite (fast-check: no input reaches ALLOW without every enabled
constraint holding; evaluation is deterministic and replayable byte-for-byte) · the two-`$4,000`-against-
`$5,000` concurrency test passing against **real Postgres**, not a mock · 100% branch coverage on the
comparison operators, which is the only place an off-by-one moves money.

---

## Phase 3 — Signing boundary  *(make the ordering structural)*

- `AuthorizationTicket`: HMAC-sealed, digest-bound, single-use, TTL 60s, branded type mintable in exactly one
  module (CC1, ADR-5).
- `apps/signer` as a separate process, verifying against **its own copy of the seal, its own clock, and its own
  record of what has been redeemed**.

  This line used to read "with a key `ari-api` does not hold", and it was corrected while building the phase
  rather than after shipping it, because that property is not obtainable from an HMAC: sealing and verifying
  need the same secret, so a compromised `ari-api` can always produce a well-formed ticket. What the boundary
  does buy is narrower and worth stating exactly — the signer re-derives the digest from the bytes it was
  handed (T10, T11), refuses a lifetime over the TTL even behind a valid seal, spends tickets against a
  database row rather than a flag on a string, and returns a reconciliation ref and never a signature (S16).
  Removing `ari-api`'s minting power entirely means an asymmetric seal, and that is a Phase 8 decision to make
  beside the custody questions in `ASSUMPTIONS.md` §8.5 — not a sentence to leave in a plan.
- `MockSigningProvider` with an invocation **counter**, and `IkaSigningProvider` as an interface only.
- DB: `signing_requests.decision_id` FK + trigger requiring an `ALLOW` decision row to exist first.
- Canonicalisation `canon/v1` with a fixed test-vector file (T10 residual).

**Gate:** the MVP negative path — `$50,000` to an unknown recipient under a `$5,000` cap — asserts the mock's
counter is **exactly zero** (A9) · a forged ticket (wrong key, expired, already-used, digest-mismatched) is
refused by the signer and each refusal has its own test · `sign()` cannot be called with a transaction, by
type.

---

## Phase 6 — Human approval  *(moved up; completes the decision set)*

Bound tokens, TTL, single-use, quorum, digest comparison at redemption, `approval_reuse_attempted` as a
first-class event. The approval UI contract: show **exactly** the fields inside the digest (T12 residual).

**Gate:** approval-replay, concurrent-redemption, expiry, digest-mismatch and self-approval tests green ·
an actor cannot be the second approver on a change that widens their own authority (T19) · `evaluate` cannot
produce a signed outcome by any path.

**Status — ✅ package and surface.** `pnpm test:security` (`approvals`, `api`). The half this section was
missing until `013` was not the token but the *person*: `APPROVAL_PENDING` returned an id that nobody outside
the process could answer, because a human had no credential to present. Approver credentials, the queue, the
decision route and the seal-returned-to-the-decider are now HTTP, and the separation is a database CHECK —
`transaction:request` cannot be issued to a human, `approval:decide` cannot be issued to an agent. Still open
here: a real session model (a person signing in rather than presenting a bearer secret), which is Phase 10's
question and stays Phase 10's question.

---

## Phase 4 — Intent engine  *(the model finally appears)*

- `IntentInterpreter` behind one interface; Zod-validated `ValidIntent | NeedsClarification | InvalidIntent`;
  raw prose terminates here (A5, S13).
- **No hallucinated values.** Unresolved recipient → `NEEDS_CLARIFICATION` (T5). This is a test, not a
  guideline.
- Provenance tagged per field (`user | agent | document | model`) and surfaced at approval time (T3).
- Provider pinned by config, validated at startup; `deterministic_only` mode exists (T22).

**Gate:** malformed-output suite (valid JSON/invalid schema; valid schema/address not in contacts) ·
injection fixtures where a model that *fully obeys* the injected instruction still cannot produce an ALLOW
outside policy · the "Pay John $2,500" case returns `NEEDS_CLARIFICATION` and creates no candidate
transaction.

---

## Phase 5 — Risk engine  *(advisory by construction)*

Deterministic behavioural baselines first (amount median/mean, recipient and chain novelty, velocity,
time-of-day, contract-interaction frequency) — explicitly statistics, not a model, per the brief's own warning.
AI-assisted *explanation* only; the score itself stays computed.

The type system enforces A6: `RiskAssessment` cannot construct an `ALLOW`, and its union has no path to
one (S12-adjacent: the code cannot overclaim what it does not decide).

**Gate:** `risk_gte:HIGH` escalation test · a risk-engine failure follows `fallback.onRiskUnavailable` and is
never silently permissive · property test: for any risk output, DENY never becomes ALLOW.

**Built (2026-09-26).** `packages/risk-engine` computes deterministic baselines from `transaction_requests`
inside the same tenant transaction as the decision — no external service, no model, and an explanation
generated from the same numbers that produced the signals. Each gate item is a named test:
`tests/security/risk.test.ts` *"sends a HIGH assessment to a human when the policy asks for that"*,
*"escalates when the policy said escalate"* and *"denies when the policy said deny"* (the second is the one
the pre-Phase-5 kernel got wrong: `onRiskUnavailable: 'escalate'` fell through stage 7 unless the policy also
wrote a `risk_gte` condition, so a missing assessment was silently permissive), and
*"keeps a refusal a refusal whatever the assessment says"*;
`packages/risk-engine/test/scoring.test.ts` holds the monotonicity properties and the A6 compile-time guard.
The signals the phase could not support — `NEW_ASSET`, `NEW_CHAIN`, `NEW_CONTRACT`,
`UNUSUAL_APPROVAL_PATTERN` — are not emitted, and the reason is in the type rather than in a comment.

---

## Phase 7 — Simulation

`SimulationProvider` + `MockSimulationProvider` carrying `trustworthy:false`, which the audit writer and UI
must render (A10). The genuinely useful early win: **anvil is already running on this machine**
(`ASSUMPTIONS.md` §1), so `EvmForkProvider` is real and cheap — but it stays advisory until the fork-head
comparison is verified, at which point it becomes a blocking gate.

**Gate:** `digest(simulated) == digest(signed)` check · simulation-mismatch test · no surface anywhere presents
a mock result as chain truth.

---

## Phase 9 — SDK + CLI  *(moved up; the E2E path is untestable without them)*

`@ari/sdk` exposes `transactions.request()`, `approvals.*`, `agents.*`, `policies.*` and **nothing** that
accepts a key, a signing call, or a raw signature (S16). Design goal: the authorising path is the shortest
path, so bypassing Ari takes more code than using it.

CLI: `ari init | agent create|list|revoke | policy validate|create|activate | transaction evaluate|simulate |
audit tail`. `policy validate` is genuinely useful offline against a compiled policy. `audit tail` streams the
hash chain and verifies it client-side — a small feature with outsized trust value.

**Gate:** the whole MVP happy path is reproducible from the CLI alone · SDK type-tests assert no bypass method
exists · `ari policy validate` rejects each malformed fixture in a corpus.

---

## Phase 8 — Ika adapter  *(blocked, and correctly so)*

Blocked on `ASSUMPTIONS.md` §6: **U-IKA-1** (does `futureSign` bind the message), **U-IKA-2** (presign
single-use), **U-IKA-3** (fee escrow-vs-burn), **U-IKA-5** (in-flight across epoch). Each is answerable, and
each has a named experiment; none is answerable by reading harder.

What makes this phase cheap rather than exploratory: the real SDK source, the generated Move BCS schemas,
three working examples, a `localnet` playbook and a version-matched `sui` CLI are all on this machine (§2).
**Ari is not guessing at Ika and must never be.** Any adapter method that cannot be traced to
`~/ika/sdk/typescript/src` or `docs.ika.xyz` is wrong, not approximately right.

Also decided here: whether `user_gated` is device-interactive (U-IKA-7). If it is, that is a product limitation
worth naming early — an approval that requires a phone is not an instant payment, and pretending otherwise
would be the S12 failure mode of the whole roadmap.

**Gate:** DKG → presign → sign round-trip on testnet for a real `zero-trust` dWallet · the four §6 experiments
run, with results written back into `ASSUMPTIONS.md` and any security claim they invalidate **removed from the
docs and UI, not softened** · adapter code isolated to `packages/signing/src/ika/**` with Ika-specific
assumptions marked in-file.

---

## Phase 10 — Dashboard

Dark, precise, institutional. The ant metaphor carried by *structure* — bounded paths, role specialisation,
nodes and trails, the trace as an ant navigating a colony — not by decoration. Full identity spec in the
brief; `prefers-reduced-motion` renders the correct static final state everywhere.

Priority surfaces, in the order that earns their keep:

1. **Transaction trace** — the strongest product moment in Ari, and the thing that makes an audit
   defensible to a non-engineer. Includes the blocked-node rendering for a DENY, which is the same component
   as the happy path rather than a special case.
2. **Colony map** — which agent can move which wallet under which policy, with **newly created relationships
   highlighted**. This is a security visualisation, and dangerous-relationship discovery is its actual job.
3. `/approvals` with the digest-bound view. 4. `/policies` with version diffs and the broadening banner.
5. `/agents`, `/overview`, `/audit`.

Wallet detail states its **actual** guarantee permanently (`delegated` vs `user_gated`), because §4.7 makes
that a correctness requirement rather than a design preference.

**Gate:** keyboard-navigable, 320px usable, works with animations disabled, no fake data rendered as real, and
every status carries icon + label + colour (never colour alone).

---

## Phase 11 — Security review

The brief's checklist, executed as a review with findings written up and fixed rather than a mood. Specific
attention to the places this architecture creates new surface rather than inheriting old ones:

- Canonicalisation: any second implementation of the digest is a substitution bug waiting to happen (T10).
- Reservation release paths: every failure branch that forgets to release converts an attack into a
  self-inflicted lockout (T13, T23).
- Import graph: the lint rule that keeps `policy-engine` free of AI/simulation/signing imports is the
  architecture's load-bearing wall, and it will erode first (S12, §12).
- Approval binding: re-derive the HMAC input from scratch in the review and compare to the docs — a drift
  here is the T12 failure.
- Any string in the codebase or README that asserts a security property, checked against
  `ASSUMPTIONS.md`. Marketing copy is part of the threat model.

**Gate:** all 25 threats have a named test or an explicit, documented acceptance with a reason · security
suite in CI, never skipped · the MVP negative path is asserted on every commit · **zero** fake integrations
presented as real.

---

## MVP success criteria, mapped

| Brief criterion | Phase | Asserted by |
|---|---|---|
| Org → agent → credential → policy → activate | 1, 2 | integration test + CLI script |
| "Pay Acme $2,000 USDC" interpreted | 4 | intent fixtures; `NEEDS_CLARIFICATION` case |
| Missing info requested, not invented | 4 | recipient-unresolved test creates no transaction |
| Normalised transaction constructed | 2 | `canon/v1` vectors |
| Policy + risk + simulation evaluated | 2, 5, 7 | decision record carries all three |
| Decision produced; approval when required | 6 | bound-token flow |
| Mock signer signs | 3 | happy path + counter |
| Audit trail records every step | 1–7 | hash-chain verified; outbox in-decision |
| Dashboard shows the trace | 10 | trace surface |
| **Negative path: $50k to unknown recipient under a $5k cap → DENIED, and no signing request ever reaches the provider** | 3 | **counter === 0** |

---

## Standing risks to the plan itself

1. **U-IKA-7 may make `user_gated` inconvenient.** If every high-value payment needs a phone, the honest
   response is to design for it, not to quietly downgrade wallets to `shared` for a better demo. That single
   trade — convenience over guarantee — is how this category of product fails, and it is the reason principle
   17 is in the brief.
2. **Phase 2's concurrency gate is the real filter.** Everything else in Phases 1–3 is well-trodden
   engineering. If the reservation design is wrong, no amount of later polish makes Ari safe.
3. **Dashboard before kernel is the failure mode this roadmap is structured to prevent.** It is also the
   version of this project that looks most like progress for the first two weeks.
