# ARI — project memory

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

## State — 2026-09-27 (fourth pass): the console is wired to a deployment

Phase 10 moved from *built, not wired* to **live, partly wired**. `apps/web` is the only
frontend now; `apps/dashboard` is deleted, and its `preflight.mjs` came with it as
`pnpm web:preflight` (scoped to `app/console`, `components/console`, `lib/ari`; the two
whole-app motion rules report as unjudged warnings there because the files that satisfy them
are the marketing layer's).

| Console surface | State (as of `8f4b4ee`) |
|---|---|
| overview, transactions list + detail (with the rebuilt trace), approvals, audit, wallets, agents list + detail, policies list + detail, risk, settings, developers | **live** — every screen reads the tenant through the proxy |
| approve / reject, revoke agent, mint agent credential, register/grant wallet, apply/activate policy | **live writes** — POST, then the queue is re-read |
| agent credential inventory, policy document body, balances, users/keys/webhooks/billing | **not drawn**: no read exists, and the screen says so rather than filling the space |

All thirteen console routes plus `/docs`. Verified in **both** states by driving the real pages
over CDP (`node apps/web/scripts/live-probe.mjs <bearer> /console/settings ...`, which visits each route connected and then unconnected in one browser session): connected
renders the live `payer`/`seed` rows with real ids and decimal counters; unconnected renders the
labelled fixture with a matching banner.

Decisions from this pass a later session must not quietly reverse:

- **The browser never talks to `ari-api`.** `apps/web/app/api/ari/[...path]/route.ts` is a
  same-origin proxy, chosen over CORS so the payment API's authentication surface does not
  grow an `Origin` concept for a frontend's benefit. Its **allowlist is the control**: method
  and path both have to appear, so `/v1/transactions/authorize` and `/evaluate` (the routes
  that spend, on an agent secret) and the three bootstrap routes (which mint human authority)
  are refused at the proxy with a 404 that names nothing. A generic tunnel would have handed a
  browser tab the whole route table. The upstream is `ARI_API_URL` from the environment and no
  request can choose it. Verified over a real socket: authorize and `/v1/users` both 404, and
  an unreachable upstream is a 502 rather than a silent pass.
- **A credential is pasted, held in `sessionStorage`, and never minted by the app.** `013`'s
  answer stands — no cookies, no session model, no invented login. The routes that could mint
  the first approver credential sit behind the deployment's bootstrap token, which is
  deliberately not proxyable, so an operator hands the console a `ucrd_` secret the CLI made.
  Anything that changes this is a security decision, not a frontend one.
- **One view model, two adapters** (`lib/ari/console.tsx`): `fromSample` and `fromLive` both
  produce `ConsoleView`. A field with no live source is **dropped from the view, not
  invented** — which is why `ConsoleTransaction` is not `TransactionRecord`: the fixture's
  risk assessment carries `baselineWindowDays` and `modelVersion`, the engine logs neither on
  the request row, and a number made up to satisfy an interface is what this whole file exists
  to refuse. Same reason `ticket` is always null on a live row: no read exposes a ticket.
- **An unwired screen refuses rather than showing the fixture under a live banner.** The
  global notice says which tenant you are looking at; a page of sample rows beneath a caption
  reading "live tenant" is a page of lies with a true header. `UnwiredScreen` names what it
  needs instead.
- **`@ari/client`'s discipline moved to the browser** in `lib/ari/wire.ts`: hand-rolled
  strict parsers (zod is not a dependency here), an unknown field is `CONTRACT_MISMATCH`,
  money stays a decimal string, and one refresh refuses if its envelopes name different
  tenants. `/v1/approvals` and `/v1/agents` answer with bare arrays and no envelope, so they
  are excluded from that check and the code says why rather than quietly skipping them.
- **The waitlist no longer shares the operational database.** `lib/db/index.ts` reads
  `WAITLIST_DATABASE_URL`, lazily, and `app/api/waitlist/route.ts` answers
  503 `WAITLIST_UNCONFIGURED` rather than 500 or a false 200; the table lives in
  `apps/web/db/waitlist.sql`, **not** in `migrations/`, because `global-setup.ts` re-applies
  every file there against the ledger schema.
- **v0's page keeps its layout and lost two things**: the chain and social logos came from
  `cdn.jsdelivr.net/gh/glincker/thesvg` (sourcing them locally turned into licensing
  guesswork over brand marks, so the networks strip is text-only now — same slots, no
  third-party request), and the footer's Discord/X/GitHub links pointed at generic
  homepages, so they are gone; `READ THE DOCS` points at this repository's README.

- **The licence is BUSL-1.1**, with the Additional Use Grant withholding exactly one thing:
  running Ari as a third party's permission infrastructure. Non-production, internal, and
  own-agents use are permitted, so an evaluator never has to ask. **Resolved 2026-09-28:** the
  Licensor is `zeroxcyril` — the handle the owner signs as, there being no company and no
  domain — and the two site footers' copyright lines were brought into line with it, because a
  footer reading "© 2026 ARI SYSTEMS" over a licence naming a different holder is the one
  contradiction a reader can act on. "Ari" stays as the product wordmark; do not reintroduce
  "ARI SYSTEMS" as if it named an entity. **Still open:** the **Change License is Apache-2.0,
  which is what most BUSL holders use but is not GPL-2.0-compatible**, while covenant 1 of the
  licence text asks for GPL-2.0-or-later or something compatible with it — GPL-3.0+ is the
  covenant-strict substitution, so switching is a one-line edit if that matters more than the
  patent grant. `Change Date` is 2030-09-27; the licence also converts four years after first
  public distribution, whichever is sooner, so a Change Date earlier than that is the only one
  that actually binds.

**Corrected as of the fifth pass.** Done since: the `/record` trace builder
(`lib/ari/trace.ts` — six stages rebuilt from the row's own events, each stage naming the
event ids it came from, `NOT_REACHED` drawn rather than hidden, EXECUTION reporting itself
unsettled), the developer route table's five new reads, and **an authenticated 200 through
the proxy for every read** (`summary`, `transactions`, `wallets`, `policies`, `approvals`),
with `agents` correctly answering `403 SCOPE_REFUSED` because that credential carries no
`agent:manage`. `/console` renders 200.

Still refused by design, in the order it costs: **wallets** (`view.grantRows` is now the
data it needs; its `grants` block still rebuilds from the fixture and the downstream JSX
references `grant.agent` / `grant.version`, so it is a rewrite of one table, not a rename),
**agents** (same rows, plus it wants `purpose`/`owner`/`created`, which no read returns),
**policies** (needs the frozen document rendered live), **risk** (the bands are derivable
from the assessments already on the view), **settings** (people/keys/webhooks have no reads
at all, and this is where a signed-in person should be *minting* a `ucrd_` rather than
having one pasted), **developers** (static docs; its sample keys must not render as
credentials). Then re-add the CDP screenshot tool that died with `apps/dashboard`: the
live state has been proven over HTTP and by build, **not** by clicking through a browser,
so a session that can drive Chromium should confirm the connected render before this is
called a shipped console.

**The favicon was v0's own.** `public/icon.svg` and the three PNGs were the generator's default mark, so every browser tab said v0 while the site said Ari. They are now rendered from `docs/assets/ari-logo.svg` (its C2PA provenance manifest stripped: 40 KB of the 42 KB was that blob, not drawing), on a paper ground so the ink mark reads on both light and dark chrome, at 32/180/192. The five shadcn `placeholder.*` files went with them. If v0 is ever used to regenerate the page, these files come back as its defaults — check them after any regeneration, not just this once.

`apps/web` has no ESLint or Prettier config, and `next build` runs no lint; the gates it
does have are `web:typecheck`, `web:preflight`, `web:build`.

**Verifying the console in a browser: use `pnpm start`, not `pnpm dev`.** This cost an hour.
Under Turbopack dev on this box the browser is asked for app chunks the server has not
finished writing, so the same file answers 403 on the initial `<script>` load and 200 on the
dynamic import seconds later; hydration dies silently, the page becomes a static picture of
the sample tenant, and every symptom downstream reads like an application bug — "the
credential does nothing", "the banner never changes", zero `/api/ari` requests. The
production build serves a complete asset graph, so there is no race: `pnpm web:build && pnpm
--dir apps/web start`, then `node apps/web/scripts/live-probe.mjs '<bearer>'`, which drives
headless Chromium over CDP and prints the failed requests, whether React hydrated, whether
the connect form was replaced by the connected buttons, and the banner text. `react root: 0`
means no hydration; `forget present: true` means the credential was restored and the reads
went out. Deleting `.next` under a live dev server reproduces it exactly — if you do it, the
server that survives is a zombie emitting references to files that no longer exist.

Two things that probe also settled: the restore path works (the earlier zero-fetch readings
were the dev race, not the effect), and a partial credential is now genuinely usable — an
approver's secret that lacks `agent:manage` gets a live tenant plus a named refusal for the
one route, instead of the sample view and an error line nobody could act on.

## State — 2026-09-28 (sixth pass): the delivery gate, and what Pxxl will not do on Free

Two things happened: the first production deploy was attempted, and the platform turned out to paywall
precisely the shape we designed for. What shipped is in `7d492de` and `a63c6b4`, both on `origin/main`.

### The signer's socket is now a surface with rules of its own

`ari-signer`'s transport moved out of `main.ts` into **`apps/signer/src/http.ts`**, which was worth doing for
its own reason: the route had **no tests at all** — `handler.test.ts` called `createSignHandler` as a plain
function, so the 404, the 128 KiB cap, the JSON refusal and the answer-whatever-happens 500 were unasserted
claims about a socket. They are asserted now over a real server on port 0 (13 cases), which is also the only
way we learned that the 413 response still reaches the client after `req.destroy()`.

- **`GET /healthz`** answers `{status:'ok'}` before the path table and before any body is read, and it is the
  only GET. Not cosmetic: Pxxl schedules each service as a Nomad job that must pass an HTTP health check
  before its route is promoted, and the signer previously 404'd everything including the check.
- **`SIGNER_DELIVERY_KEY`** gates `/v1/sign` as a bearer, checked before the body, refusing with one
  non-discriminating code (`SIGNER_UNAUTHENTICATED`) whether nothing or something-nearly-right was presented.
  **Two rules, and both matter: presence enforces, so a deployment that configured one side only fails at
  startup rather than at first payment; a non-loopback bind *requires* it, on either process.** Loopback with
  no key stays legal, which is what the local flows use.
- **A 401 is mapped without reading the body, and that is the money-bearing line in the file.** The signer's
  own refusal name is `TICKET_INVALID`-adjacent and `TICKET_INVALID` is in `TERMINAL_REFUSALS`
  (`apps/api/src/authorize.ts`), so reading through it would have released the day's capacity *and* left a
  minted, unredeemed ticket live — capacity twice over one typo. `tests/security/api.test.ts` asserts the
  parked outcome against the real routes, and tonight it was observed on live processes: wrong key →
  `TICKET_ISSUED_NOT_DELIVERED SIGNER_UNAUTHENTICATED`, reservation `HELD`.
- `acceptsBearerSecret`/`bearerToken`/`isLoopbackHost` live in `@ari/signing`, and
  `acceptsBootstrapToken` delegates to them — one comparison, not four. The byte guard is load-bearing:
  a `string.length` check calls `é` one character and two bytes, and the mismatch it lets through makes
  `timingSafeEqual` **throw**, turning a denial into a 500.
- `tsx` moved to `dependencies`: both processes run as `node --import tsx …`, so an install that prunes dev
  dependencies yields a container that cannot boot — and `@node-rs/argon2` is the only other production
  dependency, and the thing that hashes credentials.
- Gates at this revision, re-run after the phone pass: `pnpm typecheck` clean, **364** unit, **246** security.

### A hosted database is a different security property, not the same one with a new hostname

Every `DATABASE_URL` this repository had ever seen was `127.0.0.1`, where encryption is a
matter of taste. Choosing an **external Postgres** for the deploy made that invisible
assumption false, and measuring it turned up something worse than a missing `sslmode`:

- `pg-connection-string@2.14` maps **no `sslmode` at all** to `ssl: undefined` — a plaintext
  connection. A provider's copy-to-clipboard string is exactly that shape, so the service
  would boot, pass its health check, enforce row security correctly, and carry the login,
  the peppered credential lookups and every payment row across the internet unencrypted.
- It maps `require`, `prefer` and `verify-ca` to a **verifying** socket today, and prints a
  warning that v3.0.0 / `pg` v9 will give them libpq's weaker meanings. So a rule that
  accepted `sslmode=require` would be a control now and an unverified connection after a
  routine dependency bump — which is why the rule names `verify-full` and refuses the rest,
  including `no-verify` (an impostor answering row-security questions is the one threat
  `011` exists to hold).
- **`inspectDatabaseUrl` in `@ari/ledger`** (`src/connection.ts`) is that decision, made from
  the URL before a socket opens: loopback exempt, `verify-full`/`ssl=true` accepted, anything
  else refused with the reason and the fix in the sentence. Both `readConfig`s and
  `scripts/migrate.mts` call it, so a misconfigured deployment never starts — the same shape
  as `DATABASE_ROLE`, which exists because a silently-wrong database identity reads as working.
- **`pnpm db:preflight -- <url>`** runs the checks a deploy hinges on in one read-only pass:
  TLS as *negotiated* (`pg_stat_ssl`) not as requested, `CREATEROLE`/superuser for the login,
  whether `-c role=ari_app` survives their pooler, whether the advisory lock the audit chain
  depends on can be taken, RLS coverage using **the same predicate `schema.test.ts` uses**,
  and connection headroom against the two pools. It never writes; migrations stay
  `pnpm db:migrate`.
- **The waitlist got the same rule, without importing it.** `apps/web` is outside the
  workspace by an explicit decision, so `lib/db/tls.ts` is a second copy of the predicate and
  `waitlistProblem` now returns `UNENCRYPTED_CONNECTION` (routed to
  `WAITLIST_INSECURE_URL`, via a `Record<WaitlistProblem,string>` so a new problem cannot
  silently reuse somebody else's code). Two copies of a security rule is only survivable if
  something checks they agree: `tests/unit/waitlist-tls.test.ts` asserts the ledger's
  `inspectDatabaseUrl` and the web predicate decide identically over 66 host×sslmode
  combinations, which is the same "both copies tested against each other" shape as the
  lifecycle drift guard. Importing that file surfaced a genuine inconsistency —
  `apps/web` had no `"type"` field, so the root program compiled its ESM files as CommonJS and
  `verbatimModuleSyntax` refused them. It is now `"type": "module"`, which is what it always
  was: the package contains no `.js`/`.cjs` files at all, and `next build` passes.
- **Run against a real provider, the rule held and one of its own checks was wrong.** Neon
  (`eu-central-1`, direct endpoint, `?sslmode=verify-full&channel_binding=require`):
  `role-at-connect survives` came back `session_user=neondb_owner, current_user=ari_app`, so a
  managed Postgres *can* satisfy the design — the pooled/`-pooler` endpoint cannot. But
  `TLS as negotiated` failed first, because `pg_stat_ssl` for our backend pid answered
  `ssl=false` while `inet_client_addr()` reported **`10.58.5.100`**: the provider terminates TLS
  at its own proxy and the backend hop is internal, so the server's view of the socket is not
  the socket we opened. Reading that as a failure would reject every managed Postgres on earth.
  `tlsVerdict` now separates the two — a successful `verify-full` handshake *is* the proof, the
  server's row is corroboration, and the case that genuinely deserves a warning is "no TLS seen
  from a public address", which is not a proxy story. Four tests, one of them that measured case.
- **The env file that carries a Postgres URL must quote it.** `DATABASE_URL=postgresql://…?sslmode=…&channel_binding=require`
  is not a shell assignment — the `&` backgrounds the rest and `.` on the file dies with a parse
  error, which is how "it works" turned out to mean the check had never run. Double quotes fix
  it for both readers (verified: shell keeps the value, `node --env-file` strips the quotes), and
  the pxxl env form wants the value *without* them.

- Two things it caught while being written, both mine: a first version checked "every table
  in `ari`" and failed on `organizations`, which has no `org_id` because it *is* the tenant —
  the invariant is `hasOrgColumn && !rowSecurity` except `signing_tickets`, and the preflight
  now says so by borrowing that predicate rather than inventing a second one. And
  `pnpm db:preflight -- <url>` forwards the `--` as an argument, so the script read the
  literal string `--` as a hostname; positional args now skip it.

### Pxxl: what was measured, not read

- The CLI and SDK hardcode `https://gateway.pxxl.app/api/v3`, which answers `404 domain_not_connected` —
  their edge has no origin for that hostname (`api.` and `dashboard.` do too). The live host, from their own
  dashboard bundle, is `server.pxxl.app/api/v3`, and there the key returns
  `402 plan_upgrade_required / requiredPlan: "Plus"`: *"The Pxxl SDK and CLI require an active paid plan."*
  `pxxl login --api-url` throws by design and the SDK's `baseUrl` is `@deprecated` then overwritten
  (`pxxl/dist/index.js:28`), so there is no local workaround, and 0.1.11 is the newest published CLI.
- **Multiple Services is real but paid** — `Route: No` (an unrouted service with no public hostname) is
  exactly what Ari wants for the signer, and it is behind Plus. `deploy()` forwards twelve scalar keys and no
  `services` array, and `pxxl init` never copies the manifest's `services` into `pxxl.toml`, so the CLI could
  not express it either. Free tier: 5 projects, 1 domain, 1 database, and the Database/Domain/MCP sidebar
  entries are lock-iconed. Regions are **Europe only** (`eu-central` Nuremberg default, `eu-west` Paris,
  `eu-north` Helsinki) despite the positioning. Runtime is Nomad + Consul + gVisor, Caddy at the edge, env
  via Vault; archives ≤ 220 MiB (this repo measured 2.0 MB).
- The card failed, so Plus was not available. What follows is the two shapes, ready to type.

**Free — three projects, one repo, commit `a63c6b4`.** The signer is public-by-necessity and the delivery
gate is what makes that survivable; turn on Pxxl's Password Protection for its hostname too if their edge
challenge accepts a non-browser client (untested — if it does not, the api's delivery silently parks holds,
which is why the stderr line exists). **This is the shape that ran, with one substitution**: the third row is
`ari-web` and the two-web-service cap below killed it — the frontend went to Vercel instead, so the two pxxl
projects are `ari-api` and `ari-signer`.

| Project | Working dir | Port | Install | Build | Start |
|---|---|---|---|---|---|
| `ari-web` | `apps/web` | 3000 | `pnpm install --frozen-lockfile` | `next build` | `pnpm run start` |
| `ari-api` | `apps/api` | 4000 | `cd ../.. && pnpm install --frozen-lockfile` | — | `pnpm run start` |
| `ari-signer` | `apps/signer` | 4100 | `cd ../.. && pnpm install --frozen-lockfile` | — | `pnpm run start` |

Env: `ari-web` `ARI_API_URL=https://<api host>`, `WAITLIST_DATABASE_URL` (optional; unset answers 503 by
design). `ari-api` `API_HOST=0.0.0.0`, `DATABASE_URL`, `DATABASE_ROLE=ari_app`, `TICKET_KEY`, `APPROVAL_KEY`,
`CREDENTIAL_PEPPER`, `ORG_BOOTSTRAP_TOKEN`, `SIGNING_PROVIDER=mock`, `SIMULATION_PROVIDER=mock`,
`SIGNER_URL=https://<signer host>/v1/sign`, `SIGNER_DELIVERY_KEY`. `ari-signer` `SIGNER_HOST=0.0.0.0`,
`SIGNER_WALLETS`, `TICKET_KEY`, `SIGNER_DELIVERY_KEY`, `DATABASE_URL`, `DATABASE_ROLE=ari_app`,
`SIGNING_PROVIDER=mock`. Health check path `/healthz` on both backends, `/` on the web. Replicas 1 each.
`API_HOST`/`SIGNER_HOST=0.0.0.0` are not optional — both bind loopback by default and a container that binds
loopback starts cleanly, passes its own health check, and 502s from outside.

**Plus — one project, three services**, `pxxl.toml` already pins the build for it, and `Route: No` on
`signer` is set in the dashboard (the file cannot say it). Then `SIGNER_URL` is the internal alias form —
measure it from the api container with `curl http://signer:4100/healthz` — and the gate stays on as defence in
depth at no cost.

**Three measurements decide any Pxxl deploy** — the first two are database questions and
`pnpm db:preflight -- '<hosted url>'` runs them (plus TLS-as-negotiated, the advisory lock,
RLS coverage and connection headroom) in one read-only pass, exiting non-zero on any failure,
so do it before pointing a service at anything. In order: does the managed login have `rolcreaterole`
(`migrations/003_audit.sql` runs `CREATE ROLE ari_app NOLOGIN NOINHERIT`, and `scripts/migrate.mts` names the
fallback); does `options: '-c role=ari_app'` survive their **database router** — the probe is
`SELECT session_user, current_user`, and if it is not `ari_app`, the answer is a session-mode endpoint, **never
dropping `DATABASE_ROLE`**, which is the silent multi-tenant hole the startup refusal exists to prevent; and
whether an unrouted service is addressable at all, which is a platform question no database
preflight can answer and only the dashboard — or a `curl` from the other container — tells you.

**Migrations are run from outside the service, once:** `DATABASE_URL='<hosted url>' pnpm db:migrate`. Not
from the app — `ari_app` holds no DDL rights by design (`008`), and not from a test harness that would skip on
an unreachable database. It re-applies all fifteen files idempotently, so a rerun is safe and a failure names
the file.

### Staging that runs tonight, at zero cost

`ari-api` + `ari-signer` + the existing Postgres on this box, with `cloudflared`'s account-free quick tunnel
in front of the API only — the correct topology, because the signer never leaves `127.0.0.1`. Observed end to
end over the public HTTPS origin: `preview → DECIDED`, five $900 payments then
`DENIED AMOUNT_EXCEEDS_DAILY_LIMIT,LIMIT_RESERVATION_FAILED`, `RECIPIENT_NOT_IN_ALLOWLIST`, and the approval
loop — $2,000 → `APPROVAL_PENDING`, the agent 401'd when it tried to decide its own approval, one approver
vote → `GRANTED`, the retry with that seal → `COMPLETE` on the same `txr_` id, token absent from every
agent-readable read. Ledger agreed: `SETTLED` holds, `approval.granted/human=1`, `ticket.minted/agent=4`.
Seed to `/tmp/ari-seed.json` (0600), key in `/tmp/ari-keys.env`, drivers in `/tmp/ari-staging-proof.mjs` and
`/tmp/ari-one.mjs`. A quick tunnel is ephemeral and unauthenticated at the edge: it is staging, not a host.

### What is actually deployed, and the three providers it took

The topology above is not what runs. Pxxl Free caps **web services at two** — it lets the third project be
created and refuses its *Web Service* type — and `Route: No` is Plus, so "one project, three services, signer
unrouted" was not reachable on this plan. (Note the discrepancy worth re-checking rather than trusting either
number: their pricing page's "5 projects" is not what this workspace offered, which was four, and two of those
usable as web services.) What is live, with the signer public by necessity:

| Piece | Origin | What it is |
|---|---|---|
| web | `https://ari-zeta-seven.vercel.app` | Next 16 on Vercel, root directory `apps/web` |
| api | `https://ari-api.pxxlspace.cv` | pxxl Free web service, `API_HOST=0.0.0.0`, port 4000 |
| signer | `https://ari-signer.pxxlspace.cv` | pxxl Free web service — **routed, therefore public**, which is the whole job of the delivery gate |
| db | Neon `ep-rough-forest-b1a4mlmx`, `eu-central-1`, **direct** endpoint | `?sslmode=verify-full&channel_binding=require`, migrated and preflighted |

Re-measured over the public internet at 14:3x today, from this box, not from a dashboard:

- api `GET /healthz` → 200 `{"status":"ok"}`. Signer `GET /healthz` → 200 — healthz is answered **before** the
  gate, so a platform probe never needs the key, which is the ordering the code intends.
- Signer `POST /v1/sign` with no bearer → 401 `SIGNER_UNAUTHENTICATED`. Signer `GET /` → **401, not 404**: the
  gate runs before the path table, so an unauthenticated probe cannot enumerate the service's routes. That
  difference is the argument for a public signer being survivable, and it is now an observation rather than a
  reading of `http.ts`.
- api `POST /v1/transactions/evaluate` with the seeded agent credential gets *past* authentication (the 400 was
  my hand-built candidate failing `safeParse`, which is a credential-accepted signal). `GET /v1/approvals` →
  200 `{approvals:[]}` for the operator credential and 401 for the agent credential: the `crd_`/`ucrd_` split
  holds across a public hop, not just on loopback.
- web `POST /api/waitlist` → 503 `WAITLIST_UNCONFIGURED`. `WAITLIST_DATABASE_URL` is not set on the Vercel
  deployment. That is the designed refusal — an unset database must neither throw addresses away nor claim to
  have saved one — but it does mean the live form currently accepts nothing. **Thread 13.**
- Earlier in the day, one $100 payment ran end to end through the trio: `COMPLETE`, hold `SETTLED`,
  `settled=100000000` (six decimals), `settled_requests=1`. The approval loop went $2,000 →
  `APPROVAL_PENDING` → the agent 401'd on its own approval → one approver vote `GRANTED` → `COMPLETE` on the
  same `txr_`, token absent from every agent-readable read. Through the Vercel proxy,
  `POST /api/ari/transactions/authorize` answered 404 **while carrying a valid agent secret** — the allowlist is
  a server-side list of method+path pairs, so an unlisted route does not exist for a browser tab.

Three things only the deploy could teach:

- **`SIGNER_URL` is exactly `…/v1/sign`** — no trailing slash, no extra path. That one character was
  `ada49d6`: the signer's 404 body carries no `code`, the client used to default a missing code to
  `TICKET_INVALID`, `TICKET_INVALID` is terminal, and a day's capacity was released beside a live unredeemed
  ticket. The api's parked-delivery line on stderr is what made it diagnosable at all.
- **Vercel redeploys `main` by itself.** The live stylesheet's `last-modified` was `12:09:15Z` against a commit
  at `12:07:30Z` — two minutes. For the web, pushing to `main` *is* the deploy step. The two pxxl services are
  still dashboard-redeployed, and there **an environment change without a redeploy is a change that did not
  happen**: env reaches a new deployment, never a running container.
- Secrets live in five values in `~/ari-prod.env` (0600, `DATABASE_URL` double-quoted because of its `&`) and
  the same names typed into each dashboard's env form, unquoted. Nothing is in the repo. The signer's hostname
  is not the secret; `SIGNER_DELIVERY_KEY` is, and it is set on both ends.

### The phone pass: one meta tag, one hydration wall, and one regression of my own

The brief was "it looks funny on mobile and i cannot see the loading animation… make sure you keep the design".
So this was a responsiveness pass: no type scale, palette, spacing or component change moved, and
`pnpm web:preflight` still gates it.

- **Every phone was rendering the desktop page.** `app/layout.tsx` exported a `viewport` carrying `colorScheme`
  and `themeColor` and no `width`, so Next emitted no `width=device-width` tag. A 390px emulated viewport
  reported a **753px layout width**, and the desktop control matched its override exactly — which is what pinned
  the cause to the meta tag rather than to any CSS. Every "funny on mobile" complaint runs through that line,
  and no media-query work would have moved it.
- **The loader was present and invisible.** `.page-loader` is opaque from first paint (measured `opacity=1`,
  `bg=rgb(2,2,2)`), but the mark, wordmark and bar were framer-motion children sitting at their `initial`
  values (`opacity:0`, `width:0`) and those only animate once React has hydrated — hydration being the slow
  part on a phone. They are plain DOM with CSS keyframes inside the motion container now, so the entrance is
  painted rather than hydrated.
- **`vh` → `dvh`, converted in place.** The first attempt appended `.rail { height: 100vh }` *after* the 900px
  `height: auto` rule, which pushed the whole console below the fold on a phone. The sweep reported
  **0 px overflow** — a true statement about width — while the screen was still wrong. That is the one false
  clean this pass produced, and only the screenshot caught it: the metric measures width, the product has
  height.
- **`1fr` is `minmax(auto, 1fr)`**, so the grids the mobile rules "collapsed" to one column could not shrink
  below their content's min-content width; a 467px table inside a `1fr` grid makes the *page* 467px wide.
  `minmax(0, 1fr)` is the same layout that can. `pre` got `max-width:100%; overflow-x:auto`, and `/docs` had
  **no** mobile rules at all before this.
- **320px `.kv` starvation, found by measurement:** a 132px label column + 20px gap + a 140px
  `AWAITING_APPROVAL` (10px monospace at `.13em`, `white-space: nowrap`) is 292px inside a 236px panel, so the
  value column got 84px and the state spilled to `right=334`. Shrinking the label column cannot fix it (labels
  need ~90px; `LAST REQUEST` is 88px), so `.kv` stacks at ≤480: 2px rows bind a value to its label and the `dd`
  margin is what separates one pair from the next.
- Harness, now in the repo: **`pnpm web:sweep [origin] [cdpPort] [widths]`**
  (`apps/web/scripts/responsive-sweep.mjs`) walks 15 routes × 5 widths and flags only overflow
  that no ancestor clips — the first detector counted clipped marquee tracks and scrollable
  tables and produced three phantom bugs. **`pnpm web:why-overflow <origin> <path> <width> <selector>`**
  walks that element's ancestor chain printing rect, `display`, `min-width`, `white-space`,
  `grid-template-columns` and `overflow-x`, which is what turned "which box is too wide" from a
  guess into the two lines above. Result: **75/75 combinations clean, 0 unhunted**, live on the
  deployed origin at 320 and 390, and `web:typecheck` / `web:preflight` / `web:build` pass. Both
  exit non-zero on any miss, delete their own Chromium profile (which is what fills `/tmp`),
  and say in their headers that they measure width only.
- One thing left alone on purpose: the hero `h1` at 320px sets five lines with "FOR" alone on one. Tightening it
  means changing the type clamp, which is the design, under an instruction that said keep the design. It is a
  call for the owner, not a defect to sweep.
- **`/tmp` here is a 3.8 GiB tmpfs and every Chromium profile dir is ~125 MB.** Fourteen probe runs filled it,
  after which `--headless=new` cannot start and a CDP harness dies with "no DevTools page target" — or worse,
  exits on an unsettled `await` printing *nothing*, which looks exactly like a clean sweep. The sweep now bounds
  every CDP call and counts a `MISS`, and probe profiles are deleted when the run ends. If a browser probe
  behaves strangely, check `df -h /tmp` before believing the page.

### Stage 1 — operability: what the processes say about themselves (seventh pass, 2026-09-28)

The deploy worked; *observing* it did not. `fastify({ logger: false })` made `app.log` a no-op,
so every silence this repository chose **outward** — the 500 that answers `{code:'INTERNAL'}`,
the parked delivery that writes no audit event by decision rather than by omission — was
silence **inward** too, and the only way to learn what broke was to reproduce it. Stage 1 of
the current plan is about that, and it is shipped.

- **`apps/api/src/observe.ts` + `apps/signer/src/log.ts`**: JSON on stdout, level from
  `LOG_LEVEL` — the name `.env.example` had carried since before either process read anything,
  which is the `API_HOST` defect in another variable — with `API_LOG_LEVEL`/`SIGNER_LOG_LEVEL`
  overriding per process and both accepting the same seven words. A typo becomes `info` rather
  than a refusal: a log level must not stop a payment service.
- **One id across the boundary.** `x-request-id` is echoed on every response, minted when the
  caller sent none, honoured only as a bounded opaque string, and forwarded to the signer as a
  header — never in the body, which stays the two things the verifier reads. Both processes
  write it as `httpRequestId`, and the ledger row separately as `transactionRequestId`: three
  identifiers, three names. Observed on live processes with a mismatched delivery key, the
  api's `warn` and the signer's `info` carry the same id, `reservation:"HELD"`, and no ticket
  in either log.
- **`/healthz` is a claim about the service now** — `probeDatabase` in `@ari/ledger`, 500 ms
  bounded, `SELECT 1`, `200`/`503` with `{status, db, version}` — shared between the two
  processes so they cannot disagree about the word. It stays ahead of the signer's gate and
  the path table, which is asserted.
- **`/metrics` exists only if `METRICS_TOKEN` does** (404 otherwise, not a 401 advertising a
  door), hand-written exposition, and **no series labelled by tenant, agent, credential,
  digest or request id**: a scrape endpoint with a token and no principal must not answer "who
  is moving how much" (T20). The assertion is on label *keys* and identifier-shaped *values*,
  not on the whole text — `ari_api_credential_verifications_total` is a name that has to say
  what it counts.
- **`@ari/reconciliation` reports and repairs nothing.** Six codes, one SELECT each, each
  naming its tenant in the `WHERE` — which for `signing_tickets` *is* the isolation, since
  `011` leaves that table outside row security on purpose. It releases nothing, re-delivers
  nothing, prunes nothing: a sweep that could release a hold is a sweep that will one day
  release the wrong one, and non-terminal refusals keep capacity parked by design. One new
  event, `reconciliation.reported`, carrying the non-zero codes and the total — the numbers are
  re-derivable; the event is the witness that you looked.
- **No scheduler, deliberately.** `GET`/`POST /v1/operations/reconciliation` and
  `ari reconcile`, gated on `audit:read` so `013`'s scope CHECK does not widen. A correcting
  pass would need a lock, a timer, an idempotency key and the authority to move money-adjacent
  state, which is Phase 8's with a provider-confirmed callback attached.
- **Key rings, and the order they deploy in.** `TICKET_KEY_ID`/`TICKET_KEY_PREVIOUS` (and the
  approval pair) let one generation verify while the other signs; the head always signs. A
  previous secret with no id is refused at startup — a key nobody can name is a key nobody can
  retire. The wire format carries **no** `kid`, weighed and kept, so a failed seal is
  indistinguishable from a forgery and the *order* is the control, which is what
  `docs/OPERATIONS.md` §5 exists to say. `CREDENTIAL_PEPPER` rotation is **not** built, and the
  doc says why: Argon2id-over-pepper means a new pepper 401s every credential at once.
- **`docs/OPERATIONS.md`** is the operator's file: preflight before anything starts, the two
  `0.0.0.0` binds, the quoted `DATABASE_URL` in a shell file and unquoted in a dashboard form,
  what each health/metrics answer actually promises, how to read a report, the rotation order,
  backups, and what staging does not prove.

Four things this pass found by being written, each pinned by a test now:

- **An approval waiting on a human holds no capacity.** `reserve` is downstream of the approval
  branch, so the first version of that query — which required a `HELD` reservation beside the
  expired approval — could never fire. That is the defect this file already records for a
  policy option that silently evaluates to false, arriving in a monitoring query. It is
  `APPROVAL_EXPIRED_UNANSWERED` now, and the assertion is `1`, not `0`.
- **A shared bind array across six statements is two different Postgres errors**, both
  measured here: a list longer than the statement references, and a placeholder bound but
  never mentioned (`could not determine data type of parameter $2` — a parameter's type is
  inferred from where it is used, so an unused one has none). Each query declares its own binds
  beside its own SQL, and a unit test asserts the list is dense `$1…$n`.
- **`event_type` had no gate but the TypeScript union.** `003` leaves it plain text, and this
  file has always named that as why the union matters — but a union is erased by the first
  `as`, by a caller building input out of config, or by anything in JavaScript, and the row
  that produces verifies, hashes, exports and lies. `appendEvent` now refuses a name outside
  the vocabulary at the point the row would be written.
- **`--token` is visible in the process list**, and a script launcher echoes argv before
  running it: `pnpm ari --token …` printed a live bearer into this session's transcript while
  the reconciler was being verified. The flag still works — refusing it would break every
  script that exists — but the tool says so once and names `ARI_TOKEN`.

Gates at this revision: `pnpm typecheck` clean, **406** unit, **258** security. Stages 2 (read
path, indexes, statement combining, the console's seven-fetch layout) and 3 (self-minted
`ucrd_`, T23 rate limiting) are planned and not started.

### The site audit, and the claims gate (same day)

An outside review of the deployed site (`~/Downloads/Audit.md`) came back with a contradiction
table. Most of it was right, and none of it was caught by a gate — because `web:preflight` runs
over the console, the tree this repository designed, while every rotting claim lives on the page
v0 generated.

- **What was false on the page:** the marquee named `2PC-MPC`, `EVM`, `SUI`, `SOLANA` as the
  stack; Ethereum read `SUPPORTED TODAY` in a build where nothing settles; pipeline step 06 said
  "Authorize with 2PC-MPC"; the risk panel listed `CHAIN`, `ASSET` and `CONTRACT` as signals,
  which `ComputedSignal` excludes precisely because nothing can compute them; the home page and
  docs both printed a test count (548) on a day the suite held 664. All replaced with what the
  code says — the marquee now runs the vocabulary the API returns, and the number is gone rather
  than refreshed, because a build cannot verify it.
- **The console tile was wrong twice.** `AUTHORISED / settled holds` displayed
  `settled + HELD` reservations: it counted parked holds as closed *and* used the word the
  settlement pass has not earned. It is `CAPACITY COMMITTED` now, and the "sample figures"
  marker is conditional on `view.source` — on a connected tenant, "sample figures" would itself
  be a lie. Where the audit's suggested wording would have been wrong for live data
  (`TICKET MINTED` for a reservations sum), the code won, as §0 of the audit says it should.
- **`web:preflight` now checks claims, not just tokens** — six rules over the marketing and docs
  tree: no settled-payment prose, no `SUPPORTED TODAY`, no `MPC`, no hardcoded test count, no
  `LIVE` badge on a marketing card, and an unsupported chain may be named *only* on a line that
  also says it is not supported. Verified with a control file: reintroduce the claims and all six
  fire with correct line numbers; delete it and the gate passes. Two distinctions make it
  survivable — comments are masked rather than deleted so line numbers stay honest, and a
  sentence that *refuses* the claim ("will not dress a mock signature up as a settled payment")
  is the honest use of the word, so the rule looks backwards for a negation.
- **The hero headline was breaking mid-word at every width, not only on phones.** The audit's
  #1 item had the right symptom and the wrong mechanism: `h1` was sized in `vw` while the
  headline lives in a grid column ~49% of the viewport, so "FOR AUTONOMOUS" needed ~1,165px in a
  706px box at 1440. Now sized against its container (`cqi`), with the two-column hero ending at
  1023px. Measured with `getClientRects` per text node at eight widths: four whole lines
  everywhere. Two traps recorded in the CSS comments — inlining the lines below 480px so
  `text-wrap: balance` could choose the breaks put the period of "AGENTS." alone on a line, and
  the collapse media query must come *after* the base `.hero-grid` rule or it silently does
  nothing.
- **`web:sweep` caught a regression the width metric would have hidden:** the unbreakable
  `REQUIRE_HUMAN_APPROVAL` at 21px is wider than the phone's decision column, which does not
  clip — it widens the *layout viewport*, so every `position: fixed` element inherits the larger
  box and the first thing reported was the page loader, three elements from the cause. 75/75
  combinations clean after the fix.

Still open from the audit, deliberately not done in this pass: the Africa block is still second
on the page, the pipeline is still taught several times, the waitlist has no qualifying
questions (and `WAITLIST_DATABASE_URL` is still unset — thread 13), the docs quickstart still
leads with `git clone`, and the items that are decisions rather than edits: a real domain, npm
for `@ari/client`, a non-mock signer, decoded-effect policy, balance evidence, settlement.

### Eighth pass — the pipeline taught once, and a harness that measures line boxes (2026-09-28 22:00–22:18, landed 2026-09-29)

Four files sat in the tree and in no commit overnight: `apps/web/app/page.tsx`,
`apps/web/app/globals.css`, `apps/web/scripts/preflight.mjs`, and the untracked
`apps/web/scripts/line-boxes.mjs`. Re-measured
2026-09-29 08:45: with these changes applied `pnpm web:preflight` passes over 23 files and
`pnpm web:typecheck` exits 0. The deployment was **HEAD, not this tree** — proven by the
differential, not by assumption: `curl https://ari-zeta-seven.vercel.app/ | grep -c checkpoint-list`
→ 0 while the worktree held it, and `origin-strip` (committed at 20:47) reads 1 in all three. So
uncommitted here also meant undeployed, and anyone who visited the live site was looking at the page
this pass decided was wrong.

- **The pipeline and its receipt are one array now.** `stages` and the separate sample-request
  panel collapsed into `checkpoints`: seven rows, each with the `ask` the checkpoint puts to a
  request and the `value`/`why` the sample got at that row. This closes the audit item this file
  recorded as deliberately undone ("the pipeline is still taught several times") — the two
  sections had *already started to disagree*, which is the whole argument for teaching it once.
  The figures are the console's own sample tenant row for row: same agent, `treasury-payments` v8,
  4,200 USDC to Brightline at `0x3f2a1b0c…1a2b3c`. Row 07 keeps its special drawing because
  acceptance still is not settlement, and the panel's second column of copy became one footnote
  (`checkpoint-foot`, labelled SAMPLE FIGURES FROM THE CONSOLE'S SAMPLE TENANT: "the words are what
  the API returns, the numbers are a request that was never made").
- **An inverted section is a light panel in the dark theme**, so the dark rules could not keep
  handing it dark-theme greys: `--dark-line` flips to `rgba(17,17,17,.22)` and the text greys inside
  `.dark-section` / `.sdk-section` are named per element (`side-copy`, `section-kicker`,
  `architecture span`, `risk-note b`, `window-bar`) instead of inherited. `.receipt-band > div`
  joins the near-black panel set. `--muted` moved twice — light `#77736d → #6f6b65`, dark
  `→ #7e7a74` — for contrast against paper, not for taste.
- **`REQUIRE_HUMAN_APPROVAL` needs `overflow-wrap: anywhere`, not `break-word`**, and the reason is
  in a CSS comment because it will be reached for again: `break-word` does not change intrinsic
  sizes, so a flex `strong` will not shrink below min-content — the token then widens the *layout
  viewport* rather than clipping, which is the exact failure `web:sweep` already reported for the
  page loader. Below 940px the two columns stack so the break usually is not needed at all.
- **Six in-page jumps do not fit a header**, so the nav is a `<details>` now — keyboard operable,
  no custom disclosure widget, no aria state to keep honest by hand. The hero's third action became
  a sentence that scrolls to the honesty block rather than a fourth button competing with the first
  two, and the record section is three statements on one 1px-gap hairline grid (the docs' pattern).
- **`line-boxes.mjs` exists because of one specific miss, and it measures the thing that broke.**
  The hero defect was sizing against the viewport while a column set the width; an overflow sweep
  cannot see that (nothing leaves the viewport) and a 390px screenshot does not show the desktop
  case. So it walks every `h1`/`h2`, takes `getClientRects()` per text node, and reports each line's
  width against its own container at 320/390/768/900/1024/1440, in either theme, exit-non-zero on
  any line over its box by >1px. Three operating notes, each earned:
  `captureBeyondViewport` is bounded at 16,000px and a 12,000px page at scale 0.32 is legible enough
  to judge rhythm — asking for the whole thing at 1x is how this harness once ate the disk; the
  beyond-viewport resize re-triggers the reveal observers and photographs a page of invisible
  sections, so the script forces `.reveal`/`.section-reveal` to their end state and hides
  `.page-loader` before capturing; and Chromium is still writing its profile when `kill()` returns,
  so the `rmSync` sleeps 900ms and retries.
  It has **no `package.json` script** and its default URL (`127.0.0.1:3131`) matches no port
  anything binds by default — pass the URL of whatever you actually started. **`/tmp/ari-lines` is
  empty this morning**, so whatever the pass measured at 22:18 is not reproducible from disk: do not
  repeat "clean at every width" as a current fact; re-run it.
- **The claims gate learned the word `nothing`.** `NEGATION` gained `nothing` — "nothing here claims
  a provider settled it" is the plainest refusal this page writes, and a gate that recognises only
  `no` teaches people to write `no` where `nothing` reads better. The 60-character backward look and
  the six rules are unchanged.

What this pass does **not** close, still open from the audit: the docs quickstart leading with
`git clone`, a real domain, npm for `@ari/client`, a non-mock signer, decoded-effect policy, balance
evidence, settlement.

### Ninth pass — the reveal that could not fire itself, and a harness that had been hiding it (2026-09-29 morning)

The eighth pass was green on two gates and unmeasured on the one thing it had just built. Running
`line-boxes.mjs` properly found a bug that was **live on the deployed site**, invisible in every
screenshot the harness had ever produced, and not caused by that pass.

- **`.architecture` — the control-plane diagram — has been invisible to every visitor with motion
  enabled.** It is `motion.div` with `initial={{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }}` and
  `whileInView`. An element clipped to zero width has **zero intersection area**, so the observer
  that watches its visibility can never report it as entering the viewport: the wipe needs the
  observer, and the observer needs the wipe. Both reveal systems failed it simultaneously — framer's
  `whileInView` and this page's own `IntersectionObserver` (which never added `is-visible` either).
  Measured, not inferred: it was the only one of 31 reveal-driven elements stuck after being
  centred in the viewport, it was stuck identically on `ari-zeta-seven.vercel.app`, and the control
  — set `clip-path: inset(0 0 0 0)` and touch nothing else — made both observers fire within 3 s.
  Under `prefers-reduced-motion: reduce` it *was* visible, because the CSS there forces
  `clip-path: none !important`; that is the only reason nobody saw it, and it is why the reduced-motion
  path had to be kept when fixing it.
- **The fix is a rule about who may be observed.** The diagram is a plain `<div>` now and the wipe is
  CSS keyed on the **section's** `is-visible` (`.section-reveal.is-visible .architecture`), which
  works because the section is not the clipped box. The reduced-motion block gained `.architecture`
  explicitly, since it no longer rides in on the `.reveal` class it used to carry.
- **Same class, smaller consequence, in the networks marquee.** Each cell was its own
  `motion.a`/`whileInView` inside `.network-strip { overflow: hidden }` on a track that animates.
  Ancestor clipping counts in the intersection too, so a cell whose turn passed while the section was
  off-screen stayed at `opacity: 0` until the 34 s loop brought it back — watched live, cells 1–7
  revealed, cell 0 (mid-slide-out when the strip entered view) never did. The cells are plain `<a>`
  now and the section fades as one; the stagger was never load-bearing, the blank cells were.
- **Two real WCAG failures, both in the new checkpoint rows.** `.stage-num`/`.stage-mark` at
  `#9295aa` on the dark theme's inverted light panel measured **2.55:1** at 10px; `.risk-signal b` at
  `#77756f` on ink measured **4.10:1**. The first joins the `.dark .dark-section …` inversion group
  that already existed for exactly this purpose (→ `#5b5b66`, **5.78:1**, no new colour); the second
  moves to `#8a8680` (**5.22:1**), still dimmer than its `#aaa79d` label (7.84) so the hierarchy
  survives. Left alone deliberately: the vermilion `·` separator at **3.42:1** — this file already
  records that the accent lives in a marker glyph and never in a word, and a decorative separator is
  that rule, not a violation of it.
- **The harness was part of the bug.** Its forcing style (`.reveal { … !important }`) ran *before*
  the measurement, so it photographed a page that looked complete while a section nobody could see
  was in it. The probe now runs **first, unforced**, and reports `STUCK <text at zero opacity>` as a
  failure; the force still applies afterwards, for the screenshot only. Line widths are unaffected by
  the reordering — opacity, transform and clip-path do not change a layout box.
- **`width * 0.62` is not a phone.** At 320px that is a 198px-tall viewport, and a 3,000px section
  cannot reach a 12 % intersection threshold in it: the first stuck run reported 115 false positives
  at 320px. Heights are device-shaped now (`≤500 → ×2.1`, `≤1024 → ×1.3`, else ×0.62), and with that
  the page is **0 stuck, 0 overflowing at all six widths in both themes**.
- **Three harnesses, two argument orders, one silent failure mode.** `line-boxes` takes
  `(url, widths, …)`, its siblings `(origin, cdpPort, widths)` — passing widths where the port goes
  produced `no DevTools page target on :NaN`, which reads like a broken browser and is a broken
  argument; an empty URL was worse, navigating to `about:blank` and reporting **clean** on a 606px
  page. All three now validate their numeric args and their URL and exit 2 with usage (verified:
  each returns 2), and `line-boxes` defaults to the same `127.0.0.1:3120` its siblings use. It is
  wired as **`pnpm web:lines`** — it had no script entry at all, so it only existed if you remembered
  it.
- **The gate can catch this class without a browser now.** `web:preflight` refuses a JSX element
  that pairs `whileInView` with an `initial` that zeroes its own area (`clip-path: inset(… 100%`,
  `scaleX(0)`, `scale: 0`). `opacity: 0` is deliberately *not* in the list — it costs no area, which
  is exactly why the `Reveal` wrapper that uses it has always worked, and a rule that banned it would
  be a rule the next session routes around. Verified the way the other claim rules were: a control
  file carrying the old `.architecture` line verbatim fails the gate at the right file and line
  number; delete it and the tree passes. What the rule cannot see is the marquee shape
  — an element with fine geometry inside an `overflow: hidden` animated track — and that is what
  `pnpm web:lines`' STUCK check is for. The two are complementary: one is static and cheap on every
  build, the other needs a browser and sees the real thing.
- **The gate's own closing line was under-reporting itself.** It printed `passed over 23 files` while
  the claims rules had run over 24 — two scopes (the design rules over the console tree this
  repository owns, the claims over marketing and docs as well) collapsed into one number, which is
  how a reader concludes everything was checked by everything. It now prints
  `preflight passed: 23 files over the design rules, 24 over the claims.` Both counts were verified
  to be real scopes rather than a hole in the walk: every `.ts`/`.tsx` under `app/` is in the claims
  set.
- **Two standing "not judged here" warnings were really one absence and one scoping artifact.** The
  gate's reduced-motion checks scanned the console tree, while the media query that satisfies them
  lives in the marketing stylesheet — so a check that could have passed printed itself as unknown.
  Both now scan the claims set plus `app/globals.css`: the CSS half passes for real (and fails the
  build if the block is ever deleted — control-tested by renaming the query and watching the match
  go false), and the JS half reports the actual situation, which is that nothing in `apps/web` calls
  `useReducedMotion` or sets `MotionConfig` and the page relies on framer-motion's default. That
  turned up a stale claim this file had been carrying since before the v0 rebuild: `motion.tsx`,
  `motion-pref.tsx`, `public/images/` and the header's motion switch **do not exist any more** —
  corrected in the decisions section with the grep that proves it.
- **Gates at this revision, all re-run against a fresh `pnpm web:build`:** `pnpm typecheck` clean,
  **406** unit, **258** security (both unchanged from the seventh pass — nothing here touches the
  backend), `pnpm web:typecheck` clean, `pnpm web:preflight` → `passed: 23 files over the design
  rules, 24 over the claims`, `pnpm web:build`
  clean, `web:sweep` **75/75, 0 overflow, 0 unhunted**, `web:lines` clean in light and dark.
- **Deployed, and verified as deployed.** Both passes were pushed to `main` on 2026-09-29 and Vercel
  rebuilt on its own, as the sixth pass recorded it would. Confirmed the way any deploy claim should
  be: `curl https://ari-zeta-seven.vercel.app/ | grep -c checkpoint-list` went **0 → 1**, and
  `pnpm web:lines` run *against the live origin* reports 0 stuck and 0 overflowing at 390 and 1440 —
  so the control-plane diagram now renders for visitors, which it never had before.

### Tenth pass — the waitlist's database, its cold start, and a person minting their own credential (2026-09-29 afternoon)

Three pieces of work, all measured rather than assumed, and one decision taken by the owner:
**self-minted `ucrd_` is in**, which reverses nothing about how the console authenticates but does
change what a browser can reach.

- **The waitlist went live end to end** — its own database, schema applied, env set, deployment
  verified against the public origin. Thread 13 is closed; 13a records the cold-start finding and
  the budget that fixed it.
- **`POST /v1/me/credentials` — a person rotates their own secret.** `apps/api/src/routes.ts`,
  six tests in `tests/security/api.test.ts`. This is what thread 1 had been carrying since Phase
  6: the console's operator was handed a `ucrd_` by someone with a CLI, when `013`'s shape had
  always been built to be minted server-side.
  - **It requires no scope, on purpose.** Presenting a live user credential *is* the authority a
    rotation rests on — the same way changing a password needs no "change password" permission.
    Inventing `credential:self` would have meant widening `013`'s permitted-scope CHECK to let
    someone do the one thing they had already proved they could do, and that CHECK is load-bearing
    for a different boundary.
  - **What makes it safe to put behind the browser proxy is not a scope check.** Every requested
    scope must already be held by *this* credential, read from `user_credentials` inside the tenant
    transaction (`activeUserScopes`, never the value authentication returned), so the route can
    restate authority and cannot enlarge it. `/v1/users/:id/credentials` stays absent from the
    allowlist because that one creates human authority from a deployment token with no person on
    the request yet — the distinction is written into the allowlist entry itself, not left to be
    inferred from adjacency.
  - **The old credential stays live.** Revoking the presenting secret in the same breath would lock
    a client out if the response were lost, and the bearer is printed once and cannot be recovered.
    The consequence is stated plainly rather than buried: **a stolen credential can extend its own
    life by rotating itself**, which is true of every session-rotation endpoint ever shipped, and
    the mitigations that actually exist here are the bounded TTL (one minute to thirty days, the
    same ceiling the bootstrap route applies) and `rotation_of` in the trail, which makes a chain of
    self-mints visible to an operator rather than invisible. If that ever stops being acceptable,
    the fix is a revocation-on-rotate flag decided at the console layer, not a shorter TTL.
  - **The guard was seen to bite.** With the widening check disabled, exactly the two refusal tests
    turn red and the four behavioural ones stay green — which is the control that proves the tests
    are asserting the check rather than the route's mood. The refusal test also asserts the
    legitimate case beside it (the same caller minting only what it holds still succeeds), because
    a check that refused everything would pass a test that only counts refusals.
  - Counts are tenant-scoped and `::int`-cast throughout, per thread 8: an unscoped count in this
    suite counts history, and `count(*)` arrives as a string.
- **Gates at this revision:** `pnpm typecheck` clean, **415** unit (was 406), **264** security (was
  258), `web:typecheck` / `web:preflight` / `web:build` clean.

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
  to avoid writing them. **The old note here — "Node 24's global `fetch` on this box cannot reach *any* remote
  HTTPS host" — is false, and was corrected on 2026-09-28 by measurement:** Node reached `cloudflare-eth.com`
  and got `eth_chainId = 0x1` back in 745 ms, plus four other remote HTTPS hosts with response bodies read.
  What is true about this box is narrower and bit twice: **it has no IPv6 default route at all**
  (`ip -6 route show default` is empty). Cloudflare-hosted names still worked from Node because
  their A records got tried and answered; Neon's endpoint published AAAA first and a `pnpm seed`
  run died with `AggregateError [ENETUNREACH]` listing only IPv6 addresses. So the rule here is:
  prefer IPv4 explicitly (`NODE_OPTIONS=--dns-result-order=ipv4first`) when a target publishes
  AAAA, and read a `curl -6` failure as a fact about this machine, not about the service — the
  earlier claim that Node "falls back and works" was too generous and Neon disproved it the same
  night. This is a laptop property, not a deployment property: pxxl's containers have their own
  connectivity, and no Ari code should special-case it.
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
- **`apps/web` is the frontend now, and it is the v0 site plus the console built on top of it.** The
  user generated the marketing page with Vercel's v0 and asked for the rest of the pages to follow
  *that* scheme, so the console lives in the Next 16 app at `apps/web` (`/` is the marketing page,
  `/console/...` is the control plane), and `apps/dashboard` is the superseded Vite build. The
  scheme is paper `#f4f0e8` on ink `#111111`, vermilion `#d95745` as the only brand accent and lime
  `#c6ef68` as the live signal, hairlines instead of cards, zero corner radius, 10px mono for
  labels and 15px/1.45 body at a 380px measure; the class vocabulary is the `Console` block at the
  bottom of `apps/web/app/globals.css` and the primitives are `components/console/ui.tsx`. Two
  deliberate deviations from the marketing page, both written down where they are defined: state
  colour lives in a marker glyph and never in the word (vermilion on paper is 3.2:1, lime is worse),
  and console reveals are motion-only (the marketing `.reveal` class holds content at `opacity: 0`
  until an observer fires, which is a blank screen if it does not). Gates: `pnpm web:typecheck`,
  `pnpm web:dev` on **port 3100** (3000 is held by another project on this box). `v0` ships
  `typescript.ignoreBuildErrors: true` and a `generator` meta tag; both are removed. The domain
  layer (`lib/ari/types.ts`, `lib/ari/sample.ts`, `lib/ari/format.ts`) is copied from the Vite app
  unchanged, so the two frontends read the same fixture and the same engine vocabulary.
  v0's marketing page also contradicted the backend in four places and those are fixed: the trace
  ended in `EXECUTION / CONFIRMED`, the pipeline listed six stages instead of seven, the example
  policy named `Sui`, and the SDK was advertised as `npm install @ari/sdk`. The networks strip now
  says what `SupportedChain` says (Ethereum today, Bitcoin in the schema, EVM chains a config away,
  the rest not supported), and `packages/client` is labelled as the unpublished workspace package
  it is.
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
  the list.
- **The landing page runs at MOTION 7, and there is a switch for it.** **Superseded as of
  2026-09-29, and corrected here rather than left to mislead: none of this exists any more.**
  `components/motion.tsx`, `app/motion-pref.tsx`, `public/images/` and `CREDITS.md` are gone — the
  hand-built marketing page they animated was replaced by the v0 page (fourth pass), which uses
  `Reveal`/`whileInView` directly and imports none of that kit: `grep -c
  'ParallaxImage\|HorizontalPan\|CountUp\|Tilt\|useScroll' app/page.tsx` is **0**, and there is **no
  motion-preference control in the header** and no `useReducedMotion`/`MotionConfig` anywhere in
  `apps/web`. What a visitor asking for stillness now gets is the `@media
  (prefers-reduced-motion: reduce)` block in `app/globals.css` plus framer-motion's own default
  (which drops transforms and keeps opacity) — which is why that media query is a build requirement
  now, and why the ninth pass made the gate say so instead of reporting "not judged here". Keep the
  two judgements that outlived the code: *"I can't see any motion" is ambiguous* between the page
  being too still and the desktop having motion switched off, so diagnose before changing anything
  (the `.architecture` deadlock was exactly that second shape, and the CSS un-clip made the
  reduced-motion path look healthy); and reject a "concrete architecture" stock file that is a
  church interior, or a `Server_rack` that is a recording-studio console. Image generation and video
  remain quota-blocked on this box, and stock-aggregator search results are licensed previews, so
  neither is a source.
- **Screenshots of a scrolling page need CDP, not `--screenshot`.** `apps/dashboard/scripts/shoot.mjs`
  drives headless Chromium over the DevTools WebSocket (Node's built-in `WebSocket`, no dependency) to
  scroll to a fraction of the document and capture. The CLI flag only ever photographs the top, and a
  tall window is worse than useless here: sections sized in `dvh` stretch with the viewport instead of
  being scrolled through, so a pinned pan looks broken in a way it is not. It is environment-sensitive:
  Chromium on this box sometimes cannot load a page at all (`ERR_INSUFFICIENT_RESOURCES` under memory
  pressure, with a desktop browser already open), so every CDP call is bounded by a timeout and fails
  loudly instead of hanging the run.
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
   nothing more than convenience. Two things were open here; one has become a screen rather than a gap, and
   the other is still not a route: a wallet's `address` is
   accepted because it matches a grammar, never because anything checked that the wallet *is* that address on the
   chain (a wrong one makes every simulation of that wallet a question about an account holding nothing, which the
   provider will refuse as `TARGET_HAS_NO_CODE` or answer as a revert — it will not say "you typed the wrong
   wallet"); and the *route* for a signed-in person minting their own user credential now exists
   (`POST /v1/me/credentials`, tenth pass), so what is left of that thread is the console screen that
   calls it rather than a capability the API lacks. `013`'s shape was built to be minted server-side, and
   now it is.
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

11. **Simulation exists, and has now been pointed at a real chain.** What remains is a coverage gap in
    the revert classifier (below) and the absent dWallet address; neither is a provider.
   (a) *The bound is on the DB cost, not the latency.* The simulated path is now measured and priced — 36
   statements against 30, delta ≤6 — but what that number cannot see is wall clock: a configured provider's
   `timeoutMs` default of 3 000 is time an agent waits before it is told anything, and nothing asserts the
   end-to-end p50/p95 of a simulated request. If that ever matters, it is a benchmark, like the throughput
   claim in 10a, not a test. Measured once on 2026-09-29 against a keyed mainnet endpoint (see (c)):
   p50 256 ms per round trip, a whole `simulate()` at 334–1 904 ms against the 3 000 ms default —
   still asserted by no test, but no longer an unknown.
   (b) *It answers about whatever chain it is pointed at.* The blocker recorded here for weeks — that this box
   cannot reach a remote RPC at all — **is gone: on 2026-09-28 Node's `fetch` got `eth_chainId = 0x1` from
   `https://cloudflare-eth.com` in 745 ms.** *(That inference did not survive the next morning — see (c)
   below: the gateway answers `eth_chainId` and refuses the four methods a simulation needs.)* So
   `EvmForkProvider` can be pointed at a chain with real
   counterparty state on it, and nothing has done so yet: what was proven is one `eth_chainId` round trip, not
   a fork simulation, and `SIM_RPC_URL` has still never been set against a public endpoint in this repository.
   The gate that makes a real endpoint safe is the recorded `chainId`/`blockNumber`/`timestamp` plus the
   two-directional chain guard; A10's "blocking once a real provider lands" is now reachable, and advisory is
   still the honest default until someone runs that experiment and reports what the state root said.
   **(c) Attempted 2026-09-29, and the answer so far is a correction, not a result.** Probed the five methods
   `EvmForkProvider` actually issues (`eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getCode`,
   `eth_call`) across seven public gateways:
   - **`cloudflare-eth.com` — the endpoint the paragraph above cites — answers `eth_chainId` (828 ms) and
     refuses the other four** (`-32603` internal error, `-32046` for `eth_blockNumber`). So "the blocker is
     gone" was inferred from the single method a public Cloudflare gateway deigns to serve. Reaching a remote
     RPC is true; *this* RPC cannot carry a simulation, and the fork question it was supposed to have
     unblocked is as open as it was.
   - Three gateways served all five methods on a first pass — `ethereum-rpc.publicnode.com` (203–1 224 ms),
     `1rpc.io/eth` (403–941 ms), `eth.drpc.org` (222–628 ms). Within about two minutes of *light* probing
     (roughly forty requests, never more than one in flight) `eth.drpc.org` timed out at connect and
     `1rpc.io/eth` started replying with an HTML error page in place of JSON. `llamarpc` returned
     non-JSON, `rpc.ankr.com/eth` answered `-32000` for everything but `eth_chainId`, and
     `ethereum.execution-rpc.org` failed at transport. Public gateways are not a substrate a payment path can
     block on — which is an argument for advisory that has nothing to do with state roots.
   - The IPv6 hazard in the simulation section fired again, unprompted: a name publishing AAAA first died with
     `UND_ERR_CONNECT_TIMEOUT` listing IPv6 addresses, and `--dns-result-order=ipv4first` is still the fix.
   - **Answered 2026-09-29, against a keyed endpoint.** With an Alchemy mainnet URL in `SIM_RPC_URL`
     (+ `SIM_CHAIN_ID=1`, which the api requires the moment a URL is present), `EvmForkProvider` was
     run against real state for the first time. The token address was **verified on-chain, not
     recalled** — the address recall would have typed (`0xA0b86991c621b4c36E1643A23508E50d912477Ad`)
     has **zero bytes of code at it**, and the script refuses to simulate until
     `symbol()` answers `USDC`; the real one is `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`
     (2,186 bytes). Every guard behaved as designed:
     - configured for chain 5 against a chain-1 node → `CHAIN_ID_MISMATCH`, *and no `eth_call` was
       issued*; the reverse direction (candidate naming `11155111` to a chain-1 node) refused too.
     - **pinned to block 1, before USDC existed → `TARGET_HAS_NO_CODE`**, and pins at head−500 and
       head−200 answered with exactly those block numbers. That is the state-root question: a public
       node honours historical state rather than quietly replying at the head, which is the only
       thing separating simulation from guesswork.
     - `maxStalenessSeconds: 1` → `BLOCK_STALE: the block is 12s old`, so the recorded timestamps are
       real and the bound fires.
     - Wall clock (the number thread 11a said nothing asserted): raw round trips **p50 256 ms, max
       1 604 ms**, whole `simulate()` calls 334–1 904 ms against the 3 000 ms `timeoutMs` default.
       Headroom, but one slow `eth_call` plus five round trips is not nothing.
   - **And it found something the anvil suite cannot.** A transfer from a genuinely empty wallet
     (`balanceOf` = 0, no code — checked first, because the first address tried, `0x1111…1111`,
     turned out to hold 1,109 USDC and the "revert" prediction failed for the mundane reason that the
     wallet was not broke) returns `SIMULATED_REVERT` with `revert: REVERT_WITH_MESSAGE` and
     `0x08c379a0…` — **Circle's USDC reverts with a plain `Error(string)`**
     (`"ERC20: transfer amount exceeds balance"`), not the custom error the repository's own fixture
     deploys. So every `CUSTOM_ERRORS` entry that names an ERC-20 failure is exercised against an
     OpenZeppelin-modern token and has **never been seen on the mainnet token the product actually
     targets**, where the specific reason is unreachable by selector. The behaviour is honest — text
     matching is deliberately not a fallback — but `tests/security/fixtures/minierc20.json` is not
     representative, and an operator reading a mainnet simulation gets "it reverted" where the
     fixture's tests imply "insufficient balance". Worth deciding: map the known OZ revert strings
     explicitly, or deploy a string-revert fixture so both shapes are actually tested.
   - Public gateways remain unusable as a substrate: `cloudflare-eth.com` answers `eth_chainId` and
     refuses the other four methods, and three that worked initially were rate-limiting within two
     minutes. A keyed endpoint is not a preference here, it is what the measurement needed. Advisory
     is still the honest default for the *deployment* — this run proves the provider works, not that
     a public RPC is something to put behind a payment.
   (d) *The Ika wallets have no address yet.* `wallet create --address` is the only way to give the simulation
   plane a `from`, and a dWallet's address is derived, not typed — Phase 8 needs to write it, and until then
   every Ika-backed wallet is `WALLET_ADDRESS_UNKNOWN`, which is a refusal and not a failure, by design.

12. **Minted-but-never-redeemed tickets accumulate forever.** Counting them during the 2026-09-28 staging run
    gave **635 redeemed / 3,368 unredeemed** — and that table is the one tenant-bearing table with no
    `org_id` and no row security (`011`'s documented exception, because the signer redeems across tenants), so
    the number is *all history on this box*, not one tenant's. Nothing expires, prunes, or reports them: a
    ticket past `expires_at_ms` is unspendable — the signer's own clock refuses it, which is the point — but the
    row stays. Two consequences worth owning before Phase 8: an operator cannot ask "how many authorisations were
    minted and never delivered", which is exactly the question a `TICKET_ISSUED_NOT_DELIVERED` incident wants
    answered at scale; and the count is a slow leak of dead rows in the one table where a bug would be
    cross-tenant. The fix is a reconciliation pass that can name them per tenant through the decision row it
    already joins, not a `DELETE` — `008` withholds that from `ari_app` on purpose, and a one-way door in the
    schema is worth more than a tidy table.

13. **The waitlist is live and verified end to end.** A second, separate database (`ari_waitlist`,
    on the **pooled** endpoint of the same hosted project — never the ledger's URL, which is what
    `SHARES_OPERATIONAL_DATABASE` exists to catch) holds `waitlist_signups (id, email UNIQUE not
    null, created_at)` from `apps/web/db/waitlist.sql` (not from `migrations/`, because
    `global-setup.ts` re-applies every file there against the ledger schema). `WAITLIST_DATABASE_URL`
    is set on the Vercel deployment and the public origin was driven with real requests: valid
    address → `200 {"ok":true}`, the same address in a different case → `200` and **one row** (the
    route's `toLowerCase()` plus the `UNIQUE` column is what makes `on conflict do nothing` a fact),
    malformed and empty body → `400`. Test rows were deleted; the table is empty for real signups.
    Two assumptions got measured on the way: `sslmode=verify-full` **does** handshake against the
    pooled hostname (the earlier worry that only the direct endpoint would was wrong), and
    `pg_stat_ssl` answering `ssl=false` from the server's side is the provider's proxy hop —
    corroboration, not failure; the verified handshake is the proof.
13a. **The first signup of the day used to fail, and now it takes nine seconds.** Measured against
    that fresh database: with the hosted compute asleep, the first `POST /api/waitlist` failed, an
    **immediate** retry failed the same way inside 4.7 s, and a request a few seconds later
    succeeded in 2.9 s. So the failure was never a second attempt's problem — the endpoint needed
    *time*, roughly five to six seconds of it. That is not an edge case on a low-traffic marketing
    page; a serverless function is cold for most of its visitors, and Neon scales to zero between
    them. `recordSignup` now retries within a budget (four attempts, twelve seconds, pauses growing
    1.5 s → 3 s → 6 s), verified on a real 14-minute-idle cold start: **200 in 9.3 s** where the
    same request had returned 500. Three things worth keeping straight:
    - The retry is only legitimate because the insert is `on conflict do nothing` against a `UNIQUE`
      column. Around a non-idempotent write, this same pattern is a double charge.
    - It was honest before the fix and is honest after it: the refused request never filed the
      address, so no one was told a lie. The defect was the lost signup, not a false success.
    - Nine seconds is a slow form. If that ever matters, the fix is to stop the compute suspending,
      not to shorten the budget — a shorter budget is just a faster refusal. It has now been seen
      doing exactly that in production: the first request against the deployed origin after a quiet
      period took **8.8 s and returned 200**, the one after it 1.5 s. Before this change that
      visitor got a 500.
    And the log line carries `safeErrorSummary`, which is message-truncated and address-redacted,
    because the first version logged `name=Error` with no code and no syscall at all — true, and
    useless to whoever has to tell "down" from "waking".

14. **What "deployed" does not claim.** Both pxxl services run `SIGNING_PROVIDER=mock` and
    `SIMULATION_PROVIDER=mock`, so staging proves the plumbing — policy, reservation, sealing, delivery,
    credentials, row security, the approval loop, the proxy allowlist — and proves nothing about a chain or a
    dWallet. `ari-signer` still refuses to start rather than fall back to a mock, which is why the mock is an
    explicit environment value and not an absence. Separately: the Neon database now holds real rows for the
    staging tenant, so `pnpm db:up`'s local Postgres and the deployed ledger are two different bodies of data,
    and nothing has ever been migrated from one to the other.

15. **What is running on this box changed overnight, and the old claim here was stale.** This thread
    used to assert `ari-api` on :4000, `ari-signer` on :4100, a `cloudflared` quick tunnel, `next
    start` on :3120 and Postgres on :5435 were all live. Re-measured 2026-09-29 08:45 with
    `ss -ltnp | grep -E ':(4000|4100|3120|3131|5435)'` and a `ps` sweep: **only Postgres :5435 is
    listening.** The api, the signer and the local `next start` are gone, and
    `camel-heaven-die-supposed.trycloudflare.com` answers `HTTP 000` — the DNS rotation this file
    predicted for an ephemeral quick tunnel. Nothing here needs the ports freed; anything that does
    needs restarting, and `docs/OPERATIONS.md` is the order to start them in. The deployed trio
    (Vercel web + two pxxl services) is unaffected: `ari-zeta-seven.vercel.app` → `HTTP 200` in
    1.5 s.
16. **A reveal that gates on its own visibility can never fire — and a screenshot harness can hide
    it.** The `.architecture` clip-path deadlock (ninth pass) is a class, not a one-off: anything with
    `whileInView`/`IntersectionObserver` whose `initial` gives it zero intersection area — its own
    `clip-path`, or an ancestor's `overflow: hidden` while it sits off to one side (the marquee) — is
    invisible forever and photographs as fine. Two rules follow. Never put the hidden state on the
    observed element: observe an unclipped ancestor and drive the child from its `is-visible`. And
    never trust a forced screenshot: `pnpm web:lines` measures **before** the force and fails on
    `STUCK`, which is the only reason this was caught rather than shipped again. A reduced-motion
    override that un-clips content can mask the whole bug on the one path you would not think to
    test — check the motion-enabled default.
17. **A deploy is a claim, so verify it as one.** Pushing `main` is not evidence that the site
    changed: Vercel rebuilds on its own (sixth pass), and the check is two commands against the
    *origin*, not the local build — a markup marker that only exists post-change
    (`curl https://ari-zeta-seven.vercel.app/ | grep -c checkpoint-list`) and
    `pnpm web:lines https://ari-zeta-seven.vercel.app/ 390,1440 <theme> /tmp/out`, which measures what
    a visitor actually gets. Both were run on 2026-09-29 after the ninth-pass push and both agree the
    live page is the fixed one. **What is still wrong on the live site, and it needs the owner
    rather than an edit:** thread 13 — `WAITLIST_DATABASE_URL` is unset on the deployment, so the
    marketing form answers every address with `WAITLIST_UNCONFIGURED` and staging collects nothing.
    There is no `vercel` CLI on this box and `~/ari-prod.env` carries only the ledger's URL, so
    provisioning the second database is a dashboard action.
