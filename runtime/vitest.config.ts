import { configDefaults, defineConfig } from 'vitest/config';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { createScanner, ScriptTarget, SyntaxKind } from 'typescript';

const agencRoot = resolve(__dirname, 'src/agenc');
const agencUpstreamRoot = resolve(agencRoot, 'upstream');
const runtimeSourceRoot = resolve(__dirname, 'src');
const runtimeTestRoot = resolve(__dirname, 'tests');
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

const bunTestFiles = walkTestFiles(runtimeTestRoot)
  .filter((file) => readFileSync(file, 'utf8').includes('bun:test'))
  .map((file) => normalizeConfigPath(relative(__dirname, file)));

function isVitestCompatibleBunTestFile(file: string): boolean {
  const source = readFileSync(resolve(__dirname, file), 'utf8');
  const sourceWithoutComments = stripCommentsForCompatibilityScan(source);
  return (
    !/\bmock\.module\b/.test(sourceWithoutComments) &&
    !/\bmock\.restore\b/.test(sourceWithoutComments) &&
    !/\bmock\s*\(/.test(sourceWithoutComments) &&
    !/\bBun\./.test(sourceWithoutComments) &&
    !/import\s*\(\s*`/.test(sourceWithoutComments) &&
    !/\bRequestInit\s*&\s*\{\s*proxy\b/.test(sourceWithoutComments)
  );
}

function stripCommentsForCompatibilityScan(source: string): string {
  const chars = source.split('');
  const scanner = createScanner(ScriptTarget.Latest, false, undefined, source);
  let token = scanner.scan();

  while (token !== SyntaxKind.EndOfFileToken) {
    if (
      token === SyntaxKind.SingleLineCommentTrivia ||
      token === SyntaxKind.MultiLineCommentTrivia
    ) {
      chars.fill(' ', scanner.getTokenPos(), scanner.getTextPos());
    }
    token = scanner.scan();
  }

  return chars.join('');
}

const bunOnlyTestFiles = bunTestFiles.filter(
  (file) => !isVitestCompatibleBunTestFile(file),
);

export const DEFAULT_TEST_INCLUDE = Object.freeze([
  'tests/**/*.test.ts',
  'tests/**/*.test.tsx',
]);

export const DESIGN_TEST_INCLUDE = Object.freeze([
  'tests/design-hermetic-env.test.ts',
  'tests/tui/components/v2/designStateSmoke.test.tsx',
]);

/** Contracts owned by separately installed AgenC repositories. */
export const CROSS_REPO_TEST_INCLUDE = Object.freeze([
  'tests/app-server-protocol/ide-extension.repo.contract.test.ts',
  'tests/app-server/protocol.contract.test.ts',
  'tests/app-server/sdk-client.contract.test.ts',
  'tests/app-server/sdk-hello-world-example.contract.test.ts',
  'tests/app-server/sdk-tui-coattach-example.contract.test.ts',
]);

/**
 * Tests that may contact a provider, browser, or chain are never discovered by
 * the default suite. `HookProgressMessage.live.parity.test.ts` deliberately
 * remains a default test: "live" describes its production-rendering source
 * inspection, not external I/O, and its name does not match `*.live.test.*`.
 */
export const DEFAULT_TEST_EXCLUDE = Object.freeze([
  ...configDefaults.exclude,
  'dist/**',
  'tests/agenc/**/*.test.ts',
  'tests/agenc/**/*.test.tsx',
  ...bunOnlyTestFiles,
  'tests/integration.test.ts',
  'tests/eval-replay.integration.test.ts',
  'tests/live/**',
  '**/*.live.test.*',
  'tests/browser/live-e2e.test.ts',
  'tests/llm/provider.integration.test.ts',
  'tests/transaction-guard/devnet-live.e2e.test.ts',
  ...DESIGN_TEST_INCLUDE,
  ...CROSS_REPO_TEST_INCLUDE,
]);

/** Explicit allowlist for credential-preserving, operator-invoked live runs. */
export const LIVE_TEST_INCLUDE = Object.freeze([
  'tests/live/**/*.test.ts',
  'tests/live/**/*.test.tsx',
  'tests/**/*.live.test.ts',
  'tests/**/*.live.test.tsx',
  'tests/browser/live-e2e.test.ts',
  'tests/llm/provider.integration.test.ts',
  'tests/transaction-guard/devnet-live.e2e.test.ts',
]);

export type AgenCVitestMode = 'default' | 'live' | 'design' | 'cross-repo';

function splitModuleId(id: string): { readonly path: string; readonly suffix: string } {
  const index = id.search(/[?#]/);
  if (index === -1) return { path: id, suffix: '' };
  return {
    path: id.slice(0, index),
    suffix: id.slice(index),
  };
}

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

function existingRuntimeTestFile(base: string): string | null {
  const hasExtension = /\.[^/\\]+$/.test(base);
  const candidates = hasExtension
    ? [
        base,
        base.replace(/\.js$/, '.ts'),
        base.replace(/\.js$/, '.tsx'),
        base.replace(/\.jsx$/, '.tsx'),
      ]
    : [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.mts`,
        `${base}.cts`,
        resolve(base, 'index.ts'),
        resolve(base, 'index.tsx'),
        resolve(base, 'index.js'),
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

function resolveMovedRuntimeTestSource(importer: string, source: string): string | null {
  if (!source.startsWith('./') && !source.startsWith('../')) return null;
  const { path: sourcePath, suffix } = splitModuleId(source);
  const cleanImporter = importer.split('?')[0] ?? importer;
  const absoluteImporter = isAbsolute(cleanImporter)
    ? cleanImporter
    : resolve(__dirname, cleanImporter);
  if (!isWithin(runtimeTestRoot, absoluteImporter)) return null;

  const directTestTarget = existingRuntimeTestFile(resolve(dirname(absoluteImporter), sourcePath));
  if (directTestTarget !== null) return null;

  const sourceImporter = resolve(
    runtimeSourceRoot,
    relative(runtimeTestRoot, absoluteImporter),
  );
  const mirrored = existingSourceFile(resolve(dirname(sourceImporter), sourcePath));
  if (mirrored !== null) return `${mirrored}${suffix}`;

  const relocated = resolveRelativeAgenCSource(sourceImporter, sourcePath);
  return relocated === null ? null : `${relocated}${suffix}`;
}

/**
 * Build a complete config for one test mode. Explicit configs are constructed
 * directly because Vitest/Vite merges arrays; merging setup-file arrays can
 * accidentally retain or remove security setup.
 */
export function createAgenCVitestConfig(mode: AgenCVitestMode = 'default') {
  const discovery = mode === 'live'
    ? {
        // Live tests deliberately preserve provider credentials and external
        // I/O opt-ins. Keep this empty and do not merge configs.
        setupFiles: [] as string[],
        include: [...LIVE_TEST_INCLUDE],
        exclude: [...configDefaults.exclude],
      }
    : mode === 'design'
      ? {
          // Design audits preserve only their dedicated inputs while stripping
          // credentials, live-provider gates, and real home state. The Node
          // process retains the JS tripwire; an explicitly requested external
          // browser is defense-in-depth hardened but is not an OS egress gate.
          setupFiles: ['./vitest.design.setup.ts'],
          include: [...DESIGN_TEST_INCLUDE],
          exclude: [...configDefaults.exclude],
        }
      : mode === 'cross-repo'
        ? {
            // These tests inspect separately checked-out AgenC repositories.
            // They retain the default credential stripping and JS tripwire,
            // but are intentionally absent from the clean-checkout gate.
            setupFiles: ['./vitest.setup.ts'],
            include: [...CROSS_REPO_TEST_INCLUDE],
            exclude: [...configDefaults.exclude],
          }
      : {
        setupFiles: ['./vitest.setup.ts'],
        include: [...DEFAULT_TEST_INCLUDE],
        exclude: [...DEFAULT_TEST_EXCLUDE],
      };

  return defineConfig({
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
          importer !== undefined
        ) {
          const movedRuntimeTestSource = resolveMovedRuntimeTestSource(importer, source);
          if (movedRuntimeTestSource !== null) return movedRuntimeTestSource;
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
        { find: 'bun:test', replacement: resolve(__dirname, 'tests/helpers/bun-test-shim.ts') },
        { find: 'bun:bundle', replacement: resolve(__dirname, 'src/build/feature.ts') },
        { find: /^src\/(.*)$/, replacement: resolve(__dirname, 'src/$1') },
      ],
    },
    test: {
      globals: false,
      environment: 'node',
      pool: 'forks',
      // Default mode strips ambient credentials/state and installs the public
      // network tripwire before test modules load. Live mode has no setup.
      ...discovery,
      testTimeout: 30000,
      deps: {
        interopDefault: true,
      },
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx,mts,cts}'],
        exclude: ['src/**/*.d.ts'],
        reporter: ['text-summary', 'json-summary', 'json'],
        reportsDirectory: 'coverage/runtime',
        thresholds: {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  });
}

export default createAgenCVitestConfig();
