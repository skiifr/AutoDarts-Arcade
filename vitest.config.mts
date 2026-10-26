import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/devtools/fake-board', 'apps/devtools/fault-proxy'],
  },
});
