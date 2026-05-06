import { defineConfig } from 'vitest/config';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';

const benchmarkLaneEnabled = process.env.AGENC_RUNTIME_BENCHMARKS === '1';
const agencRoot = resolve(__dirname, 'src/agenc');
const agencUpstreamRoot = resolve(agencRoot, 'upstream');
const runtimeSourceRoot = resolve(__dirname, 'src');
const relocatedUpstreamRoots = [
  {
    runtimeRoot: resolve(runtimeSourceRoot, 'utils'),
    upstreamRoot: resolve(agencUpstreamRoot, 'utils'),
  },
  {
    runtimeRoot: resolve(runtimeSourceRoot, 'constants'),
    upstreamRoot: resolve(agencUpstreamRoot, 'constants'),
  },
  {
    runtimeRoot: resolve(runtimeSourceRoot, 'memdir'),
    upstreamRoot: resolve(agencUpstreamRoot, 'memdir'),
  },
];
const sourceFileBaseAliases = [
  {
    runtimeBase: resolve(runtimeSourceRoot, 'tools/Tool'),
    upstreamBase: resolve(agencUpstreamRoot, 'Tool'),
  },
  {
    runtimeBase: resolve(agencUpstreamRoot, 'tools/Tool'),
    upstreamBase: resolve(agencUpstreamRoot, 'Tool'),
  },
  {
    runtimeBase: resolve(agencUpstreamRoot, 'tasks/Task'),
    upstreamBase: resolve(agencUpstreamRoot, 'Task'),
  },
];
const relocatedTuiSourceRoots = [
  resolve(runtimeSourceRoot, 'tui/components'),
  resolve(runtimeSourceRoot, 'tui/context'),
  resolve(runtimeSourceRoot, 'tui/hooks'),
];
const movedDonorTestRoots = [
  resolve(runtimeSourceRoot, 'utils'),
  resolve(runtimeSourceRoot, 'constants'),
];

function normalizeConfigPath(file: string): string {
  return file.split(/[/\\]+/).join('/');
}

function walkTestFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return walkTestFiles(full);
    return /\.test\.(?:ts|tsx)$/.test(full) ? [full] : [];
  });
}

const movedDonorTestFiles = movedDonorTestRoots
  .flatMap(walkTestFiles)
  .map((file) => normalizeConfigPath(relative(__dirname, file)));

function aliasedSourceBases(base: string): string[] {
  const slash = base.lastIndexOf('/');
  const file = slash === -1 ? base : base.slice(slash + 1);
  const extMatch = /^(.*?)(\.(?:js|jsx|ts|tsx))?$/.exec(file);
  const ext = extMatch?.[2] ?? '';
  const extensionlessBase = ext === '' ? base : base.slice(0, -ext.length);
  const fileBaseAliases = sourceFileBaseAliases
    .filter(({ runtimeBase }) => runtimeBase === extensionlessBase)
    .map(({ upstreamBase }) => `${upstreamBase}${ext}`);
  return [base, ...fileBaseAliases];
}

function existingSourceFile(base: string): string | null {
  const hasExtension = /\.[^/\\]+$/.test(base);
  const candidates = [
    ...new Set(
      aliasedSourceBases(base).flatMap((sourceBase) =>
        hasExtension
          ? [
              sourceBase,
              sourceBase.replace(/\.js$/, '.ts'),
              sourceBase.replace(/\.js$/, '.tsx'),
              sourceBase.replace(/\.jsx$/, '.tsx'),
            ]
          : [
              sourceBase,
              `${sourceBase}.ts`,
              `${sourceBase}.tsx`,
              `${sourceBase}.mts`,
              `${sourceBase}.cts`,
              resolve(sourceBase, 'index.ts'),
              resolve(sourceBase, 'index.tsx'),
              resolve(sourceBase, 'index.js'),
            ],
      ),
    ),
  ];
  return candidates.find((candidate) => {
    if (!existsSync(candidate)) return false;
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

function isWithin(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sourceRootForImporter(importer: string): string | null {
  const cleanImporter = importer.split('?')[0] ?? importer;
  const absoluteImporter = isAbsolute(cleanImporter)
    ? cleanImporter
    : resolve(__dirname, cleanImporter);
  if (isWithin(agencUpstreamRoot, absoluteImporter)) return agencUpstreamRoot;
  const relocatedRoot = relocatedTuiSourceRoots.find((root) =>
    isWithin(root, absoluteImporter),
  );
  return relocatedRoot ?? null;
}

function relocatedUpstreamImporter(importer: string): string | null {
  const cleanImporter = importer.split('?')[0] ?? importer;
  const absoluteImporter = isAbsolute(cleanImporter)
    ? cleanImporter
    : resolve(__dirname, cleanImporter);
  for (const { runtimeRoot, upstreamRoot } of relocatedUpstreamRoots) {
    const rel = relative(runtimeRoot, absoluteImporter);
    if (rel !== '' && !rel.startsWith('..')) {
      return resolve(upstreamRoot, rel);
    }
  }
  return null;
}

function resolveAgenCBareSrc(source: string): string | null {
  const sourceRelative = source.slice('src/'.length);
  const relocatedTuiRelative = /^(components|context|hooks)\//.exec(sourceRelative);
  if (relocatedTuiRelative) {
    const found = existingSourceFile(resolve(runtimeSourceRoot, 'tui', sourceRelative));
    if (found) return found;
  }
  for (const root of [agencUpstreamRoot, runtimeSourceRoot]) {
    const found = existingSourceFile(resolve(root, sourceRelative));
    if (found) return found;
  }
  return null;
}

function normalizeRuntimePath(file: string): string {
  return file.split(/[/\\]+/).join('/');
}

function topKey(logical: string): string {
  return logical.split('/')[0]?.replace(/\.(?:jsx?|tsx?)$/, '') ?? '';
}

function relocatedLogicalCandidates(importer: string, source: string): string[] {
  const candidates: string[] = [];
  let logical: string | null = null;
  if (source.startsWith('src/')) {
    logical = source.slice('src/'.length);
  } else if (source.startsWith('./') || source.startsWith('../')) {
    const absolute = resolve(dirname(importer), source);
    const relSource = normalizeRuntimePath(relative(runtimeSourceRoot, absolute));
    if (relSource !== '' && !relSource.startsWith('..')) {
      logical = relSource;
    } else {
      const relRuntime = normalizeRuntimePath(relative(resolve(__dirname), absolute));
      if (relRuntime !== '' && !relRuntime.startsWith('..')) logical = relRuntime;
    }
  }
  if (!logical) return candidates;
  candidates.push(logical);
  if (logical.startsWith('tui/tui/')) candidates.push(logical.slice('tui/'.length));
  if (logical.startsWith('tui/')) candidates.push(logical.slice('tui/'.length));
  const first = topKey(logical);
  if (first === 'components' || first === 'context' || first === 'hooks') {
    candidates.push(`tui/${logical}`);
  }
  return [...new Set(candidates)];
}

function resolveRelocatedTuiSource(importer: string, source: string): string | null {
  for (const logical of relocatedLogicalCandidates(importer, source)) {
    const direct = existingSourceFile(resolve(runtimeSourceRoot, logical));
    if (direct) return direct;

    const first = topKey(logical);
    if (first === 'components' || first === 'context' || first === 'hooks') {
      const moved = existingSourceFile(resolve(runtimeSourceRoot, 'tui', logical));
      if (moved) return moved;
    }

    const upstream = existingSourceFile(resolve(agencUpstreamRoot, logical));
    if (upstream) return upstream;

    if (logical.startsWith('tui/')) {
      const stripped = logical.slice('tui/'.length);
      const strippedUpstream = existingSourceFile(resolve(agencUpstreamRoot, stripped));
      if (strippedUpstream) return strippedUpstream;
    }
  }
  return null;
}

function resolveRelativeAgenCSource(importer: string, source: string): string | null {
  const cleanImporter = importer.split('?')[0] ?? importer;
  const absoluteImporter = isAbsolute(cleanImporter)
    ? cleanImporter
    : resolve(__dirname, cleanImporter);
  const direct = existingSourceFile(resolve(dirname(absoluteImporter), source));
  if (direct) return direct;

  const relocatedImporter = relocatedUpstreamImporter(absoluteImporter);
  if (relocatedImporter !== null) {
    const relocatedTarget = resolve(dirname(relocatedImporter), source);
    const relocated = existingSourceFile(relocatedTarget);
    if (relocated) return relocated;
  }

  const sourceRoot = sourceRootForImporter(absoluteImporter);
  if (sourceRoot === null) return null;
  if (relocatedTuiSourceRoots.includes(sourceRoot)) {
    return resolveRelocatedTuiSource(absoluteImporter, source);
  }
  return null;
}

export default defineConfig({
  plugins: [
    {
      name: 'agenc-markdown-text-loader',
      enforce: 'pre',
      load(id) {
        const cleanId = id.split('?')[0] ?? id;
        if (!cleanId.endsWith('.md')) return null;
        return `export default ${JSON.stringify(readFileSync(cleanId, 'utf8'))};`;
      },
    },
    {
      name: 'agenc-bare-src-alias',
      enforce: 'pre',
      resolveId(source, importer) {
        if (source.startsWith('src/')) {
          if (
            importer === undefined ||
            (!importer.includes('/src/agenc/') &&
              sourceRootForImporter(importer) === null &&
              relocatedUpstreamImporter(importer) === null)
          ) {
            return null;
          }
          return resolveAgenCBareSrc(source);
        }
        if (
          (source.startsWith('./') || source.startsWith('../')) &&
          importer !== undefined &&
          (importer.includes('/src/agenc/') ||
            sourceRootForImporter(importer) !== null ||
            relocatedUpstreamImporter(importer) !== null)
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
      // Moved donor-origin tests were previously hidden under src/agenc.
      // Keep them out of Vitest until their owning items convert them.
      ...movedDonorTestFiles,
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
