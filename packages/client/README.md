# @ari/client

The agent-facing client for [Ari](https://github.com/0xCyrildev/Ari): an AI agent asks to pay, a compiled
policy answers `ALLOW | REQUIRE_HUMAN_APPROVAL | DENY`, and a sealed single-use ticket releases a signature
in a second process. This package is the part an agent's author imports.

    npm install @ari/client

    import { createClient } from '@ari/client';

    const ari = createClient({ url: 'https://…/v1', token: process.env.ARI_TOKEN! });
    const answer = await ari.authorize({ intent: 'pay the vendor', candidate });

Three properties of this API are deliberate, and two of them are the reason a call can fail loudly:

- **There is no `sign`.** Not a method that returns an error — a method that does not exist on the type.
  No path from an agent to a signature is what the client is for, and the test suite asserts it at the type
  level so removing it is a compile failure.
- **Responses are parsed, not trusted.** Every shape is a strict schema: a server that starts answering with
  an extra field — a ticket, a signature, a provider reference — is a server this client refuses to read,
  reported as `CONTRACT_MISMATCH`.
- **Money crosses as decimal strings.** A parsed candidate holds `bigint`s, which `JSON.stringify` throws
  on, so `toWire` converts them and refuses floats, unsafe integers and bare `undefined` rather than
  rounding an amount on the way out.

Licensing: this client is **Apache-2.0** (see `LICENSE`). The Ari platform — the policy engine, the signing
boundary, the ledger — remains **BUSL-1.1**. `CandidateTransaction` is re-exported here as a *type* only;
the schema object itself lives in the platform package and is not relicensed by this one.

Requirements: Node 18 or newer (global `fetch`, `AbortSignal.timeout`).
