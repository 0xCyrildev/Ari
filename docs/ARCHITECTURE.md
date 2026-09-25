# ARCHITECTURE — Ari

**Permission infrastructure for autonomous money.**

Ari sits between an autonomous AI agent and a cryptographic signer, and converts ambiguous intent into
constrained, auditable, enforceable financial permission.

```
Human intent → AI agent → Ari → Signing infrastructure → Blockchain
                              │
                    policy · risk · simulation · approval · audit
```

The claim Ari makes: **an agent can be autonomous without being unrestricted.**

The claim Ari does *not* make, and must never be documented as making: that the blockchain or Ika enforces
Ari's policy. They do not. See `ASSUMPTIONS.md` §8.4 and invariant **S12**.

---

## 1. The thesis, stated as an engineering constraint

Most "AI agent + money" systems put the model in the decision path and wrap it in prompts. Ari's premise is
that this is unfixable: a prompt is not an access-control mechanism. So the boundary is drawn at the type
level, not the review level.

```
AI decides   what might be intended
Policy       decides what is permitted
Risk         decides what looks dangerous
Simulation   reports what the transaction appears to do
Authorization decides whether execution may proceed
Signer       signs
Chain        executes
```

Three rules follow, and they are what the rest of this document exists to enforce:

1. **No path from model output to a private key, a signing primitive, or a broadcast exists in the type
   system.** The intent engine's return type does not contain a transaction; the transaction builder's input
   is not a model output; the signer's input is not any of them — it is an `AuthorizationTicket`.
2. **Fail-closed is the only branch.** `authorize()` cannot return `undefined`, cannot throw past the
   boundary, and cannot be skipped by a caller who omits a step. Errors become `DENY` with an
   `INTERNAL_ERROR_FAIL_CLOSED` reason code, never a re-throw that a caller might catch and ignore.
3. **Refusal is witnessed, not asserted.** A denied request must leave evidence that the signer was *not*
   called — a counter, not an absence of log lines (assumption A9).

---

## 2. Two planes, one narrow gate

The baseline is a modular monolith — with one deliberate, load-bearing exception. Assumption A2.

```text
┌───────────────────────── DECISION PLANE (ari-api) ─────────────────────────┐
│  Gateway → Intent Engine → Verifier → Policy Engine → Risk → Simulation    │
│                                 ↓                                          │
│                          Decision Engine                                   │
│                    mints AuthorizationTicket                               │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │  ticket only. HTTPS + HMAC. One use. TTL 60s.
┌──────────────────────────────────▼──────────── AUTHORITY PLANE ────────────┐
│  ari-signer                                                                │
│   · holds DWalletCap + Sui keypair + fee coins   (delegated wallets)       │
│   · verifies ticket signature, expiry, single-use, canonical-digest match  │
│   · is the only process that can talk to a SigningProvider                 │
│   · for user_gated wallets: holds NO share that can complete a signature   │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   ▼
                        Ika network / MockSigningProvider
```

Why the split: the brief asks that authorize-before-sign be "enforced structurally where possible". Inside a
single process, that is a convention with types. Across a process boundary where the second process
independently verifies a signed, single-use, digest-bound, expiring ticket, it is a property: **the decision
plane cannot make the signer sign, it can only ask, and its asking is only honoured if it already decided
yes.** A compromised `ari-api` that has been tricked into minting a ticket is still constrained by the
signer's own checks — including the digest match, which is what stops a policy-bypass-then-sign chain
(A2/T10 in the threat model).

It also keeps the secret-inventory honest, which is what the dashboard's authority view renders:

| Wallet mode | What `ari-api` holds | What `ari-signer` holds | What the human holds | Signer alone can move funds |
|---|---|---|---|---|
| `delegated` | agent creds, policy, audit | cap + Sui key + fee coins | — | **Yes** |
| `user_gated` | agent creds, policy, audit | cap + Sui key + fee coins | secret share (passkey-derived, never leaves device) | **No** |

Second column is why `ari-api` is the least interesting thing to breach.

**Two honesty rules attach to this table, both under invariant S12:**

1. `delegated` is chosen by converting a dWallet to *shared*, and Ika documents that conversion as
   **irreversible** — "you must now trust the network rather than relying on the zero-trust 2PC model"
   (`ASSUMPTIONS.md` I16). It is a one-way door, so Ari models it as a creation-time security decision with
   an explicit confirmation, and the wallet's detail view states its actual guarantee permanently rather than
   once at setup.
2. The `quorum` in an approval policy is, in the MVP, enforced by **Ari's database**. Ika ships a documented
   on-chain alternative (`ikavery`: t-of-N roster, WebAuthn/zkLogin, a signer that only completes under
   quorum). Until and unless Ari uses it, no Ari surface may say "enforced by multi-party approval" without
   also saying where the enforcement lives. See `ASSUMPTIONS.md` §4.7(b).

---

## 3. Request lifecycle

```
POST /v1/transactions/evaluate
  1  Gateway          authenticate agent credential → agent, org, scopes; rate limit; idempotency key
  2  Verifier         normalise + validate the candidate transaction; unknown type ⇒ DENY before anything else runs
  3  Intent           (optional) resolve natural language → structured intent; AMBIGUOUS ⇒ stop, ask
  4  Policy           evaluate compiled, immutable, versioned policy → ALLOW | DENY | REQUIRE_HUMAN_APPROVAL
  5  Risk             deterministic signals (+ optional AI explanation). Can escalate, can never grant
  6  Simulation       advisory in MVP: success, asset deltas, contract interactions, warnings
  7  Decision         fold 4+5+6 under policy's escalation rules → final decision + reason codes + policy_version
  8  Ledger          if ALLOW: atomically reserve against limits *in the same DB transaction*
  9  Approval        if REQUIRE_HUMAN_APPROVAL: create a bound, one-time, expiring approval request
 10  Ticket          if ALLOW: mint single-use AuthorizationTicket bound to the canonical digest
 11  Sign            signer verifies ticket, then calls SigningProvider (async; see §5)
 12  Broadcast       Ari-side; never hand a raw signature to the caller
 13  Audit           every step above appended, whether or not it succeeded
```

Two entry points, not one: `evaluate` (dry run, no side effects, no ledger reservation, no ticket) and
`authorize` (steps 1–13). The SDK makes `authorize` the only reachable path from an agent, and `evaluate`
explicitly labelled as a preview that reserves nothing — a limit shown as available by `evaluate` may be gone
by `authorize`. Saying so beats pretending the two are the same call.

---

## 4. Domain model

```
Organization ─┬─ User ────(membership, roles: owner|admin|approver|viewer)
              ├─ Agent ─┬─ AgentCredential (hashed, scoped, expiring, revocable; ≥1 active)
              │         ├─ Agent↔Policy binding (which policy governs this agent)
              │         └─ Agent↔Wallet grant (which wallets it may act on, under that policy)
              ├─ Wallet ─── SigningProviderBinding (mode: delegated|user_gated, curve triple, provider)
              ├─ Policy ─── PolicyVersion (immutable, numbered, one ACTIVE at a time)
              │                └─ compiled normalized form (in memory after activation)
              └─ TransactionRequest
                      ├─ Intent (optional, model-derived, always flagged as such)
                      ├─ RiskAssessment (0..n, append-only history)
                      ├─ Simulation (0..n)
                      ├─ AuthorizationDecision (exactly 1 terminal)
                      ├─ ApprovalRequest (0..1) ── Approval (0..n attempts, 1 terminal)
                      ├─ LimitReservation (0..n, atomic)
                      ├─ SigningTicket (0..1, single-use) ── SigningRequest ── SigningResult
                      └─ AuditEvent (1..n)
```

Actors are typed and never conflated: `human | agent | system`. `agent_id` is never derived from a user id,
and an `Agent` has no login path. Distinct identity is a requirement (principle 11), not a naming convention.

Terminal states are absorbing. Once `DENIED` a request can never be re-decided — a caller who wants another
attempt sends a new request, which produces a new audit chain and a new ledger reservation. This kills a
whole family of "re-evaluate until it passes" bugs.

---

## 5. Signing is asynchronous — the lifecycle has to say so

Ika's flow is submit-then-poll (`ASSUMPTIONS.md` I7). So:

```
DRAFT → VALIDATED → EVALUATING → DECIDED(allow|deny|review)
   REVIEW → APPROVAL_PENDING → (approved|rejected|expired)
   ALLOW → RESERVED → TICKET_MINTED → SIGNING_PENDING
        → SIGNING_COMPLETE → BROADCAST → BROADCAST_CONFIRMED
        → SIGNING_FAILED | SIGNING_TIMEOUT | ABANDONED
```

`SIGNING_PENDING` is a real, observable, possibly-long-lived state with its own reconciliation worker;
`BROADCAST` is deliberately not called `EXECUTED` (a reorg can undo it; `ASSUMPTIONS.md` §8.3). The UI
renders the trace against this machine, and `TICKET_MINTED → SIGNING_PENDING` is the one edge where money can
still become movable — which is why the trace highlights it.

Reconciliation must be idempotent against a signer that submitted successfully but whose response was lost.
The lookup key is the ticket ID, so a retry cannot produce a second signature.

---

## 6. Normalised transaction representation

The security-critical insight: **the canonical digest is the thing that gets authorised, ticketed, approved
and signed — and it must be computable identically by every stage.** Any stage that recomputes a digest
differently from another stage creates a substitution window (T11, T12).

```ts
type CandidateTransaction =
  | { kind: 'transfer';
      chain: ChainId;                        // 'ethereum' | 'bitcoin'  (solana is vendor pre-alpha: ASSUMPTIONS §5.1)
      asset: AssetRef;                       // native or token, with an explicit contract reference
      amount: { raw: bigint; decimals: number; usd?: { value: number; asOf: string } };
      recipient: Address;                    // chain-normalised, checksum-verified
      replayProtection:                      // ← chain-family tagged, not a flat 'nonce'
        | { scheme: 'account_sequence'; nonce: bigint; chainId: string; gas?: GasParams }
        | { scheme: 'utxo'; inputs: UtxoRef[]; outputs: TxOutput[] }
        | { scheme: 'message_digest'; digest: Uint8Array } }
  | { kind: 'contract_call';
      chain: ChainId; contract: Address; selector: string; calldata: Uint8Array;
      value: bigint; replayProtection: AccountSequence; decoded?: DecodedCall }
  | { kind: 'unknown'; reason: string };     // ← constructible only by the parser; always DENIED downstream
```

`amount.raw` is a `bigint`. **Floats are prohibited in the money path** — a `$5,000.00` limit evaluated
against a `Number` is a bug that pays out `$4,999.999...` or `$5,000.000...1`, and both are deniable-and-not-
deniable depending on rounding. Zod schemas use `z.bigint()` with explicit range checks, and every
serialisation boundary is decimal-string, never JSON number.

`kind: 'unknown'` is the structural implementation of principle 15/16: the parser's failure mode produces a
value that the policy engine has a rule for, rather than an exception that a caller has to remember to
handle.

The canonical form is BCS/JSON with sorted keys, type-tagged, and versioned (`canon/v1`). The digest is
computed once at `VALIDATED` and carried by reference; signer and approval both re-derive it from the stored
canonical blob and compare. Three independent comparisons of the same digest is what makes recipient and
amount substitution (T11, T12) detectable rather than merely unlikely.

---

## 7. Policy

### 7.1 Shape

Policy is declarative JSON, validated by Zod, compiled to a normalised internal form at activation. Nothing
in the evaluation path reads the authoring shape (assumption A4).

```jsonc
{
  "meta": { "name": "accounts-payable", "severity": "high" },
  "permissions": {
    "transfers": {
      "assets":  ["usdc", { "symbol": "USDC", "chain": "ethereum", "contract": "0xA0b8…61b0" }],
      "chains":  ["ethereum"],
      "recipients": { "mode": "allowlist", "addresses": ["0x3f2a…", "0x9bc1…"] },
      "amountPerTransaction": { "max": "2000000000", "unit": "usdc-6dp" },
      "amountPerDay":         { "max": "25000000000", "unit": "usdc-6dp", "window": "utc_day" },
      "amountPerMonth":       { "max": "200000000000", "unit": "usdc-6dp" },
      "maxTransactionsPerHour": 20
    },
    "contractCalls": { "allowed": false, "allowlist": [] },
    "newRecipients": { "allowed": false, "withApprovalOnly": true }
  },
  "escalation": {
    "humanApproval": {
      "requiredWhen": [
        { "op": "amount_gt", "value": "5000000000" },
        { "op": "recipient_not_in_allowlist" },
        { "op": "risk_gte", "level": "HIGH" }
      ],
      "approverRoles": ["owner", "approver"],
      "mode": "user_gated",                    // ← the §2 distinction, per-policy
      "quorum": { "needed": 1, "of": ["owner", "approver"] }
    }
  },
  "validity": {
    "transactionTtlSeconds": 900,
    "notBefore": null, "notAfter": "2026-12-31T00:00:00Z",
    "signingBudget": { "maxIkaPerDay": "5000000", "alertAt": "2500000" }   // §4.3 deny-before-cost
  },
  "fallback": { "onUnknown": "deny", "onEvaluationError": "deny", "onRiskUnavailable": "escalate" }
}
```

Every limit is an explicit unit-qualified integer string. No `5000` meaning "5000 dollars" living in a
config file next to a `2000000000` meaning micro-USDC.

### 7.2 Evaluation semantics

- **Default deny.** Absence of permission is denial. There is no "unrestricted" value reachable by omission;
  `recipients.mode` has no wildcard. `mode: "any"` is deliberately absent from the enum rather than
  deprecated — an option in a schema is an option someone will click.
- **Deterministic and pure.** `evaluate(policy, request, state) → decision`. No I/O, no clock (time arrives
  in `state`), no randomness, no AI. It is therefore trivially property-testable and replayable: the same
  inputs give the same bytes out, which is what makes a policy decision defensible after the fact.
- **Every decision names its rules.** `reason_codes` plus `matched_rules` with rule paths, plus the
  `policy_version`. "DENIED" without a cause is a support ticket, not an authorization system.
- **Escalation is monotone:** `DENY < ALLOW < REQUIRE_HUMAN_APPROVAL` in the direction of *less* authority.
  Risk can move ALLOW→REVIEW and can add conditions. Risk can never move DENY→ALLOW (assumption A6), which
  is encoded as a union type the risk module cannot construct an instance of.
- **`fallback` is mandatory**, not defaulted. A policy that does not state what happens when the risk engine
  is down is a policy that will improvise.

### 7.3 Versioning, activation, and downgrade

- A `PolicyVersion` is immutable once activated. Updates create version N+1. Historical rows are never
  mutated, and every decision stores the exact version it was evaluated against — so a decision from March
  can be re-derived in September.
- Activation is a separately authorised operation (`policy:activate` scope; principle 8) and is always
  audited with actor, reason and previous version.
- **Downgrade is not rollback.** Reactivating an older version requires the same authorisation as a new
  version *and* a non-empty justification, and it emits a high-severity audit event that the dashboard
  surfaces, because a rollback to a looser policy is the most efficient attack on this system (T6, T7).
- Structural guard: activation is rejected if the new version is strictly *broader* than the active one in
  any monetary or recipient dimension and the actor is not `owner`. Widening a limit must be visible as
  widening.

---

## 8. Approvals

An `ApprovalRequest` is not a checkbox with an ID. It is bound:

```
approval_token = HMAC(K_approval,
    request_id ‖ canonical_digest ‖ policy_version ‖ agent_id ‖ wallet_id ‖ amount ‖ expiry ‖ nonce)
```

- **One-time.** A DB unique constraint plus a consumed-at timestamp; the second redemption is a hard error
  and an audit event of type `approval_reuse_attempted` (T12, T13).
- **Digest-bound.** The approving human sees the canonical transaction — recipient, amount, chain, contract —
  and their approval hashes that exact blob. If anything in the request changed after the approval was
  rendered, the digest differs and the token is invalid. This is the specific defence against "approve A,
  execute B".
- **Attributable and time-bound.** A real user identity, a short TTL, and a record of what they were shown.
- **`user_gated` goes further:** approval is not the gate; the human's device decrypting the secret share is
  the gate. A forged approval then buys an attacker nothing at all, which is the whole reason that mode
  exists (§2 table).
- No generic approve tokens. A token that could approve any transaction is a credential that leaks scope.

---

## 9. Concurrency and atomic accounting

The spec's own example is the design test: two `$4,000` requests against a `$5,000` daily cap, arriving
concurrently. Independent evaluation allows both. This is the single most likely way for a correct policy
engine to be wrong.

The fix is not a lock around evaluation — that serialises the whole system. It is **reservation**:

```sql
BEGIN;
  SELECT current_reserved FROM limit_counters
    WHERE org=$1 AND agent=$2 AND window_key=$3 AND dimension='daily_usd'
    FOR UPDATE;                                  -- row lock, per (agent, window)
  -- predicate enforced in SQL, not in application memory:
  UPDATE limit_counters SET current_reserved = current_reserved + $amount
    WHERE org=$1 AND agent=$2 AND window_key=$3 AND current_reserved + $amount <= $max;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN ROLLBACK; → DENY{LIMIT_EXCEEDED}   -- lost the race, correctly
COMMIT;
```

- The limit check and the mutation are one statement, so the comparison cannot go stale between reading and
  writing.
- `TransactionRequest` carries a unique `(agent_id, idempotency_key)`; a retry cannot double-reserve.
- Reservation is created at `RESERVED`, settled at `SIGNING_COMPLETE`, **released** on any failure path
  (`SIGNING_FAILED`, `TICKET_EXPIRED`, `ABANDONED`). An unreleased reservation on a failed sign is a
  self-inflicted denial of service, so the reconciliation worker's job includes reclamation with an audit
  trail.
- Counters are derived from the reservation ledger and re-computed by a periodic checker; if the derived sum
  and the counter disagree, the system alarms and fails closed. Accounting that is only ever as correct as
  its own last update is not accounting.
- Property test, not unit test: for any interleaving of N concurrent requests under a cap, sum of allowed
  amounts ≤ cap, and no request that would have fit is refused while a later one passes. Fast-check over
  randomised schedules with real Postgres transactions.

---

## 10. Invariants

The kernel. Each is enforced by at least one of: a type, a DB constraint, or a named test. A "should" with no
mechanism is not an invariant.

| # | Invariant | Mechanism |
|---|---|---|
| S1 | Default deny | no wildcard in schema; total `evaluate` returning a 3-variant union |
| S2 | Unknown transaction types are denied | `kind:'unknown'` + exhaustive match + test |
| S3 | Unsupported chain/asset/contract denied | allowlist in compiled policy; test |
| S4 | The signer is only ever invoked with a valid ticket | `sign(ticket)` where `Ticket` is branded and mintable in exactly one module; signer re-verifies independently |
| S5 | Every amount is a bigint with an explicit unit | schema + lint rule banning `number` in money paths |
| S6 | Limits are enforced atomically | reservation SQL + concurrent property test |
| S7 | Approval is bound to one canonical digest | HMAC over digest + comparison at redemption |
| S8 | Approval and ticket are single-use | DB unique + consumed_at; reuse attempt is its own audit event |
| S9 | Policy versions are immutable | no UPDATE path; DB trigger rejecting updates on published rows; test |
| S10 | Every security decision is audited before it is returned | outbox written in the deciding transaction |
| S11 | Credentials are stored hashed (Argon2id), with expiry and revocation | schema + auth lookup on every request |
| S12 | **No component claims an enforcement property it does not hold** | docs rule + the honest `delegated`/`user_gated` split; reviewed per PR |
| S13 | Model output never reaches a sink unvalidated | `IntentInterpreter` returns a Zod-parsed union; no raw string in any downstream type |
| S14 | Revocation takes effect on the next request, not the next deploy | credential status read per request, no cached sessions |
| S15 | Failures fail closed | `fallback` mandatory in schema; error path returns DENY, never `undefined` |
| S16 | A raw signature is never returned to an agent | response type has no signature field; integration test asserts it |

---

## 11. Audit

Append-only from the application's perspective, and one step beyond that: the API's DB role gets
`INSERT` and `SELECT` on `audit_events` but **not** `UPDATE` or `DELETE`, and the table rejects updates via
trigger. "Append-only from the application's perspective" is what a compromised-app attacker is left with;
the goal is that they must escalate to a different credential to rewrite history.

Content: `event_id, org, actor, actor_type, event_type, resource, resource_id, request_id, correlation_id,
timestamp, policy_version, decision, reason_codes, metadata, prev_hash, hash`.

`prev_hash`/`hash` form a chain so that a gap or edit is *detectable*, not merely likely — the containment
story for T18 (compromised backend) depends on being able to prove which records are trustworthy after the
fact. Export to an append-only external sink (object lock) is the off-machine copy.

Event types cover the whole list in the brief — agent created, credential issued/revoked, policy
created/activated/changed, intent received/interpreted, transaction proposed, risk assessed, simulated,
policy evaluated, approval requested/granted/rejected/reuse-attempted, ticket minted, signing requested /
succeeded / failed, broadcast, budget exceeded, evaluation error.

Redaction is structural, not disciplined: the logger takes a typed `SafeLogFields` object that has no place
to put a secret, private key, credential, share, or full approval token. The one thing you can always
log is a hash of the sensitive value, which is what makes the audit trail useful during an incident.

---

## 12. Module map

```
ari/
  apps/
    api/              Fastify; routes; composition root; no domain logic
    signer/           authority-plane service; ticket verification; provider invocation
    dashboard/        Vite + React operator UI
  packages/
    schemas/          Zod + TS types: policy, candidate tx, decisions, tickets, API DTOs
    policy-engine/    pure deterministic evaluation  ← the security kernel
    transaction-engine/ canonicalisation, digest, lifecycle state machine
    intent-engine/    LLM behind IntentInterpreter; Zod validation; no authority
    risk-engine/      deterministic baselines + signals; optional AI explanation
    simulation/       SimulationProvider interface; MockSimulationProvider; EvmForkProvider
    signing/          SigningProvider interface; Mock; Ika adapter (isolated, documented assumptions)
    ledger/           Postgres limit accounting: atomic reservation, release, settle (CC3)
    audit/            append-only writer, hash chain, typed redaction
    sdk/              @ari/sdk
    cli/              ari …
  prisma/  docs/  tests/{unit,integration,security}
```

Dependency rule, enforced by lint: `policy-engine` and `transaction-engine` import nothing from
`intent-engine`, `risk-engine`, `simulation`, `ledger`, or `signing`. The kernel depends on the peripherals in name
only — they are injected at the composition root in `apps/api`. That import graph *is* the statement "the LLM
is not the security boundary", written in a language the build system checks.

`ledger` is on that list for the same reason as `signing`, and it earns its own package by being the only
place the reservation SQL lives: an evaluation that could read the counters would be an authorization
whose answer depends on what the ledger happened to say, and the point of compiling a policy to an
immutable form (A4) is that evaluation has no I/O to be surprised by. It imports the kernel; never the
reverse.

---

## 13. Interfaces

```ts
interface IntentInterpreter {          // the only AI touchpoint in the request path
  interpret(input: { utterance: string; context: IntentContext }):
    Promise<ValidIntent | NeedsClarification | InvalidIntent>   // Zod-validated; never prose
}

interface PolicyEvaluator {            // pure
  evaluate(input: { policy: CompiledPolicy; candidate: CandidateTransaction;
                    state: EvaluationState }): Decision
}
```

`EvaluationState` carries the clock (`nowMs`), the usage counters and the behavioural history, and it
carries **no digest**. The digest is derived inside the engine from the candidate and the compiled
policy's own version id, because an evaluator that accepted one from its caller could be handed
candidate B with candidate A's bytes and ALLOW the wrong transaction (T10, T25). Every `ALLOW` and
`REQUIRE_HUMAN_APPROVAL` therefore returns the digest it evaluated; a `DENY` returns none, since a
candidate the canonicaliser refuses still has to be deniable.

```ts

interface RiskEngine {                 // advisory; structurally cannot grant
  assess(input: RiskInput): Promise<RiskAssessment>
}

interface SimulationProvider {
  simulate(tx: CandidateTransaction): Promise<SimulationResult>   // advisory until real providers land
}

interface SigningProvider {
  createSigningRequest(t: AuthorizedSigningRequest): Promise<SigningRef>   // async submit
  getStatus(ref: SigningRef): Promise<SigningStatus>                       // poll (Ika-shaped, I7)
}

interface ApprovalService {
  request(digest: CanonicalDigest, ctx: ApprovalContext): ApprovalRequestRecord
  redeem(token: string, presentedDigest: CanonicalDigest):
    Promise<{ ok: true } | { ok: false; reason: 'EXPIRED' | 'USED' | 'DIGEST_MISMATCH' | 'UNAUTHORISED' }>
}
```

`SigningProvider` has no method that accepts a transaction. That absence is deliberate and is the API-level
expression of S4: there is nothing to call wrongly.

---

## 14. API surface

Exactly the endpoints in the brief plus three (`/v1/wallets`, `/v1/wallets/:id/grants`,
`/v1/transactions/:id/ticket-status`) that the two-plane split makes unavoidable. REST, JSON, versioned
under `/v1`. Structured errors with stable codes and a `requestId`; never a stack trace, never a DB error.
Agent-scoped endpoints require an agent credential with the matching scope; human-scoped endpoints require a
user session. There is no endpoint that accepts a signature request directly — reaching the signer requires
having gone through `authorize`, and the ticket proves it.

Rate limiting lives at the gateway (Redis, A3) and is *not* an authorization control; the daily spend limit
is enforced in Postgres. Two different problems, two different stores, and conflating them is how a limit
becomes bypassable by whoever has the fastest cache invalidation.

---

## 15. Deliberately not built

Not-yet, each with the reason, so the absence is visible rather than mistaken for completion:

- **No real chain broadcast.** MVP stops at signature production; `BROADCAST` is mocked.
- **No blocking simulation gate.** Advisory only until a provider that tells the truth exists (§8.2).
- **No multi-signature quorum inside Ika.** Ika's threshold *is* the signer set; Ari's `quorum` is an
  application-layer count over approvals. These are different things and the docs must not blur them.
- **No ML anomaly detection.** Deterministic statistics first; the brief's own instruction, and a model that
  cannot be explained cannot be defended in an incident.
- **No `sui` as an agent target chain.** `ASSUMPTIONS.md` §5.1.
- **No multi-tenant key-isolation design decisions.** Deferred pending U-IKA-3/6; §8.5.
- **No OAuth/OIDC, no billing, no org invites beyond MVP, no policy templates marketplace.** Nothing here
  makes autonomous execution safer, more controllable, auditable, or easier to integrate.

---

## 16. ADRs (summary)

| # | Decision | Alternatives rejected | Because |
|---|---|---|---|
| 1 | Modular monolith + one split for the authority plane | full microservices; pure monolith | Ordering enforced by a boundary rather than a convention, without inventing infra the workload doesn't need |
| 2 | Postgres is the ledger of limits; Redis only for rate limits | Redis counters | The race test in the brief is a transactional-isolation test |
| 3 | `delegated` vs `user_gated` as a per-policy field | one uniform approval model | It is the only honest way to state which approvals are cryptographic and which are procedural (I3, I4) |
| 4 | Compiled immutable policies evaluated in memory | query the DB during evaluation | Determinism, replayability of past decisions, and no authorization-time I/O to fail |
| 5 | Ticket = HMAC-sealed, digest-bound, single-use, TTL 60s | session capability; DB row check alone | Survives the decision plane being tricked; re-verified by a process that didn't make the decision |
| 6 | bigint + explicit units everywhere | decimal.js, floats | Floats are unusable; decimal adds a dependency to buy what `bigint` and a unit field already give |
| 7 | `unknown` is a transaction *kind*, not an exception | throw | Failing closed must be the ordinary path, not a handler someone remembers |
| 8 | Hash-chained audit + DB-level insert-only role | app-level "please don't update" | T18/T20 need detectable tampering, not polite refusal |
| 9 | `@ika.xyz/sdk` pinned + adapter isolated + real localnet available | write against a hand-imagined API | The SDK is on this machine at a pinned version (§2); guessing when the source is present is not acceptable |
