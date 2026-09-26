# ASSUMPTIONS — Ari

Every claim in this repository is labelled. This file is the boundary between what Ari's design **knows**,
what it **assumes**, and what it **does not know yet**. Read it before reading `ARCHITECTURE.md`.

Standing rule (project principle 18): *never claim a security property that the underlying infrastructure does
not actually provide.* This file exists to make that rule enforceable rather than aspirational.

Confidence labels used throughout Ari's docs and code comments:

| Label | Meaning |
|---|---|
| **VERIFIED** | Read from a file or command output on this machine, cited by path and line. Re-derivable. |
| **DOC-ONLY** | Stated in Ika's own documentation/skill files, not yet re-checked against code or a chain. |
| **ASSUMED** | Ari's engineering choice, not derived from external fact. Safe to build on, wrong to present as a property of Ika. |
| **NOT FOUND** | Looked, did not find. Do not fill this gap with inference from how similar systems work. |

---

## 1. Environment — VERIFIED

Measured on this machine, 2026-09-25.

| Item | Value | Consequence for Ari |
|---|---|---|
| Node | v24.18.0 | Modern `--env-module` support; target ES2023 |
| pnpm | 11.23.0 | Workspace tool of record |
| npm | 11.16.0 | Fallback only |
| yarn / bun | **absent** | Do not write instructions that need them |
| Docker | 28.5.2+dfsg4 | Available |
| `docker compose` (plugin) | v2.40.3 — **works** | Standalone `docker-compose` binary is absent; always use the plugin form |
| PostgreSQL client | 18.4 (local server on `127.0.0.1:5432`) | A local server already runs on the default port |
| Redis | 8.0.6 installed; **no listener on 6379** | `kuma-redis` occupies `127.0.0.1:6380` |
| `sui` CLI | 1.77.3 (`~/.local/bin/sui`) | Matches Ika's pinned `mainnet-v1.77.2` → a real local Sui+Ika net is plausible |
| `anvil` | 1.8.1, running on `127.0.0.1:8545` — **someone else's**, forked from `rpc.risechain.com` at block 22722272 (chain id 4153), not mainnet | EVM simulation is available locally; that node is not ours to touch, and Ari starts its own on **8561** |
| `forge` | 1.8.1, solc **embedded** (0.8.19/0.8.25/0.8.36 all compile under `unshare -rn`) | Contracts can be compiled offline; nothing needs to download a compiler |
| Forking an upstream chain | **NOT-FOUND** — no `$MAINNET_RPC_URL`, no key, and Node 24's global `fetch` cannot reach any remote HTTPS host on this box (raw TCP to the same IPs connects) | `EvmForkProvider` simulates against whatever chain it is pointed at and records the block it read. Claiming a mainnet result from here would be a lie, so nothing in Ari does |
| `cargo` / `rustc` | 1.97.1 | Matches Ika's `rust-toolchain.toml` |
| git | 2.53.0, identity configured | |

**Ports already bound:** 631, 3000 (`next-server`), 5432, 5433 (`kuma-postgres`), 6380 (`kuma-redis`),
8000 (Plausible CE), 8545 (anvil), 46537.

Ari therefore uses: **API 4000 · dashboard 5173 · Postgres 5435 · Redis 6381.** Never 5432/5433/6380 — those
belong to other projects on this box.

**Pre-existing workload on this machine that must not be disturbed:** the Plausible CE audit stack
(`ce-plausible-1`, `ce-plausible_db-1`, `ce-plausible_events_db-1`) and `kuma-*` containers are running.

---

## 2. The Ika ground truth — and the fact that it is available offline

**VERIFIED.** `~/ika` is a working clone of `https://github.com/dwallet-labs/ika.git` at v1.4.0
(`git remote -v`; `git log` head `6389339c8f`, commit `fd3fbfc3f2 chore: bump version to 1.4.0`).

It contains, among other things:

- `sdk/typescript/src/` — the real TypeScript SDK source
- `contracts/ika_dwallet_2pc_mpc/` — the on-chain coordination contracts (Move)
- `crates/dwallet-mpc-centralized-party/` — the user-side half of 2PC-MPC
- `skills/ika-sdk/references/{api-reference,flows,types-and-validation}.md` — 49 KB of API documentation
- `examples/{ikavery,keyspring,multisig-bitcoin}/` — three working integrations, one of which vendors
  `@ika.xyz/sdk` **0.5.0** as an installed package
- `dev-docs/` — engineering specs and playbooks, including `playbooks/localnet.md`

Consequence: **Ari does not need to guess about Ika.** The protocol that most determines Ari's shape is
readable locally, at a pinned version, including its generated BCS schemas. Phase 8 should be developed
against this tree and `docs.ika.xyz`, and any assertion about Ika that cannot be traced to one of them is a
bug in the docs.

---

## 3. VERIFIED facts about Ika that constrain Ari's architecture

| # | Fact | Evidence |
|---|---|---|
| I1 | Ika is a decentralised MPC signing network **settling on Sui**; dWallets sign for *other* chains | `~/ika/AGENTS.md` ("Decentralized MPC signing network built on Sui"); `flows.md` chain table |
| I2 | Four dWallet kinds exist: `zero-trust`, `imported-key`, `imported-key-shared`, `shared` | `sdk/typescript/src/client/types.ts:79-86` (`DWalletKind`) |
| I3 | A `shared` dWallet signs **with no user participation at sign time** | `references/flows.md:30` ("Network signs autonomously - no user participation at sign time") |
| I4 | A `zero-trust` dWallet requires the user's secret share at sign time, supplied as `encryptedUserSecretKeyShare` **or** a decrypted `secretShare`, and that decryption needs the `UserShareEncryptionKeys` derived from a root seed | `flows.md:142-198`; `user-share-encryption-keys.ts:331` (`decryptUserShare`); 9 sites throw `'User share encryption keys are not set'` (`ika-transaction.ts:198,300,416,470,1747,1916,2207,2295`) |
| I5 | `DWalletCap` is an **owned on-chain object**, enumerable per address | `ika-client.ts:688-709` (`getOwnedDWalletCaps(address)`); `coordinator_inner.ts:99` |
| I6 | For a `shared` dWallet the user share is public on-chain (`public_user_secret_key_share`), so the user-side round is computable by anyone who can read chain state | `flows.md:107`; `coordinator.ts:214` (`request_dwallet_dkg_with_public_user_secret_key_share`) |
| I7 | Signing is **asynchronous and polled**, never synchronous: presign → `Completed`, then sign → `Completed`, default 30 s poll with backoff and an `AbortSignal` | `skills/ika-sdk/SKILL.md:236-267` |
| I8 | Every protocol operation consumes **real tokens**: an `ikaCoin` and a `suiCoin` (`splitCoins(..., [1_000_000])`) on DKG, presign, sign, transfer | `flows.md:63-64, 92-93, 125-126, 269` |
| I9 | A two-phase "future sign" primitive exists: compute a partial signature now (`requestFutureSign`, takes the `message`), complete it later with a message approval (`futureSign`, takes `partialUserSignatureCap`) — documented as "useful for DAOs/governance where approval is separate from computation" | `flows.md:301-346` |
| I10 | Curve/algorithm/hash combinations are a fixed legal set: Ethereum `SECP256K1/ECDSASecp256k1/KECCAK256`, Bitcoin `…/Taproot/SHA256` and `…/ECDSASecp256k1/DoubleSHA256`, Solana `ED25519/EdDSA/SHA512`, WebAuthn `SECP256R1/ECDSASecp256r1/SHA256`, Substrate `RISTRETTO/SchnorrkelSubstrate/Merlin` | `SKILL.md:87-96`; `flows.md:367-377`; enforced in code by `validateCurveSignatureAlgorithm` / `validateHashSignatureCombination` |
| I11 | A dWallet's public key maps deterministically to target-chain addresses; the user encryption key can be derived from a passkey WebAuthn PRF, a wallet signature, or any ≥32-byte deterministic secret ("KeySpring") | `flows.md:380-397`; `examples/keyspring`, `examples/ikavery` |
| I12 | Transferring a dWallet requires the recipient to know `sourceEncryptionKey` **out of band**; fetching it from the network enables MITM | `flows.md:297` |
| I13 | Network-owned addresses (NOA) — signing *and* the checkpoint system — are under active development and **not deployed at all** | `~/ika/AGENTS.md` Gotchas, "NOA not live" |
| I14 | Testnet and mainnet configs both exist, with package/coordinator/system object IDs; public Sui fullnodes **no longer serve JSON-RPC**, gRPC is required | `SKILL.md:44-59, 301-310` |
| I15 | SDK is `@ika.xyz/sdk`, `@mysten/sui` ^2.5.0, Node ≥18, licence BSD-3-Clause-Clear, author dWallet Labs | vendored `examples/ikavery/packages/core/node_modules/@ika.xyz/sdk/package.json` |
| I16 | **Converting a dWallet to `shared` is irreversible** and is described by Ika as a change to the trust model itself: "you must now trust the network rather than relying on the zero-trust 2PC model… Once public, the network can sign without your participation" | `docs/content/docs/sdk/ika-transaction/zero-trust.mdx:487`; `imported-key.mdx:535`; `move-integration/protocols/converting-to-shared.mdx:13-14` ("Callout type=warn, Irreversible Operation") |
| I17 | The zero-trust guarantee Ika claims: a signature "requires both the user and a 2/3 threshold of the Ika network, so user consent [cannot be bypassed]" | `~/ika/README.md:19,26` |
| I18 | Protocol pricing is **queryable and governance-managed**: `coordinator::current_pricing` exists as a read, and `set_pricing_vote` / `calculate_pricing_votes` mean fees change over time per curve | `sdk/typescript/src/tx/coordinator.ts:943, 436, 450`; `generated/ika_dwallet_2pc_mpc/pricing_and_fee_manager.ts` |
| I19 | A fresh `SessionIdentifier` is minted inside the sign paths, giving protocol-level anti-replay per ceremony | `ika-transaction.ts:512, 1569, 1607` with `createRandomSessionIdentifier` |

### 3.3 Second source: independent web verification, and what it changed

A parallel research pass against the live docs (`ika.xyz`, `docs.ika.xyz`, GitHub, the npm registry) reached
the same conclusions as §3 on every load-bearing point — including the one I had tested and rejected: it too
found that a sign needs the **`DWalletCap`** for `approveMessage` plus, for zero-trust, the user's decrypted
share. Two independent routes to the same authority decomposition (§3.2) is the confidence level this project
requires before writing invariant S12 into code.

It also **closed or moved four open questions** and introduced one correction:

| Item | Before | After |
|---|---|---|
| U-IKA-6 (native policy?) | unknown | **Answered: no.** No documented spending limit, quota, rate limit, allowlist or policy object on a dWallet. "Programmable" means *you* write the gating logic; Ika's homepage frames policy enforcement as the developer program's job. Ari's positioning is valid, and its language must not imply otherwise. |
| U-IKA-3 (fees) | unknown | **Partly.** There is a real `current_pricing` read (I18), so Ari queries rather than hardcodes. Still open: escrow-refundable vs burned. |
| U-DOC-1 (GA?) | unknown | **Largely answered.** Mainnet is a "live beta", Solana is **pre-alpha**, releases ship weekly (v1.4.1 2026-09-04), and access is **not waitlisted** — so building for real is legitimate. Commercial-terms permission remains open. |
| U-IKA-8 (SDK drift) | unknown | **Narrowed.** Published `@ika.xyz/sdk` is 0.5.0 (2026-08-18) = the vendored copy; the local repo is v1.4.0 while releases are at v1.4.1, so the clone is one patch behind. Still open: SDK-vs-chain drift over the wire. |
| I1/I10 chain set | Ethereum/Bitcoin/Solana/Substrate all fair | **Correction: Solana is pre-alpha.** `solana-pre-alpha.ika.xyz`, and Ika warns of "many risks". Solana therefore drops out of the initial supported set (§5.1). |

Two further things came out of it that are load-bearing enough to state here rather than bury:

1. **Ika is not a wallet-as-a-service.** There is no REST signing API, no hosted console, no API-key/JWT/scope
   /organisation model. The surface is an on-chain protocol plus an SDK that builds Sui transactions, and
   authorization is capability objects. Everything Ari calls "agent credentials", "scopes" and
   "organisations" is **Ari's invention, layered on top** — which is precisely the gap, but must never be
   described as an Ika feature.
2. **A quorum-gated pattern already exists.** `ikavery` is documented as "Quorum-Gated Key Custody" with a
   t-of-N roster, WebAuthn + zkLogin authentication, and a signer that "only ever signs under quorum"
   (`docs/content/docs/move-integration/examples/ikavery.mdx`). So Ari's approval quorum does **not** have to
   be application-layer-only. See §4.7 — understating an available guarantee violates S12 just as badly as
   overstating one.

### 3.1 A hypothesis I tested and it failed

Documenting this because it is exactly the kind of plausible inference that would have become a false
security property in the product.

> **Hypothesis:** `approveMessage` is an independent human authority — a compromised Ari backend could not
> approve a message without the user's `UserShareEncryptionKeys` Ed25519 signing key.

**Rejected by reading the implementation.** `ika-transaction.ts:630-641`:

```ts
const messageApproval = coordinatorTx.approveMessage(
    this.#ikaClient.ikaConfig,
    this.#getCoordinatorObjectRef(),
    this.#transaction.object(dWalletCap),   // ← the authority is the cap
    signatureAlgorithmNumber,
    hashNumber,
    message,
    this.#transaction,
);
```

`approveMessage` is a Move-call builder parameterised by `dWalletCap`. It takes no user key and produces no
off-chain signature. Anyone holding the cap — plus the Sui keypair that owns it and can pay for the
transaction — can approve any message. The name is descriptive of an on-chain object, **not** of a human
step.

**What this changes:** the cryptographic human gate in Ika is *not* message approval. It is the **secret
share**, and it exists only for `zero-trust` (and non-shared `imported-key`) dWallets. See §4.1 — that is
where Ari's strongest guarantee actually lives, and it is a different mechanism than the one I first
reached for.

### 3.2 The authority decomposition that survived

Signing with Ika requires, simultaneously:

```text
(1) DWalletCap                         — on-chain owned object
(2) the Sui keypair that owns it       — pays gas + the IKA/SUI fee coins, executes the tx
(3) a Completed presign                — message-independent, consumed via verifiedPresignCap
(4) user-side round input              — for `shared`: readable off chain (I6)
                                         for `zero-trust`: the decrypted secret share (I4)
```

For a `shared` dWallet, (1)+(2) collapse into one holder and (4) is public. **One party is sufficient.**
For a `zero-trust` dWallet, (4) requires a secret the user's device holds, so **two parties are required**,
and neither Ari alone nor a stolen Ari database alone can produce a signature.

That asymmetry is the single most important architectural fact in this project.

---

## 4. Design conclusions drawn from verified facts

Each conclusion names its evidence, so a future change to Ika invalidates it visibly rather than silently.

### 4.1 "Human approval" must be offered in two strengths, not one  *(from I3, I4, I6, §3.2)*

A policy that says `humanAbove: 5000` can be implemented two ways with **materially different guarantees**:

| Mode | Implementation | Guarantee if Ari's backend is fully compromised |
|---|---|---|
| `delegated` | `shared` dWallet, Ari holds cap + Sui key; approval is an application check | **None.** Ari can sign anything. Approval is a promise, not a property. |
| `user_gated` | `zero-trust` dWallet; the secret share is decryptable only with keys derived from the human's device (passkey PRF per I11) | **Intact.** Ari cannot complete a signing round without the human. |

Ari must expose this as an explicit, per-policy field and must **never describe `delegated` approval with
the same language it uses for `user_gated`.** The product line "an agent can be autonomous without being
unrestricted" is cryptographically true only in `user_gated` mode; in `delegated` mode it is an
organisational control backed by software. Both are useful. They are not the same claim, and saying they
are would be the false advertising that principle 18 forbids.

### 4.2 The lifecycle is asynchronous and Ari must model that honestly  *(from I7)*

`authorize` cannot return a signature. It returns an accepted request; signing completes later, on a poll,
possibly never. Ari's state machine therefore has explicit `SIGNING_PENDING` and `SIGNING_FAILED` states,
and a client-visible reconciliation step: a request can fail *after* authorisation succeeded. The audit
trail must record both, and the dashboard must be able to show "authorised but unsigned" as a distinct,
actionable condition rather than a stuck spinner.

### 4.3 Deny-before-cost  *(from I8)*

Every DKG, presign and sign spends IKA plus SUI. So "the signing provider must never be reached on a denied
request" (spec, MVP negative path) is not only a safety property, it is a **cost** property: a policy bug
burns real tokens at request rate. Consequences: a per-agent and per-organisation signing budget,
presign pooling treated as a scarce resource with its own accounting, and an alert when spend rises without
completed transactions. A hostile agent with a leaked credential and a permissive policy can be made
expensive even when every request is denied — so budget enforcement belongs *before* the expensive call,
not in a post-hoc meter.

### 4.4 Presigns are capabilities and must be handled as secrets  *(from I9, I3)*

A presign is message-independent by construction (it is computed before the message is known in the
two-phase flow) and is redeemed by `verifyPresignCap`. A presign object ID plus the cap set (case §3.2)
is therefore pre-authorised signing capacity sitting in a publicly readable chain object. Ari must: not
persist presigns longer than needed, never expose them to agents or through the SDK, and treat "presign
requested" as a metered, auditable event in its own right. **UNVERIFIED-I1** below is the specific question
about how far that pre-authorisation reaches.

### 4.5 Ari owns nonce and replay semantics; Ika does not  *(from I1, I3)*

A dWallet produces a signature over a hash. It does not know or care which chain that signature lands on,
and ECDSA over the same key and same message is deterministic. Two implications, both hard requirements:

1. **Nonce allocation is Ari's responsibility** and must be serialised per (wallet, chain, sender). Two
   concurrent requests that both pass policy must not both be assigned the same nonce, and a
   replacement/underpriced transaction must be an explicit, audited operation.
2. **Broadcast is the real money-moving step.** A signature is not a transaction; anyone holding it can
   broadcast it. Ari must never return a raw signature to a requesting agent, and the broadcast path is
   inside the authorised perimeter, not outside it. "Denied" must mean no signature exists *anywhere*.

### 4.6 The chain set is curve-bound  *(from I10)*

Supported targets are exactly the legal `(curve, signatureAlgorithm, hash)` triples Ika documents, and
Ari's policy vocabulary must be expressible in those terms or it will produce policies that are valid on
paper and unsignable in practice. Ari's `Asset`/`Chain` config therefore carries the triple as a first-class
constraint and validates it with the same rules the SDK does, rather than accepting an arbitrary string.

### 4.7 Two consequences that change what Ari is allowed to promise

**(a) `delegated` is a one-way door, so the choice is not a config toggle.** Ika documents conversion of a
zero-trust dWallet to shared as **irreversible**, and as replacing the 2PC non-collusion guarantee with
trust in a 2/3 network threshold (I16, I17). A wallet that has ever been made public cannot be pulled back.
Therefore:

- Wallet mode is chosen at **creation** and Ari must treat it as a security decision with a written warning,
  not a dropdown.
- The dashboard must name the guarantee the wallet actually has, in the wallet's own detail view, permanently
  — not in a tooltip at signup.
- Any Ari feature that "temporarily enables automation" is a lie if the underlying wallet is zero-trust, and
  a **destructive, irreversible** operation if it converts the wallet. Do not build such a feature without a
  confirmation flow that states the irreversibility in the user's own words.

**(b) The approval quorum can be moved on-chain, and should be evaluated there.** Ika already ships a
documented pattern — `ikavery` quorum-gated custody, t-of-N roster, WebAuthn/zkLogin, signer that only
completes under quorum (§3.3.2). Ari's application-layer `quorum` (arch §8) is enforceable and auditable but
it is enforced by *Ari's database*. A quorum expressed as on-chain objects would be enforced by the chain.

This does not change the MVP — the DB-backed quorum is correct to build first, and is what makes the
`delegated`/`user_gated` matrix tractable. It does change one sentence that would otherwise have been
written into the product: **"Ari enforces multi-party approval" must, for as long as the quorum is
application-layer, read "Ari records and enforces multi-party approval; on-chain enforcement is available as a
deployment option and is not enabled here."** Understating a guarantee the infrastructure offers is the same
error as overstating one it doesn't; both are S12.

---

## 5. Corrections to the brief

Raised now rather than discovered in Phase 8. Each is a factual disagreement with the specification, not a
stylistic one.

### 5.1 `chains: [ethereum, sui]` — Sui is not a documented Ika signing target

The brief's capability example lists Sui as a chain an agent may transact on. Per I1 and I10, **Sui is Ika's
coordination layer, not one of the chains a dWallet signs for.** The documented target set is Bitcoin
(legacy + Taproot), Ethereum, Solana, WebAuthn/P-256 and Substrate.

The nuance worth stating precisely: Sui accepts Ed25519 signatures, and Ika can produce Ed25519 signatures
(I10, the Solana row), so a dWallet whose public key maps to a Sui address is *conceivable*. That is where
the reasoning goes, and it is exactly the kind of inference from adjacent facts that this project forbids:
nobody has documented it, and Sui has address-derivation and transaction-digest specifics that could break
it. So:

- **Initial supported set: `ethereum` and `bitcoin` (legacy + Taproot).** Both trace directly to I10 and to a
  live, non-pre-alpha Ika path.
- **`solana` is deferred, not rejected-as-impossible** — the curve triple is documented (I10), but Ika
  labels Solana support **pre-alpha** and warns of "many risks" (§3.3). Shipping an agent-facing feature on
  a vendor's pre-alpha path is how a customer loses money on someone else's unfinished work.
- **`sui` is rejected by default** (principle 16: unsupported → reject), not because it is impossible but
  because it is unverified. Revisit only if someone actually signs a Sui transaction on testnet.
- If the brief intends "Sui" as *where Ari's own control-plane state lives*, that is a different claim
  entirely and does not belong in an agent's asset policy.

### 5.2 `approveMessage` is not a human-in-the-loop mechanism

See §3.1. Any design that treated it as one would have shipped a false guarantee. The real gate is the
secret share, and it exists only in `zero-trust`.

### 5.3 Signing is not synchronous

The brief's step list ("only then passes the transaction to the configured signing layer" … "records the
complete authorization decision") reads as one request/response. Per I7 it is a submit-then-poll flow with
a 30-second default horizon and possible non-completion. The API is `POST` → `202 + id`, then poll or
webhook. Building the synchronous version would produce a system that times out in production and pretends
to have failed *after* money may have moved.

### 5.4 "Mock signing" is not the only non-fake option available

The brief assumes Ika specifics may be unavailable. They are — on this machine, at a pinned version (§2),
with the SDK source, generated Move schemas, three examples and a localnet playbook, plus a `sui` CLI at the
matching version. So Phase 8 can be **real integration against a local or testnet Ika**, not a stub that
hopes to be right. The mock still exists and stays the default for CI; but "we couldn't verify it" is not an
available excuse here, and the docs should not read as if it were.

### 5.5 The `nonce` field in the normalised transaction request is under-specified

`nonce` appears once in a flat model that spans UTXO and account chains (I10 includes Bitcoin). Bitcoin has
no nonce; account chains need a per-sender sequence with replacement rules. The model needs either a
chain-family-tagged `replayProtection` union or the flat field becomes a lie for half the targets. Resolved
in `ARCHITECTURE.md` §6.

### 5.6 Minor: `POST /v1/organizations` with no auth is an open registration surface

A public endpoint that creates tenants, given that agents and wallets attach to organisations, is a spam
and abuse surface with no mitigation described. Phase 1 gates it behind a bootstrap/admin credential.

---

## 6. UNVERIFIED — the list that must not be quietly forgotten

Each line is a question with a named experiment. None of them block Phases 1–7, because those are entirely
Ari-side and deterministic. They are the honest content of the phrase "Ika integration assumptions", and
**all of them must be closed before Ari ships a real dWallet.**

| ID | Question | Experiment that answers it | Blocks |
|---|---|---|---|
| U-IKA-1 | Does a `futureSign` partial signature bind cryptographically to the message supplied in phase 1, or can phase 2 complete it against a different message? | On testnet: `requestFutureSign(msgA)` → attempt `futureSign` with `approveMessage(msgB)`. Expect failure. | The claim "approval cannot be replayed onto another transaction" (§4.4) |
| U-IKA-2 | Can a `verifiedPresignCap` be reused, or is it single-use? Can an unredeemed presign be consumed by another party who holds the cap? | Two `requestSign` calls against one presign on testnet | Presign pooling design; §4.4 |
| U-IKA-3 | Exact fee semantics: is `1_000_000` IKA a refundable escrow, a burn, or a maximum? | Read `coordinator.move` fee handling + measure balances across a testnet sign. **Partly closed:** `current_pricing` is queryable (I18), so Ari reads live prices instead of hardcoding; escrow-vs-burn still open | Budget guard thresholds (§4.3) |
| U-IKA-4 | Realistic end-to-end latency and failure rate of a sign on mainnet and testnet | Instrument 100 signs | SLAs, timeouts, retry/idempotency policy |
| U-IKA-5 | What happens to an in-flight sign across an epoch boundary / validator reconfiguration | Force an epoch change mid-sign on localnet (`dev-docs/playbooks/localnet.md`) | Whether `SIGNING_FAILED` needs a "safe to retry" distinction |
| U-IKA-6 | Is there any Ika-native spending limit, allowlist or policy concept on a dWallet? | **CLOSED — no** (see §3.3). No documented limit/quota/rate-limit/allowlist; policy is explicitly the developer program's job | Product positioning restated: the gap is real and is ours |
| U-IKA-7 | Can a `zero-trust` signing ceremony be completed server-side with a decrypted share cached, and what does caching that share actually cost in security terms | Prototype the KMS/TEE path, then decide | Whether `user_gated` can be made ergonomic (it may have to stay device-interactive, and that is a UX limit worth naming early) |
| U-IKA-8 | Does `@ika.xyz/sdk@0.5.0` (vendored) match the chain at the pinned release? | **Narrowed:** published SDK 0.5.0 = vendored copy; local clone v1.4.0 is one patch behind the v1.4.1 release. Remaining: SDK-vs-chain wire drift; bump the clone to v1.4.1 before Phase 8 | Which SDK + chain version Ari pins |
| U-DOC-1 | Is Ika mainnet GA, and is a third party permitted to run a production dWallet commercially? | **Partly answered:** mainnet is a "live beta", not waitlisted, weekly releases (§3.3). Open: ToS/commercial terms | Whether the README can say "signs via Ika" or must say "integrates with Ika" |
| U-DOC-2 | Rate limits and any access tiering on the coordinator | Docs / testnet observation | Capacity planning |

Anything in this table that turns out to be **load-bearing for a security claim** gets promoted into
`THREAT_MODEL.md` with its mitigation removed until it is closed.

---

## 7. Ari-side assumptions (ours, not Ika's — safe to build, must be stated)

These are choices, not discoveries. Each is defensible; none is externally forced.

| ID | Assumption | Why | Revisit if |
|---|---|---|---|
| A1 | A modular monolith in one deployable API is correct for the baseline | Ika's own model is "submit then poll"; there is no throughput argument for splitting the decision path, and every boundary crossed is a place ordering can leak | Load testing says otherwise |
| A2 | **Deliberate physical split**: the *decision* plane (API, policy, risk, intent) and the *authority* plane (a signer service holding cap/Sui key, and for `user_gated` nothing at all — the human device holds the share) are separate processes with a narrow ticket protocol | The brief asks for ordering "enforced structurally where possible"; a process boundary plus a mintable-elsewhere-impossible ticket is the strongest cheap version of that | — |
| A3 | Postgres is the single source of truth for all limit accounting; Redis is used only for gateway rate limiting and never for authorization | A daily spend limit enforced in Redis is a limit enforced outside the transaction boundary. The concurrency test in the spec (two $4,000 requests, $5,000 cap) is a database row-lock test, not a cache test | — |
| A4 | Policies are compiled to an immutable normalised form at activation; evaluation never touches the database | Determinism, and it makes policy-version rollback testable as a pure function | Policy size makes compilation impractical |
| A5 | The LLM boundary is one interface, `IntentInterpreter`, returning a Zod-validated union `VALID \| NEEDS_CLARIFICATION \| INVALID`, and the rest of the system never sees model text | Prevents "parse the prose later" drift, which is how LLMs sneak into the decision path | — |
| A6 | Risk never grants. Risk can only *escalate* (allow→review) or annotate; it can never turn a DENY into an ALLOW | Encodes the brief's separation as a type-level constraint instead of a code-review convention | — |
| A7 | Agent credentials are opaque high-entropy secrets, hashed with Argon2id at rest; identity is a separate id from the secret | Rotation/revocation semantics stay clean; a JWT that must be revoked needs a state lookup anyway, so it buys nothing | — |
| A8 | Every externally visible identifier is a UUIDv7 (time-ordered, non-enumerable) with a type prefix (`agt_`, `pol_`, `txr_`) | The brief forbids sequential public IDs; prefixes make logs and support readable | — |
| A9 | The MVP negative path is asserted as a **counter**, not a log line: the signing mock records invocation count and the test demands exactly zero | "No signing request must ever reach the signing provider" is a property about absence; absence needs a witness | — |
| A10 | Simulation is advisory in MVP. A mock simulator cannot prove anything about real chain behaviour and must not be presented as a gate | Principle 18 again. Real simulation (anvil fork — already running on this box, §1) becomes a *blocking* control when the EVM provider lands | When U-IKA/chain providers are real |
| A11 | `denied` is a decision, `error` is not a decision, and the two never share a code path; any failure inside authorization produces **DENY** | Fail-closed has to be the only available alternative in the type system | — |

---

## 8. What cannot be built safely yet

Stated plainly, because "we did not build it" and "we built a fake version of it" are different failures and
only one of them is recoverable.

1. **`user_gated` approvals without a user device.** U-IKA-7 decides whether the human's share can ever be
   custodied server-side. Until then, any "instant autonomous execution" claim on a `user_gated` wallet is
   false, and the dashboard must say so rather than showing a pending approval as a bug.
2. **Real simulation-backed authorization.** Only advisory until the anvil-fork provider exists.
3. **Broadcast confirmation.** Chain reorganisation means a broadcast transaction is not final. Until a
   finality provider per chain exists, `EXECUTED` in the trace must be labelled `BROADCAST`, and any UI
   wording that implies confirmation is a defect.
4. **A policy that constrains Ika itself.** Ari's policy is enforced by Ari. On a `shared` dWallet the chain
   will happily sign whatever the cap holder requests — that is I3 and it is by design. Ari's guarantee is
   "we deterministically refuse, and here is the audit trail proving we refused", which is a real and
   valuable product, and is not the same sentence as "the chain enforces your policy". Say the first one.
5. **Multi-tenant key isolation details** (per-tenant Sui addresses, cap custody, secrets storage backend) —
   an infrastructure decision that deserves its own ADR after U-IKA-3 and U-IKA-6 close, not a scaffold
   guess made today.
