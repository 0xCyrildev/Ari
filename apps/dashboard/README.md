# ARI dashboard

The operator's, approver's and auditor's screen for ARI: what the agents are doing, which policy
governs each of them, what a human is being asked to authorise, and why a transaction was allowed or
refused. `/` is the public page; everything under `/app` is the control center.

```bash
cd apps/dashboard
pnpm dev            # http://127.0.0.1:5173, Fast Refresh on
pnpm ui:preflight   # the mechanical design gate, see "Design rules"
pnpm typecheck
pnpm build && pnpm preview
```

From the repository root: `pnpm ui:dev`, `pnpm typecheck:ui`, `pnpm ui:preflight`, `pnpm ui:build`.

| Route | Screen |
| --- | --- |
| `/app` | Overview: what is happening, and what is waiting on a person |
| `/app/agents`, `/app/agents/:name` | Principals, their envelope, their credentials |
| `/app/policies`, `/app/policies/:key` | Versions, rules, the widening awaiting review |
| `/app/transactions`, `/app/transactions/:id` | The ledger, and the authorization trace per request |
| `/app/approvals` | The queue, with what each vote seals |
| `/app/risk` | Signals raised, signals that could not be computed, boundary proximity |
| `/app/wallets` | Execution resources and what their authority mode can promise |
| `/app/audit` | The hash chain, with each row's recomputed link |
| `/app/developers` | SDK, keys, the route table, webhooks, environments |
| `/app/settings` | People, scopes, tenancy, and what this build does not do yet |

## What is real and what is not

**The data is a fixture.** One sample tenant lives in `src/domain/sample.ts` and a strip above every
console screen says so; the sidebar reads *API not connected*. No balance was fetched, no block
confirmation is claimed beyond what the record itself says, and the single row that carries
`BROADCAST_CONFIRMED` carries a note saying this build has no reconciler, so it is the shape of a
confirmed row rather than a chain fact. Amounts are decimal strings end to end, because the wire
format is `numeric(80,0)` and rounding one silently on a screen that says "this is what will be
signed" is a UI bug with financial consequences.

**The vocabulary is not invented.** Every status, reason code, signal name, lifecycle state and audit
event type on screen is copied from the running code, and `src/domain/types.ts` names the file each
block came from. Statuses render as the engine writes them (`REQUIRE_HUMAN_APPROVAL`, not "needs a
second signer"): a screen that paraphrases a state teaches its users a false model of their own
controls. That is the point of separating `domain/` from `api/` from the components. The layout can
be wrong; a state the engine cannot produce must not appear.

**Swapping in the real backend is one file.** `src/api/client.ts` defines `AriApi` and each method
names the route it maps to in `apps/api/src/routes.ts`. Two methods are marked `no route yet`.

**Actions refuse rather than pretend.** Approving, revoking, creating an agent, activating a policy:
each resolves to a message that says no deployment is connected, instead of mutating local state and
showing a success. Button labels name their consequence ("Approve this transfer", "Revoke
treasury-agent"), never "Continue" or "Confirm".

## Design rules

The first pass of this interface looked generated, and counting proved it: 52 em dashes in visible
copy, 46 small-caps micro-labels, three files of hand-drawn SVG icons, ten identical metric cards, an
accent that appeared in more hues than one. The rebuild is a token file, a primitive layer, and a
gate that fails the build if any of it creeps back.

`pnpm ui:preflight` (`scripts/preflight.mjs`) is that gate. It greps the source for the signatures
and exits non-zero: em or en dash, `uppercase` plus `tracking` on one element, any `shadow-[`, a
corner radius outside `rounded-control`/`rounded-full`, a hand-drawn `<svg>` or `<path d=`, `h-screen`,
a `scroll`/`wheel`/`resize` listener, a CDN font, an infinite CSS animation, `Acme`/`Northwind`-class
placeholder names, or a class from the deleted token set. It does not prove the interface is good
design. It proves it is not carrying the default output of a model, and it keeps the rules in one
readable file instead of in whoever remembers them.

The four rules the primitives enforce, all in `src/styles/tokens.css`:

1. **One radius.** Surfaces are sharp. Interactive controls are `--radius-control` (4px). Nothing else.
2. **One accent.** `--color-accent` is a lifted version of the mark's own hue (208°), passing AA on
   near-black. `ok`, `wait` and `stop` are desaturated and appear only on a real state.
3. **`.label` is for table heads and field keys.** Nothing gets a small-caps word above its heading.
   `PageHead` has no eyebrow slot, on purpose.
4. **No shadows.** Depth is the surface ramp (`sunken → base → panel → raised → press`) plus one
   hairline.

Grouping is by hairline and `divide-y`, not by nested boxes: `MetricBand` is one row of headline
figures, `Surface` is one bordered region, `Block` separates runs inside it. Ten identical cards was
the single most recognisable layout in the first pass.

Icons are `@phosphor-icons/react` at one weight, and there is no hand-drawn set. Type is
`@fontsource-variable/geist` with `geist-mono` for every figure, identifier and digest, tabular so a
column of amounts lines up.

**Motion.** The console uses CSS transitions on state changes and nothing else. The landing page has
one piece of continuous motion: `components/hero.tsx` renders faceted prisms with physical
transmission through `@react-three/fiber`, drifting under a single cool key light, with pointer
parallax. It is ARI's palette, not an iridescent rainbow. `prefers-reduced-motion` renders one still
frame instead of removing the scene, and a machine without a WebGL context gets the same seven
pipeline stages set in type rather than a fake screenshot. A video file was considered and rejected:
a recording of somebody else's scene, frozen at one angle, is an artefact this product does not have.

**The mark is used exactly as supplied.** `public/ari-logo.svg` is copied, not redrawn, reinterpreted
or regenerated. Because it was drawn in ink for a light surface, the dark interface paints it through
`mask-image` with `currentColor`, so the geometry is byte-identical at every size and only the paint
comes from a token. There is no mascot and there is no second version of it.

## Why this is not in the pnpm workspace

`pnpm-workspace.yaml` excludes `apps/dashboard`. That is isolation, not a limitation of the machine:
a Vite/React/Tailwind toolchain inside the workspace would put its resolution into the root lockfile
and its `.tsx` files into the root `tsc -p tsconfig.json`, so `pnpm install` and `pnpm typecheck`,
the two commands every other gate here starts from, would have something to do with a frontend. The
dashboard has its own `node_modules` (gitignored) and its own three gates.

An earlier version of this file, and of `vite.config.ts`, said the exclusion was because the box
could not reach the npm registry from Node. That was false, measured with `--offline` probes and never
by running an install. Installs work here; `@vitejs/plugin-react`, `framer-motion`, `three`,
`@react-three/fiber`, `@phosphor-icons/react` and the Geist variable fonts all arrived from the
registry in seconds.

## Adding a screen

Add it from `tokens.css` and `domain/types.ts`, not from a hex picker, and not with a status word the
engine does not write. Import primitives from `components/ui.tsx`, composites from
`components/product.tsx`, icons from Phosphor. Then run `pnpm ui:preflight && pnpm typecheck` and look
at the screen in a browser at 1440px and at 390px before it is called done.
