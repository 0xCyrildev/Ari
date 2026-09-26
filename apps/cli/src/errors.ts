/**
 * The two ways this tool says no without the server having been asked anything.
 *
 * `UsageError` is an exit 2: the invocation was wrong, nothing ran, fix the command line.
 * `Invalid` is an exit 1: the command did exactly what it was told, and the thing it was
 * pointed at is not valid. The distinction is not punctuation. An operator scripting
 * against `ari policy validate` needs `2` to mean "my script is broken" and `1` to mean
 * "this policy is broken", because the second one is the answer they came for and the
 * first one is a bug in the caller. A single error class with one exit code would make
 * both of those the same event.
 *
 * A refusal from the *server* is a third thing — `Refusal` in `http.ts` — and it carries
 * an HTTP status, which is why this file does not.
 */

export class Invalid extends Error {
  constructor(
    readonly code: string,
    override readonly message: string,
  ) {
    super(message);
  }
}
