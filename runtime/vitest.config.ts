import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    // npm workspaces hoist deps to the monorepo root and symlink workspace
    // packages into node_modules/@tetsuo-ai/*. No manual aliases needed.
  },
  test: {
    globals: false,
    environment: 'node',
    pool: 'forks',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      'tests/integration.test.ts',
      'tests/eval-replay.integration.test.ts',
      'tests/benchmark-runner.integration.test.ts',
      // T4: compact/ ported from openclaude; tests re-enabled tranche-by-tranche
      // as their cross-directory deps land (T5 phase machine, T6 event log,
      // T7 tools, T9 subagents, T10 memory). See docs/plan/invariants.md
      // I-2 / I-18 / I-88 wiring in T4.
      'src/llm/compact/**/*.test.ts',
    ],
    testTimeout: 30000,
    deps: {
      interopDefault: true,
    },
  },
});
