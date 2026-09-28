# Operating Ari

Whoever is holding a deployment. The design rationale is in `ARCHITECTURE.md`, the threat
model in `THREAT_MODEL.md`, and the open unknowns in `ASSUMPTIONS.md`; this file is only the
order things have to happen in, and what each one costs.

Everything below was run against private staging on 2026-09-28: `ari-zeta-seven.vercel.app`
(web), `ari-api.pxxlspace.cv` and `ari-signer.pxxlspace.cv` (two Pxxl Free projects), and a
Neon **direct** endpoint as the ledger. Both providers are `mock`, so nothing here settles a
transaction on a chain — see §7.

---

## 1. Before any service starts: the database

```sh
pnpm db:preflight -- '<DATABASE_URL>'
```

Read-only, and it exits non-zero on a failure. It answers the four questions a hosted
Postgres can silently get wrong for this schema:

- **Is the connection verifying?** Beyond loopback, only `sslmode=verify-full` (or
  `ssl=true`) is accepted. `require`, `prefer` and `verify-ca` verify *today* and are
  documented to adopt libpq's weaker meanings on a routine `pg` major bump, so a rule that
  allowed them would be a control now and an unverified socket after an upgrade. An
  impostor answering row-security questions is the one threat `011` exists to hold.
- **Can the login create `ari_app`?** `003_audit.sql` runs `CREATE ROLE ari_app NOLOGIN
  NOINHERIT`, and both services refuse to start unless the connection comes up as that
  role. If `rolcreaterole` is false, have the provider create the role and grant
  membership; do not connect as the table owner.
- **Does `-c role=ari_app` survive the provider's router?** Both pools set the role *at
  connect*, which a transaction-mode pooler rewrites. `session_user` should be the login
  and `current_user` should be `ari_app`. If it is not, the answer is a session-mode
  endpoint — **never** dropping `DATABASE_ROLE`, which is the silent multi-tenant hole the
  startup refusal exists to prevent.
- **Can the audit chain's advisory lock be taken, and is every tenant-bearing table behind
  row security?** The RLS check borrows the same predicate `tests/security/schema.test.ts`
  uses, so the two cannot drift.

Note on `pg_stat_ssl`: a managed provider terminates TLS at its own proxy, so the server's
row can read `ssl=false` while the socket you opened is verifying. The client-side
`verify-full` handshake is the proof; the server's view is corroboration. Measured on Neon
with `inet_client_addr()` returning a private address.

Then migrate, from outside the services:

```sh
DATABASE_URL='<DATABASE_URL>' pnpm db:migrate
```

`ari_app` holds no DDL rights by design (`008`), so this runs as the owner and is done once
per new database, not per deploy. Every file is idempotent and re-applied, so a rerun is
safe and a failure names the file.

---

## 2. Starting the two processes

| Variable | `ari-api` | `ari-signer` | Notes |
|---|---|---|---|
| `API_HOST` / `SIGNER_HOST` | required | required | Both bind **loopback** by default. A container that binds loopback starts cleanly, passes its own health check, and 502s from outside — set `0.0.0.0` and terminate TLS in front. |
| `API_PORT` / `SIGNER_PORT` | `PORT` honoured | `PORT` honoured | |
| `DATABASE_URL` | yes | yes | §1 |
| `DATABASE_ROLE` | `ari_app` | `ari_app` | Do not unset it. |
| `TICKET_KEY`, `APPROVAL_KEY`, `CREDENTIAL_PEPPER`, `ORG_BOOTSTRAP_TOKEN` | yes | `TICKET_KEY` | ≥32 chars; `openssl rand -base64 48` |
| `SIGNER_URL` | yes | — | Exactly `…/v1/sign`. No trailing slash, no query: a stray one made the signer answer its 404, which carries no refusal code, and the client used to default that to a *terminal* refusal — releasing a day's capacity beside a live, unspent ticket. |
| `SIGNER_DELIVERY_KEY` | both or neither | both or neither | Setting it on one side turns the gate on for both, so a half-configured deployment fails at startup rather than at first payment. Required when the signer binds beyond loopback. |
| `SIGNER_WALLETS` | — | yes | A signer that names no wallet refuses to start. |
| `SIGNING_PROVIDER` | — | `mock` | Anything else exits. There is no fallback to a mock, on purpose. |
| `LOG_LEVEL` | `info` | `info` | JSON on stdout. `API_LOG_LEVEL` / `SIGNER_LOG_LEVEL` override per process. |
| `METRICS_TOKEN` | optional | — | Unset means `GET /metrics` does not exist (404, not 401). |
| `ARI_VERSION` | optional | optional | Reported by `/healthz` and `ari_api_build_info`. |

Secrets go in through the platform's environment form, never a committed file. On Pxxl an
environment change **only reaches a new deployment**: editing env without redeploying is an
edit that did not happen.

`DATABASE_URL` in a shell env file must be double-quoted — the `&` in a Neon connection
string otherwise backgrounds the rest of the line and the check you think ran never did.
The dashboard's env form wants the value unquoted.

---

## 3. Health, metrics, and what each one promises

- `GET /healthz` — 200 `{status:'ok', db:'ok', version}` when the pool can answer, 503
  `{status:'degraded', db:'unavailable'}` when it cannot, after a 500 ms probe. On the
  signer it is answered **before** the delivery gate, so the platform's probe needs no
  secret; the gate still precedes the route table, so an unauthenticated caller cannot map
  the signer's paths.
- `GET /metrics` — Prometheus text, bearer-gated by `METRICS_TOKEN`. Request counts by
  compiled route/method/status, a duration histogram, credential verifications by
  accepted/refused, delivery outcomes, pool gauges, and reconciliation passes. **No series
  is labelled by tenant, agent, credential, digest or request id**: this endpoint has a
  token in front of it and no principal, so a per-tenant label would answer "who is moving
  how much" for anyone who could scrape it (T20).
- `x-request-id` is on every response. Send one and it is echoed, if it is a bounded opaque
  string; otherwise the process mints one. The same value is forwarded to the signer and
  written as `httpRequestId` by both processes, which is what makes a parked delivery one
  story instead of two coincidences. The ledger's own row id is logged separately as
  `transactionRequestId` (`txr_…`) — three identifiers, three names, deliberately.

---

## 4. Reconciliation: finding a payment nobody finished

```sh
ari reconcile --json                       # one pass, records the report on the chain
ari reconcile --no-record --json           # one pass, writes nothing
ari reconcile --threshold 30 --json        # a shorter grace period
ari reconcile --interval-ms 60000          # keep asking, in this terminal
```

or `POST /v1/operations/reconciliation` (records) and `GET` (does not), on an operator
credential with `audit:read`.

It reports six things:

| Code | Meaning |
|---|---|
| `APPROVAL_EXPIRED_UNANSWERED` | A human was asked, never answered, and the deadline passed. It holds **no** capacity — nothing is reserved before approval. |
| `DELIVERY_PARKED` | A ticket was minted and never delivered or redeemed; the hold stays parked. |
| `TICKET_REDEEMED_NOT_RECORDED` | **Critical.** The signer spent the ticket and the decision plane never recorded the answer: a signature exists that the ledger does not acknowledge. |
| `TICKET_MINTED_NOT_REDEEMED` | Expired, unspent tickets, counted per tenant. Dead rows by design; the number is what an operator is owed. |
| `ABANDONED_CLAIMS_ACCUMULATED` | Idempotency claims a retry may re-take. A pile, not a bug. |
| `STATE_MACHINE_STALLED` | A request left in a pre-decision state — usually a deploy that killed a process mid-transaction. |

There is no scheduler, and that is a decision. A report-only pass needs no lock, no timer
and no idempotency key, so it is a command an operator runs. A pass that *corrected* state
would need all three plus the authority to move money-adjacent rows, which belongs to
Phase 8 and a provider-confirmed callback.

The pass releases nothing, settles nothing, re-delivers nothing and deletes nothing. That is
not timidity: the rule in the code is that a non-terminal refusal keeps capacity parked,
because only the agent knows whether it intends to retry, and `008` withholds `DELETE` from
`ari_app` on purpose.

Each recorded pass appends one `reconciliation.reported` event, carrying the codes that were
non-zero and the total — not the row ids. Re-run it for the numbers, read the chain for the
evidence that you looked.

---

## 5. Rotating a key

`TICKET_KEY` and `APPROVAL_KEY` each accept a two-generation ring: `*_KEY_ID` names the head
that signs, and `*_KEY_PREVIOUS` with `*_KEY_PREVIOUS_ID` names one older seal still
honoured. Setting a previous secret without its id is refused at startup — a key nobody can
name is a key nobody can retire.

**The wire format carries no key id.** A seal that fails to verify is indistinguishable from
a forgery, which means the *order* is the only control:

1. Generate the new secret. On **`ari-signer`** first, set
   `TICKET_KEY=<new>`, `TICKET_KEY_ID=v2`, `TICKET_KEY_PREVIOUS=<old>`,
   `TICKET_KEY_PREVIOUS_ID=v1`, and deploy. The signer now honours both.
2. Then **`ari-api`** with the same four values. It starts sealing `v2`; anything still in
   flight under `v1` still redeems.
3. When the startup line's `sealIds` shows both and no traffic reports `v1` for a full
   ticket lifetime (60 seconds) plus your retry window, remove the two `*_PREVIOUS`
   variables and redeploy both. Order no longer matters at that point.

The same three steps apply to `APPROVAL_KEY`, with a longer window: an approval token is
minted when a person votes and spent when the agent retries, so a rotation that honours only
the new key refuses a vote that was honestly cast.

A **panic** rotation — you believe a key leaked — is different and immediate: set the new
secret on both processes with no `*_PREVIOUS`, and redeploy. Every outstanding ticket and
approval token becomes invalid at once, which is the point, and every in-flight payment
fails closed rather than being honoured under a secret you no longer trust.

---

## 6. `CREDENTIAL_PEPPER` is not rotatable

Argon2id runs over `pepper ‖ secret`, and the pepper lives outside the database so a stolen
credentials table is not a usable one. There is no pepper version column and no key ring for
it, so changing `CREDENTIAL_PEPPER` invalidates **every** agent and approver credential at
once: they all 401, and each has to be re-minted and re-delivered by hand.

Deliberately not half-built. If this ever needs to be rotatable, the change is a
`pepper_version` on the credential row and a verify-then-resave path, not a second pepper
list in the environment.

---

## 7. Backups, and what staging does not prove

- **Backups are the database provider's job and nobody's default.** Neon's restore window
  and PITR availability depend on the plan; check what the deployed project actually has
  before treating the ledger as durable. Nothing in this repository takes a `pg_dump`, and
  `THREAT_MODEL.md` names a leaked backup as an attacker asset — an export of the ledger
  carries peppered hashes, every recipient address and the whole audit chain.
- **Staging runs `SIGNING_PROVIDER=mock` and `SIMULATION_PROVIDER=mock`.** What that proves
  is the plumbing: policy evaluation, reservations, sealing, the process boundary, single
  use, credentials, row security, the approval loop, the proxy allowlist. What it proves
  about a chain, a dWallet, or a fee is nothing. The lifecycle stops at `SIGNING_COMPLETE`
  because a mock's word is not a chain fact (S12), and no amount of green staging makes
  `BROADCAST` or `BROADCAST_CONFIRMED` reachable — nothing in this build writes them.
- **The hosted ledger and a local `pnpm db:up` are two bodies of data.** Nothing has ever
  been migrated from one to the other, and the seeded tenants in each are unrelated.

---

## 8. Onboarding the first human

There is no signup, and no session model. In order:

1. `POST /v1/organizations` with `Authorization: Bearer $ORG_BOOTSTRAP_TOKEN` — creates the
   tenant and its first owner.
2. `POST /v1/users`, then `POST /v1/users/:id/credentials` — both bootstrap-gated. The
   credential is printed once and cannot be read back.
3. `ari` (or the console) with that `ucrd_` — agents, wallets, policies, approvals.

The web console's proxy **refuses** the three bootstrap routes by construction, so a browser
can never mint authority: an operator pastes a credential the CLI made. The route by which a
signed-in person mints their own `ucrd_` is Stage 3 of the current plan (`POST
/v1/me/credentials`), and until it exists, `settings/page.tsx` says so on screen rather than
pretending otherwise.
