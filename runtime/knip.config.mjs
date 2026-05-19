import { readFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';

const tsconfig = parseJsonc(readFileSync('tsconfig.json', 'utf8'));
const typecheckExcludedIssueTypes = [
  'unlisted',
  'unresolved',
  'exports',
  'types',
  'duplicates',
];
const typecheckExcludedIssueIgnores = Object.fromEntries(
  (tsconfig.exclude ?? []).map((pattern) => [
    pattern,
    typecheckExcludedIssueTypes,
  ]),
);
const intentionalEntryPointIssueIgnores = {
  // Public SDK bridge: these exports are consumed by packages outside this
  // private runtime workspace, so production Knip cannot see the callers.
  'src/entrypoints/agentSdkTypes.ts': ['exports', 'types'],
  // Public SDK constant barrel; external SDK consumers use this runtime value.
  'src/entrypoints/sdk/coreTypes.ts': ['exports'],
  // Generated SDK schema roots kept for validation/generation consumers even
  // when nested helper schemas have been made file-local.
  'src/entrypoints/sdk/coreSchemas.ts': ['exports'],
  // Generated public SDK type surface, re-exported for external consumers.
  'src/entrypoints/sdk/coreTypes.generated.ts': ['types'],
  // SDK control protocol and sandbox settings types are public declaration
  // surfaces even when no production runtime file imports them directly.
  'src/entrypoints/sdk/controlTypes.ts': ['types'],
  'src/entrypoints/sandboxTypes.ts': ['types'],
};

export default {
  $schema: 'https://unpkg.com/knip@6/schema.json',
  entry: [
    'src/index.ts!',
    'src/bin/agenc.ts!',
    'src/bin/tui-trust-prompt.tsx!',
    // Type-only shim for build-time `bun:bundle` feature flags.
    'src/build/feature.ts!',
    'src/sandbox/linux-launcher/main.ts!',
    'src/tui/main.tsx!',
    'tsup.config.ts',
    'scripts/**/*.mjs',
    'tests/**/*.{test,e2e,contract,parity}.ts',
    'tests/**/*.{test,e2e,contract,parity}.tsx',
    'local-packages/*/src/**/*.{ts,tsx}',
  ],
  project: [
    'src/**/*.{ts,tsx,js,mjs,cjs}!',
    'scripts/**/*.mjs',
    'tests/**/*.{ts,tsx}',
    'tsup.config.ts',
    'local-packages/**/*.{ts,tsx,js,mjs,cjs}!',
  ],
  paths: {
    'bun:bundle': ['./src/build/feature.ts'],
    'src/*': ['./src/*'],
    'src/*.js': ['./src/*.ts', './src/*.tsx'],
    'src/*.jsx': ['./src/*.tsx'],
  },
  ignoreFiles: [
    'src/types/generated/**',
    // String-loaded fixture used by MCP client lifecycle tests.
    'src/mcp-client/test-fixtures/**',
    // String-loaded fixture used by plugin registration tests.
    'src/plugins/test-fixtures/**',
    // Required by the memory subsystem contract even though production code
    // currently reaches the memory store through narrower helpers.
    'src/memory/store.ts',
    // Service utility contract tests import these through Vitest's moved-source
    // resolver; Knip does not model that custom test resolver.
    'src/services/notifier.ts',
    // Declaration shim for the generated Message.renderers.js module.
    'src/tui/components/Message.renderers.d.ts',
    // TUI design smoke tests import these fixtures through the test resolver.
    'src/tui/components/v2/designBrowserMarkerFixture.ts',
    'src/tui/components/v2/designBrowserTextFixture.ts',
    // Shared TUI test renderer imported from many tests, not production code.
    'src/utils/staticRender.tsx',
    'src/test-parity/**',
    'tests/fixtures/**',
  ],
  ignoreIssues: {
    ...typecheckExcludedIssueIgnores,
    ...intentionalEntryPointIssueIgnores,
  },
  ignoreBinaries: [
    'findstr',
    'ip',
    'powershell.exe',
    'ps',
    'secret-tool',
    'security',
    'tasklist',
  ],
  ignoreDependencies: [
    // Path alias imports such as `src/foo.js` are resolved by tsup/tsc, but
    // Knip reports the bare alias root as a package dependency.
    'src',
    // Optional private integration loaded only when the matching MCP server is
    // configured. It is not available from the public npm registry.
    '@ant/agenc-for-chrome-mcp',
  ],
  ignoreExportsUsedInFile: {
    interface: true,
    type: true,
  },
};
