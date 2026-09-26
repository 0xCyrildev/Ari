/**
 * The API client, and the only place in this tool that knows what a response costs.
 *
 * Two rules, both about secrets. A non-2xx answer becomes a `Refusal` carrying the
 * server's own `code` and `detail` — Ari's codes are the useful vocabulary, and a stack
 * trace about a refused payment is noise. And a bearer secret is only ever read from
 * `--token` or `ARI_TOKEN`, never echoed back: the commands that *mint* a secret print it,
 * once, because the row holds an Argon2id digest of it and there is no second reading.
 */

import { UsageError } from './args.js';

export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    override readonly message: string,
  ) {
    super(message);
  }
}

export interface Call {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly token?: string;
}

export type Json = Record<string, unknown>;

export class Api {
  readonly base: string;
  readonly token: string | undefined;

  constructor(base: string, token?: string) {
    if (!base.startsWith('http://127.0.0.1') && !base.startsWith('https://')) {
      // Loopback or TLS. A tool that prints bearer secrets to stderr should not be able to
      // be configured to send them across a plain HTTP link to a host that is not this one.
      throw new UsageError(`--url must be https:// or http://127.0.0.1, got "${base}"`);
    }
    this.base = base.endsWith('/') ? base.slice(0, -1) : base;
    this.token = token;
  }

  async call<T = Json>(call: Call): Promise<T> {
    const token = call.token ?? this.token;
    const response = await fetch(`${this.base}${call.path}`, {
      method: call.method,
      headers: {
        // Only with a body. `ari agent revoke` is the first body-less POST this tool makes,
        // and declaring `content-type: application/json` while sending no bytes is not
        // cosmetic: Fastify refuses the request at the body parser with a 400 — "Body cannot
        // be empty when content-type is set to 'application/json'" — before it has read a
        // credential, checked a scope or looked at the agent. Every test that exercised the
        // route through `app.inject()` passed, because inject does not reproduce a framework
        // default; this is the difference between driving the app and driving the wire.
        ...(call.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    });

    const raw = await response.text();
    let parsed: Json;
    try {
      parsed = raw.length === 0 ? {} : (JSON.parse(raw) as Json);
    } catch {
      throw new Refusal(
        response.status,
        'UNPARSEABLE_RESPONSE',
        `${call.method} ${call.path} answered ${response.status} in a form this tool cannot read`,
      );
    }

    if (response.status >= 400) {
      const code = typeof parsed.code === 'string' ? parsed.code : 'UNKNOWN';
      const detail = typeof parsed.detail === 'string' ? parsed.detail : `HTTP ${response.status}`;
      // The call is named in the message. A five-command `ari init` that fails with one
      // opaque sentence is a support thread; one that says which route refused, twice.
      throw new Refusal(response.status, code, `${call.method} ${call.path}: ${detail}`);
    }
    return parsed as T;
  }
}
