import { readFileSync } from "node:fs";
import { parse as parseJsonc } from "jsonc-parser";

const tsconfig = parseJsonc(readFileSync("tsconfig.json", "utf8"));
const typecheckExcludedIssueTypes = [
  "unlisted",
  "unresolved",
  "exports",
  "types",
  "duplicates",
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
  "src/entrypoints/agentSdkTypes.ts": ["exports", "types"],
  // Public SDK constant barrel; external SDK consumers use this runtime value.
  "src/entrypoints/sdk/coreTypes.ts": ["exports"],
  // Generated SDK schema roots kept for validation/generation consumers even
  // when nested helper schemas have been made file-local.
  "src/entrypoints/sdk/coreSchemas.ts": ["exports"],
  // Generated public SDK type surface, re-exported for external consumers.
  "src/entrypoints/sdk/coreTypes.generated.ts": ["types"],
  // SDK control protocol and sandbox settings types are public declaration
  // surfaces even when no production runtime file imports them directly.
  "src/entrypoints/sdk/controlTypes.ts": ["types"],
  "src/entrypoints/sandboxTypes.ts": ["types"],
};
const serviceTestContractExportFiles = [
  // Contract tests and service-level harnesses import these directly; the
  // production Knip graph intentionally excludes test-only callers.
  "src/services/AgentSummary/agentSummary.ts",
  "src/services/MagicDocs/magicDocs.ts",
  "src/services/MagicDocs/prompts.ts",
  "src/services/PromptSuggestion/limits.ts",
  "src/services/PromptSuggestion/speculation.ts",
  "src/services/autoDream/autoDream.ts",
  "src/services/autoFix/autoFixConfig.ts",
  "src/services/autoFix/autoFixHook.ts",
  "src/services/compact/cachedMicrocompact.ts",
  "src/services/compact/compact.ts",
  "src/services/compact/compactWarningState.ts",
  "src/services/compact/microCompact.ts",
  "src/services/compact/prompt.ts",
  "src/services/compact/sessionMemoryCompact.ts",
  "src/services/compact/snipCompact.ts",
  "src/services/compact/timeBasedMCConfig.ts",
  "src/services/contextCollapse/index.ts",
  "src/services/extractMemories/extractMemories.ts",
  "src/services/extractMemories/memory-paths.ts",
  "src/services/lsp/LSPDiagnosticRegistry.ts",
  "src/services/lsp/LSPServerInstance.ts",
  "src/services/lsp/config.ts",
  "src/services/lsp/manager.ts",
  "src/services/lsp/passiveFeedback.ts",
  "src/services/policyLimits/index.ts",
  "src/services/toolUseSummary/toolUseSummaryGenerator.ts",
];
const servicePublicContractExportFiles = [
  // Service API surfaces are consumed by runtime integration, diagnostics,
  // optional provider paths, or external/manual harnesses outside the
  // production-only Knip graph.
  "src/services/agencAiLimits.ts",
  "src/services/api/anthropic.ts",
  "src/services/api/cacheMetrics.ts",
  "src/services/api/compressToolHistory.ts",
  "src/services/api/errorUtils.ts",
  "src/services/api/errors.ts",
  "src/services/api/fetchWithProxyRetry.ts",
  "src/services/api/openAiCodeOAuthShared.ts",
  "src/services/api/openaiErrorClassification.ts",
  "src/services/api/providerConfig.ts",
  "src/services/api/sessionIngress.ts",
  "src/services/api/withRetry.ts",
  "src/services/github/deviceFlow.ts",
  "src/services/mcp/SdkControlTransport.ts",
  "src/services/mcp/auth.ts",
  "src/services/mcp/client.ts",
  "src/services/mcp/config.ts",
  "src/services/mcp/doctor.ts",
  "src/services/mcp/elicitationHandler.ts",
  "src/services/rateLimitMessages.ts",
  "src/services/tokenEstimation.ts",
  "src/services/vcr.ts",
];
const intentionalServiceIssueIgnores = {
  ...Object.fromEntries(
    serviceTestContractExportFiles.map((file) => [file, ["exports"]]),
  ),
  ...Object.fromEntries(
    servicePublicContractExportFiles.map((file) => [file, ["exports"]]),
  ),
  // MCP schema/type definitions are a public config surface shared with TUI,
  // CLI, plugin, and SDK-adjacent callers beyond production entrypoints.
  "src/services/mcp/types.ts": ["exports", "types"],
};
const toolContractExportFiles = [
  // Tool registration, schema, UI rendering, runtime, and test contract
  // surfaces. Production Knip cannot see every dynamic tool-registry consumer.
  "src/tools/AgentTool/loadAgentsDir.ts",
  "src/tools/Tool.ts",
  "src/tools/BashTool/bashPermissions.ts",
  "src/tools/BashTool/sedEditParser.ts",
  "src/tools/BashTool/utils.ts",
  "src/tools/BriefTool/BriefTool.ts",
  "src/tools/BriefTool/prompt.ts",
  "src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts",
  "src/tools/FileEditTool/UI.tsx",
  "src/tools/FileEditTool/types.ts",
  "src/tools/FileReadTool/imageProcessor.ts",
  "src/tools/FileWriteTool/FileWriteTool.ts",
  "src/tools/SendMessageTool/SendMessageTool.ts",
  "src/tools/SyntheticOutputTool/SyntheticOutputTool.ts",
  "src/tools/TeamCreateTool/TeamCreateTool.ts",
  "src/tools/TeamDeleteTool/TeamDeleteTool.ts",
  "src/tools/WebFetchTool/utils.ts",
  "src/tools/WebFetchTool/prompt.ts",
  "src/tools/WebSearchTool/WebSearchTool.ts",
  "src/tools/WebSearchTool/providers/custom.ts",
  "src/tools/WebSearchTool/providers/index.ts",
  "src/tools/WebSearchTool/providers/types.ts",
  "src/tools/apply-patch/runtime.ts",
  "src/tools/apply-patch/tool.ts",
  "src/tools/ask-user-question/tool.ts",
  "src/tools/code-mode/description.ts",
  "src/tools/code-mode/service.ts",
  "src/tools/code-mode/tools.ts",
  "src/tools/concurrency.ts",
  "src/tools/context.ts",
  "src/tools/execution.ts",
  "src/tools/hooks.ts",
  "src/tools/orchestration.ts",
  "src/tools/orchestrator.ts",
  "src/tools/router.ts",
  "src/tools/runtimes/sandboxing.ts",
  "src/tools/shared/spawnMultiAgent.ts",
  "src/tools/system/bash.ts",
  "src/tools/system/coding-common.ts",
  "src/tools/system/command-line.ts",
  "src/tools/system/file-edit.ts",
  "src/tools/system/file-read.ts",
  "src/tools/system/filesystem.ts",
  "src/tools/system/glob.ts",
  "src/tools/system/grep.ts",
  "src/tools/system/notebook-edit.ts",
  "src/tools/system/types.ts",
  "src/tools/system/worktree.ts",
  "src/tools/tasks/index.ts",
  "src/tools/types.ts",
];
const intentionalToolIssueIgnores = {
  ...Object.fromEntries(
    toolContractExportFiles.map((file) => [file, ["exports", "types"]]),
  ),
  // Prompt identity tests import these built-in prompt definitions directly.
  "src/tools/AgentTool/built-in/agencGuideAgent.ts": ["files"],
  "src/tools/AgentTool/built-in/statuslineSetup.ts": ["files"],
  "src/tools/AgentTool/built-in/verificationAgent.ts": ["files"],
  "src/tools/LSPTool/schemas.ts": ["types"],
  "src/tools/MCPTool/MCPTool.ts": ["exports", "types"],
};
const sessionContractExportFiles = [
  // Session persistence, rollout, startup, MCP, mailbox, plan-mode, and
  // review helpers are covered by session tests or consumed through dynamic
  // runtime/bootstrap paths not visible in the production-only Knip graph.
  "src/session/agenc-delegate.ts",
  "src/session/agent-task-lifecycle.ts",
  "src/session/attachment-state.ts",
  "src/session/autonomous-mode.ts",
  "src/session/bootstrap.ts",
  "src/session/cost.ts",
  "src/session/error-log.ts",
  "src/session/event-log-reducer.ts",
  "src/session/event-log.ts",
  "src/session/file-history.ts",
  "src/session/lifecycle.ts",
  "src/session/mcp-startup.ts",
  "src/session/observer-wiring.ts",
  "src/session/plan-mode.ts",
  "src/session/review.ts",
  "src/session/rollout-item.ts",
  "src/session/rollout-reconstruction.ts",
  "src/session/rollout-trace.ts",
  "src/session/run-turn.ts",
  "src/session/session-store.ts",
  "src/session/session.ts",
  "src/session/current-session.ts",
  "src/session/startup-prewarm.ts",
  "src/session/tasks.ts",
  "src/session/turn-context.ts",
];
const intentionalSessionIssueIgnores = Object.fromEntries(
  sessionContractExportFiles.map((file) => [file, ["exports", "types"]]),
);
const llmContractExportFiles = [
  // LLM provider, retry, parser, token, wire, and hook helpers are covered by
  // LLM tests or consumed by provider adapters and model registries outside
  // the production-only Knip graph.
  "src/llm/api/errors.ts",
  "src/llm/api/fallback-ladder.ts",
  "src/llm/api/retry.ts",
  "src/llm/auth/bearer.ts",
  "src/llm/capabilities.ts",
  "src/llm/context-window-upgrade.ts",
  "src/llm/errors.ts",
  "src/llm/hooks/dispatcher.ts",
  "src/llm/hooks/registry.ts",
  "src/llm/messages.ts",
  "src/llm/model-metadata.ts",
  "src/llm/oauth/refresh-loop.ts",
  "src/llm/policy.ts",
  "src/llm/provider.ts",
  "src/llm/provider-capabilities.ts",
  "src/llm/providers/grok/adapter-utils.ts",
  "src/llm/providers/grok/incremental.ts",
  "src/llm/providers/openai-compatible/index.ts",
  "src/llm/providers/openrouter/index.ts",
  "src/llm/registry/features.ts",
  "src/llm/registry/model-catalog.ts",
  "src/llm/registry/provider-info.ts",
  "src/llm/shape-request.ts",
  "src/llm/stream-parser.ts",
  "src/llm/stream-watchdog.ts",
  "src/llm/structured-output.ts",
  "src/llm/token-estimation.ts",
  "src/llm/tool-turn-validator.ts",
  "src/llm/wire/messages-anthropic.ts",
  "src/llm/wire/responses-xai.ts",
];
const intentionalLlmIssueIgnores = Object.fromEntries(
  llmContractExportFiles.map((file) => [file, ["exports", "types"]]),
);
const sandboxContractExportFiles = [
  // Sandbox hardening, network policy, linux launcher, engine, escalation, and
  // execpolicy exports are security/runtime surfaces with direct test coverage.
  "src/sandbox/engine/bwrap.ts",
  "src/sandbox/engine/index.ts",
  "src/sandbox/engine/landlock.ts",
  "src/sandbox/engine/policy-transforms.ts",
  "src/sandbox/engine/seatbelt.ts",
  "src/sandbox/escalation/approvals.ts",
  "src/sandbox/escalation/network-approval.ts",
  "src/sandbox/escalation/sandboxing.ts",
  "src/sandbox/escalation/unix-escalation.ts",
  "src/sandbox/execpolicy/decision.ts",
  "src/sandbox/execpolicy/error.ts",
  "src/sandbox/execpolicy/policy.ts",
  "src/sandbox/execpolicy/rule.ts",
  "src/sandbox/hardening/index.ts",
  "src/sandbox/linux-launcher/cli.ts",
  "src/sandbox/linux-launcher/landlock.ts",
  "src/sandbox/linux-launcher/launcher.ts",
  "src/sandbox/linux-launcher/linux-run-main.ts",
  "src/sandbox/linux-launcher/proxy-routing.ts",
  "src/sandbox/network-policy.ts",
];
const memoryContractExportFiles = [
  // Memory barrels and helpers are user/project/session memory public surfaces
  // or test-covered parsing/privacy/path contracts.
  "src/memory/age.ts",
  "src/memory/agencmd.ts",
  "src/memory/index.ts",
  "src/memory/memdir.ts",
  "src/memory/paths.ts",
  "src/memory/privacy.ts",
  "src/memory/project-memory.ts",
  "src/memory/scan.ts",
  "src/memory/session/prompts.ts",
  "src/memory/session/sessionMemory.ts",
];
const intentionalSandboxMemoryIssueIgnores = {
  ...Object.fromEntries(
    sandboxContractExportFiles.map((file) => [file, ["exports", "types"]]),
  ),
  ...Object.fromEntries(
    memoryContractExportFiles.map((file) => [file, ["exports", "types"]]),
  ),
};
const permissionContractExportFiles = [
  // Permission CLI, trust, policy, evaluator, and sandbox helpers are consumed
  // by permission tests and by runtime/TUI adapters outside this production
  // Knip graph. The cleanup tranche removes only truly local-only exports.
  "src/permissions/approval-cache.ts",
  "src/permissions/approval-policy.ts",
  "src/permissions/bash.ts",
  "src/permissions/classifier.ts",
  "src/permissions/denial-tracking.ts",
  "src/permissions/evaluator.ts",
  "src/permissions/guardian/approval-request.ts",
  "src/permissions/guardian/rejection-circuit-breaker.ts",
  "src/permissions/guardian/reviewer.ts",
  "src/permissions/mode-display.ts",
  "src/permissions/network-approval.ts",
  "src/permissions/path-validation.ts",
  "src/permissions/permission-audit-log.ts",
  "src/permissions/permission-cli.ts",
  "src/permissions/permission-mode.ts",
  "src/permissions/review-decision.ts",
  "src/permissions/rpc/mcp-tool-approval-templates.ts",
  "src/permissions/rpc/request-permissions.ts",
  "src/permissions/rules.ts",
  "src/permissions/sandbox.ts",
  "src/permissions/tool-approval.ts",
  "src/permissions/trust/project-trust.ts",
  "src/permissions/trust/TrustDialog.tsx",
  "src/permissions/types.ts",
  "src/permissions/unattended-policy.ts",
];
const commandContractExportFiles = [
  // Slash command implementations expose focused helpers for command tests and
  // dynamic command/menu wiring not visible to production-only Knip.
  "src/commands/config-menu.tsx",
  "src/commands/config.ts",
  "src/commands/diff.ts",
  "src/commands/dispatcher.ts",
  "src/commands/help.ts",
  "src/commands/mcp.ts",
  "src/commands/model.ts",
  "src/commands/permissions.ts",
  "src/commands/plan-menu.tsx",
  "src/commands/plan.ts",
  "src/commands/provider.ts",
  "src/commands/resume.ts",
  "src/commands/session-compact.ts",
  "src/commands/skills.ts",
  "src/commands/status.ts",
  "src/commands/tasks.ts",
];
const intentionalCommandPermissionIssueIgnores = {
  ...Object.fromEntries(
    permissionContractExportFiles.map((file) => [file, ["exports"]]),
  ),
  ...Object.fromEntries(
    commandContractExportFiles.map((file) => [file, ["exports"]]),
  ),
  "src/permissions/sandbox.ts": ["exports", "types"],
};
const promptContractExportFiles = [
  // Prompt assembly, project instruction, rule discovery, attachment, and
  // permission prompt surfaces are imported by tests, excluded prompt adapters,
  // or runtime prompt builders that production-only Knip does not fully see.
  "src/prompts/agenc-md.ts",
  "src/prompts/attachments/agent-mentions.ts",
  "src/prompts/attachments/auto-mode.ts",
  "src/prompts/attachments/file-mentions.ts",
  "src/prompts/attachments/plan-mode.ts",
  "src/prompts/attachments/types.ts",
  "src/prompts/attachments/user-pdf-input.ts",
  "src/prompts/attachments/verify-plan-reminder.ts",
  "src/prompts/file-mentions.ts",
  "src/prompts/permissions-prompt.ts",
  "src/prompts/project-instructions.ts",
  "src/prompts/rules/discovery.ts",
  "src/prompts/sections.ts",
  "src/prompts/system-prompt.ts",
];
const pluginContractExportFiles = [
  // Plugin manifest, marketplace, registration, directory, resolution, loader,
  // and sandbox helpers are test-backed compatibility surfaces or dynamically
  // consumed by plugin/MCP/LSP integration paths outside this Knip graph.
  "src/plugins/directories.ts",
  "src/plugins/loader.ts",
  "src/plugins/marketplace/marketplace.ts",
  "src/plugins/registration/load-plugin-commands.ts",
  "src/plugins/registration/load-plugin-hooks.ts",
  "src/plugins/registration/lsp-plugin-integration.ts",
  "src/plugins/registration/manager.ts",
  "src/plugins/registration/mcp-plugin-integration.ts",
  "src/plugins/resolution.ts",
  "src/plugins/sandbox.ts",
  "src/plugins/validation.ts",
];
const intentionalPluginPromptIssueIgnores = {
  ...Object.fromEntries(
    promptContractExportFiles.map((file) => [file, ["exports", "types"]]),
  ),
  ...Object.fromEntries(
    pluginContractExportFiles.map((file) => [file, ["exports"]]),
  ),
};
const appServerContractExportFiles = [
  // Daemon protocol, transport, realtime, agent CLI, health, auth, and
  // lifecycle helpers are exercised by contract tests and external daemon
  // clients, so production-only Knip cannot see every caller.
  "src/app-server/agent-cli.ts",
  "src/app-server/auth.ts",
  "src/app-server/background-agent-runner.ts",
  "src/app-server/client-multiplexer.ts",
  "src/app-server/daemon-autostart.ts",
  "src/app-server/daemon-cli.ts",
  "src/app-server/fuzzy-file-search.ts",
  "src/app-server/health.ts",
  "src/app-server/protocol/index.ts",
  "src/app-server/realtime-transport.ts",
  "src/app-server/session-lifecycle.ts",
  "src/app-server/transport/auth.ts",
  "src/app-server/transport/peer-credentials.ts",
  "src/app-server/transport/stdio.ts",
  "src/app-server/transport/unix-socket.ts",
  "src/app-server/transport/websocket.ts",
];
const agentContractExportFiles = [
  // Agent control, registry, role, mailbox, worktree, resume, truncation, job,
  // and spawn helpers are runtime/test contracts or consumed by excluded agent
  // adapters outside the production-only Knip graph.
  "src/agents/control.ts",
  "src/agents/fork-context.ts",
  "src/agents/jobs/csv-reader.ts",
  "src/agents/mailbox.ts",
  "src/agents/registry.ts",
  "src/agents/resume.ts",
  "src/agents/role.ts",
  "src/agents/run-agent.ts",
  "src/agents/status.ts",
  "src/agents/thread-manager.ts",
  "src/agents/thread-rollout-truncation.ts",
  "src/agents/worktree.ts",
];
const errorContractExportFiles = [
  // Runtime, SDK, provider, API, category-marker, and hint-store error
  // surfaces are shared compatibility contracts and are directly test-covered.
  "src/errors/api.ts",
  "src/errors/hints.ts",
  "src/errors/openai-compatible.ts",
  "src/errors/runtime.ts",
];
const intentionalAppAgentErrorIssueIgnores = {
  ...Object.fromEntries(
    appServerContractExportFiles.map((file) => [file, ["exports", "types"]]),
  ),
  ...Object.fromEntries(
    agentContractExportFiles.map((file) => [file, ["exports", "types"]]),
  ),
  ...Object.fromEntries(
    errorContractExportFiles.map((file) => [file, ["exports", "types"]]),
  ),
};
const binConfigTaskOnboardingContractExportFiles = [
  // CLI bootstrap ingress helpers, config schema/compatibility helpers,
  // onboarding flows, and task registry surfaces are covered by focused tests
  // or consumed through dynamic runtime paths outside this Knip graph.
  "src/bin/_deps/current-session.ts",
  "src/bin/_deps/session-ingress-auth.ts",
  "src/bin/_deps/session-storage.ts",
  "src/bin/bootstrap-services.ts",
  "src/bin/mcp-cli.ts",
  "src/bin/providers-cli.ts",
  "src/bin/slash.ts",
  "src/bin/structured-output-tool.ts",
  "src/bin/task-store.ts",
  "src/bin/tui-local-events.ts",
  "src/bin/web-fetch-preapproved.ts",
  "src/config/init.ts",
  "src/config/loader.ts",
  "src/config/profiles.ts",
  "src/config/project-init.ts",
  "src/config/resolve-model.ts",
  "src/config/resolve-provider.ts",
  "src/config/schema.ts",
  "src/onboarding/Onboarding.tsx",
  "src/onboarding/inputPaste.ts",
  "src/onboarding/pasteStore.ts",
  "src/onboarding/projectOnboardingState.ts",
  "src/onboarding/projectOnboardingSteps.ts",
  "src/onboarding/useApiKeyVerification.ts",
  "src/tasks/DreamTask/DreamTask.ts",
  "src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx",
  "src/tasks/LocalAgentTask/LocalAgentTask.tsx",
  "src/tasks/LocalMainSessionTask.ts",
  "src/tasks/LocalShellTask/LocalShellTask.tsx",
  "src/tasks/MonitorMcpTask/MonitorMcpTask.ts",
  "src/tasks/index.ts",
  "src/tasks/registry.ts",
  "src/tasks/stopTask.ts",
  "src/tasks/types.ts",
];
const intentionalBinConfigTaskOnboardingIssueIgnores = Object.fromEntries(
  binConfigTaskOnboardingContractExportFiles.map((file) => [file, ["exports"]]),
);
const conversationRecoveryStateShellContractExportFiles = [
  // Realtime, recovery, shell parser/safety, and state persistence helpers are
  // focused contract-test surfaces or dynamically consumed by session/runtime
  // flows outside the production-only Knip graph.
  "src/conversation/realtime/context.ts",
  "src/conversation/realtime/conversation.ts",
  "src/conversation/realtime/instructions/messages.ts",
  "src/conversation/realtime/prompt.ts",
  "src/conversation/realtime/webrtc/native.ts",
  "src/conversation/token-budget.ts",
  "src/recovery/api-errors.ts",
  "src/recovery/fallback-ladder.ts",
  "src/recovery/max-output-tokens.ts",
  "src/recovery/reconnection.ts",
  "src/recovery/terminal-tool-result.ts",
  "src/recovery/tombstone.ts",
  "src/recovery/triggers.ts",
  "src/shell-command/parser.ts",
  "src/shell-command/powershell-parser.ts",
  "src/shell-command/safety.ts",
  "src/state/atomic-snapshot-writes.ts",
  "src/state/backfill.ts",
  "src/state/migrations/config-migrations.ts",
  "src/state/pruning.ts",
  "src/state/sqlite-driver.ts",
  "src/state/tool-output-rotation.ts",
];
const intentionalConversationRecoveryStateShellIssueIgnores =
  Object.fromEntries(
    conversationRecoveryStateShellContractExportFiles.map((file) => [
      file,
      ["exports"],
    ]),
  );
const transactionGuardContractExportFiles = [
  // Transaction guard internals are exercised by focused contract tests while
  // production reaches only the narrower runtime entrypoints.
  "src/transaction-guard/config.ts",
  "src/transaction-guard/docket.ts",
  "src/transaction-guard/errors.ts",
  "src/transaction-guard/ollama-courtguard.ts",
];
const intentionalTransactionGuardIssueIgnores = Object.fromEntries(
  transactionGuardContractExportFiles.map((file) => [file, ["exports"]]),
);
const remainingRuntimeContractExportFiles = [
  // The final cleanup tranche leaves only daemon/client protocol, command,
  // MCP, elicitation, hook, phase, planning, skill, secret, and thread-store
  // surfaces that are public, dynamically consumed, or covered by focused
  // contract tests outside the production-only Knip graph.
  "src/app-server-client/index.ts",
  "src/app-server-protocol/index.ts",
  "src/commands.ts",
  "src/context/personality-spec-instructions.ts",
  "src/coordinator/coordinatorMode.ts",
  "src/cost/tracker.ts",
  "src/elicitation/mcp.ts",
  "src/elicitation/request-user-input.ts",
  "src/elicitation/respond.ts",
  "src/file-watcher/index.ts",
  "src/hooks/configured-hooks.ts",
  "src/hooks/engine/dispatcher.ts",
  "src/lifecycle/signal-handlers.ts",
  "src/mcp-client/resources.ts",
  "src/mcp-client/supply-chain.ts",
  "src/mcp-client/transports/stdio.ts",
  "src/mcp-client/transports/websocket.ts",
  "src/mcp-server/http-sse.ts",
  "src/mcp-server/stdio.ts",
  "src/mcp-server/tools.ts",
  "src/mcp/server/start.ts",
  "src/personality/migration.ts",
  "src/phases/_deps/tool-runtime.ts",
  "src/phases/post-sample-recovery.ts",
  "src/phases/stop-hooks.ts",
  "src/phases/stream-model.ts",
  "src/planning/exit-plan-approval.ts",
  "src/planning/plan-files.ts",
  "src/pty/loadPty.ts",
  "src/secrets/index.ts",
  "src/secrets/sanitizer.ts",
  "src/skills/local-loader.ts",
  "src/thread-store/live-thread.ts",
  "src/tools.ts",
  "src/unified-exec/process-manager.ts",
];
const remainingRuntimeContractTypeFiles = [
  "src/schemas/hooks.ts",
  "src/types/hooks.ts",
  "src/types/tools.ts",
  "src/types/permissions.ts",
];
const intentionalRemainingRuntimeIssueIgnores = {
  ...Object.fromEntries(
    remainingRuntimeContractExportFiles.map((file) => [file, ["exports"]]),
  ),
  ...Object.fromEntries(
    remainingRuntimeContractTypeFiles.map((file) => [file, ["types"]]),
  ),
};
const isProductionScan = process.argv.includes("--production");

export default {
  $schema: "https://unpkg.com/knip@6/schema.json",
  entry: [
    "src/bin/agenc.ts!",
    "src/bin/tui-trust-prompt.tsx!",
    // Type-only shim for build-time `bun:bundle` feature flags.
    "src/build/feature.ts!",
    "src/sandbox/linux-launcher/main.ts!",
    "src/tui/main.tsx!",
    "build.config.ts",
    "scripts/**/*.mjs",
    "tests/**/*.{test,e2e,contract,parity}.ts",
    "tests/**/*.{test,e2e,contract,parity}.tsx",
  ],
  project: [
    "src/**/*.{ts,tsx,js,mjs,cjs}!",
    "scripts/**/*.mjs",
    "tests/**/*.{ts,tsx}",
  ],
  paths: {
    "bun:bundle": ["./src/build/feature.ts"],
    "src/*": ["./src/*"],
    "src/*.js": ["./src/*.ts", "./src/*.tsx"],
    "src/*.jsx": ["./src/*.tsx"],
  },
  ignoreFiles: [
    "src/types/generated/**",
    // String-loaded fixture used by MCP client lifecycle tests.
    "src/mcp-client/test-fixtures/**",
    // String-loaded fixture used by plugin registration tests.
    "src/plugins/test-fixtures/**",
    // Required by the memory subsystem contract even though production code
    // currently reaches the memory store through narrower helpers.
    "src/memory/store.ts",
    // Service utility contract tests import these through Vitest's moved-source
    // resolver; Knip does not model that custom test resolver.
    "src/services/notifier.ts",
    // Declaration shim for the generated Message.renderers.js module.
    "src/tui/components/Message.renderers.d.ts",
    // TUI design smoke tests import these fixtures through the test resolver.
    "src/tui/components/v2/designBrowserMarkerFixture.ts",
    "src/tui/components/v2/designBrowserTextFixture.ts",
    ...(isProductionScan
      ? [
          // Shared TUI test renderer imported from many tests, not production code.
          "src/utils/staticRender.tsx",
        ]
      : []),
    // Vitest aliases `bun:test` to this compatibility shim.
    "tests/helpers/bun-test-shim.ts",
  ],
  ignoreIssues: {
    ...typecheckExcludedIssueIgnores,
    ...intentionalEntryPointIssueIgnores,
    ...intentionalServiceIssueIgnores,
    ...intentionalToolIssueIgnores,
    ...intentionalSessionIssueIgnores,
    ...intentionalLlmIssueIgnores,
    ...intentionalSandboxMemoryIssueIgnores,
    ...intentionalCommandPermissionIssueIgnores,
    ...intentionalPluginPromptIssueIgnores,
    ...intentionalAppAgentErrorIssueIgnores,
    ...intentionalBinConfigTaskOnboardingIssueIgnores,
    ...intentionalConversationRecoveryStateShellIssueIgnores,
    ...intentionalTransactionGuardIssueIgnores,
    ...intentionalRemainingRuntimeIssueIgnores,
  },
  ignoreBinaries: [
    "arecord",
    "cc",
    "mkfifo",
    "pdftotext",
    "powershell.exe",
    "rec",
    "rg",
    "secret-tool",
    "security",
    "taskkill",
    "tmux",
    "wslpath",
  ],
  ignoreDependencies: [
    // Optional private integration loaded only when the matching MCP server is
    // configured. It is not available from the public npm registry.
    "@ant/agenc-for-chrome-mcp",
  ],
  ignoreExportsUsedInFile: {
    interface: true,
    type: true,
  },
};
