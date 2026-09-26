# ARI dashboard

The operator's, approver's and auditor's screen for ARI: what the agents are doing, which policy
governs each of them, what a human is being asked to authorise, and why a transaction was allowed
or refused.

```bash
cd apps/dashboard
pnpm dev          # http://127.0.0.1:5173  (no HMR — see "Why this is not in the workspace")
pnpm build        # → dist/
pnpm preview      # serves dist/ on the same port
pnpm typecheck
```

`/` is the public landing page. Everything under `/app` is the control center:

| Route | Screen |
| --- | --- |
| `/app` | Overview — what is happening, and what is waiting |
| `/app/agents`, `/app/agents/:name` | Principals, their envelope, their credentials |
| `/app/policies`, `/app/policies/:key` | Versions, rules, the widening diff awaiting review |
| `/app/transactions`, `/app/transactions/:id` | The ledger, and the authorization trace per request |
| `/app/approvals` | The queue, with what each vote actually seals |
| `/app/risk` | Signals raised, signals the engine cannot compute, boundary proximity |
| `/app/wallets` | Execution resources and what their mode can promise |
| `/app/audit` | The hash chain, with each row's recomputed link |
| `/app/developers` | SDK, keys, the route table, webhooks, environments |
| `/app/settings` | People, scopes, tenancy, and what this build does not do yet |

## What is real and what is not

**The data is a fixture.** One coherent sample tenant lives in `src/domain/sample.ts`, and a banner
says so on every screen. The sidebar reads *API not connected*. Nothing here is presenting sample
activity as observed fact: no balances were fetched, no block confirmations are claimed beyond what
the record says, and the transaction whose signature came from a mock provider is labelled
`UNSETTLED — awaiting confirmation` rather than drawn as a tick.

**The vocabulary is not invented.** Every status, reason code, signal name, lifecycle state and
audit event type on screen is copied from the running code, and `src/domain/types.ts` names the file
each block came from:

```
ReasonCode ......... packages/schemas/src/contracts.ts
RiskSignal ......... packages/schemas/src/contracts.ts
LifecycleState ..... packages/transaction-engine/src/index.ts
Audit event types .. packages/audit/src/index.ts
PolicyDocument ..... packages/schemas/src/policy.ts
Routes ............. apps/api/src/routes.ts
```

That is the point of separating `domain/` from `api/` from the UI: the screen can be wrong about its
layout, but it cannot quietly invent a state the engine does not produce. A status a policy cannot
write is a status that must not appear here.

**Swapping in the real backend is one file.** `src/api/client.ts` defines `AriApi`, and each method
names the route it maps to. Replace `mockApi` with a fetch client and the screens do not change. Two
methods are marked `no route yet` where the interface wants something the API does not answer with
(policy version listings are read from the ledger by the operator's tooling today).

**Actions are honest about not working.** Approving, revoking, creating an agent and activating a
policy all resolve to a refusal that says no deployment is connected, rather than mutating local
state and showing a success. A demo that pretends a button worked teaches the operator the wrong
contract.

## Design system

Every colour, radius and space value is a token in `src/styles/tokens.css`; a component that
hardcodes a hex is a bug. The palette is derived from `public/ari-logo.svg`, which is used exactly as
supplied — no redraw, no reinterpretation. The mark is drawn in ink (`#07111A`) for a light surface,
so on a dark interface it is painted through a CSS mask (`.ari-mark`): geometry byte-identical,
colour from a token. The brand accent is the mark's own hue (208°) lifted to a lightness that passes
AA on near-black, and the semantic colours carry state only:

```
brand    ARI actions, selected states
allow    authorized, healthy
caution  approval required, elevated risk
deny     refused, anomalous
neutral  revoked, expired, informational
```

Motion is for state changes that mean something — a stage advancing, a drawer arriving. Everything
is legible with animation off, and `prefers-reduced-motion` disables it wholesale. Numbers are
tabular everywhere, because amounts on a ledger have to be comparable column by column.

## Why this is not in the pnpm workspace

`pnpm-workspace.yaml` excludes `apps/dashboard`. This box cannot reach the npm registry from Node
(only `curl` and raw TCP get there), so a root `pnpm install` that tried to resolve React against
`registry.npmjs.org` would fail the install of the entire repository — breaking the first command
every other gate in this repo starts from. The dashboard's `node_modules` is materialised from the
local store instead, and it is excluded from git by the root `.gitignore`.

Two consequences worth knowing before you touch it:

- **No `@vitejs/plugin-react`.** Not in the store. Vite 8 transforms `.tsx` through its own pipeline
  with the automatic JSX runtime, so the app builds and runs; what is lost is Fast Refresh.
- **No icon package and no web fonts.** Icons are hand-drawn on a 16px grid at 1.5 stroke in
  `components/ui.tsx`; type is the system stack with tabular numerals. Both were the right call for a
  product that should not depend on a CDN to render its own interface.

The mark, the palette derivation and the token file are the contract. A later session that adds a
screen adds it from `tokens.css` and `domain/types.ts`, not from a hex picker.
