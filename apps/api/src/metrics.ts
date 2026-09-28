/**
 * The counters an operator watches before anything is on fire.
 *
 * Hand-written, no dependency: the exposition format for the handful of metrics worth
 * having here is short, and the alternative is a package deciding how this process
 * reports its own health.
 *
 * What is deliberately absent is any label that can name a tenant. This endpoint is
 * gated by a token, not by an identity, and a counter labelled by organisation, agent,
 * credential, digest or request id would let whoever can scrape it answer "how much does
 * this tenant move" — a cross-tenant inference channel (T20) sitting in the one surface
 * that has no principal to check it against. The route label comes from the route table
 * (`req.routeOptions.url`, never the path a caller typed), the status from the codes this
 * process sends, and the buckets from the list below. Both label sets are therefore
 * bounded by this repository, not by traffic.
 */

/** Seconds. Straddles the measured p50 of a payment (~30 ms) and the 5 s signer timeout. */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

export interface HttpSample {
  readonly route: string;
  readonly method: string;
  readonly status: number;
  readonly seconds: number;
}

export interface PoolSnapshot {
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
}

/** `labelKey`/`renderLabels` round-trip through `name=value` pairs, so a value may not contain either. */
function sanitize(value: string): string {
  return value.replace(/["\\,\n]/g, '?');
}

function labelKey(labels: Readonly<Record<string, string>>): string {
  return Object.keys(labels)
    .sort()
    .map((name) => `${name}=${sanitize(labels[name]!)}`)
    .join(',');
}

function renderLabels(key: string): string {
  if (key.length === 0) return '';
  return `{${key.split(',').map((pair) => {
    const at = pair.indexOf('=');
    return `${pair.slice(0, at)}="${pair.slice(at + 1)}"`;
  }).join(',')}}`;
}

interface Histogram {
  /**
   * Already cumulative: an observation increments every bucket whose bound is at or above
   * it, which is what `_bucket{le=x}` means. The alternative — counting "landed in this
   * bucket" and summing at render — produces numbers that look plausible and are wrong in
   * every bucket but the top one.
   */
  readonly atOrBelow: number[];
  sum: number;
  total: number;
}

export class ApiMetrics {
  readonly #counters = new Map<string, Map<string, number>>();
  readonly #histograms = new Map<string, Histogram>();
  #pool: PoolSnapshot = { total: 0, idle: 0, waiting: 0 };

  constructor(readonly version: string) {}

  #increment(name: string, labels: Readonly<Record<string, string>>): void {
    let series = this.#counters.get(name);
    if (series === undefined) this.#counters.set(name, (series = new Map()));
    const key = labelKey(labels);
    series.set(key, (series.get(key) ?? 0) + 1);
  }

  noteRequest(sample: HttpSample): void {
    this.#increment('ari_api_http_requests_total', {
      route: sample.route,
      method: sample.method,
      status: String(sample.status),
    });
    let h = this.#histograms.get('ari_api_http_request_seconds');
    if (h === undefined) {
      h = { atOrBelow: BUCKETS.map(() => 0), sum: 0, total: 0 };
      this.#histograms.set('ari_api_http_request_seconds', h);
    }
    for (let i = 0; i < BUCKETS.length; i += 1) {
      if (sample.seconds <= BUCKETS[i]!) h.atOrBelow[i] = (h.atOrBelow[i] ?? 0) + 1;
    }
    h.sum += sample.seconds;
    h.total += 1;
  }

  /** Both label sets are closed here rather than strings from the call site: `kind` and `result` are this file's vocabulary. */
  noteCredentialVerify(kind: 'agent' | 'user', result: 'accepted' | 'refused'): void {
    this.#increment('ari_api_credential_verifications_total', { kind, result });
  }

  /** The delivery hop's answer, which is what separates a signing outage from a busy one. */
  noteDelivery(outcome: 'accepted' | 'parked'): void {
    this.#increment('ari_api_delivery_total', { outcome });
  }

  /** A reconciliation pass, by whether it found anything to say. */
  noteReconciliation(found: boolean): void {
    this.#increment('ari_api_reconciliation_total', { found: found ? 'true' : 'false' });
  }

  /** Read off `pg.Pool` at scrape time — a gauge, not a counter, because it goes down again. */
  notePool(snapshot: PoolSnapshot): void {
    this.#pool = snapshot;
  }

  /** Prometheus text exposition, version 0.0.4. */
  exposition(): string {
    const lines: string[] = [
      '# TYPE ari_api_build_info gauge',
      `ari_api_build_info{version="${sanitize(this.version)}"} 1`,
    ];

    for (const [name, series] of [...this.#counters.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines.push(`# TYPE ${name} counter`);
      for (const [key, value] of [...series.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        lines.push(`${name}${renderLabels(key)} ${value}`);
      }
    }

    for (const [name, h] of this.#histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (let i = 0; i < BUCKETS.length; i += 1) {
        lines.push(`${name}_bucket{le="${BUCKETS[i]}"} ${h.atOrBelow[i] ?? 0}`);
      }
      lines.push(`${name}_bucket{le="+Inf"} ${h.total}`);
      lines.push(`${name}_sum ${h.sum.toFixed(6)}`);
      lines.push(`${name}_count ${h.total}`);
    }

    lines.push('# TYPE ari_api_pool_connections gauge');
    lines.push(`ari_api_pool_connections{state="total"} ${this.#pool.total}`);
    lines.push(`ari_api_pool_connections{state="idle"} ${this.#pool.idle}`);
    lines.push(`ari_api_pool_connections{state="waiting"} ${this.#pool.waiting}`);
    return `${lines.join('\n')}\n`;
  }
}
