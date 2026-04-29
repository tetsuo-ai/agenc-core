import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const benchmarkLaneEnabled = process.env.AGENC_RUNTIME_BENCHMARKS === '1';

export default defineConfig({
  resolve: {
    alias: [
      { find: 'bun:bundle', replacement: resolve(__dirname, 'src/build/feature.ts') },
      // Mirror the tsconfig `paths` mapping `src/*` to the runtime `src/` tree
      // so AgenC-style absolute imports resolve both under tsc and vitest.
      { find: /^src\/(.*)$/, replacement: resolve(__dirname, 'src/$1') },
    ],
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
      ...(benchmarkLaneEnabled ? [] : ['tests/benchmark-runner.integration.test.ts']),
    ],
    testTimeout: benchmarkLaneEnabled ? 120000 : 30000,
    deps: {
      interopDefault: true,
    },
  },
});
