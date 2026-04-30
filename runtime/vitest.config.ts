import { defineConfig } from 'vitest/config';
import { existsSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';

const benchmarkLaneEnabled = process.env.AGENC_RUNTIME_BENCHMARKS === '1';
const agencRoot = resolve(__dirname, 'src/agenc');
const agencUpstreamRoot = resolve(agencRoot, 'upstream');
const runtimeSourceRoot = resolve(__dirname, 'src');

function existingSourceFile(base: string): string | null {
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.jsx$/, '.tsx'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function sourceRootForImporter(importer: string): string | null {
  const absoluteImporter = isAbsolute(importer) ? importer : resolve(__dirname, importer);
  const rel = relative(agencUpstreamRoot, absoluteImporter);
  return rel !== '' && !rel.startsWith('..') ? agencUpstreamRoot : null;
}

function resolveAgenCBareSrc(source: string): string {
  const sourceRelative = source.slice('src/'.length);
  for (const root of [agencUpstreamRoot, runtimeSourceRoot]) {
    const found = existingSourceFile(resolve(root, sourceRelative));
    if (found) return found;
  }
  return resolve(runtimeSourceRoot, sourceRelative);
}

function resolveRelativeAgenCSource(importer: string, source: string): string | null {
  const absoluteImporter = isAbsolute(importer) ? importer : resolve(__dirname, importer);
  const direct = existingSourceFile(resolve(dirname(absoluteImporter), source));
  if (direct) return direct;

  const sourceRoot = sourceRootForImporter(absoluteImporter);
  if (sourceRoot === null) return null;
  return null;
}

export default defineConfig({
  plugins: [
    {
      name: 'agenc-bare-src-alias',
      enforce: 'pre',
      resolveId(source, importer) {
        if (
          source.startsWith('src/') &&
          importer !== undefined &&
          (importer.includes('/src/agenc/') ||
            sourceRootForImporter(importer) !== null)
        ) {
          return resolveAgenCBareSrc(source);
        }
        if (
          (source.startsWith('./') || source.startsWith('../')) &&
          importer !== undefined &&
          (importer.includes('/src/agenc/') ||
            sourceRootForImporter(importer) !== null)
        ) {
          return resolveRelativeAgenCSource(importer, source);
        }
        return null;
      },
    },
  ],
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
      'src/agenc/**/*.test.ts',
      'src/agenc/**/*.test.tsx',
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
