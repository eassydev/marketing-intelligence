import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // Integration/E2E tests spin up Testcontainers Postgres — give them room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
      exclude: [
        'node_modules/**',
        'dist/**',
        'drizzle/**',
        'scripts/**',
        'tests/**',
        '**/*.config.*',
        // Parked stubs and pure network adapters are excluded from the
        // coverage denominator until their slice ships with real tests.
        'src/marketing/actions/live-port.ts',
        'src/marketing/ingest/ga4-connector.ts',
        'src/server.ts',
      ],
    },
  },
});
