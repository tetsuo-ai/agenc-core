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
const serviceTestContractExportFiles = [
  // Contract tests and service-level harnesses import these directly; the
  // production Knip graph intentionally excludes test-only callers.
  'src/services/AgentSummary/agentSummary.ts',
  'src/services/MagicDocs/magicDocs.ts',
  'src/services/MagicDocs/prompts.ts',
  'src/services/PromptSuggestion/limits.ts',
  'src/services/PromptSuggestion/speculation.ts',
  'src/services/autoFix/autoFixConfig.ts',
  'src/services/compact/cachedMicrocompact.ts',
  'src/services/compact/compact.ts',
  'src/services/compact/compactWarningState.ts',
  'src/services/compact/microCompact.ts',
  'src/services/compact/prompt.ts',
  'src/services/compact/sessionMemoryCompact.ts',
  'src/services/compact/snipCompact.ts',
  'src/services/compact/timeBasedMCConfig.ts',
  'src/services/contextCollapse/index.ts',
  'src/services/extractMemories/extractMemories.ts',
  'src/services/extractMemories/memory-paths.ts',
  'src/services/lsp/LSPDiagnosticRegistry.ts',
  'src/services/lsp/LSPServerInstance.ts',
  'src/services/lsp/config.ts',
  'src/services/lsp/manager.ts',
  'src/services/lsp/passiveFeedback.ts',
  'src/services/policyLimits/index.ts',
  'src/services/toolUseSummary/toolUseSummaryGenerator.ts',
];
const servicePublicContractExportFiles = [
  // Service API surfaces are consumed by runtime integration, diagnostics,
  // optional provider paths, or external/manual harnesses outside the
  // production-only Knip graph.
  'src/services/agencAiLimits.ts',
  'src/services/analytics/firstPartyEventLogger.ts',
  'src/services/analytics/index.ts',
  'src/services/api/anthropic.ts',
  'src/services/api/cacheMetrics.ts',
  'src/services/api/compressToolHistory.ts',
  'src/services/api/errorUtils.ts',
  'src/services/api/errors.ts',
  'src/services/api/fetchWithProxyRetry.ts',
  'src/services/api/openAiCodeOAuthShared.ts',
  'src/services/api/openaiErrorClassification.ts',
  'src/services/api/providerConfig.ts',
  'src/services/api/withRetry.ts',
  'src/services/github/deviceFlow.ts',
  'src/services/mcp/SdkControlTransport.ts',
  'src/services/mcp/auth.ts',
  'src/services/mcp/client.ts',
  'src/services/mcp/config.ts',
  'src/services/mcp/doctor.ts',
  'src/services/mcp/elicitationHandler.ts',
  'src/services/mcp/officialRegistry.ts',
  'src/services/rateLimitMessages.ts',
  'src/services/tokenEstimation.ts',
  'src/services/tools/toolExecution.ts',
  'src/services/vcr.ts',
];
const intentionalServiceIssueIgnores = {
  ...Object.fromEntries(
    serviceTestContractExportFiles.map((file) => [file, ['exports']]),
  ),
  ...Object.fromEntries(
    servicePublicContractExportFiles.map((file) => [file, ['exports']]),
  ),
  // MCP schema/type definitions are a public config surface shared with TUI,
  // CLI, plugin, and SDK-adjacent callers beyond production entrypoints.
  'src/services/mcp/types.ts': ['exports', 'types'],
};
const toolContractExportFiles = [
  // Tool registration, schema, UI rendering, runtime, and test contract
  // surfaces. Production Knip cannot see every dynamic tool-registry consumer.
  'src/tools/AgentTool/loadAgentsDir.ts',
  'src/tools/BashTool/bashPermissions.ts',
  'src/tools/BashTool/sedEditParser.ts',
  'src/tools/BashTool/utils.ts',
  'src/tools/BriefTool/BriefTool.ts',
  'src/tools/BriefTool/prompt.ts',
  'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts',
  'src/tools/FileEditTool/UI.tsx',
  'src/tools/FileEditTool/types.ts',
  'src/tools/FileReadTool/imageProcessor.ts',
  'src/tools/FileWriteTool/FileWriteTool.ts',
  'src/tools/SendMessageTool/SendMessageTool.ts',
  'src/tools/SyntheticOutputTool/SyntheticOutputTool.ts',
  'src/tools/TeamCreateTool/TeamCreateTool.ts',
  'src/tools/TeamDeleteTool/TeamDeleteTool.ts',
  'src/tools/WebFetchTool/utils.ts',
  'src/tools/WebSearchTool/WebSearchTool.ts',
  'src/tools/WebSearchTool/providers/custom.ts',
  'src/tools/WebSearchTool/providers/index.ts',
  'src/tools/WebSearchTool/providers/types.ts',
  'src/tools/apply-patch/runtime.ts',
  'src/tools/apply-patch/tool.ts',
  'src/tools/ask-user-question/tool.ts',
  'src/tools/code-mode/description.ts',
  'src/tools/code-mode/service.ts',
  'src/tools/code-mode/tools.ts',
  'src/tools/concurrency.ts',
  'src/tools/context.ts',
  'src/tools/execution.ts',
  'src/tools/hooks.ts',
  'src/tools/orchestration.ts',
  'src/tools/orchestrator.ts',
  'src/tools/router.ts',
  'src/tools/runtimes/sandboxing.ts',
  'src/tools/shared/spawnMultiAgent.ts',
  'src/tools/system/bash.ts',
  'src/tools/system/coding-common.ts',
  'src/tools/system/command-line.ts',
  'src/tools/system/file-edit.ts',
  'src/tools/system/file-read.ts',
  'src/tools/system/filesystem.ts',
  'src/tools/system/glob.ts',
  'src/tools/system/grep.ts',
  'src/tools/system/notebook-edit.ts',
  'src/tools/system/types.ts',
  'src/tools/system/worktree.ts',
  'src/tools/tasks/index.ts',
  'src/tools/types.ts',
];
const intentionalToolIssueIgnores = {
  ...Object.fromEntries(
    toolContractExportFiles.map((file) => [file, ['exports', 'types']]),
  ),
  // Prompt identity tests import these built-in prompt definitions directly.
  'src/tools/AgentTool/built-in/agencGuideAgent.ts': ['files'],
  'src/tools/AgentTool/built-in/statuslineSetup.ts': ['files'],
  'src/tools/AgentTool/built-in/verificationAgent.ts': ['files'],
  'src/tools/LSPTool/schemas.ts': ['types'],
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
    ...intentionalServiceIssueIgnores,
    ...intentionalToolIssueIgnores,
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
