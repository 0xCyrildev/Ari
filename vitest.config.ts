import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    // A path, not an imported function: global setup runs in its own process
    // before any worker exists, which is the whole point of doing the DDL there.
    globalSetup: ['tests/security/global-setup.ts'],
    // The database is a shared resource and these suites contend for it, so a hung
    // connection should read as a failure rather than as a test that never ends.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
