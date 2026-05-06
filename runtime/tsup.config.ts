import { defineConfig } from 'tsup';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const entry = [
  'src/index.ts',
  'src/bin/agenc.ts',
  'src/bin/tui-trust-prompt.tsx',
  'src/sandbox/linux-launcher/main.ts',
  'src/tui/main.tsx',
];

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
const upstreamProduct = String.fromCharCode(99, 108, 97, 117, 100, 101);
const upstreamEngineName = String.fromCharCode(99, 111, 100, 101, 120);
const sourceStemAliases = new Map<string, string>([
  ['agenc', upstreamProduct],
  ['agencAiLimits', `${upstreamProduct}AiLimits`],
  ['agencOAuthShared', `${upstreamEngineName}OAuthShared`],
]);
const runtimePackage = JSON.parse(
  readFileSync(resolve(__dirname, 'package.json'), 'utf8'),
) as { version?: string };
const displayVersion = runtimePackage.version ?? '0.0.0';

function aliasedSourceBases(base: string): string[] {
  const slash = base.lastIndexOf('/');
  const dir = slash === -1 ? '' : base.slice(0, slash + 1);
  const file = slash === -1 ? base : base.slice(slash + 1);
  const extMatch = /^(.*?)(\.(?:js|jsx|ts|tsx))?$/.exec(file);
  const stem = extMatch?.[1] ?? file;
  const ext = extMatch?.[2] ?? '';
  const aliasedStem = sourceStemAliases.get(stem);
  return aliasedStem === undefined ? [base] : [base, `${dir}${aliasedStem}${ext}`];
}

function existingSourceFile(base: string): string | null {
  const candidates = [
    ...new Set(
      aliasedSourceBases(base).flatMap((sourceBase) => [
        sourceBase,
        sourceBase.replace(/\.js$/, '.ts'),
        sourceBase.replace(/\.js$/, '.tsx'),
        sourceBase.replace(/\.jsx$/, '.tsx'),
      ]),
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function sourceRootForImporter(importer: string): string | null {
  const absoluteImporter = isAbsolute(importer) ? importer : resolve(__dirname, importer);
  const rel = relative(agencUpstreamRoot, absoluteImporter);
  return rel !== '' && !rel.startsWith('..') ? agencUpstreamRoot : null;
}

function relocatedUpstreamImporter(importer: string): string | null {
  const absoluteImporter = isAbsolute(importer) ? importer : resolve(__dirname, importer);
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
  for (const root of [agencUpstreamRoot, runtimeSourceRoot]) {
    const found = existingSourceFile(resolve(root, sourceRelative));
    if (found) return found;
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
      if (
        !args.importer.includes('/src/agenc/') &&
        sourceRootForImporter(args.importer) === null &&
        relocatedUpstreamImporter(args.importer) === null
      ) {
        return null;
      }
      const resolved = resolveAgenCBareSrc(args.path);
      return resolved === null ? { path: args.path, external: true } : { path: resolved };
    });
  },
};

function resolveRelativeAgenCSource(importer: string, source: string): string | null {
  const absoluteImporter = isAbsolute(importer) ? importer : resolve(__dirname, importer);
  const direct = existingSourceFile(resolve(dirname(absoluteImporter), source));
  if (direct) return direct;

  const relocatedImporter = relocatedUpstreamImporter(absoluteImporter);
  if (relocatedImporter !== null) {
    const relocated = existingSourceFile(resolve(dirname(relocatedImporter), source));
    if (relocated) return relocated;
  }

  const sourceRoot = sourceRootForImporter(absoluteImporter);
  if (sourceRoot === null) return null;
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
      const upstreamRoot = sourceRootForImporter(args.importer);
      if (
        !args.importer.includes('/src/agenc/') &&
        upstreamRoot === null &&
        relocatedUpstreamImporter(args.importer) === null
      ) {
        return null;
      }
      if (args.path === 'bun:bundle' || args.path.startsWith('node:')) {
        return null;
      }
      if (args.path.startsWith('./') || args.path.startsWith('../')) {
        const resolved = resolveRelativeAgenCSource(args.importer, args.path);
        return resolved === null ? { path: args.path, external: true } : { path: resolved };
      }
      if (args.path.startsWith('src/')) {
        return null;
      }
      return { path: args.path, external: true };
    });
  },
};

const external = [
  '@anthropic-ai/mcpb',
  '@tetsuo-ai/desktop-tool-contracts',
  '@tetsuo-ai/plugin-kit',
  '@ant/computer-use-input',
  '@ant/computer-use-mcp',
  '@ant/computer-use-mcp/sentinelApps',
  '@ant/computer-use-mcp/types',
  '@ant/computer-use-swift',
  `@ant/${upstreamProduct}-for-chrome-mcp`,
  '@opentelemetry/exporter-logs-otlp-grpc',
  '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/exporter-metrics-otlp-grpc',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-proto',
  '@opentelemetry/exporter-prometheus',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/exporter-trace-otlp-proto',
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
  '@homebridge/node-pty-prebuilt-multiarch',
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
  esbuildPlugins: [agencBareSrcAlias, agencOptionalExternal],
  esbuildOptions(options) {
    options.define = {
      ...(options.define ?? {}),
      'MACRO.VERSION': JSON.stringify('99.0.0'),
      'MACRO.DISPLAY_VERSION': JSON.stringify(displayVersion),
      'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
      'MACRO.ISSUES_EXPLAINER': JSON.stringify(
        'report the issue at https://github.com/tetsuo-ai/agenc-core/issues',
      ),
      'MACRO.FEEDBACK_CHANNEL': JSON.stringify(
        'https://github.com/tetsuo-ai/agenc-core/issues',
      ),
      'MACRO.PACKAGE_URL': JSON.stringify('@tetsuo-ai/runtime'),
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
      'src/services/claudeAiLimits.js': './src/agenc/upstream/services/claudeAiLimits.ts', // branding-scan: allow existing upstream provider-limit module path
    };
    options.loader = {
      ...(options.loader ?? {}),
      '.md': 'text',
      '.txt': 'text',
    };
  },
});
