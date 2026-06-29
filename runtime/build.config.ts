import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function defineConfig<T>(config: T): T {
  return config;
}

const entry = [
  'src/index.ts',
  'src/bin/agenc.ts',
  'src/bin/tui-trust-prompt.tsx',
  'src/sandbox/linux-launcher/main.ts',
  'src/tui/main.tsx',
  'src/tui/pending-resume.ts',
];

const runtimeRoot =
  process.env.AGENC_RUNTIME_ROOT ?? dirname(fileURLToPath(import.meta.url));
const yoloClassifierPromptSourceDir = resolve(
  runtimeRoot,
  'src/utils/permissions/yolo-classifier-prompts',
);
const yoloClassifierPromptDistDir = resolve(
  runtimeRoot,
  'dist/yolo-classifier-prompts',
);
const agencRoot = resolve(runtimeRoot, 'src/agenc');
const agencUpstreamRoot = resolve(agencRoot, 'upstream');
const runtimeSourceRoot = resolve(runtimeRoot, 'src');
const copiedTreeFeatureFlags = readCopiedTreeFeatureFlags();
// Moved utils/constants still contain upstream-relative imports to sibling
// subsystems that later purge items own. These aliases let the production
// bundle resolve those imports without leaving dead external paths in dist.
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
// File-level aliases for upstream modules whose historical import paths do
// not match their current mirror location. Keep this narrow and delete entries
// as the owning purge items absorb those subsystems.
const sourceFileBaseAliases = [
  {
    runtimeBase: resolve(runtimeSourceRoot, 'Tool'),
    upstreamBase: resolve(runtimeSourceRoot, 'tools/Tool'),
  },
  {
    runtimeBase: resolve(runtimeSourceRoot, 'Task'),
    upstreamBase: resolve(runtimeSourceRoot, 'tasks/Task'),
  },
  {
    runtimeBase: resolve(runtimeSourceRoot, 'QueryEngine'),
    upstreamBase: resolve(runtimeSourceRoot, 'query/QueryEngine'),
  },
  {
    // branding-scan: allow text cursor compatibility alias
    runtimeBase: resolve(runtimeSourceRoot, 'utils/Cursor'),
    upstreamBase: resolve(runtimeSourceRoot, 'utils/TextCursor'),
  },
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
const runtimePackage = JSON.parse(
  readFileSync(resolve(runtimeRoot, 'package.json'), 'utf8'),
) as { version?: string };
const displayVersion = runtimePackage.version ?? '0.0.0';
const publicPackageName = '@tetsuo-ai/agenc';

function copyYoloClassifierPrompts(): void {
  if (!existsSync(yoloClassifierPromptSourceDir)) return;
  mkdirSync(yoloClassifierPromptDistDir, { recursive: true });
  cpSync(yoloClassifierPromptSourceDir, yoloClassifierPromptDistDir, {
    recursive: true,
  });
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

function isWithin(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sourceRootForImporter(importer: string): string | null {
  const absoluteImporter = isAbsolute(importer) ? importer : resolve(runtimeRoot, importer);
  if (isWithin(agencUpstreamRoot, absoluteImporter)) return agencUpstreamRoot;
  const relocatedRoot = relocatedTuiSourceRoots.find((root) =>
    isWithin(root, absoluteImporter),
  );
  return relocatedRoot ?? null;
}

function relocatedUpstreamImporter(importer: string): string | null {
  const absoluteImporter = isAbsolute(importer) ? importer : resolve(runtimeRoot, importer);
  for (const { runtimeRoot, upstreamRoot } of relocatedUpstreamRoots) {
    const rel = relative(runtimeRoot, absoluteImporter);
    if (rel !== '' && !rel.startsWith('..')) {
      return resolve(upstreamRoot, rel);
    }
  }
  return null;
}

function shouldUseAgenCResolution(importer: string): boolean {
  return (
    importer.includes('/src/agenc/') ||
    sourceRootForImporter(importer) !== null ||
    relocatedUpstreamImporter(importer) !== null
  );
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

function readCopiedTreeFeatureFlags(): ReadonlyMap<string, boolean> {
  const featureSource = readFileSync(
    resolve(runtimeSourceRoot, 'build/feature.ts'),
    'utf8',
  );
  const flags = new Map<string, boolean>();
  for (const match of featureSource.matchAll(/\b([A-Z][A-Z0-9_]*)\s*:\s*(true|false)\s*,/g)) {
    flags.set(match[1], match[2] === 'true');
  }
  if (flags.size === 0) {
    throw new Error('Unable to read copied tree feature flags for build DCE');
  }
  return flags;
}

function featureFlagLiteral(flag: string): 'true' | 'false' {
  return copiedTreeFeatureFlags.get(flag) === true ? 'true' : 'false';
}

function inlineCopiedTreeFeatureCalls(source: string): string {
  return source.replace(
    /\bfeature\(\s*(['"])([A-Z][A-Z0-9_]*)\1\s*,?\s*\)/g,
    (_match, _quote, flag: string) => featureFlagLiteral(flag),
  );
}

function loaderForSourcePath(file: string): 'ts' | 'tsx' | 'js' | 'jsx' | null {
  switch (extname(file)) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.jsx':
      return 'jsx';
    default:
      return null;
  }
}

const agencFeatureFlagInline = {
  name: 'agenc-feature-flag-inline',
  setup(build: {
    onLoad: (
      options: { filter: RegExp },
      callback: (args: { path: string }) => { contents: string; loader: 'ts' | 'tsx' | 'js' | 'jsx' } | null,
    ) => void;
  }) {
    build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, (args) => {
      if (!isWithin(runtimeSourceRoot, args.path)) return null;
      const loader = loaderForSourcePath(args.path);
      if (loader === null) return null;
      const source = readFileSync(args.path, 'utf8');
      const inlined = inlineCopiedTreeFeatureCalls(source);
      if (inlined === source) return null;
      return { contents: inlined, loader };
    });
  },
};

const agencRuntimeAssets = {
  name: 'agenc-runtime-assets',
  setup(build: {
    onEnd: (callback: () => void) => void;
  }) {
    build.onEnd(() => {
      copyYoloClassifierPrompts();
    });
  },
};

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
      const relRuntime = normalizeRuntimePath(relative(runtimeRoot, absolute));
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

const agencBareSrcAlias = {
  name: 'agenc-bare-src-alias',
  setup(build: {
    onResolve: (
      options: { filter: RegExp },
      callback: (args: { path: string; importer: string }) => { path: string; external?: boolean } | null,
    ) => void;
  }) {
    build.onResolve({ filter: /^src\// }, (args) => {
      const resolved = resolveAgenCBareSrc(args.path);
      if (resolved !== null) return { path: resolved };
      return null;
    });
  },
};

function resolveRelativeAgenCSource(importer: string, source: string): string | null {
  const absoluteImporter = isAbsolute(importer) ? importer : resolve(runtimeRoot, importer);
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

const agencOptionalExternal = {
  name: 'agenc-optional-external',
  setup(build: {
    onResolve: (
      options: { filter: RegExp },
      callback: (args: { path: string; importer: string }) => { path: string; external?: boolean } | null,
    ) => void;
  }) {
    build.onResolve({ filter: /^(?:[^./]|\.{1,2}\/)/ }, (args) => {
      if (!shouldUseAgenCResolution(args.importer)) {
        return null;
      }
      if (args.path === 'bun:bundle' || args.path.startsWith('node:')) {
        return null;
      }
      if (args.path.startsWith('./') || args.path.startsWith('../')) {
        const resolved = resolveRelativeAgenCSource(args.importer, args.path);
        if (resolved !== null) return { path: resolved };
        return isKnownMissingOptionalModule(args.path)
          ? { path: args.path, external: true }
          : null;
      }
      if (args.path.startsWith('src/')) {
        return null;
      }
      return { path: args.path, external: true };
    });
  },
};

function isKnownMissingOptionalModule(source: string): boolean {
  return source === '@mendable/firecrawl-js';
}

const agencKnownMissingOptionalExternal = {
  name: 'agenc-known-missing-optional-external',
  setup(build: {
    onResolve: (
      options: { filter: RegExp },
      callback: (args: { path: string; importer: string }) => { path: string; external?: boolean } | null,
    ) => void;
  }) {
    build.onResolve({ filter: /^(?:@mendable\/firecrawl-js|[^./]|\.{1,2}\/)/ }, (args) => {
      return isKnownMissingOptionalModule(args.path)
        ? { path: args.path, external: true }
        : null;
    });
  },
};

export const __agencBuildConfigTest = {
  featureFlagLiteral,
  inlineCopiedTreeFeatureCalls,
  isKnownMissingOptionalModule,
  publicPackageName,
  relocatedTuiSourceRoots,
  relocatedUpstreamRoots,
  resolveAgenCBareSrc,
  resolveRelativeAgenCSource,
  shouldUseAgenCResolution,
  sourceFileBaseAliases,
  sourceRootForImporter,
} as const;

const external = [
  '@anthropic-ai/mcpb',
  '@tetsuo-ai/desktop-tool-contracts',
  '@tetsuo-ai/plugin-kit',
  '@ant/computer-use-input',
  '@ant/computer-use-mcp',
  '@ant/computer-use-mcp/sentinelApps',
  '@ant/computer-use-mcp/types',
  '@ant/computer-use-swift',
  '@ant/claude-for-chrome-mcp', // branding-scan: allow real external package name
  'asciichart',
  'audio-capture-napi',
  'cross-spawn',
  'execa',
  'openai',
  'ollama',
  'better-sqlite3',
  'ioredis',
  'ws',
  'grammy',
  'discord.js',
  '@whiskeysockets/baileys',
  'matrix-js-sdk',
  'cheerio',
  'playwright',
  'edge-tts',
  '@modelcontextprotocol/sdk',
  'node-pty',
  '@anthropic-ai/bedrock-sdk',
  '@aws-sdk/client-bedrock',
  '@aws-sdk/client-bedrock-runtime',
  '@aws-sdk/client-sts',
  '@smithy/core',
  '@smithy/node-http-handler',
  'axios',
  'fflate',
  'google-auth-library',
  'semver',
  'sharp',
  'yaml',
  '@mendable/firecrawl-js',
  // Keep the TUI renderer stack on one runtime React singleton. The moved-source
  // resolver externalizes some TUI React imports; bundling the reconciler or
  // hook helpers alongside them creates split dispatchers and invalid hook calls.
  'react',
  'react-compiler-runtime',
  'react-reconciler',
  'scheduler',
  'usehooks-ts',
];

export default defineConfig({
  entry,
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'node',
  target: 'es2022',
  sourcemap: true,
  external,
  noExternal: ['supports-hyperlinks'],
  esbuildPlugins: [
    agencFeatureFlagInline,
    agencBareSrcAlias,
    agencOptionalExternal,
    agencKnownMissingOptionalExternal,
    agencRuntimeAssets,
  ],
  esbuildOptions(options) {
    options.define = {
      ...(options.define ?? {}),
      'MACRO.VERSION': JSON.stringify(displayVersion),
      'MACRO.DISPLAY_VERSION': JSON.stringify(displayVersion),
      'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
      'MACRO.ISSUES_EXPLAINER': JSON.stringify(
        'report the issue at https://github.com/tetsuo-ai/agenc-core/issues',
      ),
      'MACRO.FEEDBACK_CHANNEL': JSON.stringify(
        'https://github.com/tetsuo-ai/agenc-core/issues',
      ),
      'MACRO.PACKAGE_URL': JSON.stringify(publicPackageName),
      'MACRO.NATIVE_PACKAGE_URL': 'undefined',
      'MACRO.VERSION_CHANGELOG': 'undefined',
    };
    options.banner = {
      ...(options.banner ?? {}),
      js: [
        'import { createRequire as __agencCreateRequire } from "node:module";',
        'const require = __agencCreateRequire(import.meta.url);',
      ].join('\n'),
    };
    options.alias = {
      ...(options.alias ?? {}),
      'bun:bundle': './src/build/feature.ts',
    };
    options.loader = {
      ...(options.loader ?? {}),
      '.md': 'text',
      '.txt': 'text',
    };
    options.jsx = 'automatic';
  },
});
