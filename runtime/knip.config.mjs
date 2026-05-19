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
    'src/test-parity/**',
    'tests/fixtures/**',
  ],
  ignoreIssues: Object.fromEntries(
    (tsconfig.exclude ?? []).map((pattern) => [
      pattern,
      typecheckExcludedIssueTypes,
    ]),
  ),
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
