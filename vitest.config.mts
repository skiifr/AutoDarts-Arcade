import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/devtools/fake-board', 'apps/devtools/fault-proxy'],
    coverage: {
      provider: 'v8',
      include: ['packages/games/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      reporter: [['text', { skipFull: false }]],
      reportsDirectory: 'node_modules/.cache/coverage',
      thresholds: {
        // Every game's rules must be fully exercised by its rules suite (ROADMAP Phase 3).
        'packages/games/src/*/module.ts': { branches: 100, perFile: true },
      },
    },
  },
});
