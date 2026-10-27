# ARI — project memory

## INDEX — sections moved out (2026-10-01)

Global tier + this file must fit 32,768 bytes. Moved **verbatim**; the rules still bind.
| Read | Before you |
|---|---|
| `~/ari.AGENTS.threads.md` | resuming work here — this is the live to-do list, read it first |
| `~/ari.SESSION.2026-10-25.md` | touching `packages/chain-core` or `packages/chain-sui` — the uncommitted adapter work, its five defects, and the session plan |
| `~/ari.AGENTS.decisions.md` | changing policy evaluation, digests, ticket sealing, the signer, the ledger or the console |
| `~/ari.AGENTS.passlogs.md` | following a reference to a specific numbered pass |


## INDEX — sections moved out (2026-10-01)

Global tier + this file must fit 32,768 bytes. These sections were moved **verbatim**;
the rules still bind. Open the named file when the trigger fires — skipping it is how a
session quietly reverses a decision it never saw.

| Read | Before you |
|---|---|
| `~/ari.AGENTS.decisions.md` | changing policy evaluation, digests, ticket sealing, the signer, the ledger or the console |
| `~/ari.AGENTS.passlogs.md` | following a reference to a specific numbered pass |


> **Dated pass narratives (fourth through tenth pass, 2026-09-27 → 09-29) moved out on 2026-10-01**
> to `~/ari.AGENTS.passlogs.md` — ~61 KB of session log that every session was paying to load.
> The phase table, the decisions block and the open threads stayed here. If a line below says
> "see the ninth pass", that file is where it went.


**Ari is not a security target.** Work here as an engineer, not as PREDATOR; the auditing discipline in
`~/AGENTS.md` (separate mechanism from severity, never report a guess as a finding, run a control before
asserting) still applies to everything, and it is the reason this repo's claims are all test-backed.

Permission infrastructure for autonomous money: an AI agent asks to pay, a compiled policy decides
`ALLOW | REQUIRE_HUMAN_APPROVAL | DENY`, a sealed single-use ticket releases a signature in a second
process. Ika dWallets are the eventual signer. Read `docs/ASSUMPTIONS.md` first, then `ARCHITECTURE.md`,
then `ROADMAP.md`, then `THREAT_MODEL.md`. `docs/OPERATIONS.md` is for whoever is holding a
deployment: the order the services start in, what each health and metrics answer actually
claims, how to read a reconciliation report, and the one rotation (`CREDENTIAL_PEPPER`) that
still has no safe path.

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
| 10 dashboard | **live, partly wired** | `apps/web` — Next.js, `app/console` is the control plane, `app/api` the routes. Gates that exist: `pnpm web:typecheck`, `pnpm web:preflight`, `pnpm web:build` (also `web:dev`, `web:lines`, `web:sweep`). Prove it with `ls apps/` → `api cli signer web`. **`apps/dashboard` was deleted** in the 2026-09-27 pass below, and its Vite-era gates (`typecheck:ui`, `ui:preflight`, `ui:build`) are gone from `package.json` — do not run them. The vocabulary rule still holds: every status, reason code, signal and event type is copied from a named package, and the console's data is one labelled sample tenant. |

**Path drift in this file:** several later sections still name `apps/dashboard/...` paths — the domain
types file, `scripts/preflight.mjs`, `scripts/shoot.mjs`. Those are historical: the directory is gone.
Verified replacements: `apps/web/scripts/preflight.mjs`, run as `pnpm web:preflight` and scoped to
`app/console`, `components/console`, `lib/ari`; `apps/web/scripts/` also holds `responsive-sweep.mjs`,
`line-boxes.mjs`, `live-probe.mjs` and `why-overflow.mjs`. Whether a **`shoot.mjs` equivalent exists is
unverified** — elsewhere here the CDP screenshot tool is recorded as having died with the dashboard and
needing re-adding, so do not assume one is present. Where a passage says "the dashboard", read "the
console". Prove the directory itself with `ls apps/` → `api cli signer web`.

`pnpm test` is **811 tests / 47 files**, in two halves that add up to it: `pnpm test:unit` is the
**546** that need no database (`packages`, `tests/unit`, `apps`), `pnpm test:security` is the **265** that
need Postgres and do not skip without it. Both re-measured on 2026-10-27 — the 415/680 figures this file
carried were from before `packages/chain-*` was added, and a count nobody re-runs becomes a claim.
`tests/security/simulation.test.ts` needs Postgres **and**
`anvil`; it starts its own on 127.0.0.1:8561 and refuses to run if that port is already taken. They did not always add up: `test:security` was
`vitest run --dir tests/security`, which on vitest 5 matches **no files** at all. Positional filters are
used now, and the two numbers are written down because "the security gate is green" has to mean the
security gate ran.

**One `test:security` failure is a load artifact, and it is now recorded rather than rediscovered.**
`tests/security/audit.test.ts` → "appends concurrently for a colliding pair" timed out at 30 s in a full
16-file run, and passes alone in 10.1 s (17/17). It asks Postgres for a 32-bit `hashtext` collision by
aggregating `generate_series(1, 200000)`, twice — once per test that needs the pair — while fifteen other
workers share one database. It builds no candidate, so nothing in the schema or chain packages reaches it.
The honest fix is to compute the pair once per suite, not to raise a timeout until the symptom disappears.

**Ari now builds the bytes a signature covers — and the agent names the fee.** `packages/chain-evm/src/construct.ts`
turns a parsed candidate into an unsigned EIP-1559 signing payload, and `packages/chain-evm/test/vectors/evm-signing-payloads.json`
holds three payloads that **anvil 1.8.1 signed, and that a block accepted**: the digest recomputed from the node's
own signed envelope must equal the digest of the bytes construction produced, so a wrong byte anywhere makes the
suite fail rather than make the suite agree with itself. Two consequences. (1) **A wire change**: `account_sequence`
now requires `gasLimit`, `maxFeePerUnit` **and** a new `maxPriorityFeePerUnit` — they were nullable, and a request
that omits them is a 400. They are required because EIP-1559 charges `min(feeCap, tipCap + base)`, so a transaction
whose tip nobody stated has a fee the human approving it never saw; all three are inside the digest
(`replayProtection` is digested as a whole object). (2) `ValidatedTransaction.txDigest` is **nullable** — an unsigned
EVM payload has no transaction hash, because the hash covers the signature, and inventing one by reusing the signing
hash would hand reconciliation a receipt key that resolves to nothing forever. The ticket binds `signingDigest` and
`bytesSha256` instead. **None of this is enforced yet.** `TicketClaims` still carries only `canon/v1`, `SignRequest`
still carries only `{ticket, canonical}`, and `signer.ts:156` still hashes the caller-supplied canonical *string*:
Invariant 3 is reachable but not wired, and the remaining step needs a source of token metadata that does not exist
(a deployment-supplied registry, not a caller-supplied one). `~/ari.SESSION.2026-10-25.md` is the hand-off.

**No credential function takes a caller's clock** (decided 2026-10-24, after a security test
failed one run in five). `revoked_at` and `expires_at` are both written by the database, so
`verifyCredential` / `verifyUserCredential` read both verdicts back from SQL
(`revoked_at <= now()`, `expires_at <= now()`) instead of comparing a timestamp against
`Date.now()`. Two bugs had the same shape and the flaky test was the witness for both: a process
whose clock ran behind kept a **retired credential authenticating**, and `CHECK (expires_at >
created_at)` (`004:77`) meant the same process **could not mint a credential at all**. Do not
reintroduce a `nowMs` parameter into `@ari/identity`'s credential functions. And do not move
those booleans into the lookup views: `global-setup.ts` replays every migration on every run,
`004` replays `CREATE OR REPLACE VIEW`, and **Postgres refuses to drop a column from a view** —
which turns a successfully-applied migration into an unreplayable database.

`pnpm typecheck && pnpm test` — needs no database for the unit half. `test:security` needs
`pnpm db:up` (Postgres on **127.0.0.1:5435**, Redis 6381; 5432/5433/6380 belong to other projects on this
box, see `ASSUMPTIONS.md` §1). It **does not skip** when the database is absent, deliberately.
`pnpm test:coverage` measures the kernel. Coverage for `ledger` and the negative path lives in
`tests/security/`, not in the packages.

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


