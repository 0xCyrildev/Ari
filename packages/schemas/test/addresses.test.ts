import { describe, expect, it } from 'vitest';
import { hostOfUrl, isLoopbackHost } from '../src/index.js';

describe('isLoopbackHost', () => {
  it('names the addresses that cannot be reached beyond this machine', () => {
    for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('does not call a public address loopback because it looks local', () => {
    // `0.0.0.0` is the binding a platform proxy asks for and the widest exposure there is;
    // treating it as local would switch off every rule that depends on this predicate.
    for (const host of ['0.0.0.0', '10.0.0.4', '172.17.0.2', 'signer', 'gateway.pxxl.app', 'localhost.example']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('hostOfUrl', () => {
  it('reads the hostname out of a connection string, brackets and all', () => {
    expect(hostOfUrl('postgresql://u:p@db.example.com:6432/ari')).toBe('db.example.com');
    expect(hostOfUrl('postgresql://u:p@[::1]:5432/ari')).toBe('::1');
    expect(hostOfUrl('not a url')).toBeNull();
  });
});
