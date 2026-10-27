/** The package's public surface: an agent's author imports this and nothing else. */
export { toWire, wireStringify, type JsonValue } from './serialize.js';
export {
  createClient,
  type AriClient,
  type AuthorizeBody,
  type CallResult,
  type ClientOptions,
  type Delivered,
  type DeniedBody,
  type NotDeliveredBody,
  type PendingBody,
  type PreviewBody,
  type RefusedBody,
  type StatusBody,
} from './client.js';
/**
 * The candidate's *shape*, not its parser.
 *
 * Type-only on purpose, and it is a licence boundary as much as a dependency one:
 * `@ari/schemas` carries `DIGEST_FIELD_ALLOWLIST`, the branded digests and the money
 * grammar — the platform's decision machinery, licensed BUSL-1.1. This package is
 * Apache-2.0, so shipping the schema **object** here would relicense platform code by
 * re-export. A declaration of the input shape is the minimum an agent's author needs to
 * call the API, and it is what `dist/vendor/schemas/` is generated into at build time —
 * derived mechanically from the real source, never hand-copied, so the two cannot drift.
 */
export type { CandidateTransaction } from '@ari/schemas';
