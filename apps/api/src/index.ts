/**
 * The composition root's public surface.
 *
 * Route handlers live in `routes.ts` and hold no logic that could re-order the
 * pipeline: they authenticate, parse, call, and strip before answering.
 */
export {
  authorize,
  type AuthorizeInput,
  type AuthorizeOutcome,
  type PipelineDeps,
} from './authorize.js';
export { authenticateAgent, acceptsBootstrapToken, type AuthResult, type Principal } from './gateway.js';
export { createSignerClient, type DeliveryResult, type SignerClient } from './signer-client.js';
export { registerRoutes, type RouteDeps } from './routes.js';
export { readConfig, startApi, type ApiConfig, type RunningApi } from './server.js';
