/**
 * The composition root's public surface.
 *
 * Route handlers belong beside this file, not inside it: the pipeline below already
 * enforces the order that matters, and an HTTP layer that could re-order it would be
 * a second, weaker copy of the same guarantees.
 */
export {
  authorize,
  type AuthorizeInput,
  type AuthorizeOutcome,
  type PipelineDeps,
} from './authorize.js';
