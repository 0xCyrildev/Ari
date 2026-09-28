/**
 * Addresses, as a security predicate.
 *
 * This lives in the shared contract package rather than beside either of the two gates
 * that ask it, because the question — "is this address reachable beyond this machine?" —
 * is what decides whether a secret is *required* (the signer's bind, the delivery URL)
 * and whether a database connection may be plaintext at all. Two answers to it, in two
 * packages, is how one of them ends up wrong while both suites stay green.
 */

const LOOPBACK_HOST = /^(?:127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|localhost|\[::1\]|::1)$/;

/**
 * True only for addresses that cannot be routed to from another machine.
 *
 * `0.0.0.0` is deliberately **not** loopback: it is what a platform proxy asks for, and it
 * is also the widest possible exposure. A predicate that called it local would silently
 * switch off every rule that depends on this one.
 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOST.test(host);
}

/**
 * The host of a connection string, or null when it is not a parseable URL.
 *
 * Bracketed IPv6 comes back without its brackets, so `isLoopbackHost` sees the same shape
 * a hostname does.
 */
export function hostOfUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  } catch {
    return null;
  }
}
