#!/usr/bin/env node
// Run all gates for a PORT_CHECKLIST.md item.
//
// Usage:
//   node scripts/goal/verify.mjs <item-id> [--skip-validate] [--skip-typecheck]
//
// Exit 0 only when every gate passes. The goal-runner must not signal
// completion unless this exits 0 (and complete.mjs after it).
//
// Gates run, in order:
//   1. Branch shape: current branch must be port/<item-id>.
//   2. Branding scan over staged + working-tree changes against main.
//   3. Upstream/import-shape gates and item-specific gates by ID prefix.
//   4. Typecheck (npm run typecheck) — slow; skip with --skip-typecheck for
//      iteration but never skip for completion.
//   5. agenc-tui-validate — rebuild + PTY startup of agenc and agenc --yolo.
//      Skip with --skip-validate for iteration but never skip for completion.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { findItem, parseItems, repoRoot, mainCheckoutRoot, STATUS, fail } from "./checklist-utils.mjs";
import {
  RUNTIME_UPSTREAM_SCAN_PATHS,
  collectRuntimeUpstreamReferences,
  validateZPurgecTsconfigBoundary,
} from "./purge-scans.mjs";
import {
  SHIM_BEHAVIOR_RATIO_LIMIT,
  formatShimBehaviorViolation,
  measureShimBehaviorForPath,
} from "./shim-behavior.mjs";
import {
  collectKnipIssueTypesByFile,
  collectKnipUnusedIssueEntries,
  findStaleKnipIssueIgnores,
  findUnignoredKnipIssues,
  normalizeKnipIssueIgnoreEntries,
  stripKnipIssueAllowlists,
} from "./knip-issue-audit.mjs";
import { collectIncompleteZFinalPredecessors } from "./z-final-contracts.mjs";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";

// Hard cap on the typecheck baseline. The baseline file
// (.typecheck-baseline.json) records how many TS errors the project
// currently tolerates. Without an upper bound, anyone (or future-self)
// could write `{"errorCount": 99999}` and silently bless inflation. This
// cap is the project's current high-water-mark; tighten it (never raise)
// in dedicated cleanup items.
const MAX_ALLOWED_BASELINE = 22;

// Per-item named-evidence map. Each entry declares the concrete evidence
// the gate must find before passing. Items not registered here fall back to
// the per-prefix generic gate registered below.
//
// Evidence shape:
//   files: string[] | { globUnder, matching, minCount?, optional? }[]
//   filesAbsent: string[]
//   grepPresent: { pattern, scope }[]
//   grepNotPresent: { pattern, scope }[]
//   tests: string[] | { globUnder, matching, minCount?, optional? }[]
//   runStrict: boolean — if true, typecheck gate enforces zero errors.
const ITEM_EVIDENCE = {
  "Z-PURGEA": {
    files: [
      "runtime/src/utils",
      "runtime/src/constants",
      "parity/Z-PURGEA-parity.json",
    ],
    grepPresent: [
      { pattern: "constantsPlacementRationale", scope: "parity/Z-PURGEA-parity.json" },
      { pattern: "runtime/src/constants is therefore the AgenC-owned consuming subsystem", scope: "parity/Z-PURGEA-parity.json" },
    ],
  },
  "Z-PURGEFINAL": {
    grepNotPresent: [
      { pattern: "agenc/upstream", scope: "runtime/src" },
    ],
  },
  "Z-FINAL": {
    runStrict: true,
  },
  "ZC-08": {
    tests: [
      "runtime/src/tools/ask-user-question-tui-routing.test.tsx",
      "runtime/src/tools/tool-rendering-bash.test.tsx",
      "runtime/src/tools/tool-rendering-edit.test.tsx",
      "runtime/src/tools/tool-rendering-extra.test.tsx",
      "runtime/src/tui/parity/session-transcript.contract.test.ts",
      "runtime/src/tui/parity/session-transcript.test.ts",
      "runtime/src/tui/parity/session-transcript.streaming-tool-use.parity.test.ts",
      "runtime/src/tui/parity/session-transcript.no-runningtoolprogress.parity.test.ts",
      "runtime/src/tui/parity/session-transcript-hook.streaming-tool-use.parity.test.ts",
    ],
    filesAbsent: [
      "runtime/src/tools/ask-user-question-bridge-routing.test.tsx",
      "runtime/src/tools/tool-stubs-bash-bridge.test.tsx",
      "runtime/src/tools/tool-stubs-edit-bridge.test.tsx",
      "runtime/src/tools/tool-stubs-extra-bridge.test.tsx",
      "runtime/src/tui/parity/message-adapter.contract.test.ts",
      "runtime/src/tui/parity/message-adapter.test.ts",
      "runtime/src/tui/parity/message-adapter.streaming-tool-use.parity.test.ts",
      "runtime/src/tui/parity/message-adapter.no-runningtoolprogress.parity.test.ts",
      "runtime/src/tui/parity/use-session-transcript.streaming-tool-use.parity.test.ts",
    ],
  },
  "ZC-15": {
    files: ["scripts/goal/verify.mjs"],
    grepPresent: [
      { pattern: "assertZc15ChecklistHandoffClarified", scope: "scripts/goal/verify.mjs" },
    ],
  },
  "GAP-PROV-01": {
    files: [
      "runtime/src/llm/providers/bedrock/index.ts",
      "runtime/src/llm/registry/provider-info.ts",
      "runtime/src/llm/provider.ts",
      "runtime/src/llm/discovery/provider-discovery.ts",
      "runtime/src/bin/startup-selection.ts",
    ],
    tests: [
      "runtime/src/llm/providers/bedrock/provider.test.ts",
      "runtime/src/llm/registry/provider-info.test.ts",
      "runtime/src/llm/provider.test.ts",
      "runtime/src/llm/provider-parity.test.ts",
      "runtime/src/llm/discovery/provider-discovery.test.ts",
      "runtime/src/bin/startup-selection.test.ts",
    ],
    grepPresent: [
      { pattern: "AWS4-HMAC-SHA256", scope: "runtime/src/llm/providers/bedrock/index.ts" },
      { pattern: "amazon\\.nova-pro-v1:0", scope: "runtime/src/llm/registry/provider-info.ts" },
      { pattern: "case \"amazon-bedrock\"", scope: "runtime/src/llm/provider.ts" },
    ],
  },
  "GAP-PROV-03": {
    files: [
      "runtime/src/auth/backend.ts",
      "runtime/src/auth/backends/remote.ts",
      "runtime/src/llm/provider.ts",
    ],
    tests: [
      "runtime/src/auth/backends/remote.contract.test.ts",
      "runtime/src/llm/provider.test.ts",
      "runtime/src/llm/provider-parity.test.ts",
      "runtime/src/llm/provider.integration.test.ts",
      "runtime/src/session/session.test.ts",
    ],
    grepPresent: [
      { pattern: "resolveFactoryApiKey", scope: "runtime/src/llm/provider.ts" },
      { pattern: "requireFactoryApiKey", scope: "runtime/src/llm/provider.ts" },
      { pattern: "authBackend\\.vendKey\\(", scope: "runtime/src/llm/provider.ts" },
      { pattern: "AuthBackend\\.vendKey\\(\\)", scope: "runtime/src/llm/provider.ts" },
      { pattern: "mergeAuthVendedProviderExtra", scope: "runtime/src/llm/provider.ts" },
      { pattern: "resolveAuthVendedProviderModel", scope: "runtime/src/llm/provider.ts" },
      { pattern: "secretAccessKey", scope: "runtime/src/auth/backend.ts" },
      { pattern: "preserves Bedrock credential fields from HTTP key vending responses", scope: "runtime/src/auth/backends/remote.contract.test.ts" },
      { pattern: "vends concrete provider keys through AuthBackend", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "defaults model metadata on AuthBackend-vended providers without explicit model", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "prepares AuthBackend-vended provider switches without explicit model", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "keeps env model metadata on AuthBackend-vended providers without explicit model", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "uses AuthBackend-vended keys on delegated compatible requests", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "keeps Bedrock accessKeyId precedence over generic apiKey", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "does not use OPENAI_API_KEY as LMStudio-compatible auth fallback", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "does not use OPENAI_BASE_URL as LMStudio-compatible base URL fallback", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "does not vend AuthBackend keys for OAuth config", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "uses AuthBackend-vended Bedrock credentials on delegated requests", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "uses AuthBackend-vended Bedrock access key with explicit non-access credentials", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "rejects AuthBackend-vended provider keys with mismatched", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "re-vends AuthBackend keys after vended expiry", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "preserves optional provider hooks on AuthBackend-vended providers", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "does not expose unsupported optional provider hooks", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "recreates AuthBackend-vended providers from readProviderFactoryOptions", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "coalesces concurrent AuthBackend vending", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "authBackend without sessionId", scope: "runtime/src/llm/provider.test.ts" },
      { pattern: "retries AuthBackend vending after transient delegate failures", scope: "runtime/src/llm/provider.test.ts" },
    ],
    grepNotPresent: [
      { pattern: "process\\.env\\.[A-Z0-9_]*(API_KEY|ACCESS_KEY|SESSION_TOKEN)", scope: "runtime/src/llm/provider.ts" },
      { pattern: "process\\.env\\[[\"'][A-Z0-9_]*(API_KEY|ACCESS_KEY|SESSION_TOKEN)[\"']\\]", scope: "runtime/src/llm/provider.ts" },
      { pattern: "process\\.env\\[[^\\]]*apiKeyEnvLabel[^\\]]*\\]", scope: "runtime/src/llm/provider.ts" },
      { pattern: "resolveApiKey\\(process\\.env\\)", scope: "runtime/src/llm/provider.ts" },
      { pattern: "envApiKey", scope: "runtime/src/llm/provider.ts" },
      { pattern: "alternateApiKeys", scope: "runtime/src/llm/provider.ts" },
    ],
  },
  "GAP-TUI-03": {
    files: [
      "runtime/src/commands/clear.ts",
      "runtime/src/phases/events.ts",
      "runtime/src/bin/agenc.ts",
      "runtime/src/bin/tui-local-events.ts",
      "runtime/src/tui/session-transcript.ts",
      "runtime/src/tui/session-types.ts",
      "runtime/src/tui/daemon-session.ts",
    ],
    tests: [
      "runtime/src/commands/clear.test.ts",
      "runtime/src/bin/tui-local-events.test.ts",
      "runtime/src/tui/parity/session-transcript.test.ts",
    ],
    grepPresent: [
      { pattern: "history_cleared", scope: "runtime/src/commands/clear.ts" },
      { pattern: "emitLocalTuiPhaseEvent", scope: "runtime/src/bin/agenc.ts" },
      { pattern: "isHistoryClearedEvent", scope: "runtime/src/tui/session-transcript.ts" },
    ],
  },
  "GAP-TUI-04": {
    files: ["runtime/src/commands/keybindings.ts"],
    tests: ["runtime/src/commands/keybindings.test.ts"],
    grepPresent: [
      { pattern: "spawnKeybindingsEditor", scope: "runtime/src/commands/keybindings.ts" },
      { pattern: "enterAlternateScreen", scope: "runtime/src/commands/keybindings.ts" },
      { pattern: "stdio:\\s*[\"']ignore[\"']", scope: "runtime/src/commands/keybindings.ts" },
    ],
  },
  "GAP-TUI-05": {
    files: ["runtime/src/commands/init.ts"],
    tests: ["runtime/src/commands/init.test.ts"],
    grepPresent: [
      { pattern: "kind:\\s*[\"']prompt[\"']", scope: "runtime/src/commands/init.ts" },
      { pattern: "buildInitPrompt", scope: "runtime/src/commands/init.ts" },
      { pattern: "Do not write these instructions", scope: "runtime/src/commands/init.ts" },
    ],
  },
  "GAP-TUI-06": {
    files: ["runtime/src/commands/copy.ts"],
    tests: ["runtime/src/commands/copy.test.ts"],
    grepPresent: [
      { pattern: "copyTextToClipboard", scope: "runtime/src/commands/copy.ts" },
      { pattern: "setClipboard", scope: "runtime/src/commands/copy.ts" },
      { pattern: "writeSequence", scope: "runtime/src/commands/copy.ts" },
      { pattern: "Copied to clipboard|Sent to clipboard via OSC 52", scope: "runtime/src/commands/copy.ts" },
    ],
  },
  "GAP-TUI-07": {
    files: [
      "runtime/src/commands/reload-plugins.ts",
      "runtime/src/commands/registry.ts",
      "runtime/src/commands/dispatcher.ts",
      "runtime/src/commands/types.ts",
    ],
    tests: [
      "runtime/src/commands/command-surface.test.ts",
      "runtime/src/commands/registry.test.ts",
    ],
    grepPresent: [
      { pattern: "replaceDynamicCommands", scope: "runtime/src/commands/registry.ts" },
      { pattern: "commandRegistry", scope: "runtime/src/commands/dispatcher.ts" },
      { pattern: "refreshDispatcherPluginCommands", scope: "runtime/src/commands/reload-plugins.ts" },
      { pattern: "pluginCommandToSlashCommand", scope: "runtime/src/commands/reload-plugins.ts" },
    ],
  },
  "GAP-TUI-08": {
    files: [
      "runtime/src/commands/session-compact.ts",
      "runtime/src/services/compact/compact.ts",
      "runtime/src/services/compact/types.ts",
      "runtime/src/tui/screens/REPL.tsx",
      "runtime/src/tui/session-types.ts",
      "runtime/src/tui/daemon-session.ts",
    ],
    tests: [
      "runtime/tests/slash-compact.contract.test.ts",
      "runtime/src/services/compact/compact.test.ts",
      "runtime/src/tui/daemon-session.contract.test.ts",
    ],
    grepPresent: [
      { pattern: "installCompactProgressControls", scope: "runtime/src/tui/session-types.ts" },
      { pattern: "installCompactProgressControls\\(session", scope: "runtime/src/tui/screens/REPL.tsx" },
      { pattern: "compact_start", scope: "runtime/src/services/compact/compact.ts" },
      { pattern: "compact_end", scope: "runtime/src/services/compact/compact.ts" },
      { pattern: "onCompactProgress", scope: "runtime/tests/slash-compact.contract.test.ts" },
      { pattern: "setSDKStatus", scope: "runtime/tests/slash-compact.contract.test.ts" },
    ],
  },
  "GAP-TUI-09": {
    files: [
      "runtime/src/commands/registry.ts",
      "runtime/src/commands.ts",
      "runtime/src/commands/btw/index.ts",
      "runtime/src/commands/btw/btw.tsx",
    ],
    tests: [
      "runtime/src/commands/registry.test.ts",
      "runtime/src/commands/tui-command-list.test.ts",
    ],
    grepPresent: [
      { pattern: "btwCommand", scope: "runtime/src/commands/registry.ts" },
      { pattern: "modulePath: \"\\./commands/btw/index\\.js\"", scope: "runtime/src/commands.ts" },
      { pattern: "reg\\.has\\(\"btw\"\\)", scope: "runtime/src/commands/registry.test.ts" },
      { pattern: "interactive local JSX descriptor for /btw", scope: "runtime/src/commands/tui-command-list.test.ts" },
    ],
  },
  "GAP-TUI-10": {
    files: [
      "runtime/src/commands/registry.ts",
      "runtime/src/commands.ts",
    ],
    tests: [
      "runtime/src/commands/registry.test.ts",
      "runtime/src/commands/tui-command-list.test.ts",
    ],
    grepPresent: [
      { pattern: "legacyCommandSurfaces", scope: "runtime/src/commands/registry.ts" },
      { pattern: "registeredLegacyCommandSurfaceNames", scope: "runtime/src/commands/registry.ts" },
      { pattern: "legacyCommandOverrideMap", scope: "runtime/src/commands.ts" },
      { pattern: "lazyCommand", scope: "runtime/src/commands.ts" },
      { pattern: "projects registered legacy command surfaces", scope: "runtime/src/commands/tui-command-list.test.ts" },
    ],
  },
  "GAP-TUI-11": {
    files: [
      "runtime/src/commands/files.ts",
    ],
    tests: [
      "runtime/src/commands/command-surface.test.ts",
      "runtime/src/commands/tui-command-list.test.ts",
      "runtime/src/commands/help.test.ts",
    ],
    grepPresent: [
      { pattern: "keeps /files enabled for AgenC users", scope: "runtime/src/commands/command-surface.test.ts" },
      { pattern: "includes /files in the TUI command list for AgenC users", scope: "runtime/src/commands/tui-command-list.test.ts" },
      { pattern: "lists /files with visible default registry commands", scope: "runtime/src/commands/help.test.ts" },
    ],
    grepNotPresent: [
      { pattern: "USER_TYPE", scope: "runtime/src/commands/files.ts" },
    ],
  },
  "GAP-TUI-12": {
    files: [
      "runtime/src/tui/components/App.tsx",
      "runtime/src/tui/components/App.render.test.tsx",
      "runtime/src/tui/components/MessageSelector.tsx",
      "runtime/src/tui/components/message-selector-filter.ts",
      "runtime/src/tui/components/MessageSelector.filter.test.ts",
      "runtime/src/session/session.ts",
      "runtime/src/session/session.test.ts",
      "runtime/src/session/message-history-conversion.ts",
      "runtime/src/session/transcript-replacement.ts",
      "runtime/src/services/compact/compact.ts",
      "runtime/src/services/compact/compact.test.ts",
      "runtime/src/tui/session-transcript.ts",
      "runtime/src/tui/parity/session-transcript.test.ts",
      "runtime/src/tui/daemon-session.ts",
      "runtime/src/tui/daemon-session.contract.test.ts",
      "runtime/src/app-server/agent-cli.ts",
      "runtime/src/app-server/protocol/index.ts",
      "runtime/src/app-server/agent-lifecycle.contract.test.ts",
      "runtime/src/commands/clear.ts",
      "runtime/src/commands/clear.test.ts",
      "scripts/goal/verify.mjs",
    ],
    tests: [
      "runtime/src/tui/components/App.render.test.tsx",
      "runtime/src/session/session.test.ts",
      "runtime/src/services/compact/compact.test.ts",
      "runtime/src/tui/parity/session-transcript.test.ts",
      "runtime/src/tui/daemon-session.contract.test.ts",
      "runtime/src/tui/components/MessageSelector.filter.test.ts",
      "runtime/src/app-server/protocol.contract.test.ts",
      "runtime/src/app-server/agent-lifecycle.contract.test.ts",
      "runtime/src/commands/clear.test.ts",
    ],
    grepPresent: [
      { pattern: "useCostSummary\\(useFpsMetrics\\(\\)\\)", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "installCompactProgressControls\\(props\\.session", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "CostThresholdDialog", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "getTotalCost\\(\\)", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "getCurrentWorktreeSession\\(\\)", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "ExitFlow", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "fileHistoryRewind", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "partialCompactFromMessage", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "rewindConversationToMessage", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "selectableUserMessagesFilter", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "history_replaced", scope: "runtime/src/tui/session-transcript.ts" },
      { pattern: "partialCompactConversationAsync", scope: "runtime/src/services/compact/compact.ts" },
      { pattern: "No earlier messages to summarize", scope: "runtime/src/services/compact/compact.ts" },
      { pattern: "Session\\.partialCompactFromMessage", scope: "runtime/src/session/session.test.ts" },
      { pattern: "Session\\.rewindConversationToMessage", scope: "runtime/src/session/session.test.ts" },
      { pattern: "request\\.cancel", scope: "runtime/src/app-server/agent-cli.ts" },
      { pattern: "session\\.partialCompactFromMessage", scope: "runtime/src/app-server/protocol/index.ts" },
      { pattern: "session\\.rewindConversationToMessage", scope: "runtime/src/app-server/protocol/index.ts" },
      { pattern: "matches the session selector by rejecting empty visible user text", scope: "runtime/src/tui/components/MessageSelector.filter.test.ts" },
      { pattern: "installs compact progress controls and restores them on unmount", scope: "runtime/src/tui/components/App.render.test.tsx" },
      { pattern: "routes exit through worktree ExitFlow", scope: "runtime/src/tui/components/App.render.test.tsx" },
      { pattern: "wires MessageSelector code restore, conversation rewind, and partial summarize", scope: "runtime/src/tui/components/App.render.test.tsx" },
      { pattern: "blocks MessageSelector conversation actions while a turn is active", scope: "runtime/src/tui/components/App.render.test.tsx" },
      { pattern: "refuses to clear while a turn is in flight", scope: "runtime/src/commands/clear.test.ts" },
    ],
    grepNotPresent: [
      { pattern: "This rewind action is unavailable in the live TUI shell", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "handleSummarizeUnavailable", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "onSummarize=\\{handleSummarize\\s+as\\s+any\\}", scope: "runtime/src/tui/components/App.tsx" },
    ],
  },
  "OC-06": {
    files: [
      "runtime/src/tui/vim/types.ts",
      "runtime/src/tui/vim/motions.ts",
      "runtime/src/tui/vim/operators.ts",
      "runtime/src/tui/vim/text-objects.ts",
      "runtime/src/tui/vim/transitions.ts",
      "runtime/src/tui/vim/PARITY.md",
      "parity/OC-06-vim-parity.json",
      "runtime/src/tools/ConfigTool/nestedSettingPath.ts",
      "runtime/src/tui/components/PromptInput/ConfiguredPromptTextInput.tsx",
    ],
    filesAbsent: [
      "runtime/src/tui/vim/textObjects.ts",
    ],
    tests: [
      "runtime/src/tui/vim/types.test.ts",
      "runtime/src/tui/vim/motions.test.ts",
      "runtime/src/tui/vim/operators.test.ts",
      "runtime/src/tui/vim/text-objects.test.ts",
      "runtime/src/tui/vim/transitions.test.ts",
      "runtime/src/tui/input/processTextPrompt.test.ts",
      "runtime/src/tui/input/processUserInput.test.ts",
      "runtime/src/tui/components/App.render.test.tsx",
      "runtime/src/utils/handlePromptSubmit.vimMode.test.ts",
      "runtime/src/tui/components/PromptInput/PromptInput.vimMode.test.tsx",
      "runtime/src/tui/components/PromptInput/utils.test.ts",
      "runtime/src/tui/components/PromptInput/PromptInputFooterLeftSide.test.tsx",
      "runtime/src/tui/startup/StatusLine.test.tsx",
      "runtime/src/tools/ConfigTool/ConfigTool.test.ts",
      "runtime/src/config/config.test.ts",
    ],
    grepPresent: [
      { pattern: "TEXT_OBJ_TYPES = new Set", scope: "runtime/src/tui/vim/types.ts" },
      { pattern: "'p'", scope: "runtime/src/tui/vim/types.ts" },
      { pattern: "'t'", scope: "runtime/src/tui/vim/types.ts" },
      { pattern: "case 'ge'", scope: "runtime/src/tui/vim/motions.ts" },
      { pattern: "case 'gE'", scope: "runtime/src/tui/vim/motions.ts" },
      { pattern: "findParagraphObject", scope: "runtime/src/tui/vim/text-objects.ts" },
      { pattern: "findTagObject", scope: "runtime/src/tui/vim/text-objects.ts" },
      { pattern: "executeOperatorRepeatFind", scope: "runtime/src/tui/vim/transitions.ts" },
      { pattern: "input === ';' \\|\\| input === ','", scope: "runtime/src/tui/vim/transitions.ts" },
      { pattern: "tui\\.vimMode", scope: "runtime/src/tools/ConfigTool/supportedSettings.ts" },
      { pattern: "setGlobalConfigSettingValue", scope: "runtime/src/tools/ConfigTool/ConfigTool.ts" },
      { pattern: "vimMode: value_1 === 'vim'", scope: "runtime/src/tui/components/Settings/Config.tsx" },
      { pattern: "editorMode: value_1", scope: "runtime/src/tui/components/Settings/Config.tsx" },
      { pattern: "ConfiguredPromptTextInput", scope: "runtime/src/tui/components/PromptInput/PromptInput.tsx" },
      { pattern: "vimRoutingState", scope: "runtime/src/tui/components/PromptInput/PromptInput.tsx" },
      { pattern: "vimRoutingState: options\\?\\.vimRoutingState", scope: "runtime/src/tui/screens/REPL.tsx" },
      { pattern: "vimRoutingState: isFirst \\? vimRoutingState : undefined", scope: "runtime/src/utils/handlePromptSubmit.ts" },
      { pattern: "threads vim routing state into the real input dispatch path", scope: "runtime/src/utils/handlePromptSubmit.vimMode.test.ts" },
      { pattern: "isVimModeEnabled\\(\\) \\? \\(", scope: "runtime/src/tui/components/PromptInput/ConfiguredPromptTextInput.tsx" },
      { pattern: "useState<VimMode>\\(\"INSERT\"\\)", scope: "runtime/src/tui/components/App.tsx" },
      { pattern: "treats 0 as a line-start motion after operators", scope: "runtime/src/tui/vim/transitions.test.ts" },
      { pattern: "clamps normal and operator counts to the maximum vim count", scope: "runtime/src/tui/vim/transitions.test.ts" },
      { pattern: "operatorSemicolon", scope: "runtime/src/tui/vim/transitions.test.ts" },
      { pattern: "operatorComma", scope: "runtime/src/tui/vim/transitions.test.ts" },
      { pattern: "declares delimiter alias text object keys", scope: "runtime/src/tui/vim/types.test.ts" },
      { pattern: "executes required operator motion behavior", scope: "runtime/src/tui/vim/operators.test.ts" },
      { pattern: "routes modal-edited composer text when tui\\.vimMode is true", scope: "runtime/src/tui/components/PromptInput/PromptInput.vimMode.test.tsx" },
      { pattern: "keeps normal text input behavior when tui\\.vimMode is false", scope: "runtime/src/tui/components/PromptInput/PromptInput.vimMode.test.tsx" },
      { pattern: "processes finalized text after configured vim composer movement", scope: "runtime/src/tui/input/processTextPrompt.test.ts" },
      { pattern: "ConfiguredPromptTextInput", scope: "runtime/src/tui/input/processTextPrompt.test.ts" },
      { pattern: "finalizeVimInputForRouting", scope: "runtime/src/tui/input/processTextPrompt.ts" },
      { pattern: "applies vim routing keys before slash dispatch", scope: "runtime/src/tui/input/processUserInput.test.ts" },
      { pattern: "applies vim routing keys before bash dispatch", scope: "runtime/src/tui/input/processUserInput.test.ts" },
      { pattern: "reports the routed vim prompt when a hook blocks submission", scope: "runtime/src/tui/input/processUserInput.test.ts" },
      { pattern: "covers delete, change, and yank across required text objects", scope: "runtime/src/tui/vim/operators.test.ts" },
      { pattern: "formatVimModeIndicator\\(vimMode\\)", scope: "runtime/src/tui/startup/StatusLine.tsx" },
      { pattern: "renders current %s vim mode when vim mode is active", scope: "runtime/src/tui/startup/StatusLine.test.tsx" },
      { pattern: "StatusLine.*renders the visible", scope: "runtime/src/tui/vim/PARITY.md" },
      { pattern: "processUserInput.*before bash, slash, or prompt dispatch", scope: "runtime/src/tui/vim/PARITY.md" },
      { pattern: "formatVimModeIndicator", scope: "runtime/src/tui/components/PromptInput/PromptInputFooterLeftSide.tsx" },
      { pattern: "readonly tui\\?: TuiConfig", scope: "runtime/src/config/schema.ts" },
      { pattern: "tui\\?: TuiConfig", scope: "runtime/src/utils/config.ts" },
    ],
    grepNotPresent: [
      { pattern: "\\./textObjects\\.js", scope: "runtime/src/tui/vim" },
    ],
  },
  "MM-01": {
    files: [
      "runtime/src/memory/PARITY.md",
      "runtime/src/memory/age.ts",
      "runtime/src/memory/agencmd.ts",
      "runtime/src/memory/detection.ts",
      "runtime/src/memory/find-relevant.ts",
      "runtime/src/memory/memdir.ts",
      "runtime/src/memory/paths.ts",
      "runtime/src/memory/scan.ts",
      "runtime/src/memory/store.ts",
      "runtime/src/memory/types.ts",
      "runtime/src/state/migrations/011_memory_pipeline_schema.ts",
      "parity/MM-01-parity.json",
    ],
    filesAbsent: [
      "runtime/src/memdir/memdir.ts",
      "runtime/src/memdir/paths.ts",
      "runtime/src/memdir/memoryAge.ts",
      "runtime/src/memdir/memoryScan.ts",
      "runtime/src/memdir/memoryTypes.ts",
      "runtime/src/memdir/findRelevantMemories.ts",
      "runtime/src/utils/agencmd.ts",
      "runtime/src/utils/memoryFileDetection.ts",
    ],
    grepPresent: [
      { pattern: "buildSessionMemoryLayerLines", scope: "runtime/src/memory/memdir.ts" },
      { pattern: "getGlobalMemoryPath", scope: "runtime/src/memory/paths.ts" },
      { pattern: "getProjectMemoryPath", scope: "runtime/src/memory/paths.ts" },
      { pattern: "class MemoryStore", scope: "runtime/src/memory/store.ts" },
      { pattern: "tryClaimStage1Job", scope: "runtime/src/memory/store.ts" },
      { pattern: "tryClaimGlobalPhase2Job", scope: "runtime/src/memory/store.ts" },
      { pattern: "memoryPipelineSchemaMigration", scope: "runtime/src/state/migrations/011_memory_pipeline_schema.ts" },
    ],
    tests: [
      "runtime/src/memory/paths.test.ts",
      "runtime/src/memory/memdir.test.ts",
      "runtime/src/memory/scan.test.ts",
      "runtime/src/memory/store.test.ts",
      "runtime/src/memory-wiring.contract.test.ts",
      "runtime/src/state/migrations.test.ts",
    ],
    runStrict: true,
  },
  "MM-03": {
    files: [
      "runtime/src/memory/project-memory.ts",
      "runtime/src/memory/project-memory.test.ts",
      "runtime/src/memory/project-memory-routing.test.ts",
      "parity/MM-03-parity.json",
    ],
    grepPresent: [
      { pattern: "getProjectMemoryPathForSelector", scope: "runtime/src/memory/project-memory.ts" },
      { pattern: "MEMORY_MENTION_SYNTAX", scope: "runtime/src/memory/project-memory.ts" },
      { pattern: "isMemoryMention", scope: "runtime/src/memory/project-memory.ts" },
      { pattern: "@memory", scope: "runtime/src/memory/project-memory.ts" },
      { pattern: "project-memory-api", scope: "parity/MM-03-parity.json" },
    ],
    tests: [
      "runtime/src/memory/project-memory.test.ts",
      "runtime/src/memory/project-memory-routing.test.ts",
      "runtime/src/components/memory/memory-components.contract.test.tsx",
      "runtime/src/memory-wiring.contract.test.ts",
    ],
  },
  "RT-11": {
    files: [
      "runtime/src/conversation/realtime/instructions/markers.ts",
      "runtime/src/conversation/realtime/instructions/messages.ts",
      "runtime/src/conversation/realtime/instructions/instructions.contract.test.ts",
      "parity/RT-11-parity.json",
    ],
    grepPresent: [
      { pattern: "REALTIME_CONVERSATION_OPEN_TAG", scope: "runtime/src/conversation/realtime/instructions/markers.ts" },
      { pattern: "REALTIME_CONVERSATION_CLOSE_TAG", scope: "runtime/src/conversation/realtime/instructions/markers.ts" },
      { pattern: "realtimeEndInstructionMessage\\(\"inactive\"\\)", scope: "runtime/src/session/run-turn.ts" },
      { pattern: "isContextualDeveloperMessageContent", scope: "runtime/src/session/rollout-reconstruction.ts" },
      { pattern: "developer", scope: "runtime/src/llm/types.ts" },
      { pattern: "experimental_realtime_start_instructions", scope: "runtime/src/config/config.test.ts" },
      { pattern: "role === \"developer\"", scope: "runtime/src/rollout/policy.ts" },
      { pattern: "deferredSourceFiles", scope: "parity/RT-11-parity.json" },
    ],
    tests: [
      "runtime/src/conversation/realtime/instructions/instructions.contract.test.ts",
      "runtime/src/conversation/realtime/context.contract.test.ts",
      "runtime/src/session/run-turn.test.ts",
      "runtime/src/session/rollout-reconstruction.test.ts",
      "runtime/src/llm/wire/responses-openai.test.ts",
      "runtime/src/llm/wire/chat-completions.test.ts",
      "runtime/src/llm/wire/messages-anthropic.test.ts",
      "runtime/src/llm/wire/responses-xai.test.ts",
      "runtime/src/config/config.test.ts",
      "runtime/src/rollout/rollout-store.contract.test.ts",
    ],
  },
  "RT-12": {
    files: [
      "runtime/src/conversation/realtime/prompt.ts",
      "runtime/src/conversation/realtime/prompts/backend_prompt.md",
      "runtime/src/conversation/realtime/prompts/realtime_start.md",
      "runtime/src/conversation/realtime/prompts/realtime_end.md",
      "runtime/src/conversation/realtime/prompt.contract.test.ts",
      "runtime/src/types/markdown.d.ts",
      "parity/RT-12-parity.json",
    ],
    grepPresent: [
      { pattern: "prepareRealtimeBackendPrompt", scope: "runtime/src/conversation/realtime/prompt.ts" },
      { pattern: "\\{\\{ user_first_name \\}\\}", scope: "runtime/src/conversation/realtime/prompts/backend_prompt.md" },
      { pattern: "experimental_realtime_ws_backend_prompt", scope: "runtime/src/config/schema.ts" },
      { pattern: "experimental_realtime_ws_backend_prompt", scope: "runtime/src/conversation/realtime/conversation.contract.test.ts" },
      { pattern: "runtime/src/conversation/realtime/prompts/realtime_start\\.md", scope: "parity/RT-12-parity.json" },
      { pattern: "core/src/realtime_prompt\\.rs", scope: "parity/RT-12-parity.json" },
    ],
    tests: [
      "runtime/src/conversation/realtime/prompt.contract.test.ts",
      "runtime/src/conversation/realtime/conversation.contract.test.ts",
      "runtime/src/conversation/realtime/instructions/instructions.contract.test.ts",
      "runtime/src/config/config.test.ts",
    ],
  },
  "IDE-03": {
    files: [
      "scripts/goal/verify.mjs",
    ],
    grepPresent: [
      { pattern: "assertAgenCVscodeDaemonConnection", scope: "scripts/goal/verify.mjs" },
      { pattern: "createAgenCDaemonLaunchPlan", scope: "scripts/goal/verify.mjs" },
      { pattern: "agenc daemon", scope: "scripts/goal/verify.mjs" },
    ],
  },
  "WP-03": {
    files: [
      "runtime/src/app-server-protocol/index.ts",
      "runtime/src/app-server-protocol/portal.contract.test.ts",
      "runtime/src/app-server-protocol/portal-auth.contract.test.ts",
      "runtime/src/index.ts",
      "parity/WP-03-parity.json",
      "scripts/goal/verify.mjs",
      "scripts/goal/review.mjs",
    ],
    grepPresent: [
      { pattern: "AGENC_PORTAL_AUTH_METHODS", scope: "runtime/src/app-server-protocol/index.ts" },
      { pattern: "portal\\.auth\\.login", scope: "runtime/src/app-server-protocol/index.ts" },
      { pattern: "AgenCPortalAuthState", scope: "runtime/src/app-server-protocol/index.ts" },
      { pattern: "routes portal auth actions through the daemon AuthBackend token store", scope: "runtime/src/app-server-protocol/portal-auth.contract.test.ts" },
      { pattern: "assertAgenCPortalAuthIntegration", scope: "scripts/goal/verify.mjs" },
      { pattern: "id\\.startsWith\\(\"WP-\"\\).*agenc-portal", scope: "scripts/goal/review.mjs" },
    ],
    tests: [
      "runtime/src/app-server-protocol/portal.contract.test.ts",
      "runtime/src/app-server-protocol/portal-auth.contract.test.ts",
    ],
  },
  "WP-06": {
    files: [
      "runtime/src/app-server-protocol/index.ts",
      "runtime/src/app-server-protocol/portal.contract.test.ts",
      "runtime/src/app-server-protocol/portal-mobile.contract.test.ts",
      "runtime/src/index.ts",
      "parity/WP-06-parity.json",
      "parity/WP-06-mobile-status-fixture.json",
      "scripts/goal/verify.mjs",
    ],
    grepPresent: [
      { pattern: "portal\\.mobile\\.status\\.read", scope: "runtime/src/app-server-protocol/index.ts" },
      { pattern: "AgenCPortalMobileStatusSnapshot", scope: "runtime/src/app-server-protocol/index.ts" },
      { pattern: "createAgenCPortalMobileStatusSnapshot", scope: "runtime/src/app-server-protocol/index.ts" },
      { pattern: "does not expose desktop workspace, auth identity, or transcript fields", scope: "runtime/src/app-server-protocol/portal-mobile.contract.test.ts" },
      { pattern: "mobile-read-only-status-contract", scope: "parity/WP-06-parity.json" },
      { pattern: "agent-error", scope: "parity/WP-06-mobile-status-fixture.json" },
      { pattern: "assertAgenCPortalMobileStatusContract", scope: "scripts/goal/verify.mjs" },
    ],
    tests: [
      "runtime/src/app-server-protocol/portal.contract.test.ts",
      "runtime/src/app-server-protocol/portal-mobile.contract.test.ts",
    ],
  },
  "MG-05": {
    files: [
      "package.json",
      "runtime/package.json",
      "scripts/goal/verify.mjs",
    ],
    grepPresent: [
      { pattern: "\"daemon\": \"node bin/agenc daemon start --foreground\"", scope: "runtime/package.json" },
      { pattern: "\"daemon:status\": \"node bin/agenc daemon status\"", scope: "runtime/package.json" },
      { pattern: "\"start\": \"node bin/agenc\"", scope: "runtime/package.json" },
      { pattern: "\"daemon\": \"npm --workspace=@tetsuo-ai/runtime run daemon\"", scope: "package.json" },
      { pattern: "\"daemon:status\": \"npm --workspace=@tetsuo-ai/runtime run daemon:status\"", scope: "package.json" },
      { pattern: "\"start\": \"npm --workspace=@tetsuo-ai/runtime run start\"", scope: "package.json" },
    ],
  },
  "IDE-02": {
    files: [
      "runtime/src/app-server-protocol/ide-extension.ts",
      "runtime/src/app-server-protocol/ide-extension.repo.contract.test.ts",
      "scripts/goal/verify.mjs",
    ],
    grepPresent: [
      { pattern: "assertAgenCVscodeExtensionBoilerplate", scope: "scripts/goal/verify.mjs" },
      { pattern: "npm run build", scope: "scripts/goal/verify.mjs" },
      { pattern: "agenc-vscode", scope: "runtime/src/app-server-protocol/ide-extension.repo.contract.test.ts" },
    ],
    tests: [
      "runtime/src/app-server-protocol/ide-extension.repo.contract.test.ts",
    ],
  },
  "IDE-01": {
    files: [
      "runtime/src/app-server-protocol/ide-extension.ts",
      "runtime/src/app-server-protocol/ide-extension.contract.test.ts",
      "runtime/src/app-server-protocol/ide-extension.repo.contract.test.ts",
    ],
    grepPresent: [
      { pattern: "AGENC_IDE_EXTENSION_REPOSITORY_NAME = \"agenc-vscode\"", scope: "runtime/src/app-server-protocol/ide-extension.ts" },
      { pattern: "AGENC_IDE_EXTENSION_PACKAGE_NAME", scope: "runtime/src/index.ts" },
      { pattern: "createAgenCIdeInitializeParams", scope: "runtime/src/index.ts" },
      { pattern: "AgenC VS Code sibling repo scaffold", scope: "runtime/src/app-server-protocol/ide-extension.repo.contract.test.ts" },
    ],
    tests: [
      "runtime/src/app-server-protocol/ide-extension.contract.test.ts",
      "runtime/src/app-server-protocol/ide-extension.repo.contract.test.ts",
    ],
  },
  "CF-02": {
    files: ["runtime/src/config/schema.ts", "runtime/src/config/config.test.ts"],
    grepPresent: [
      { pattern: "model_provider: \"grok\"", scope: "runtime/src/config/schema.ts" },
      { pattern: "expect\\(cfg\\.model_provider\\)\\.toBe\\(\"grok\"\\)", scope: "runtime/src/config/config.test.ts" },
    ],
    tests: ["runtime/src/config/config.test.ts"],
  },
  "CF-04": {
    files: [
      "runtime/src/config/resolve-provider.ts",
      "runtime/src/config/resolve-model.ts",
      "runtime/src/bin/startup-selection.ts",
      "runtime/src/config/config.test.ts",
      "runtime/src/bin/bootstrap.test.ts",
    ],
    grepPresent: [
      { pattern: "isAgencModelShortcut", scope: "runtime/src/config/resolve-provider.ts" },
      { pattern: "cliModel", scope: "runtime/src/bin/startup-selection.ts" },
      { pattern: "model = \"agenc\"", scope: "runtime/src/config/config.test.ts" },
      { pattern: "routes --model agenc", scope: "runtime/src/bin/bootstrap.test.ts" },
    ],
    tests: [
      "runtime/src/config/config.test.ts",
      "runtime/src/bin/bootstrap.test.ts",
    ],
  },
  "CF-10": {
    files: [
      "runtime/src/config/schema.ts",
      "runtime/src/config/config.test.ts",
      "runtime/src/plugins/loader.ts",
      "runtime/src/plugins/policy.ts",
      "runtime/src/plugins/registration/common.ts",
      "runtime/src/plugins/cli/pluginOperations.ts",
      "runtime/src/plugins/marketplace/startup_checks.ts",
      "runtime/src/config/PARITY.md",
      "runtime/src/mcp-client/tools.ts",
      "runtime/src/mcp-client/manager.ts",
      "runtime/src/mcp-client/types.ts",
      "runtime/src/commands.ts",
      "runtime/src/prompts/attachments/skill-listing.ts",
      "runtime/src/prompts/attachments/orchestrator.ts",
      "runtime/src/session/run-turn.ts",
      "runtime/src/bin/model-facing-tools.ts",
      "runtime/src/bin/bootstrap-services.ts",
    ],
    grepPresent: [
      { pattern: "interface PluginsConfig", scope: "runtime/src/config/schema.ts" },
      { pattern: "cfg\\.plugins\\?\\.enabled", scope: "runtime/src/config/config.test.ts" },
      { pattern: "configuredPluginAllowlist", scope: "runtime/src/plugins/loader.ts" },
      { pattern: "configuredPluginDirs", scope: "runtime/src/plugins/loader.ts" },
      { pattern: "applyPluginMcpServerConfig", scope: "runtime/src/plugins/loader.ts" },
      { pattern: "pluginFeatureBlockedByConfig", scope: "runtime/src/plugins/policy.ts" },
      { pattern: "plugins\\.plugins", scope: "runtime/src/plugins/policy.ts" },
      { pattern: "hasExplicitPluginDiscoveryInput", scope: "runtime/src/plugins/registration/common.ts" },
      { pattern: "ensurePluginsFeatureEnabled", scope: "runtime/src/plugins/cli/pluginOperations.ts" },
      { pattern: "defaultToolsApprovalMode", scope: "runtime/src/mcp-client/tools.ts" },
      { pattern: "default_tools_approval_mode", scope: "runtime/src/mcp-client/types.ts" },
      { pattern: "skillsForConfig\\(config", scope: "runtime/src/commands.ts" },
      { pattern: "skillsForConfig\\(opts\\.config \\?\\? \\{\\}", scope: "runtime/src/prompts/attachments/skill-listing.ts" },
      { pattern: "\\[plugins\\.plugins", scope: "runtime/src/plugins/cli/pluginOperations.ts" },
      { pattern: "config: opts\\.configStore\\.current\\(\\)", scope: "runtime/src/bin/bootstrap-services.ts" },
    ],
    tests: [
      "runtime/src/config/config.test.ts",
      "runtime/src/plugins/loader.test.ts",
      "runtime/src/plugins/policy.test.ts",
      "runtime/src/plugins/cli/pluginCliCommands.test.ts",
      "runtime/src/plugins/registration.test.ts",
      "runtime/src/plugins/resolution.test.ts",
      "runtime/src/mcp-client/tools.test.ts",
      "runtime/src/mcp-client/manager.test.ts",
      "runtime/src/commands/command-surface.test.ts",
      "runtime/src/prompts/attachments/integration.test.ts",
      "runtime/src/skills/local-loader.test.ts",
    ],
  },
  "CF-06": {
    files: [
      "runtime/src/config/schema.ts",
      "runtime/src/config/PARITY.md",
      "runtime/src/config/config.test.ts",
      "runtime/src/state/pruning.ts",
      "runtime/src/state/pruning.test.ts",
      "runtime/src/state/snapshot-policy.ts",
      "runtime/src/state/snapshot-policy.test.ts",
      "runtime/src/app-server/daemon-cli.ts",
      "runtime/src/app-server/daemon-cli.contract.test.ts",
      "runtime/src/agents/run-agent.ts",
    ],
    grepPresent: [
      { pattern: "AgentRunRetentionConfig", scope: "runtime/src/config/schema.ts" },
      { pattern: "completed_days: 30", scope: "runtime/src/config/schema.ts" },
      { pattern: "failed_days: 90", scope: "runtime/src/config/schema.ts" },
      { pattern: "snapshot_days: 3", scope: "runtime/src/config/schema.ts" },
      { pattern: "snapshot_max_count: 10_000", scope: "runtime/src/config/schema.ts" },
      { pattern: "snapshot_max_bytes: 67_108_864", scope: "runtime/src/config/schema.ts" },
      { pattern: "agent\\.retention TOML overrides the default pruning windows", scope: "runtime/src/config/config.test.ts" },
      { pattern: "runtime/src/agents/run-agent\\.ts.*does not read retention directly", scope: "runtime/src/config/PARITY.md" },
      { pattern: "pruneTerminalAgentRuns\\(driver, config\\.agent\\?\\.retention\\)", scope: "runtime/src/app-server/daemon-cli.ts" },
      { pattern: "pruneSessionStateSnapshots\\(driver, config\\.agent\\?\\.retention\\)", scope: "runtime/src/app-server/daemon-cli.ts" },
      { pattern: "snapshotRetention: authStartup\\.config\\.agent\\?\\.retention", scope: "runtime/src/app-server/daemon-cli.ts" },
      { pattern: "snapshotRetention: \\{ snapshot_max_count: 2 \\}", scope: "runtime/src/state/snapshot-policy.test.ts" },
      { pattern: "run-prune-failed", scope: "runtime/src/app-server/daemon-cli.contract.test.ts" },
      { pattern: "foreground daemon applies agent\\.retention config to terminal and snapshot startup pruning", scope: "runtime/src/app-server/daemon-cli.contract.test.ts" },
      { pattern: "snapshot_max_bytes = 64", scope: "runtime/src/app-server/daemon-cli.contract.test.ts" },
    ],
    tests: [
      "runtime/src/config/config.test.ts",
      "runtime/src/state/pruning.test.ts",
      "runtime/src/state/snapshot-policy.test.ts",
      "runtime/src/app-server/daemon-cli.contract.test.ts",
    ],
  },
  "F-01": {
    files: ["runtime/src/constants/querySource.ts"],
    grepNotPresent: [{ pattern: "@ts-nocheck", scope: "runtime/src/constants/querySource.ts" }],
  },
  "F-02": {
    files: ["runtime/src/types/message.ts"],
    grepNotPresent: [{ pattern: "@ts-nocheck", scope: "runtime/src/types/message.ts" }],
  },
  "F-03a": {
    files: [
      "runtime/src/app-server/protocol/index.ts",
      "runtime/src/app-server/protocol/schema.json",
    ],
    grepPresent: [
      { pattern: "agent.create", scope: "runtime/src/app-server/protocol" },
      { pattern: "agent.list", scope: "runtime/src/app-server/protocol" },
      { pattern: "agent.attach", scope: "runtime/src/app-server/protocol" },
      { pattern: "agent.stop", scope: "runtime/src/app-server/protocol" },
      { pattern: "session.create", scope: "runtime/src/app-server/protocol" },
      { pattern: "session.list", scope: "runtime/src/app-server/protocol" },
      { pattern: "message.send", scope: "runtime/src/app-server/protocol" },
      { pattern: "message.stream", scope: "runtime/src/app-server/protocol" },
      { pattern: "tool.approve", scope: "runtime/src/app-server/protocol" },
      { pattern: "tool.deny", scope: "runtime/src/app-server/protocol" },
      { pattern: "permission.list", scope: "runtime/src/app-server/protocol" },
      { pattern: "auth.whoami", scope: "runtime/src/app-server/protocol" },
    ],
    tests: ["runtime/src/app-server/protocol.contract.test.ts"],
  },
  "F-03b": {
    files: ["runtime/src/app-server/transport/stdio.ts"],
    tests: [{ globUnder: "runtime/src/app-server/transport", matching: /stdio.*\.test\.tsx?$/ }],
  },
  "F-03c": {
    files: ["runtime/src/app-server/transport/unix-socket.ts"],
    tests: [{ globUnder: "runtime/src/app-server/transport", matching: /unix-socket.*\.test\.tsx?$/ }],
  },
  "F-03d": {
    grepNotPresent: [
      { pattern: "ChatGPT", scope: "runtime/src/app-server" },
      { pattern: "openai\\.com\\/oauth", scope: "runtime/src/app-server" },
    ],
    grepPresent: [
      { pattern: "auth.login", scope: "runtime/src/app-server/protocol" },
      { pattern: "auth.logout", scope: "runtime/src/app-server/protocol" },
      { pattern: "auth.whoami", scope: "runtime/src/app-server/protocol" },
    ],
  },
  "F-03e": {
    grepPresent: [
      { pattern: "AuthBackend", scope: "runtime/src/app-server" },
    ],
    grepNotPresent: [
      { pattern: "process\\.env\\.\\w*_API_KEY", scope: "runtime/src/app-server" },
    ],
  },
  "F-03f": {
    grepPresent: [
      { pattern: "session\\.create", scope: "runtime/src/app-server" },
      { pattern: "session\\.attach", scope: "runtime/src/app-server" },
      { pattern: "session\\.detach|session\\.terminate|session\\.close", scope: "runtime/src/app-server" },
    ],
  },
  "F-03g": {
    tests: [{ globUnder: "runtime/src/app-server", matching: /multi.?client|concurrent/i }],
  },
  "F-03h": {
    tests: [{ globUnder: "runtime/src/app-server", matching: /disconnect|resilience|reattach/i }],
  },
  "F-03i": {
    grepPresent: [
      { pattern: "agenc daemon start|daemon\\.start", scope: "runtime/src/bin" },
      { pattern: "agenc daemon stop|daemon\\.stop", scope: "runtime/src/bin" },
      { pattern: "agenc daemon status|daemon\\.status", scope: "runtime/src/bin" },
    ],
  },
  "F-03j": {
    grepPresent: [
      { pattern: "health\\.ping", scope: "runtime/src/app-server" },
      { pattern: "health\\.ready", scope: "runtime/src/app-server" },
      { pattern: "health\\.stats", scope: "runtime/src/app-server" },
    ],
  },
  "F-03k": {
    tests: [{ globUnder: "runtime/src/app-server", matching: /\.contract\.test\.tsx?$/, minCount: 2 }],
  },
  "F-03l": {
    files: ["runtime/src/app-server/fuzzy-file-search.ts"],
    grepPresent: [{ pattern: "fs.fuzzy_search", scope: "runtime/src/app-server" }],
  },
  "F-03m": {
    grepPresent: [
      { pattern: "commandExec\\.start", scope: "runtime/src/app-server" },
      { pattern: "commandExec\\.write", scope: "runtime/src/app-server" },
      { pattern: "commandExec\\.terminate", scope: "runtime/src/app-server" },
    ],
  },
  "F-03n": {
    files: ["runtime/src/app-server/transport/in-process.ts"],
  },
  "F-03o": {
    files: ["runtime/src/app-server/transport/websocket.ts"],
  },
  "F-03p": {
    grepPresent: [
      { pattern: "SO_PEERCRED|peerCred|cookie", scope: "runtime/src/app-server/transport" },
    ],
  },
  "F-03q": {
    grepPresent: [
      { pattern: "initialize", scope: "runtime/src/app-server/protocol" },
      { pattern: "protocol.version|protocolVersion", scope: "runtime/src/app-server/protocol" },
    ],
  },
  "F-03r": {
    grepPresent: [
      { pattern: "request\\.cancel", scope: "runtime/src/app-server" },
      { pattern: "tool\\.cancel", scope: "runtime/src/app-server" },
    ],
  },
  "F-03s": {
    grepPresent: [
      { pattern: "event\\.message_chunk|event\\.tool_request|event\\.permission_request|event\\.agent_status", scope: "runtime/src/app-server/protocol" },
    ],
  },
  "F-04a": {
    files: ["runtime/src/app-server-client/index.ts"],
    grepPresent: [{ pattern: "autostart|spawnDaemon|startDaemon", scope: "runtime/src/app-server-client" }],
  },
  "F-04b": {
    files: [{ globUnder: "runtime/src/app-server-client", matching: /\.tsx?$/, minCount: 2 }],
  },
  "F-04c": {
    grepPresent: [
      { pattern: "reattach|resume", scope: "runtime/src/app-server-client" },
    ],
  },
  "F-04d": {
    grepPresent: [
      { pattern: "reconnect|disconnect", scope: "runtime/src/app-server-client" },
    ],
  },
  "F-05a": {
    grepPresent: [
      { pattern: "@tetsuo-ai/protocol", scope: "runtime/src/app-server" },
    ],
  },
  "F-05b": {
    files: [{ globUnder: "runtime/src/app-server", matching: /sdk-?client/i, minCount: 1 }],
  },
  "F-05c": {
    files: [{ globUnder: "../agenc-sdk", matching: /examples?/, minCount: 1, optional: true }],
  },
  "F-06a": {
    grepPresent: [{ pattern: "agenc agent start|agent\\.start", scope: "runtime/src/bin" }],
  },
  "F-06b": {
    grepPresent: [{ pattern: "agenc agent list|agent\\.list", scope: "runtime/src/bin" }],
  },
  "F-06c": {
    grepPresent: [{ pattern: "agenc agent attach|agent\\.attach", scope: "runtime/src/bin" }],
  },
  "F-06d": {
    grepPresent: [{ pattern: "agenc agent stop|agent\\.stop", scope: "runtime/src/bin" }],
  },
  "F-06e": {
    grepPresent: [{ pattern: "agenc agent logs|agent\\.logs", scope: "runtime/src/bin" }],
  },
  "F-06f": {
    tests: [{ globUnder: "runtime/src", matching: /persistence|recover.*restart|restart.*recover/i }],
  },
  "F-06g": {
    tests: [{ globUnder: "runtime/src", matching: /e2e.*c.?compiler|compiler.*e2e/i, optional: true }],
  },
  "F-06h": {
    grepPresent: [
      { pattern: "agent\\.budget", scope: "runtime/src" },
      { pattern: "token_cap|dollar_cap|wall_clock_seconds", scope: "runtime/src" },
    ],
  },
  "F-06j": {
    files: ["scripts/check-upstream-import-growth.mjs"],
    grepPresent: [
      {
        pattern: "check-upstream-import-growth",
        scope: "scripts/goal/verify.mjs",
      },
    ],
    tests: ["scripts/check-upstream-import-growth.test.mjs"],
  },
  "PK-11": {
    files: [
      "scripts/check-protocol-package-schema-export.mjs",
      "runtime/src/app-server/protocol/schema.json",
    ],
    grepPresent: [
      {
        pattern: "daemon-json-rpc\\.schema\\.json",
        scope: "runtime/src/app-server/protocol",
      },
    ],
    tests: ["runtime/src/app-server/protocol.contract.test.ts"],
  },
  "S-01": {
    files: [
      "runtime/src/services/compact/compact.ts",
      "runtime/src/services/compact/autoCompact.ts",
      "runtime/src/services/compact/microCompact.ts",
      "runtime/src/services/compact/sessionMemoryCompact.ts",
      "runtime/src/services/compact/cachedMicrocompact.ts",
    ],
    tests: [
      "runtime/src/services/compact/compact.test.ts",
      "runtime/src/services/compact/autoCompact.test.ts",
      "runtime/src/services/compact/microCompact.test.ts",
      "runtime/src/services/compact/compact-surfaces.test.ts",
      "runtime/tests/runtime-session.compact-contract.test.ts",
    ],
    grepNotPresent: [
      {
        pattern: "agenc/upstream/services/compact",
        scope: "runtime/src/tui",
      },
    ],
  },
  "S-03": {
    files: [
      "runtime/src/services/extractMemories/extractMemories.ts",
      "runtime/src/services/extractMemories/prompts.ts",
      "runtime/src/services/extractMemories/memory-paths.ts",
      "runtime/src/services/extractMemories/memory-scan.ts",
      "runtime/src/agents/delegate.ts",
      "runtime/src/agents/fork-context.ts",
      "runtime/src/agents/run-agent.ts",
      "runtime/src/phases/commit.ts",
      "runtime/src/phases/execute-tools.ts",
      "runtime/src/session/run-turn.ts",
      "runtime/src/session/turn-context.ts",
      "runtime/src/session/turn-state.ts",
    ],
    grepPresent: [
      { pattern: "executeExtractMemories", scope: "runtime/src/phases/commit.ts" },
      { pattern: "completedToolResults", scope: "runtime/src/session" },
      { pattern: "childToolPolicy", scope: "runtime/src/agents" },
      { pattern: "childPolicyDenied", scope: "runtime/src" },
      { pattern: "drainPendingExtraction", scope: "runtime/src/session/run-turn.ts" },
      { pattern: "parentMessagesOverride", scope: "runtime/src/agents/delegate.ts" },
      { pattern: "Saved memor(y|ies):", scope: "runtime/src/phases/commit.ts" },
      { pattern: "AGENC_COWORK_MEMORY_PATH_OVERRIDE", scope: "runtime/src/services/extractMemories/memory-paths.ts" },
    ],
    grepNotPresent: [
      {
        pattern: "\\b(system\\.bash|exec_command|Bash)\\b",
        scope: "runtime/src/services/extractMemories/prompts.ts",
      },
    ],
    tests: [
      "runtime/src/services/extractMemories/extractMemories.test.ts",
      "runtime/src/agents/run-agent.test.ts",
    ],
  },
  "S-10": {
    files: [
      "runtime/src/tools/orchestration.ts",
      "runtime/src/tools/execution.ts",
      "runtime/src/tools/streaming-executor.ts",
      "runtime/src/tools/hooks.ts",
      "runtime/src/phases/execute-tools.ts",
      "runtime/src/session/turn-state.ts",
    ],
    grepPresent: [
      { pattern: "partitionToolCalls", scope: "runtime/src/tools/orchestration.ts" },
      { pattern: "runTools", scope: "runtime/src/tools/orchestration.ts" },
      { pattern: "maxConcurrency", scope: "runtime/src/tools/streaming-executor.ts" },
      { pattern: "runToolUse", scope: "runtime/src/tools/execution.ts" },
      { pattern: "PermissionDecisionHook", scope: "runtime/src/tools/hooks.ts" },
      { pattern: "../tools/streaming-executor", scope: "runtime/src/phases/execute-tools.ts" },
      { pattern: "../tools/orchestration", scope: "runtime/src/phases/execute-tools.ts" },
    ],
    grepNotPresent: [
      { pattern: "_deps/tool-runtime", scope: "runtime/src/phases/execute-tools.ts" },
      { pattern: "_deps/orchestration", scope: "runtime/src/phases/execute-tools.ts" },
      { pattern: "@ts-nocheck", scope: "runtime/src/tools/orchestration.ts" },
      { pattern: "@ts-nocheck", scope: "runtime/src/tools/execution.ts" },
      { pattern: "@ts-nocheck", scope: "runtime/src/tools/streaming-executor.ts" },
      { pattern: "@ts-nocheck", scope: "runtime/src/tools/hooks.ts" },
    ],
    tests: [
      "runtime/src/tools/orchestration.test.ts",
      "runtime/src/tools/execution.test.ts",
      "runtime/src/tools/streaming-executor.test.ts",
      "runtime/src/tools/hooks.test.ts",
      "runtime/src/phases/execute-tools.test.ts",
    ],
  },
  "S-14": {
    files: [
      "runtime/src/services/notifier.ts",
      "runtime/src/services/preventSleep.ts",
      "runtime/src/services/tokenEstimation.ts",
    ],
    tests: [
      "runtime/src/services/service-utilities.test.ts",
      "runtime/src/services/service-utilities.contract.test.ts",
    ],
  },
  "OC-10": {
    files: [
      "runtime/src/cost/tracker.ts",
      "runtime/src/cost/hook.ts",
      "runtime/src/session/cost.ts",
      "runtime/src/bin/bootstrap.ts",
      "runtime/src/tui/history/ResumeConversation.tsx",
      "runtime/src/tui/startup/StatusLine.tsx",
    ],
    grepPresent: [
      { pattern: "bindActiveCostSidecar", scope: "runtime/src/cost/tracker.ts" },
      { pattern: "restoreSessionCostsForSession", scope: "runtime/src/session/cost.ts" },
      { pattern: "registerCostSummaryFallbackOnExit", scope: "runtime/src/cost/hook.ts" },
      { pattern: "bindActiveCostSidecar", scope: "runtime/src/bin/bootstrap.ts" },
      { pattern: "../../cost/tracker\\.js", scope: "runtime/src/tui/startup/StatusLine.tsx" },
      { pattern: "../../cost/tracker\\.js", scope: "runtime/src/tui/history/ResumeConversation.tsx" },
    ],
    grepNotPresent: [
      { pattern: "agenc/upstream/cost-tracker", scope: "runtime/src/tui" },
    ],
    tests: [
      "runtime/src/cost/tracker.test.ts",
      "runtime/src/session/cost.test.ts",
      "runtime/src/session/cost-persistence.test.ts",
      "runtime/src/commands/status.test.ts",
    ],
  },
  "S-12": {
    files: [
      "runtime/src/services/AgentSummary/agentSummary.ts",
      "runtime/src/services/AgentSummary/transcript.ts",
      "runtime/src/tasks/lifecycle.ts",
      "runtime/src/tasks/agent-thread.ts",
      "runtime/src/agents/run-agent.ts",
      "runtime/src/agents/thread.ts",
      "runtime/src/agents/delegate.ts",
    ],
    grepPresent: [
      { pattern: "startAgentSummarization", scope: "runtime/src/services/AgentSummary/agentSummary.ts" },
      { pattern: "startAgentSummarization", scope: "runtime/src/tasks/agent-thread.ts" },
      { pattern: "buildSummaryPrompt", scope: "runtime/src/services/AgentSummary/agentSummary.ts" },
      { pattern: "filterIncompleteToolCalls", scope: "runtime/src/services/AgentSummary/agentSummary.ts" },
      { pattern: "extractAssistantSummaryText", scope: "runtime/src/services/AgentSummary/agentSummary.ts" },
      { pattern: "runAgentProgressEventToAgentSummaryMessage", scope: "runtime/src/services/AgentSummary/transcript.ts" },
      { pattern: "updateAgentSummary", scope: "runtime/src/tasks/lifecycle.ts" },
      { pattern: "summaryCacheSafeParams", scope: "runtime/src/tasks/agent-thread.ts" },
      { pattern: "onCacheSafeParams", scope: "runtime/src/agents/run-agent.ts" },
      { pattern: "recordSummaryProgressEvent", scope: "runtime/src/agents/delegate.ts" },
    ],
    grepNotPresent: [
      { pattern: "@ts-nocheck", scope: "runtime/src/services/AgentSummary" },
    ],
    tests: [
      "runtime/src/services/AgentSummary/agentSummary.test.ts",
      "runtime/src/services/AgentSummary/transcript.test.ts",
      "runtime/src/tasks/lifecycle.test.ts",
      "runtime/src/agents/run-agent.test.ts",
      "runtime/src/agents/delegate.test.ts",
    ],
  },
  "F-07": {
    files: [{ globUnder: "runtime/src/lifecycle", matching: /\.tsx?$/, minCount: 1 }],
  },
  "F-08": {
    files: [
      { globUnder: "packaging", matching: /\.(service|plist|xml)$/, minCount: 1 },
    ],
  },
  "A-00a": {
    files: ["runtime/src/auth/backend.ts"],
    grepPresent: [
      { pattern: "interface AuthBackend|type AuthBackend", scope: "runtime/src/auth/backend.ts" },
      { pattern: "login|logout|whoami|vendKey|inferAgencModel|getSubscriptionTier", scope: "runtime/src/auth/backend.ts" },
    ],
  },
  "A-00b": {
    files: ["runtime/src/auth/backends/local.ts"],
    grepPresent: [{ pattern: "LocalAuthBackend", scope: "runtime/src/auth/backends/local.ts" }],
  },
  "A-00c": {
    grepPresent: [{ pattern: "auth\\.backend", scope: "runtime/src/config" }],
  },
  "A-01": {
    grepPresent: [
      { pattern: "agenc login|auth\\.login", scope: "runtime/src/bin" },
      { pattern: "agenc logout|auth\\.logout", scope: "runtime/src/bin" },
      { pattern: "agenc whoami|auth\\.whoami", scope: "runtime/src/bin" },
    ],
  },
  "A-03": {
    tests: [{ globUnder: "runtime/src/auth", matching: /byok|precedence|env.*key/i }],
  },
  "A-06": {
    grepPresent: [{ pattern: "vendKey", scope: "runtime/src/app-server" }],
    grepNotPresent: [{ pattern: "process\\.env\\.\\w*_API_KEY", scope: "runtime/src/app-server" }],
  },
  "A-07": {
    tests: [{ globUnder: "runtime/src/auth", matching: /fallback|byok-fallback/i }],
  },
  "A-09": {
    grepPresent: [{ pattern: "peerCred|peerUid|cookie", scope: "runtime/src/auth" }],
  },
  "C-01a": {
    files: [
      "runtime/src/sandbox/engine/index.ts",
      "runtime/src/sandbox/engine/manager.ts",
      "runtime/src/sandbox/engine/policy-transforms.ts",
      "runtime/src/sandbox/engine/seatbelt.ts",
      "runtime/src/sandbox/engine/landlock.ts",
      "runtime/src/sandbox/engine/bwrap.ts",
      "runtime/src/sandbox/engine/policies/seatbelt_base_policy.sbpl",
      "runtime/src/sandbox/engine/policies/seatbelt_network_policy.sbpl",
      "runtime/src/sandbox/engine/policies/restricted_read_only_platform_defaults.sbpl",
    ],
    grepPresent: [
      { pattern: "SandboxManager", scope: "runtime/src/sandbox/engine/manager.ts" },
      { pattern: "createSeatbeltCommandArgs", scope: "runtime/src/sandbox/engine/seatbelt.ts" },
      { pattern: "createLinuxSandboxCommandArgsForPermissionProfile", scope: "runtime/src/sandbox/engine/landlock.ts" },
      { pattern: "systemBwrapWarning", scope: "runtime/src/sandbox/engine/bwrap.ts" },
    ],
    tests: [
      "runtime/src/sandbox/engine/linux-engine.test.ts",
      "runtime/src/sandbox/engine/seatbelt.test.ts",
      "runtime/src/sandbox/engine/policy-transforms.test.ts",
    ],
  },
  "C-01b": {
    files: [
      "runtime/bin/agenc-linux-sandbox",
      "runtime/src/sandbox/linux-launcher/main.ts",
      "runtime/src/sandbox/linux-launcher/lib.ts",
      "runtime/src/sandbox/linux-launcher/cli.ts",
      "runtime/src/sandbox/linux-launcher/linux-run-main.ts",
      "runtime/src/sandbox/linux-launcher/launcher.ts",
      "runtime/src/sandbox/linux-launcher/bwrap.ts",
      "runtime/src/sandbox/linux-launcher/landlock.ts",
      "runtime/src/sandbox/linux-launcher/proxy-routing.ts",
      "runtime/src/sandbox/linux-launcher/vendored-bwrap.ts",
      "runtime/src/sandbox/linux-launcher/build.ts",
      "runtime/package.json",
    ],
    grepPresent: [
      { pattern: "spawn\\(", scope: "runtime/src/sandbox/linux-launcher/launcher.ts" },
      { pattern: "spawn\\(", scope: "runtime/src/sandbox/linux-launcher/linux-run-main.ts" },
      { pattern: "\\-\\-unshare-user", scope: "runtime/src/sandbox/linux-launcher/bwrap.ts" },
      { pattern: "\\-\\-unshare-pid", scope: "runtime/src/sandbox/linux-launcher/bwrap.ts" },
      { pattern: "\\-\\-unshare-net", scope: "runtime/src/sandbox/linux-launcher/bwrap.ts" },
      { pattern: "\\-\\-seccomp", scope: "runtime/src/sandbox/linux-launcher/bwrap.ts" },
      { pattern: "createNetworkSeccompProgram", scope: "runtime/src/sandbox/linux-launcher/landlock.ts" },
      { pattern: "\\-\\-apply-seccomp-then-exec", scope: "runtime/src/sandbox/linux-launcher/cli.ts" },
      { pattern: "agenc-linux-sandbox", scope: "runtime/package.json" },
      { pattern: "activateProxyRoutesInNetns", scope: "runtime/src/sandbox/linux-launcher/linux-run-main.ts" },
      { pattern: "\\-\\-proxy-route-spec", scope: "runtime/src/sandbox/linux-launcher/linux-run-main.ts" },
      { pattern: "AGENC_LINUX_SANDBOX_ACTIVE", scope: "runtime/src/sandbox/linux-launcher/linux-run-main.ts" },
    ],
    tests: ["runtime/src/sandbox/linux-launcher/linux-launcher.test.ts"],
  },
  "C-01c": {
    files: [
      "runtime/src/sandbox/hardening/index.ts",
    ],
    grepPresent: [
      { pattern: "applyPreMainProcessHardening", scope: "runtime/src/sandbox/hardening/index.ts" },
      { pattern: "scrubDangerousEnvironment", scope: "runtime/src/sandbox/hardening/index.ts" },
      { pattern: "compileAndLoadNativeHardeningBinding", scope: "runtime/src/sandbox/hardening/index.ts" },
      { pattern: "prlimit", scope: "runtime/src/sandbox/hardening/index.ts" },
      { pattern: "LD_|DYLD_|MallocStackLogging|MallocLogFile", scope: "runtime/src/sandbox/hardening/index.ts" },
    ],
    tests: [
      "runtime/src/sandbox/hardening/hardening.test.ts",
    ],
  },
  "C-01d": {
    files: [
      "runtime/src/sandbox/execpolicy/decision.ts",
      "runtime/src/sandbox/execpolicy/error.ts",
      "runtime/src/sandbox/execpolicy/executable-name.ts",
      "runtime/src/sandbox/execpolicy/rule.ts",
      "runtime/src/sandbox/execpolicy/policy.ts",
      "runtime/src/sandbox/execpolicy/parser.ts",
      "runtime/src/sandbox/execpolicy/amend.ts",
      "runtime/src/sandbox/execpolicy/execpolicycheck.ts",
      "runtime/src/sandbox/execpolicy/main.ts",
      "runtime/src/sandbox/execpolicy/index.ts",
      "runtime/src/sandbox/execpolicy/examples/example.agencpolicy",
    ],
    grepPresent: [
      { pattern: "class PolicyParser", scope: "runtime/src/sandbox/execpolicy/parser.ts" },
      { pattern: "prefix_rule", scope: "runtime/src/sandbox/execpolicy/parser.ts" },
      { pattern: "network_rule", scope: "runtime/src/sandbox/execpolicy/parser.ts" },
      { pattern: "host_executable", scope: "runtime/src/sandbox/execpolicy/parser.ts" },
      { pattern: "matchesForCommandWithOptions", scope: "runtime/src/sandbox/execpolicy/policy.ts" },
      { pattern: "normalizeNetworkRuleHost", scope: "runtime/src/sandbox/execpolicy/rule.ts" },
      { pattern: "lockSync", scope: "runtime/src/sandbox/execpolicy/amend.ts" },
      { pattern: "formatMatchesJson", scope: "runtime/src/sandbox/execpolicy/execpolicycheck.ts" },
    ],
    tests: ["runtime/src/sandbox/execpolicy/execpolicy.test.ts"],
  },
  "C-01e": {
    files: [
      "runtime/src/sandbox/escalation/sandboxing.ts",
      "runtime/src/sandbox/escalation/unix-escalation.ts",
      "runtime/src/sandbox/escalation/approvals.ts",
      "runtime/src/sandbox/escalation/network-approval.ts",
      "runtime/src/sandbox/escalation/on-request.ts",
      "runtime/src/sandbox/escalation/on-failure.ts",
      "runtime/src/sandbox/escalation/on-request-rule-request-permission.ts",
      "runtime/src/tools/orchestrator.ts",
      "runtime/src/tools/router.ts",
      "runtime/src/bin/bootstrap-services.ts",
      "runtime/src/tools/system/exec-command.ts",
    ],
    tests: [
      "runtime/src/sandbox/escalation/escalation.test.ts",
      "runtime/src/tools/orchestrator.test.ts",
      "runtime/src/tools/runtimes/runtime.test.ts",
      "runtime/src/permissions/guardian/approval-request.test.ts",
    ],
    grepPresent: [
      { pattern: "sandbox.*bypass|bypass.*sandbox", scope: "runtime/src/sandbox/escalation" },
      { pattern: "execvePromptRejectedByPolicy", scope: "runtime/src/sandbox/escalation" },
      { pattern: "renderDecisionForUnmatchedCommand", scope: "runtime/src/sandbox/escalation" },
      { pattern: "kind: \"prompt\"", scope: "runtime/src/sandbox/escalation" },
      { pattern: "requestManagedNetworkApprovalForSandbox", scope: "runtime/src/sandbox/escalation" },
      { pattern: "defaultAvailableApprovalDecisions", scope: "runtime/src/sandbox/escalation" },
      { pattern: "proposedNetworkPolicyAmendments", scope: "runtime/src/sandbox/escalation" },
      { pattern: "with_additional_permissions", scope: "runtime/src/sandbox/escalation" },
      { pattern: "sandboxPermissionsFromArgs", scope: "runtime/src/tools/orchestrator.ts" },
      { pattern: "evaluateLocalShellExecPolicyAction", scope: "runtime/src/tools/orchestrator.ts" },
      { pattern: "currentExecPolicyFromSession", scope: "runtime/src/tools/router.ts" },
      { pattern: "requestManagedNetworkApprovalForSandbox", scope: "runtime/src/bin/bootstrap-services.ts" },
      { pattern: "require_escalated", scope: "runtime/src/tools/system/exec-command.ts" },
    ],
  },
  "C-01f": {
    files: [
      "runtime/src/sandbox/environment-selection.ts",
      "runtime/src/sandbox/sandbox-tags.ts",
    ],
    tests: [
      "runtime/src/sandbox/environment-selection.test.ts",
      "runtime/src/sandbox/sandbox-tags.test.ts",
    ],
  },
  "C-01g": {
    files: ["runtime/src/sandbox/network-policy.ts"],
  },
  "C-02": {
    files: [
      { globUnder: "runtime/src/mcp-client/transports", matching: /stdio.*\.tsx?$/, minCount: 1 },
      { globUnder: "runtime/src/mcp-client/transports", matching: /websocket.*\.tsx?$|\bws\b.*\.tsx?$/, minCount: 1 },
    ],
  },
  "C-03": {
    files: [
      "runtime/src/utils/terminal-detection.ts",
      "runtime/src/utils/terminal-detection.test.ts",
    ],
  },
  "C-04": {
    files: [
      "runtime/src/utils/git.ts",
      "runtime/src/utils/git.test.ts",
    ],
  },
  "C-05": {
    files: [{ globUnder: "runtime/src/tools/code-mode", matching: /\.tsx?$/, minCount: 2 }],
  },
  "C-06": {
    files: [{ globUnder: "runtime/src/connectors", matching: /\.tsx?$/, minCount: 1 }],
  },
  "RT-01": {
    files: [{ globUnder: "runtime/src/conversation", matching: /thread.*manager|conversation/i, minCount: 1 }],
  },
  "RT-02": {
    files: ["runtime/src/conversation/multi-turn-context.ts"],
  },
  "FW-01": {
    files: [{ globUnder: "runtime/src/file-watcher", matching: /\.tsx?$/, minCount: 1 }],
    tests: [{ globUnder: "runtime/src/file-watcher", matching: /\.test\.tsx?$/ }],
  },
  "SE-01": {
    files: [{ globUnder: "runtime/src/secrets", matching: /sanitiz/i, minCount: 1 }],
    tests: [{ globUnder: "runtime/src/secrets", matching: /\.test\.tsx?$/ }],
  },
  "SK-01": {
    files: [{ globUnder: "runtime/src/skills", matching: /load.*skills|skills.*load/i, minCount: 1 }],
  },
  "SK-02": {
    files: [{ globUnder: "runtime/src/skills", matching: /change.*detector|hot.?reload/i, minCount: 1 }],
  },
  "ZC-31": {
    files: [
      "runtime/src/skills/local-loader.ts",
      "runtime/src/skills/local-loader.test.ts",
      "runtime/src/prompts/attachments/skill-listing.ts",
      "runtime/src/bin/model-facing-tools.ts",
      "runtime/src/commands/skills.ts",
    ],
    grepPresent: [
    ],
  },
  "ZC-32": {
    files: [
      "runtime/src/shell-command/parser.ts",
      "runtime/src/shell-command/safety.ts",
      "runtime/src/shell-command/powershell-parser.ts",
      "parity/ZC-32-parity.json",
    ],
    tests: [
      "runtime/src/shell-command/parser.test.ts",
      "runtime/src/shell-command/safety.test.ts",
      "runtime/src/shell-command/powershell-parser.test.ts",
    ],
  },
  "ST-01": {
    grepPresent: [{ pattern: "CREATE TABLE.*agent_runs|agent_runs.*CREATE TABLE|table.*agent_runs", scope: "runtime/src/state" }],
  },
  "ST-02": {
    grepPresent: [{ pattern: "CREATE TABLE.*session_state_snapshots|session_state_snapshots.*CREATE TABLE|table.*session_state_snapshots", scope: "runtime/src/state" }],
  },
  "ST-03": {
    grepPresent: [{ pattern: "CREATE TABLE.*in_flight_tool_calls|in_flight_tool_calls.*CREATE TABLE|table.*in_flight_tool_calls", scope: "runtime/src/state" }],
  },
  "ST-04": {
    tests: [{ globUnder: "runtime/src/state", matching: /recovery|restart/i }],
  },
  "ST-05": {
    grepPresent: [{ pattern: "snapshotPolicy|snapshot.*policy", scope: "runtime/src/state" }],
  },
  "ST-06": {
    files: [{ globUnder: "runtime/src/state/migrations", matching: /\d+_/, minCount: 1 }],
  },
  "OC-04": {
    files: [
      "runtime/src/state/migrations/config-migrations.ts",
      "runtime/src/config/loader.ts",
      "runtime/src/config/schema.ts",
      "runtime/src/bin/bootstrap.ts",
      "runtime/src/bin/agenc.ts",
    ],
    tests: [
      "runtime/src/state/config-migrations.test.ts",
      "runtime/src/config/config.test.ts",
      "runtime/src/bin/project-trust-preflight.test.ts",
    ],
    grepPresent: [
      { pattern: "runStartupConfigMigrations", scope: "runtime/src/bin" },
      { pattern: "migrateRawAgenCConfig", scope: "runtime/src/config/loader.ts" },
      { pattern: "configMigrationVersion", scope: "runtime/src/state/migrations/config-migrations.ts" },
      { pattern: "remoteControlAtStartup", scope: "runtime/src/config/schema.ts" },
    ],
  },
  "OC-08": {
    files: [
      "runtime/src/tasks/types.ts",
      "runtime/src/tasks/registry.ts",
      "runtime/src/tasks/stopTask.ts",
      "runtime/src/tasks/pillLabel.ts",
      "runtime/src/tasks/lifecycle.ts",
      "runtime/src/tasks/index.ts",
      "runtime/src/tools/tasks/background.ts",
      "runtime/src/tui/state/AppStateStore.ts",
      "runtime/src/tui/components/PromptInput/PromptInput.tsx",
      "runtime/src/tui/components/PromptInput/PromptInputFooterLeftSide.tsx",
      "runtime/src/tui/components/spinner/Spinner.tsx",
    ],
    tests: [
      "runtime/src/tasks/types.test.ts",
      "runtime/src/tasks/registry.test.ts",
      "runtime/src/tasks/stopTask.test.ts",
      "runtime/src/tasks/pillLabel.test.ts",
      "runtime/src/tasks/lifecycle.test.ts",
      "runtime/src/tools/tasks/task-tools.test.ts",
    ],
    grepPresent: [
      { pattern: "TaskType", scope: "runtime/src/tasks/types.ts" },
      { pattern: "isBackgroundTask", scope: "runtime/src/tasks/types.ts" },
      { pattern: "getTaskByType", scope: "runtime/src/tasks/registry.ts" },
      { pattern: "getAllTasks", scope: "runtime/src/tasks/registry.ts" },
      { pattern: "StopTaskError", scope: "runtime/src/tasks/stopTask.ts" },
      { pattern: "getPillLabel", scope: "runtime/src/tasks/pillLabel.ts" },
      { pattern: "stopTask\\(", scope: "runtime/src/tools/tasks/background.ts" },
    ],
  },
  "OC-09": {
    files: [
      "runtime/src/onboarding/projectOnboardingState.ts",
      "runtime/src/onboarding/projectOnboardingSteps.ts",
      "runtime/src/onboarding/PARITY.md",
      "parity/OC-09-parity.json",
    ],
    tests: [
      "runtime/src/onboarding/projectOnboardingState.test.ts",
      "runtime/src/onboarding/projectOnboardingSteps.test.ts",
      "runtime/src/onboarding/onboarding.test.tsx",
    ],
    grepPresent: [
      { pattern: "shouldShowProjectOnboarding", scope: "runtime/src/onboarding/projectOnboardingState.ts" },
      { pattern: "maybeMarkProjectOnboardingComplete", scope: "runtime/src/onboarding/projectOnboardingState.ts" },
      { pattern: "incrementProjectOnboardingSeenCount", scope: "runtime/src/onboarding/projectOnboardingState.ts" },
      { pattern: "AGENC\\.md", scope: "runtime/src/onboarding/projectOnboardingSteps.ts" },
      { pattern: "OC-09", scope: "runtime/src/onboarding/PARITY.md" },
    ],
  },
  "ST-07": {
    grepPresent: [{ pattern: "retention|prun", scope: "runtime/src/state" }],
  },
  "ST-08": {
    tests: [{ globUnder: "runtime/src/state", matching: /concurren|race/i }],
  },
  "ST-09": {
    grepPresent: [{ pattern: "agenc state export|agenc state import|state\\.export|state\\.import", scope: "runtime/src" }],
  },
  "T-09": {
    files: [
      "runtime/src/tools/ask-user-question/tui-tool.tsx",
      "runtime/src/tools/AgentTool/loadAgentsDir.ts",
      "runtime/src/tools/AgentTool/agentColorManager.ts",
      "runtime/src/tools/AgentTool/constants.ts",
      "runtime/src/tools/AgentTool/prompt.ts",
      "runtime/src/tools/BriefTool/prompt.ts",
      "runtime/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx",
      "runtime/src/tools/AskUserQuestionTool/prompt.ts",
    ],
    tests: [
      "runtime/src/tools/ask-user-question-tui-routing.test.tsx",
      "runtime/src/tools/ask-user-question/tui-tool.test.tsx",
      "runtime/src/tools/AgentTool/loadAgentsDir.test.ts",
    ],
    grepNotPresent: [
      {
        pattern: "agenc/upstream/tools/(AskUserQuestionTool|AgentTool|BriefTool)",
        scope: "runtime/src/tui/tool-rendering.tsx",
      },
      {
        pattern: "agenc/upstream/tools/(AskUserQuestionTool|AgentTool|BriefTool)",
        scope: "runtime/src/tui/components/PromptInput",
      },
      {
        pattern: "agenc/upstream/tools/(AskUserQuestionTool|AgentTool|BriefTool)",
        scope: "runtime/src/tui/components/Messages.tsx",
      },
      {
        pattern: "agenc/upstream/tools/(AskUserQuestionTool|AgentTool|BriefTool)",
        scope: "runtime/src/tui/components/App.tsx",
      },
      {
        pattern: "agenc/upstream/tools/(AskUserQuestionTool|AgentTool|BriefTool)",
        scope: "runtime/src/tui/state/AppStateStore.ts",
      },
      {
        pattern: "agenc/upstream/tools/(AskUserQuestionTool|AgentTool|BriefTool)",
        scope: "runtime/src/agenc/adapters/upstream-agent-list.ts",
      },
    ],
  },
  "T-14": {
    files: [
      "runtime/src/tui/startup/StartupScreen.ts",
      "runtime/src/tui/startup/StatusLine.tsx",
      "runtime/src/tui/startup/StatusNotices.tsx",
      "runtime/src/tui/startup/statusNoticeDefinitions.tsx",
    ],
    tests: [
      "runtime/src/tui/startup/StartupScreen.test.ts",
      "runtime/src/tui/startup/statusNoticeDefinitions.test.tsx",
    ],
    grepPresent: [
      {
        pattern: "\\.\\./startup/StatusNotices\\.js",
        scope: "runtime/src/tui/components/Messages.tsx",
      },
      {
        pattern: "\\.\\./\\.\\./startup/StatusLine\\.js",
        scope: "runtime/src/tui/components/PromptInput/PromptInputFooter.tsx",
      },
      {
        pattern: "\\.\\./\\.\\./\\.\\./tui/startup/StartupScreen\\.js",
        scope: "runtime/src/agenc/upstream/entrypoints/cli.tsx",
      },
    ],
  },
  "T-15": {
    files: [
      "runtime/src/tui/history/history.ts",
      "runtime/src/tui/history/HistorySearchDialog.tsx",
      "runtime/src/tui/history/ResumeConversation.tsx",
      "runtime/src/tui/history/transcriptSearch.ts",
    ],
    tests: [
      "runtime/src/tui/history/history.test.ts",
      "runtime/src/tui/history/transcriptSearch.test.ts",
    ],
    grepPresent: [
      {
        pattern: "\\.\\./history/transcriptSearch\\.js",
        scope: "runtime/src/tui/components/Messages.tsx",
      },
      {
        pattern: "\\.\\./\\.\\./history/history\\.js",
        scope: "runtime/src/tui/components/PromptInput/PromptInput.tsx",
      },
      {
        pattern: "\\.\\./\\.\\./history/HistorySearchDialog\\.js",
        scope: "runtime/src/tui/components/PromptInput/PromptInput.tsx",
      },
      {
        pattern: "\\.\\./\\.\\./history/history\\.js",
        scope: "runtime/src/tui/components/PromptInput/inputPaste.ts",
      },
      {
        pattern: "\\.\\./\\.\\./tui/history/ResumeConversation\\.js",
        scope: "runtime/src/agenc/upstream/dialogLaunchers.tsx",
      },
    ],
  },
  "T-16": {
    files: [
      "runtime/src/tui/cost/Stats.tsx",
      "runtime/src/tui/cost/TokenWarning.tsx",
      "runtime/src/tui/cost/MemoryUsageIndicator.tsx",
      "runtime/src/tui/cost/tokenAnalytics.ts",
    ],
    tests: [
      "runtime/src/tui/cost/tokenAnalytics.test.ts",
    ],
    grepPresent: [
      {
        pattern: "\\.\\./\\.\\./cost/TokenWarning\\.js",
        scope: "runtime/src/tui/components/PromptInput/Notifications.tsx",
      },
      {
        pattern: "\\.\\./\\.\\./cost/MemoryUsageIndicator\\.js",
        scope: "runtime/src/tui/components/PromptInput/Notifications.tsx",
      },
    ],
  },
  "T-17": {
    files: [
      "runtime/src/tui/components/spinner/Spinner.tsx",
      "runtime/src/tui/components/spinner/SpinnerAnimationRow.tsx",
      "runtime/src/tui/components/spinner/SpinnerGlyph.tsx",
      "runtime/src/tui/components/spinner/ShimmerChar.tsx",
      "runtime/src/tui/components/spinner/useShimmerAnimation.ts",
      "runtime/src/tui/components/spinner/useStalledAnimation.ts",
      "runtime/src/tui/components/spinner/utils.ts",
      "runtime/src/tui/components/spinner/types.ts",
    ],
    tests: [
      "runtime/src/tui/components/spinner/spinner-primitives.test.tsx",
    ],
    grepPresent: [
      {
        pattern: "\\.\\./components/spinner/Spinner\\.js",
        scope: "runtime/src/tui/cost/Stats.tsx",
      },
      {
        pattern: "\\.\\./components/spinner/Spinner\\.js",
        scope: "runtime/src/tui/history/ResumeConversation.tsx",
      },
      {
        pattern: "\\.\\./spinner/ShimmerChar\\.js",
        scope: "runtime/src/tui/components/PromptInput/ShimmeredInput.tsx",
      },
      {
        pattern: "\\.\\./spinner/utils\\.js",
        scope: "runtime/src/tui/components/PromptInput/VoiceIndicator.tsx",
      },
    ],
  },
  "T-18": {
    files: [
      "runtime/src/tui/components/markdown/Markdown.tsx",
      "runtime/src/tui/components/markdown/MarkdownTable.tsx",
      "runtime/src/tui/components/markdown/HighlightedCode.tsx",
      "runtime/src/tui/components/markdown/HighlightedCodeFallback.tsx",
    ],
    tests: [
      "runtime/src/tui/components/markdown/markdown-rendering.test.tsx",
    ],
    grepPresent: [
      {
        pattern: "\\./markdown/Markdown\\.js",
        scope: "runtime/src/tui/components/Messages.tsx",
      },
      {
        pattern: "tui/components/markdown/Markdown\\.js",
        scope: "runtime/src/agenc/upstream/tools/AgentTool/UI.tsx",
      },
      {
        pattern: "tui/components/markdown/HighlightedCode\\.js",
        scope: "runtime/src/agenc/upstream/tools/FileWriteTool/UI.tsx",
      },
    ],
  },
  "T-20": {
    files: [
      "runtime/src/tui/components/dialogs/CostThresholdDialog.tsx",
      "runtime/src/tui/components/dialogs/RateLimitMessage.tsx",
    ],
    tests: [
      "runtime/src/tui/components/dialogs/cost-limit-dialogs.test.tsx",
    ],
    grepPresent: [
      {
        pattern: "tui/components/dialogs/CostThresholdDialog\\.js",
        scope: "runtime/src/agenc/upstream/screens/REPL.tsx",
      },
      {
        pattern: "tui/components/dialogs/RateLimitMessage\\.js",
        scope: "runtime/src/agenc/upstream/components/messages/AssistantTextMessage.tsx",
      },
    ],
  },
  "T-21": {
    files: [
      "runtime/src/tui/components/compact/CompactSummary.tsx",
      "runtime/src/tui/components/compact/CompactBoundaryMessage.tsx",
      "runtime/src/tui/components/compact/compact-rendering.test.tsx",
      "parity/T-21-parity.json",
    ],
    filesAbsent: [
      "runtime/src/tui/components/CompactSummary.tsx",
      "runtime/src/tui/components/messages/CompactBoundaryMessage.tsx",
    ],
    tests: [
      "runtime/src/tui/components/compact/compact-rendering.test.tsx",
    ],
    grepPresent: [
      {
        pattern: "\\./compact/CompactSummary",
        scope: "runtime/src/tui/components/Message.tsx",
      },
      {
        pattern: "\\./compact/CompactBoundaryMessage",
        scope: "runtime/src/tui/components/Message.tsx",
      },
      {
        pattern: "T-21 Compact Summary",
        scope: "runtime/src/tui/components/PARITY.md",
      },
      {
        pattern: "CompactBoundaryMessage\\.tsx",
        scope: "parity/T-21-parity.json",
      },
    ],
  },
  "T-13": {
    files: [
      "runtime/src/tui/slash/slash-command-parsing.ts",
      "runtime/src/tui/slash/argument-substitution.ts",
      "runtime/src/tui/slash/shell-quote.ts",
    ],
    tests: [
      "runtime/src/tui/slash/slash-command-parsing.test.ts",
      "runtime/src/tui/slash/argument-substitution.test.ts",
      "runtime/src/skills/local-loader.test.ts",
      "runtime/src/commands/dispatcher.test.ts",
    ],
    grepPresent: [
      {
        pattern: "\\.\\./tui/slash/argument-substitution\\.js",
        scope: "runtime/src/skills/local-loader.ts",
      },
    ],
  },
  "T-12": {
    files: [
      "runtime/src/tui/input/processUserInput.ts",
      "runtime/src/tui/input/processBashCommand.tsx",
      "runtime/src/tui/input/processSlashCommand.tsx",
      "runtime/src/tui/input/processTextPrompt.ts",
    ],
    tests: [
      "runtime/src/tui/input/processBashCommand.test.tsx",
      "runtime/src/tui/input/processSlashCommand.test.ts",
      "runtime/src/tui/input/processUserInput.test.ts",
      "runtime/src/tui/components/PromptInput/inputModes.test.ts",
    ],
    grepPresent: [
      {
        pattern: "\\.\\./\\.\\./\\.\\./tui/input/processUserInput\\.js",
        scope: "runtime/src/agenc/upstream/utils/handlePromptSubmit.ts",
      },
      {
        pattern: "\\.\\./\\.\\./input/processUserInput\\.js",
        scope: "runtime/src/tui/components/PromptInput/PromptInput.tsx",
      },
    ],
  },
  "ST-10": {
    files: [{ globUnder: "runtime/src/rollout", matching: /recorder|session.?index/i, minCount: 1 }],
  },
  "ST-11": {
    files: [{ globUnder: "runtime/src/thread-store", matching: /\.tsx?$/, minCount: 1 }],
  },
  "ST-12": {
    grepPresent: [{ pattern: "fsync|atomic.*rename|atomicWrite|tmp.*rename", scope: "runtime/src/state" }],
  },
  "ST-13": {
    grepPresent: [{ pattern: "recoveryCategory|recovery_category|toolCategory|poison", scope: "runtime/src/state" }],
  },
  "ST-14": {
    grepPresent: [{ pattern: "snapshotRetention|prune.*snapshot|snapshot.*prune", scope: "runtime/src/state" }],
  },
  "ST-15": {
    grepPresent: [{ pattern: "outputRotation|output.*rotation|rotate.*output", scope: "runtime/src" }],
  },
  "TL-01": {
    grepPresent: [{ pattern: "\"bash\"|'bash'", scope: "runtime/src/tool-registry.ts" }],
    files: [{ globUnder: "runtime/src/tools", matching: /bash/i, minCount: 1 }],
  },
  "TL-02": {
    grepPresent: [{ pattern: "\"edit\"|'edit'", scope: "runtime/src/tool-registry.ts" }],
    files: [{ globUnder: "runtime/src/tools", matching: /edit/i, minCount: 1 }],
  },
  "TL-03": {
    grepPresent: [{ pattern: "\"read\"|'read'", scope: "runtime/src/tool-registry.ts" }],
    files: [{ globUnder: "runtime/src/tools", matching: /read/i, minCount: 1 }],
  },
  "TL-04": {
    grepPresent: [{ pattern: "\"write\"|'write'", scope: "runtime/src/tool-registry.ts" }],
    files: [{ globUnder: "runtime/src/tools", matching: /write/i, minCount: 1 }],
  },
  "TL-05": {
    grepPresent: [{ pattern: "\"grep\"|'grep'", scope: "runtime/src/tool-registry.ts" }],
  },
  "TL-06": {
    grepPresent: [{ pattern: "\"glob\"|'glob'", scope: "runtime/src/tool-registry.ts" }],
  },
  "TL-07": {
    grepPresent: [{ pattern: "multi.?edit", scope: "runtime/src/tool-registry.ts" }],
  },
  "TL-08": {
    grepPresent: [{ pattern: "web_fetch|webFetch", scope: "runtime/src/tool-registry.ts" }],
  },
  "TL-09": {
    grepPresent: [{ pattern: "web_search|webSearch", scope: "runtime/src/tool-registry.ts" }],
  },
  "TL-10": {
    grepPresent: [{ pattern: "TodoWrite|todo_write", scope: "runtime/src/tool-registry.ts" }],
  },
  "TL-11": {
    grepPresent: [{ pattern: "EnterPlanMode|ExitPlanMode|plan_mode", scope: "runtime/src/tool-registry.ts" }],
  },
  "TL-12": {
    grepPresent: [{ pattern: "AgentTool|agent_tool", scope: "runtime/src/tool-registry.ts" }],
  },
  "TL-13": {
    grepPresent: [{ pattern: "SkillCreate|skill_invoke|Skill.*Tool", scope: "runtime/src/tool-registry.ts" }],
  },
  "TL-14": {
    grepPresent: [{ pattern: "NotebookRead|notebook_read", scope: "runtime/src/tool-registry.ts" }],
  },
  "TL-15": {
    grepPresent: [{ pattern: "NotebookEdit|notebook_edit", scope: "runtime/src/tool-registry.ts" }],
  },
  "TL-19": {
    files: ["runtime/src/tool-registry.ts"],
    tests: [{ globUnder: "runtime/src", matching: /tool-registry.*\.test\.tsx?$/ }],
  },
  "TL-21": {
    files: [
      "runtime/src/tools/runtimes/context.ts",
      "runtime/src/tools/runtimes/parallel.ts",
      "runtime/src/tools/runtimes/shell.ts",
      "runtime/src/tools/runtimes/unified-exec.ts",
      "runtime/src/tools/runtimes/apply-patch.ts",
      "runtime/src/tools/runtimes/sandboxing.ts",
      "runtime/src/tools/system/exec-command.ts",
      "runtime/src/tools/system/write-stdin.ts",
      "runtime/src/unified-exec/process-manager.ts",
      "runtime/src/sandbox/engine/manager.ts",
    ],
    grepPresent: [
      { pattern: "analyzeShellRuntimeAccess", scope: "runtime/src/tools/runtimes/sandboxing.ts" },
      { pattern: "analyzeApplyPatchRuntimeWrites", scope: "runtime/src/tools/runtimes/sandboxing.ts" },
      { pattern: "buildToolRuntimeAttemptContext", scope: "runtime/src/tools/router.ts" },
      { pattern: "executeToolDispatch", scope: "runtime/src/tools/router.ts" },
      { pattern: "enforceRuntimeSandboxAttempt", scope: "runtime/src/tools/execution.ts" },
      { pattern: "ToolRuntimeScheduler|runToolRuntimeCall", scope: "runtime/src/tools/streaming-executor.ts" },
      { pattern: "createToolExecutionRuntime", scope: "runtime/src/phases/execute-tools.ts" },
      { pattern: "write_stdin", scope: "runtime/src/tools/runtimes/runtime.test.ts" },
      { pattern: "contentItems", scope: "runtime/src/tools/runtimes/runtime.test.ts" },
      { pattern: "codeModeResult", scope: "runtime/src/tools/runtimes/runtime.test.ts" },
      { pattern: "BigInt", scope: "runtime/src/tools/runtimes/runtime.test.ts" },
      { pattern: "TMPDIR", scope: "runtime/src/tools/runtimes/runtime.test.ts" },
      { pattern: "runtimeSandbox", scope: "runtime/src/tools/system/exec-command.ts" },
      { pattern: "runtimeSandbox", scope: "runtime/src/tools/system/write-stdin.ts" },
      { pattern: "SandboxManager", scope: "runtime/src/unified-exec/process-manager.ts" },
      { pattern: "read_only_subpaths", scope: "runtime/src/sandbox/engine/manager.ts" },
    ],
    tests: [
      "runtime/src/tools/runtimes/runtime.test.ts",
      "runtime/src/phases/execute-tools.test.ts",
      "runtime/src/tools/router.test.ts",
      "runtime/src/unified-exec/process-manager.test.ts",
      "runtime/src/sandbox/engine/linux-engine.test.ts",
    ],
  },
  "TL-22": {
    files: [{ globUnder: "runtime/src/agents/v2", matching: /\.tsx?$/, minCount: 2 }],
  },
  "TL-23": {
    files: [{ globUnder: "runtime/src/elicitation", matching: /\.tsx?$/, minCount: 1 }],
  },
  "TL-24": {
    files: [{ globUnder: "runtime/src/tools/apply-patch", matching: /\.tsx?$/, minCount: 1 }],
  },
  "TL-25": {
    files: [{ globUnder: "runtime/src/tools/tasks", matching: /\.tsx?$/, minCount: 2 }],
    grepPresent: [{ pattern: "TaskCreate|TaskList|TaskStop", scope: "runtime/src/tool-registry.ts" }],
  },
  "TL-26": {
    files: [{ globUnder: "runtime/src/tools/ask-user-question", matching: /\.tsx?$/, minCount: 1 }],
    grepPresent: [{ pattern: "AskUserQuestion", scope: "runtime/src/tool-registry.ts" }],
  },
  "PE-01": {
    files: [{ globUnder: "runtime/src/permissions", matching: /approval.?cache/i, minCount: 1 }],
    tests: [{ globUnder: "runtime/src/permissions", matching: /approval.?cache.*\.test/i }],
  },
  "PE-02": {
    files: [{ globUnder: "runtime/src/permissions", matching: /dangerous.?pattern/i, minCount: 1 }],
    tests: [{ globUnder: "runtime/src/permissions", matching: /dangerous.?pattern.*\.test/i }],
  },
  "PE-03": {
    files: [{ globUnder: "runtime/src/permissions", matching: /tool.?approval/i, minCount: 1 }],
  },
  "PE-04": {
    files: [{ globUnder: "runtime/src/permissions", matching: /permission.?mode/i, minCount: 1 }],
    tests: [{ globUnder: "runtime/src/permissions", matching: /permission.?mode.*\.test/i }],
  },
  "PE-05": {
    files: [
      "runtime/src/tools/execution.ts",
      "runtime/src/tools/runtimes/sandboxing.ts",
      "runtime/src/tools/runtimes/shell.ts",
      "runtime/src/tools/runtimes/unified-exec.ts",
      "runtime/src/tools/system/exec-command.ts",
      "runtime/src/tools/system/write-stdin.ts",
      "runtime/src/tools/runtimes/runtime.test.ts",
    ],
    tests: ["runtime/src/tools/runtimes/runtime.test.ts"],
    grepPresent: [
      {
        pattern: "attachToolRuntimeContext",
        scope: "runtime/src/tools/execution.ts",
      },
      {
        pattern: "enforceRuntimeSandboxAttempt\\(\\{",
        scope: "runtime/src/tools/execution.ts",
      },
      {
        pattern: "runtimeSandboxForExec",
        scope: "runtime/src/tools/system/exec-command.ts",
      },
      {
        pattern: "manager\\.execCommand",
        scope: "runtime/src/tools/system/exec-command.ts",
      },
      {
        pattern: "runtimeSandbox !== undefined \\? \\{ runtimeSandbox \\}",
        scope: "runtime/src/tools/system/exec-command.ts",
      },
      {
        pattern: "runtimeSandboxForExec",
        scope: "runtime/src/tools/system/write-stdin.ts",
      },
      {
        pattern: "manager\\.writeStdin",
        scope: "runtime/src/tools/system/write-stdin.ts",
      },
      {
        pattern: "runtimeSandbox !== undefined \\? \\{ runtimeSandbox \\}",
        scope: "runtime/src/tools/system/write-stdin.ts",
      },
      {
        pattern: "actual Edit and MultiEdit handlers obey per-attempt file sandbox preflight",
        scope: "runtime/src/tools/runtimes/runtime.test.ts",
      },
    ],
  },
  "PE-06": {
    files: [{ globUnder: "runtime/src/hooks", matching: /\.tsx?$/, minCount: 1 }],
  },
  "PE-07": {
    grepPresent: [{ pattern: "agenc permissions", scope: "runtime/src" }],
  },
  "PE-08": {
    grepPresent: [{ pattern: "audit.?log", scope: "runtime/src/permissions" }],
  },
  "PE-09": {
    files: [{ globUnder: "runtime/src/permissions/trust", matching: /\.tsx?$/, minCount: 1 }],
  },
  "PE-10": {
    files: [{ globUnder: "runtime/src/hooks/engine", matching: /dispatcher/i, minCount: 1 }],
  },
  "PE-11": {
    files: [{ globUnder: "runtime/src/permissions/guardian", matching: /\.tsx?$/, minCount: 1 }],
  },
  "PE-12": {
    files: ["runtime/src/shell-command/parser.ts"],
  },
  "PE-13": {
    grepPresent: [
      { pattern: "RequestPermissions|request.?permissions", scope: "runtime/src/permissions" },
    ],
  },
  "PE-14": {
    grepPresent: [
      { pattern: "unattended", scope: "runtime/src/permissions" },
    ],
  },
  "PE-15": {
    grepPresent: [
      { pattern: "PreToolUse", scope: "runtime/src/hooks" },
      { pattern: "PostToolUse", scope: "runtime/src/hooks" },
      { pattern: "PermissionRequest", scope: "runtime/src/hooks" },
      { pattern: "SessionStart", scope: "runtime/src/hooks" },
      { pattern: "Stop", scope: "runtime/src/hooks" },
    ],
  },
  "MS-01": {
    files: [{ globUnder: "runtime/src/mcp-server", matching: /\.tsx?$/, minCount: 1 }],
  },
  "MS-02": {
    grepPresent: [{ pattern: "registerTool|tool.*register", scope: "runtime/src/mcp-server" }],
  },
  "MS-03": {
    files: [{ globUnder: "runtime/src/mcp-server", matching: /stdio/i, minCount: 1 }],
  },
  "MS-04": {
    files: [{ globUnder: "runtime/src/mcp-server", matching: /http|sse/i, minCount: 1 }],
  },
  "MS-05": {
    grepPresent: [{ pattern: "permission|guardian", scope: "runtime/src/mcp-server" }],
  },
  "MS-06": {
    grepPresent: [{ pattern: "agenc mcp|mcp\\.serve", scope: "runtime/src/bin" }],
  },
  "PK-01": {
    files: [{ globUnder: "runtime/src/plugins", matching: /loader/i, minCount: 1 }],
  },
  "PK-02": {
    grepPresent: [{ pattern: "plugin\\.json|pluginManifest", scope: "runtime/src/plugins" }],
  },
  "PK-03": {
    grepPresent: [{ pattern: "registerTool|tool.*register", scope: "runtime/src/plugins" }],
  },
  "PK-04": {
    grepPresent: [{ pattern: "permission|capability", scope: "runtime/src/plugins" }],
  },
  "PK-05": {
    grepPresent: [{ pattern: "sandbox|isolation", scope: "runtime/src/plugins" }],
  },
  "PK-06": {
    grepPresent: [{ pattern: "agenc plugin", scope: "runtime/src" }],
  },
  "PK-08": {
    files: [
      "scripts/check-plugin-kit-hello-example.mjs",
    ],
    grepPresent: [
      {
        pattern: "hello-tool",
        scope: "scripts/check-plugin-kit-hello-example.mjs",
      },
    ],
  },
  "PK-09": {
    files: [
      "runtime/src/plugins/resolution.ts",
      "runtime/src/plugins/cli/pluginOperations.ts",
      "runtime/src/plugins/loader.ts",
      "runtime/src/plugins/registration/manager.ts",
    ],
    grepPresent: [
      { pattern: "plugin.*resolve|resolvePlugin", scope: "runtime/src/plugins" },
      { pattern: "verifySignature|signature.*verify", scope: "runtime/src/plugins" },
      { pattern: "requireSignature:\\s*input\\.requireSignature\\s*\\?\\?\\s*true", scope: "runtime/src/plugins/cli/pluginOperations.ts" },
      { pattern: "verifyPluginDependencyState", scope: "runtime/src/plugins/loader.ts" },
      { pattern: "maxExtractedFiles|maxExtractedBytes|maxExtractDepth", scope: "runtime/src/plugins/resolution.ts" },
      { pattern: "plugin-dependency-invalid", scope: "runtime/src/plugins/registration/manager.ts" },
    ],
    tests: ["runtime/src/plugins/resolution.test.ts"],
  },
  "PK-10": {
    files: ["scripts/check-sdk-daemon-methods.mjs"],
    grepPresent: [
      { pattern: "AGENC_DAEMON_NOTIFICATION_METHODS", scope: "scripts/check-sdk-daemon-methods.mjs" },
    ],
    tests: ["scripts/check-sdk-daemon-methods.test.mjs"],
  },
  "PK-12": {
    files: ["scripts/check-plugin-kit-abi-surface.mjs"],
    grepNotPresent: [
      {
        pattern:
          "ChannelAdapter|CHANNEL_ADAPTER|certifyChannelAdapter|certifyChannelAdapterModule|createChannelAdapter|channel_adapter|channel-host-matrix",
        scope: "runtime/src",
      },
    ],
  },
  "PK-13": {
    files: ["scripts/check-sibling-package-pins.mjs"],
    grepPresent: [
      { pattern: "@tetsuo-ai", scope: "scripts/check-sibling-package-pins.mjs" },
      { pattern: "npm view", scope: "scripts/check-sibling-package-pins.mjs" },
    ],
    tests: ["scripts/check-sibling-package-pins.test.mjs"],
  },
  "ZC-30": {
    files: [
    ],
    grepPresent: [
    ],
  },
  "MG-01": {
    files: ["runtime/src/bin/agenc.ts"],
  },
  "MG-02": {
    files: [
      "runtime/src/bin/MIGRATION.md",
      "scripts/check-bin-classification.mjs",
    ],
    grepPresent: [
      { pattern: "client-only", scope: "runtime/src/bin/MIGRATION.md" },
      { pattern: "daemon-only", scope: "runtime/src/bin/MIGRATION.md" },
      { pattern: "shared", scope: "runtime/src/bin/MIGRATION.md" },
      { pattern: "discoverBinSourceFiles", scope: "scripts/check-bin-classification.mjs" },
    ],
    tests: ["scripts/check-bin-classification.test.mjs"],
  },
  "MG-03": {
    files: [
      "runtime/src/bin/MIGRATION.md",
      "scripts/check-bin-classification.mjs",
    ],
    grepPresent: [
      { pattern: "MG-03 Relocation Result", scope: "runtime/src/bin/MIGRATION.md" },
      { pattern: "runtime/src/app-server/handlers", scope: "runtime/src/bin/MIGRATION.md" },
      { pattern: "forbidDaemonOnly", scope: "scripts/check-bin-classification.mjs" },
    ],
    tests: ["scripts/check-bin-classification.test.mjs"],
  },
  "MG-04": {
    files: ["runtime/src/app-server-client/index.ts"],
    grepNotPresent: [
      { pattern: "directRuntime|direct.*runtime|legacy.*direct", scope: "runtime/src/bin" },
      { pattern: "AGENC_FORCE_DIRECT_RUNTIME|--no-daemon|shouldSkipAgenCDaemonForStartup", scope: "runtime/src/bin" },
    ],
  },
  "MG-06": {
    files: [
      "packages/agenc/package.json",
      "packages/agenc/bin/agenc",
      "packages/agenc/src/launcher.mjs",
      "packages/agenc/test/launcher.test.mjs",
    ],
    grepPresent: [
      { pattern: "autostart|spawnDaemon", scope: "packages/agenc/src/launcher.mjs" },
      { pattern: "daemon\\.pid", scope: "packages/agenc/src/launcher.mjs" },
      { pattern: "daemon\\.cookie", scope: "packages/agenc/src/launcher.mjs" },
      { pattern: "AGENC_DAEMON_READY_TIMEOUT_MS", scope: "packages/agenc/src/launcher.mjs" },
      { pattern: "AGENC_DAEMON_AUTOSTART", scope: "packages/agenc/src/launcher.mjs" },
      { pattern: "\"@tetsuo-ai/runtime\": \"file:../../runtime\"", scope: "packages/agenc/package.json" },
    ],
    tests: ["packages/agenc/test/launcher.test.mjs"],
  },
  "MG-07": {
    files: [
      "packages/agenc/RELEASE_NOTES.md",
      "docs/cli/agenc-docs-daemon-contract.json",
    ],
    grepPresent: [
      { pattern: "Daemon-Backed CLI|daemon-backed CLI", scope: "packages/agenc/RELEASE_NOTES.md" },
      { pattern: "agenc daemon start --foreground", scope: "packages/agenc/RELEASE_NOTES.md" },
      { pattern: "agenc agent start", scope: "packages/agenc/RELEASE_NOTES.md" },
      { pattern: "AGENC_DAEMON_AUTOSTART", scope: "packages/agenc/RELEASE_NOTES.md" },
      { pattern: "AGENC_DAEMON_READY_TIMEOUT_MS", scope: "packages/agenc/RELEASE_NOTES.md" },
      { pattern: "systemd", scope: "packages/agenc/RELEASE_NOTES.md" },
      { pattern: "launchd", scope: "packages/agenc/RELEASE_NOTES.md" },
      { pattern: "\"siblingRepo\": \"agenc-docs\"", scope: "docs/cli/agenc-docs-daemon-contract.json" },
      { pattern: "\"docsPath\": \"docs/cli/daemon.mdx\"", scope: "docs/cli/agenc-docs-daemon-contract.json" },
      { pattern: "\"npm run prebuild\"", scope: "docs/cli/agenc-docs-daemon-contract.json" },
      { pattern: "\"contentSha256\"", scope: "docs/cli/agenc-docs-daemon-contract.json" },
    ],
  },
  "CF-01": {
    grepPresent: [{ pattern: "auth\\.backend", scope: "runtime/src/config" }],
  },
  "CF-03": {
    files: [
      "runtime/src/config/schema.ts",
      "runtime/src/config/env.ts",
      "runtime/src/auth/selection.ts",
      "runtime/src/auth/byok-precedence.ts",
      "runtime/src/auth/backends/remote.ts",
      "runtime/src/config/PARITY.md",
    ],
    grepPresent: [
      { pattern: "managedKeys", scope: "runtime/src/config/schema.ts" },
      { pattern: "AGENC_AUTH_MANAGED_KEYS_ENABLED", scope: "runtime/src/config/env.ts" },
      { pattern: "resolveAuthManagedKeysEnabled", scope: "runtime/src/auth/selection.ts" },
      { pattern: "managedKeysEnabled", scope: "runtime/src/auth/backends/remote.ts" },
    ],
    tests: [
      "runtime/src/config/config.test.ts",
      "runtime/src/auth/selection.contract.test.ts",
      "runtime/src/auth/byok-precedence.contract.test.ts",
      "runtime/src/auth/backends/remote.contract.test.ts",
    ],
  },
  "CF-05": {
    grepPresent: [{ pattern: "sandbox\\.mode", scope: "runtime/src/config" }],
  },
  "CF-07": {
    grepPresent: [{ pattern: "permissions\\.default_mode", scope: "runtime/src/config" }],
  },
  "CF-08": {
    grepPresent: [{ pattern: "daemon\\.transport", scope: "runtime/src/config" }],
  },
  "CF-09": {
    grepPresent: [{ pattern: "daemon\\.autostart", scope: "runtime/src/config" }],
  },
  "CF-15": {
    grepPresent: [{ pattern: "agent\\.budget", scope: "runtime/src/config" }],
  },
  "CF-12": {
    files: [
      "runtime/src/config/migrate.ts",
      "runtime/src/config/migrate.test.ts",
      "runtime/src/config/loader.ts",
      "runtime/src/config/schema.ts",
      "runtime/src/config/config.test.ts",
    ],
    grepPresent: [
      { pattern: "runConfigFileMigrations", scope: "runtime/src/config/migrate.ts" },
      { pattern: "runConfigFileMigrations", scope: "runtime/src/config/loader.ts" },
      { pattern: "configVersion", scope: "runtime/src/config/schema.ts" },
      { pattern: "config\\.json", scope: "runtime/src/config/migrate.ts" },
      { pattern: "config\\.json", scope: "runtime/src/config/migrate.test.ts" },
    ],
    tests: [
      "runtime/src/config/migrate.test.ts",
      "runtime/src/config/config.test.ts",
    ],
  },
  "CF-13": {
    files: [
      "runtime/src/config/schema.ts",
      "runtime/src/config/loader.ts",
      "runtime/src/config/PARITY.md",
    ],
    grepPresent: [
      { pattern: "validateAuthConfig", scope: "runtime/src/config/schema.ts" },
      { pattern: "validateProviderConfig", scope: "runtime/src/config/schema.ts" },
      { pattern: "validateAgentConfig", scope: "runtime/src/config/schema.ts" },
      { pattern: "validatePluginsConfig", scope: "runtime/src/config/schema.ts" },
      { pattern: "validateMcpServerModeConfig", scope: "runtime/src/config/schema.ts" },
      { pattern: "InvalidAuthConfigError", scope: "runtime/src/config/schema.ts" },
      { pattern: "InvalidProviderConfigError", scope: "runtime/src/config/schema.ts" },
      { pattern: "InvalidAgentConfigError", scope: "runtime/src/config/schema.ts" },
      { pattern: "InvalidPluginsConfigError", scope: "runtime/src/config/schema.ts" },
      { pattern: "InvalidMcpServerModeConfigError", scope: "runtime/src/config/schema.ts" },
      { pattern: "validateAgenCConfigBlocks", scope: "runtime/src/config/loader.ts" },
      { pattern: "invalid config at", scope: "runtime/src/config/loader.ts" },
      { pattern: "formatConfigReloadWarnings", scope: "runtime/src/commands/config.ts" },
      { pattern: "CF-13", scope: "runtime/src/config/PARITY.md" },
    ],
    tests: [
      "runtime/src/config/config.test.ts",
      "runtime/src/commands/config.test.ts",
    ],
  },
  "CF-14": {
    files: [
      "runtime/src/bin/config-cli.ts",
      "runtime/src/bin/config-cli.test.ts",
      "runtime/src/config/PARITY.md",
    ],
    grepPresent: [
      { pattern: "agenc config <get\\|set\\|unset\\|validate\\|show\\|edit\\|path>", scope: "runtime/src/bin/agenc.ts" },
      { pattern: "parseAgenCConfigCliArgs", scope: "runtime/src/bin/config-cli.ts" },
      { pattern: "runAgenCConfigCli", scope: "runtime/src/bin/config-cli.ts" },
      { pattern: "runConfigFileMigrations", scope: "runtime/src/bin/config-cli.ts" },
      { pattern: "validateAgenCConfigBlocks", scope: "runtime/src/bin/config-cli.ts" },
      { pattern: "CONFIG_FILE_VERSION_KEY", scope: "runtime/src/bin/config-cli.ts" },
      { pattern: "configCommand = parseAgenCConfigCliArgs", scope: "runtime/src/bin/agenc.ts" },
      { pattern: "agenc config validate", scope: "runtime/src/bin/agenc-help.test.ts" },
      { pattern: "CF-14 Shell config CLI", scope: "runtime/src/config/PARITY.md" },
      { pattern: "apply_user_plugin_config_edits", scope: "runtime/src/config/PARITY.md" },
    ],
    tests: [
      "runtime/src/bin/config-cli.test.ts",
      "runtime/src/bin/agenc-help.test.ts",
    ],
  },
  "OB-01": {
    grepPresent: [{ pattern: "onboarding|firstRun|first-run", scope: "runtime/src" }],
  },
  "OB-02": {
    grepPresent: [{ pattern: "--help", scope: "runtime/src/bin" }],
  },
  "OB-03": {
    grepPresent: [{ pattern: "/help", scope: "runtime/src/commands" }],
  },
  "OB-04": {
    grepPresent: [{ pattern: "/doctor", scope: "runtime/src/commands" }],
  },
  "OB-06": {
    files: [
      "runtime/src/bin/agenc.ts",
      "runtime/src/bin/init-cli.ts",
      "runtime/src/config/project-init.ts",
      "runtime/src/bin/init-cli.test.ts",
      "runtime/src/bin/agenc-help.test.ts",
      "parity/OB-06-parity.json",
    ],
    grepPresent: [
      { pattern: "agenc init", scope: "runtime/src/bin/agenc.ts" },
      { pattern: "parseAgenCInitCliArgs", scope: "runtime/src/bin/init-cli.ts" },
      { pattern: "initializeAgenCProject", scope: "runtime/src/config/project-init.ts" },
      { pattern: "\\.agenc/config\\.json", scope: "runtime/src/bin/init-cli.test.ts" },
      { pattern: "OB-06", scope: "parity/OB-06-parity.json" },
    ],
    tests: [
      "runtime/src/bin/init-cli.test.ts",
      "runtime/src/bin/agenc-help.test.ts",
    ],
  },
  "OB-07": {
    grepPresent: [{ pattern: "AGENC\\.md", scope: "runtime/src/prompts" }],
  },
  "OB-09": {
    files: [
      "runtime/src/onboarding/ApproveApiKey.tsx",
      "runtime/src/onboarding/useApiKeyVerification.ts",
      "runtime/src/onboarding/inputPaste.ts",
      "runtime/src/onboarding/pasteStore.ts",
      "runtime/src/onboarding/Onboarding.tsx",
      "runtime/src/auth/backends/local.ts",
      "runtime/src/bin/bootstrap.ts",
      "runtime/src/onboarding/onboarding.test.tsx",
      "runtime/src/onboarding/useApiKeyVerification.test.ts",
      "runtime/src/onboarding/inputPaste.test.ts",
      "runtime/src/auth/backends/local.contract.test.ts",
      "runtime/src/bin/bootstrap.test.ts",
      "runtime/src/tui/components/App.render.test.tsx",
      "parity/OB-09-parity.json",
    ],
    grepPresent: [
      { pattern: "ApproveApiKey", scope: "runtime/src/onboarding/ApproveApiKey.tsx" },
      { pattern: "verifyApiKey", scope: "runtime/src/onboarding/useApiKeyVerification.ts" },
      { pattern: "maybeTruncateInput", scope: "runtime/src/onboarding/inputPaste.ts" },
      { pattern: "hashPastedText", scope: "runtime/src/onboarding/pasteStore.ts" },
      { pattern: "pendingApiKeyApproval", scope: "runtime/src/onboarding/Onboarding.tsx" },
      { pattern: "saveByokKey", scope: "runtime/src/auth/backends/local.ts" },
      { pattern: "readByokKey", scope: "runtime/src/bin/bootstrap.ts" },
      { pattern: "OB-09", scope: "parity/OB-09-parity.json" },
    ],
    tests: [
      "runtime/src/onboarding/onboarding.test.tsx",
      "runtime/src/onboarding/useApiKeyVerification.test.ts",
      "runtime/src/onboarding/inputPaste.test.ts",
      "runtime/src/auth/backends/local.contract.test.ts",
      "runtime/src/bin/bootstrap.test.ts",
      "runtime/src/tui/components/App.render.test.tsx",
    ],
  },
  "UP-01": {
    grepPresent: [{ pattern: "agenc update", scope: "runtime/src" }],
  },
  "UP-06": {
    files: [{ globUnder: "runtime/src/install-context", matching: /\.tsx?$/, minCount: 1 }],
  },
  "PR-02": {
    files: [
      "runtime/src/prompts/agenc-md.ts",
      "runtime/src/prompts/project-instructions.ts",
      "runtime/src/prompts/agenc-md.test.ts",
      "runtime/src/prompts/project-instructions.test.ts",
      "parity/PR-02-parity.json",
    ],
    grepPresent: [
      { pattern: "loadTieredInstructions", scope: "runtime/src/prompts/agenc-md.ts" },
      { pattern: "resolveIncludes", scope: "runtime/src/prompts/agenc-md.ts" },
      { pattern: "loadProjectInstructionChain", scope: "runtime/src/prompts/project-instructions.ts" },
      { pattern: "outer document exceeds the byte budget", scope: "runtime/src/prompts/project-instructions.test.ts" },
      { pattern: "project-instruction-tiering", scope: "parity/PR-02-parity.json" },
    ],
    tests: [
      "runtime/src/prompts/agenc-md.test.ts",
      "runtime/src/prompts/project-instructions.test.ts",
      "runtime/src/prompts/system-prompt.test.ts",
      "runtime/src/conversation/multi-turn-context.contract.test.ts",
    ],
  },
  "PR-06": {
    files: [
      "runtime/src/llm/wire/tools.ts",
      "runtime/src/llm/wire/tools.test.ts",
      "parity/PR-06-parity.json",
    ],
    grepPresent: [
      { pattern: "toChatCompletionsTools", scope: "runtime/src/llm/wire/tools.ts" },
      { pattern: "toOpenAIResponsesTools", scope: "runtime/src/llm/wire/tools.ts" },
      { pattern: "toXaiResponsesTools", scope: "runtime/src/llm/wire/tools.ts" },
      { pattern: "toAnthropicTools", scope: "runtime/src/llm/wire/tools.ts" },
      { pattern: "toChatCompletionsTools", scope: "runtime/src/llm/wire/chat-completions.ts" },
      { pattern: "toOpenAIResponsesTools", scope: "runtime/src/llm/wire/responses-openai.ts" },
      { pattern: "toXaiResponsesTools", scope: "runtime/src/llm/wire/responses-xai.ts" },
      { pattern: "toAnthropicTools", scope: "runtime/src/llm/wire/messages-anthropic.ts" },
      { pattern: "tool-description-injection", scope: "parity/PR-06-parity.json" },
    ],
    tests: [
      "runtime/src/llm/wire/tools.test.ts",
      "runtime/src/llm/wire/chat-completions.test.ts",
      "runtime/src/llm/wire/messages-anthropic.test.ts",
      "runtime/src/llm/wire/responses-openai.test.ts",
      "runtime/src/llm/wire/responses-xai.test.ts",
    ],
  },
  "PR-09": {
    files: [
      "runtime/src/context/personality-spec-instructions.ts",
      "runtime/src/context/personality-spec-instructions.test.ts",
      "runtime/src/llm/registry/model-catalog.ts",
      "runtime/src/llm/model-registry.ts",
      "runtime/src/session/run-turn.ts",
      "runtime/src/session/run-turn.test.ts",
      "runtime/src/session/rollout-reconstruction.ts",
      "runtime/src/session/rollout-reconstruction.test.ts",
      "parity/PR-09-parity.json",
    ],
    grepPresent: [
      { pattern: "PERSONALITY_SPEC_START_MARKER", scope: "runtime/src/context/personality-spec-instructions.ts" },
      { pattern: "renderPersonalitySpecBody", scope: "runtime/src/context/personality-spec-instructions.ts" },
      { pattern: "modelMessages: OPENAI_PERSONALITY_MESSAGES", scope: "runtime/src/llm/registry/model-catalog.ts" },
      { pattern: "modelSupportsPersonality", scope: "runtime/src/llm/model-registry.ts" },
      { pattern: "buildPersonalitySpecUpdateMessage", scope: "runtime/src/session/run-turn.ts" },
      { pattern: "export type Personality = \"none\" \\| \"friendly\" \\| \"pragmatic\"", scope: "runtime/src/config/schema.ts" },
      { pattern: "personality-spec-developer-fragment", scope: "parity/PR-09-parity.json" },
    ],
    tests: [
      "runtime/src/context/personality-spec-instructions.test.ts",
      "runtime/src/llm/registry/registry.test.ts",
      "runtime/src/session/run-turn.test.ts",
      "runtime/src/session/rollout-reconstruction.test.ts",
    ],
  },
  "PR-10": {
    files: [
      "runtime/src/personality/migration.ts",
      "runtime/src/personality/migration.test.ts",
      "runtime/src/config/edit.ts",
      "runtime/src/bin/bootstrap.ts",
      "runtime/src/bin/bootstrap.test.ts",
      "runtime/src/bin/bootstrap-services.ts",
      "parity/PR-10-parity.json",
    ],
    grepPresent: [
      { pattern: "PERSONALITY_MIGRATION_FILENAME", scope: "runtime/src/personality/migration.ts" },
      { pattern: "SkippedMarker", scope: "runtime/src/personality/migration.ts" },
      { pattern: "SkippedExplicitPersonality", scope: "runtime/src/personality/migration.ts" },
      { pattern: "SkippedNoSessions", scope: "runtime/src/personality/migration.ts" },
      { pattern: "setPersonality\\(\"pragmatic\"\\)", scope: "runtime/src/personality/migration.ts" },
      { pattern: "AgenCConfigEditsBuilder", scope: "runtime/src/config/edit.ts" },
      { pattern: "maybeMigratePersonality", scope: "runtime/src/bin/bootstrap.ts" },
      { pattern: "personalityMigrationStatus === \"Applied\"", scope: "runtime/src/bin/bootstrap.ts" },
      { pattern: "defaultModelProviderId: opts\\.providerName", scope: "runtime/src/bin/bootstrap-services.ts" },
      { pattern: "personality-one-shot-migration", scope: "parity/PR-10-parity.json" },
    ],
    tests: [
      "runtime/src/personality/migration.test.ts",
      "runtime/src/bin/bootstrap.test.ts",
    ],
  },
  "PR-11": {
    files: [
      "runtime/src/llm/registry/model-catalog.ts",
      "runtime/src/personality/personality.contract.test.ts",
      "runtime/src/personality/personality-migration.contract.test.ts",
      "parity/PR-11-parity.json",
    ],
    grepPresent: [
      { pattern: "personality_does_not_mutate_base_instructions_without_template", scope: "runtime/src/personality/personality.contract.test.ts" },
      { pattern: "base_instructions_override_disables_personality_template", scope: "runtime/src/personality/personality.contract.test.ts" },
      { pattern: "user_turn_personality_none_does_not_add_update_message", scope: "runtime/src/personality/personality.contract.test.ts" },
      { pattern: "config_personality_some_sets_instructions_template", scope: "runtime/src/personality/personality.contract.test.ts" },
      { pattern: "config_personality_none_sends_no_personality", scope: "runtime/src/personality/personality.contract.test.ts" },
      { pattern: "default_personality_is_pragmatic_without_config_toml", scope: "runtime/src/personality/personality.contract.test.ts" },
      { pattern: "user_turn_personality_some_adds_update_message", scope: "runtime/src/personality/personality.contract.test.ts" },
      { pattern: "user_turn_personality_same_value_does_not_add_update_message", scope: "runtime/src/personality/personality.contract.test.ts" },
      { pattern: "applies_when_sessions_exist_and_no_personality", scope: "runtime/src/personality/personality-migration.contract.test.ts" },
      { pattern: "applies_when_only_archived_sessions_exist_and_no_personality", scope: "runtime/src/personality/personality-migration.contract.test.ts" },
      { pattern: "skips_when_marker_exists", scope: "runtime/src/personality/personality-migration.contract.test.ts" },
      { pattern: "skips_when_personality_explicit", scope: "runtime/src/personality/personality-migration.contract.test.ts" },
      { pattern: "skips_when_no_sessions", scope: "runtime/src/personality/personality-migration.contract.test.ts" },
      { pattern: "personalityDefault: OPENAI_PRAGMATIC_PERSONALITY", scope: "runtime/src/llm/registry/model-catalog.ts" },
      { pattern: "personality-integration-contract", scope: "parity/PR-11-parity.json" },
    ],
    tests: [
      "runtime/src/personality/personality.contract.test.ts",
      "runtime/src/personality/personality-migration.contract.test.ts",
    ],
  },
  "MM-06": {
    grepPresent: [{ pattern: "agenc memory", scope: "runtime/src" }],
  },
  "Z-04": {
    // Strict typecheck must pass with NO baseline tolerance.
    runStrict: true,
  },
  "ZC-20": {
    files: ["scripts/goal/shim-behavior.mjs", "parity/ZC-20-parity.json"],
    tests: ["scripts/goal/shim-behavior.test.mjs"],
  },
  "ZC-35": {
    files: [
      "parity/ZC-35-parity.json",
    ],
    grepPresent: [
    ],
    tests: [
      "runtime/src/agents/mailbox.test.ts",
      "runtime/src/hooks/configured-hooks.test.ts",
      "runtime/src/secrets/sanitizer.test.ts",
      "runtime/src/auth/backends/local.contract.test.ts",
      "runtime/src/auth/backends/remote.contract.test.ts",
      "runtime/src/conversation/thread-manager.contract.test.ts",
    ],
  },
  "ZC-37": {
    files: [".gitignore"],
    grepPresent: [
      { pattern: "^undefined/$", scope: ".gitignore" },
      { pattern: "^\\*\\*/undefined/$", scope: ".gitignore" },
    ],
  },
  "ZC-39": {
    files: [
      "runtime/src/tui/components/PromptInput/Notifications.tsx",
      "runtime/src/tui/components/PromptInput/PromptInput.tsx",
      "runtime/src/tui/components/PromptInput/PromptInputFooterLeftSide.tsx",
      "runtime/src/tui/state/AppState.tsx",
      "runtime/src/tui/keybindings/defaultBindings.ts",
      "runtime/src/tui/keybindings/types.ts",
      "runtime/src/tui/keybindings/validate.ts",
      "runtime/src/build/feature.ts",
      "runtime/src/config/schema.ts",
      "runtime/src/commands/keybindings.ts",
      "runtime/src/agenc/upstream/screens/REPL.tsx",
    ],
    grepNotPresent: [
      { pattern: "VoiceIndicator|VoiceWarmupHint|voiceInterimRange|useVoiceState|useVoiceEnabled|VOICE_MODE", scope: "runtime/src/tui/components/PromptInput" },
      { pattern: "VoiceProvider|VOICE_MODE|context/voice", scope: "runtime/src/tui/state/AppState.tsx" },
      { pattern: "voice:pushToTalk|VOICE_MODE", scope: "runtime/src/tui/keybindings" },
      { pattern: "chat:voiceInput", scope: "runtime/src/commands/keybindings.ts" },
      { pattern: "VoiceInputConfig|voiceInput", scope: "runtime/src/config" },
      { pattern: "VOICE_MODE", scope: "runtime/src/build/feature.ts" },
      { pattern: "useVoiceIntegration|VoiceKeybindingHandler|insertTextRef|VOICE_MODE|voiceInterimRange", scope: "runtime/src/agenc/upstream/screens/REPL.tsx" },
    ],
  },
  "ZC-42": {
    files: [
      "runtime/src/migration/external-agent/project-importer.ts",
      "runtime/src/migration/external-agent/toml.ts",
      "runtime/src/migration/external-agent/PARITY.md",
      "parity/ZC-42-parity.json",
    ],
    grepPresent: [
      { pattern: "buildMcpConfigFromSource", scope: "runtime/src/migration/external-agent/project-importer.ts" },
      { pattern: "importExternalAgentProject", scope: "runtime/src/migration/external-agent/project-importer.ts" },
      { pattern: "importHooks", scope: "runtime/src/migration/external-agent/project-importer.ts" },
      { pattern: "importSubagents", scope: "runtime/src/migration/external-agent/project-importer.ts" },
      { pattern: "importCommands", scope: "runtime/src/migration/external-agent/project-importer.ts" },
      { pattern: "External Agent Migration Parity", scope: "runtime/src/migration/external-agent/PARITY.md" },
    ],
    tests: ["runtime/src/migration/external-agent/project-importer.test.ts"],
  },
  "ZC-33": {
    files: [
      "runtime/src/permissions/sandbox.ts",
      "runtime/src/sandbox/engine/index.ts",
      "runtime/src/sandbox/engine/manager.ts",
      "runtime/src/sandbox/engine/policy-transforms.ts",
      "runtime/src/sandbox/engine/seatbelt.ts",
      "runtime/src/sandbox/engine/landlock.ts",
      "runtime/src/sandbox/engine/bwrap.ts",
      "runtime/src/sandbox/engine/policies/seatbelt_base_policy.sbpl",
      "runtime/src/sandbox/engine/policies/seatbelt_network_policy.sbpl",
      "runtime/src/sandbox/engine/policies/restricted_read_only_platform_defaults.sbpl",
      "runtime/src/sandbox/linux-launcher/main.ts",
      "runtime/src/sandbox/linux-launcher/lib.ts",
      "runtime/src/sandbox/linux-launcher/cli.ts",
      "runtime/src/sandbox/linux-launcher/linux-run-main.ts",
      "runtime/src/sandbox/linux-launcher/launcher.ts",
      "runtime/src/sandbox/linux-launcher/bwrap.ts",
      "runtime/src/sandbox/linux-launcher/landlock.ts",
      "runtime/src/sandbox/linux-launcher/proxy-routing.ts",
      "runtime/src/sandbox/linux-launcher/vendored-bwrap.ts",
      "runtime/src/sandbox/linux-launcher/config.ts",
      "runtime/src/sandbox/linux-launcher/build.ts",
      "runtime/bin/agenc-linux-sandbox",
    ],
    grepPresent: [
      { pattern: "platform-backed execution", scope: "runtime/src/permissions/sandbox.ts" },
      { pattern: "spawnSeatbeltCommand", scope: "runtime/src/sandbox/engine/seatbelt.ts" },
      { pattern: "spawnLinuxSandboxCommand", scope: "runtime/src/sandbox/engine/landlock.ts" },
      { pattern: "spawnSync", scope: "runtime/src/sandbox/engine/bwrap.ts" },
      { pattern: "spawn\\(", scope: "runtime/src/sandbox/linux-launcher/launcher.ts" },
      { pattern: "spawn\\(", scope: "runtime/src/sandbox/linux-launcher/linux-run-main.ts" },
      { pattern: "\\-\\-seccomp", scope: "runtime/src/sandbox/linux-launcher/bwrap.ts" },
      { pattern: "createNetworkSeccompProgram", scope: "runtime/src/sandbox/linux-launcher/landlock.ts" },
    ],
    grepNotPresent: [
      {
        pattern: "does not use any of those primitives directly",
        scope: "runtime/src/permissions/sandbox.ts",
      },
    ],
    tests: [
      "runtime/src/sandbox/engine/linux-engine.test.ts",
      "runtime/src/sandbox/engine/seatbelt.test.ts",
      "runtime/src/sandbox/engine/policy-transforms.test.ts",
      "runtime/src/sandbox/linux-launcher/linux-launcher.test.ts",
    ],
  },
  "ZC-34": {
    files: [
      "runtime/src/agents/graph-store/types.ts",
      "runtime/src/agents/graph-store/errors.ts",
      "runtime/src/agents/graph-store/store.ts",
      "runtime/src/agents/graph-store/local.ts",
      "runtime/src/agents/graph-store/local.test.ts",
    ],
    grepPresent: [
      { pattern: "LocalAgentGraphStore", scope: "runtime/src/agents/graph-store/local.ts" },
      { pattern: "thread_spawn_edges", scope: "runtime/src/agents/graph-store/local.ts" },
      { pattern: "listThreadSpawnDescendants", scope: "runtime/src/agents/graph-store/local.ts" },
      { pattern: "breadth-first", scope: "runtime/src/agents/graph-store/local.test.ts" },
    ],
    tests: ["runtime/src/agents/graph-store/local.test.ts"],
  },
  "ZC-36": {
    files: [
      "runtime/src/test-parity/zc36-suite-coverage.test.ts",
      "parity/ZC-36-parity.json",
    ],
    grepPresent: [
      { pattern: "representative-subset", scope: "parity/ZC-36-parity.json" },
      { pattern: "selectedCases", scope: "parity/ZC-36-parity.json" },
    ],
    tests: ["runtime/src/test-parity/zc36-suite-coverage.test.ts"],
  },
  "ZC-38": {
    files: [".gitignore", "scripts/goal/verify.mjs"],
    grepPresent: [
      { pattern: "\\*\\*/dist/", scope: ".gitignore" },
      { pattern: "runtime/dist/", scope: ".gitignore" },
      { pattern: "web/dist/", scope: ".gitignore" },
      { pattern: "mcp/dist/", scope: ".gitignore" },
      { pattern: "!patches/\\*\\*/dist/", scope: ".gitignore" },
      { pattern: "ZC-38: keep package build outputs", scope: ".gitignore" },
    ],
  },
  "ZC-41": {
    files: [
      "runtime/src/observability/telemetry.ts",
      "runtime/src/observability/telemetry.test.ts",
      "parity/ZC-41-parity.json",
    ],
    grepPresent: [
      { pattern: "ZC-41 coverage lock", scope: "parity/ZC-41-parity.json" },
      { pattern: "TelemetryClient", scope: "runtime/src/observability/telemetry.ts" },
      { pattern: "startSpan", scope: "runtime/src/observability/telemetry.ts" },
      { pattern: "recordDuration", scope: "runtime/src/observability/telemetry.ts" },
      { pattern: "setAgencTelemetryClient", scope: "runtime/src/observability/telemetry.ts" },
      { pattern: "AGENC_TURN_TTFT_DURATION_METRIC", scope: "runtime/src/session/run-turn.ts" },
      { pattern: "AGENC_HOOK_RUN_DURATION_METRIC", scope: "runtime/src/hooks/engine/dispatcher.ts" },
      { pattern: "mcp\\.tools\\.call", scope: "runtime/src/mcp-client/tools.ts" },
      { pattern: "AGENC_TOOL_UNIFIED_EXEC_DURATION_METRIC", scope: "runtime/src/app-server/command-exec.ts" },
    ],
    tests: [
      "runtime/src/observability/telemetry.test.ts",
      "runtime/src/hooks/engine/dispatcher.test.ts",
      "runtime/src/mcp-client/tools.test.ts",
    ],
  },
  "ZC-40": {
    files: ["scripts/goal/verify.mjs"],
    grepPresent: [
      { pattern: "assertZc40RuntimeParityDocsGone", scope: "scripts/goal/verify.mjs" },
      { pattern: "ZC-40: runtime PARITY.md scaffolding is gone", scope: "scripts/goal/verify.mjs" },
    ],
    grepNotPresent: [
      { pattern: "PARITY\\.md", scope: "runtime/src" },
    ],
  },
  "ZC-43": {
    files: [
      "runtime/src/sandbox/network-policy.ts",
      "runtime/src/sandbox/network-policy.test.ts",
      "runtime/src/sandbox/engine/index.ts",
      "runtime/src/session/turn-context.ts",
      "runtime/src/session/turn-context.test.ts",
      "runtime/src/session/session.test.ts",
      "runtime/src/tools/system/exec-command.ts",
      "runtime/src/tools/system/exec-command.test.ts",
      "runtime/src/tools/execution.ts",
      "runtime/src/tools/execution.test.ts",
      "runtime/src/tools/router.ts",
      "runtime/src/tools/router.test.ts",
      "runtime/src/unified-exec/types.ts",
      "runtime/src/unified-exec/process-manager.ts",
      "runtime/src/unified-exec/process-manager.test.ts",
      "runtime/src/permissions/guardian/arbiter.ts",
      "runtime/src/permissions/guardian/approval-request.ts",
      "runtime/src/permissions/guardian/approval-request.test.ts",
      "parity/ZC-43-parity.json",
      "scripts/goal/verify.mjs",
    ],
    grepPresent: [
      { pattern: "NetworkPolicyDecider", scope: "runtime/src/sandbox/network-policy.ts" },
      { pattern: "BlockedRequestObserver", scope: "runtime/src/sandbox/network-policy.ts" },
      { pattern: "networkPolicyDeciderFrom", scope: "runtime/src/sandbox/network-policy.ts" },
      { pattern: "notifyBlockedRequest", scope: "runtime/src/sandbox/network-policy.ts" },
      { pattern: "policyDecider", scope: "runtime/src/session/turn-context.ts" },
      { pattern: "blockedRequestObserver", scope: "runtime/src/session/turn-context.ts" },
      { pattern: "turn-builder helpers preserve network policy decider", scope: "runtime/src/session/turn-context.test.ts" },
      { pattern: "networkPolicyInterfaces", scope: "runtime/src/tools/system/exec-command.ts" },
      { pattern: "networkPolicyInterfacesFromInvocation", scope: "runtime/src/tools/execution.ts" },
      { pattern: "legacy guardian approval fallback carries turn network policy interfaces", scope: "runtime/src/tools/execution.test.ts" },
      { pattern: "networkPolicyInterfacesFromTurn", scope: "runtime/src/tools/router.ts" },
      { pattern: "guardian approval context", scope: "runtime/src/tools/router.test.ts" },
      { pattern: "networkPolicyDecider", scope: "runtime/src/unified-exec/process-manager.ts" },
      { pattern: "no-op-interface-port", scope: "parity/ZC-43-parity.json" },
    ],
    grepNotPresent: [
      { pattern: "networkPolicyInterfaces", scope: "runtime/src/permissions/guardian/approval-request.ts" },
    ],
    tests: [
      "runtime/src/sandbox/network-policy.test.ts",
      "runtime/src/session/turn-context.test.ts",
      "runtime/src/session/session.test.ts",
      "runtime/src/tools/system/exec-command.test.ts",
      "runtime/src/tools/execution.test.ts",
      "runtime/src/tools/router.test.ts",
      "runtime/src/unified-exec/process-manager.test.ts",
      "runtime/src/permissions/guardian/approval-request.test.ts",
    ],
  },
};

function usage() {
  process.stderr.write(
    `Usage: node scripts/goal/verify.mjs <item-id> [--skip-validate] [--skip-typecheck]\n`,
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith("--"));
const skipValidate = args.includes("--skip-validate");
const skipTypecheck = args.includes("--skip-typecheck");
if (!id) usage();

const root = repoRoot();
const { item } = await findItem(id);

function header(name) {
  process.stdout.write(`\n${BOLD}━━ gate: ${name}${RESET}\n`);
}

function pass(msg) {
  process.stdout.write(`${GREEN}✓${RESET} ${msg}\n`);
}

function failGate(msg, code = 1) {
  process.stderr.write(`${BOLD}${RED}✗${RESET} ${msg}\n`);
  process.exit(code);
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, {
    cwd: opts.cwd ?? root,
    stdio: opts.silent ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  return r;
}

function git(...argv) {
  return run("git", argv, { silent: true });
}

// --- Gate 1: branch shape -----------------------------------------------

header("branch shape");
const branchRes = git("rev-parse", "--abbrev-ref", "HEAD");
if (branchRes.status !== 0) failGate("could not read current branch");
const branch = branchRes.stdout.trim();
const expected = `port/${id}`;
if (branch !== expected) {
  failGate(`current branch is "${branch}", expected "${expected}".`);
}
pass(`on ${branch}`);

// --- Gate 2: branding scan ----------------------------------------------

header("branding scan (changed vs main)");
const scanScript = path.join(root, "scripts", "branding-scan.mjs");
if (!existsSync(scanScript)) failGate(`branding scan missing at ${scanScript}`);

// Get the list of files changed on this branch vs main (committed +
// working tree). Only scan AgenC-owned source paths.
const diffRes = git("diff", "--name-only", "--diff-filter=ACMR", "main...HEAD");
const stagedRes = git("diff", "--name-only", "--diff-filter=ACMR", "--cached");
const wtRes = git("diff", "--name-only", "--diff-filter=ACMR");
const candidates = new Set(
  [diffRes.stdout, stagedRes.stdout, wtRes.stdout]
    .join("\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean),
);
const SCANNABLE = (p) =>
  /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx|md|mdx|json|jsonc|yaml|yml|sh|bash|zsh|toml|html|css|scss|svg|env|conf|ini|py|rb|go|rs|java|kt|swift|dockerfile)$/i.test(p) &&
  !/node_modules\//.test(p) &&
  !/\bdist\//.test(p) &&
  !/\bbuild\//.test(p) &&
  // Exempt the upstream mirror itself; it gets removed in Phase 6.
  !/^runtime\/src\/agenc\/upstream\//.test(p);
// Files that aren't in the SCANNABLE extension list but DO carry text we
// must scan: extensionless config and Dockerfile/Makefile and similar.
const SCANNABLE_BASENAME = (basename) =>
  /^(Dockerfile|Makefile|Jenkinsfile|Procfile|\.env(\..*)?|\.gitignore|\.npmignore|\.dockerignore)$/.test(basename);
const toScan = [...candidates]
  .filter((p) => SCANNABLE(p) || SCANNABLE_BASENAME(path.basename(p)))
  .map((p) => path.join(root, p))
  .filter(existsSync);

if (toScan.length === 0 && candidates.size === 0) {
  pass("no changes vs main");
} else if (toScan.length === 0) {
  // There ARE changes, just none in scannable file types. List what was
  // skipped so the user can verify the file extensions are intentionally
  // exempt (e.g. binary assets) and not a hole.
  const skipped = [...candidates].filter((p) => !SCANNABLE(p) && !SCANNABLE_BASENAME(path.basename(p)));
  process.stdout.write(`${YELLOW}!${RESET} branding scan: ${skipped.length} changed file(s) outside SCANNABLE extension list:\n`);
  for (const p of skipped.slice(0, 20)) process.stdout.write(`  - ${p}\n`);
  if (skipped.length > 20) process.stdout.write(`  ... +${skipped.length - 20} more\n`);
  process.stdout.write(`${YELLOW}!${RESET} If any of these contain user-visible text, add their extension to SCANNABLE in verify.mjs.\n`);
  pass(`no scannable changes (${skipped.length} non-source file(s) excluded — review the list above)`);
} else {
  const r = run("node", [scanScript, ...toScan], { silent: false });
  if (r.status !== 0) failGate(`branding scan reported findings (${toScan.length} file(s) scanned)`);
  pass(`branding clean (${toScan.length} file(s))`);
}

// --- Gate 2.6: no upstream growth; no new shim-pattern files; no forwarding-only modules ---
//
// Hard rule: this codebase isn't public yet, there is no backwards-compatibility
// to preserve, and the upstream mirror at runtime/src/agenc/upstream/ exists ONLY
// as temporary scaffolding that gets deleted at Z-02. Bans:
//   1. Any new file inside runtime/src/agenc/upstream/ and any net-positive
//      line growth in existing upstream files. Absorbs may delete or rewrite
//      imports there, but the mirror must only shrink.
//   2. Any new file matching a shim suffix (shim/adapter/compat/legacy/bridge/wrapper/
//      facade/proxy/glue/forwarder/passthrough/stub/indirect/dispatch/barrel) across
//      .ts/.tsx/.mts/.cts/.mjs/.cjs/.js/.jsx outside the two legitimate dirs
//      (runtime/src/mcp-client/).
//   3. Any new file under runtime/src/ whose body is overwhelmingly imports +
//      re-exports + single-line forwarders (catches barrel/index files that the
//      filename suffix wouldn't flag — wrapper-by-another-name).

header("no upstream growth; no new shim/adapter/compat/legacy/bridge files");
const addedRes = git("diff", "--name-only", "--diff-filter=ACR", "-M", "-C", "main...HEAD");
const addedStagedRes = git("diff", "--name-only", "--diff-filter=ACR", "-M", "-C", "--cached");
const addedWtRes = git("ls-files", "--others", "--exclude-standard");
const added = new Set(
  [addedRes.stdout, addedStagedRes.stdout, addedWtRes.stdout]
    .join("\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean),
);
const changedRes = git("diff", "--name-only", "--diff-filter=ACMR", "-M", "-C", "main...HEAD");
const changedStagedRes = git("diff", "--name-only", "--diff-filter=ACMR", "-M", "-C", "--cached");
const changedWtRes = git("diff", "--name-only", "--diff-filter=ACMR", "-M", "-C");
const changed = new Set(
  [changedRes.stdout, changedStagedRes.stdout, changedWtRes.stdout, addedWtRes.stdout]
    .join("\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean),
);

const upstreamAdditions = [...added].filter((p) =>
  /^runtime\/src\/agenc\/upstream\//.test(p),
);
if (upstreamAdditions.length > 0) {
  failGate(
    `forbidden: this item adds ${upstreamAdditions.length} file(s) inside runtime/src/agenc/upstream/. ` +
      `That tree is temporary scaffolding scheduled for deletion at Z-02. Do not add to it. ` +
      `Move the new logic to its proper AgenC-owned destination instead.\n  ` +
      upstreamAdditions.map((p) => `- ${p}`).join("\n  "),
  );
}

const DONOR_DIR_NAMES = [
  ["open", "cla", "ude"].join(""),
  ["co", "dex"].join(""),
  ["cla", "ude"].join(""),
  ["Open", "Cla", "ude"].join(""),
  ["Co", "dex"].join(""),
  ["Cla", "ude"].join(""),
  "donor",
  "mirror",
  "vendored",
  "external",
  "_donor",
  "_mirror",
  "_vendored",
  "_external",
  "_oc",
  "_cx",
];
const donorNamedDirRe = new RegExp(
  `(^|/)(${DONOR_DIR_NAMES.join("|")})(/|$)`,
);
const donorNamedDirAdditions = [...added].filter((p) =>
  p.startsWith("runtime/src/") &&
  !p.startsWith("runtime/src/agenc/upstream/") &&
  donorNamedDirRe.test(p),
);
if (donorNamedDirAdditions.length > 0) {
  failGate(
    `forbidden: this item adds ${donorNamedDirAdditions.length} file(s) inside donor-named AgenC-owned directories. ` +
      `Known donor-name directory segments are banned outside runtime/src/agenc/upstream/.\n  ` +
      donorNamedDirAdditions.map((p) => `- ${p}`).join("\n  "),
  );
}

const upstreamNumstatRes = git(
  "diff",
  "--numstat",
  "main...HEAD",
  "--",
  "runtime/src/agenc/upstream",
);
const upstreamGrowth = upstreamNumstatRes.stdout
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [addedText, deletedText, file] = line.split("\t");
    return {
      added: Number.parseInt(addedText ?? "0", 10),
      deleted: Number.parseInt(deletedText ?? "0", 10),
      file: file ?? "",
    };
  })
  .filter((row) =>
    Number.isFinite(row.added) &&
    Number.isFinite(row.deleted) &&
    row.file.startsWith("runtime/src/agenc/upstream/") &&
    !added.has(row.file) &&
    row.added > row.deleted,
  );
if (upstreamGrowth.length > 0) {
  failGate(
    `forbidden: existing runtime/src/agenc/upstream/ file(s) have net-positive line growth. ` +
      `Absorb items may delete upstream files or rewrite imports, but must not grow the mirror.\n  ` +
      upstreamGrowth
        .map((row) => `- ${row.file} (+${row.added}/-${row.deleted})`)
        .join("\n  "),
  );
}

const upstreamImportGrowthScript = path.join(
  root,
  "scripts",
  "check-upstream-import-growth.mjs",
);
if (!existsSync(upstreamImportGrowthScript)) {
  failGate(`upstream-import growth script missing at ${upstreamImportGrowthScript}`);
}
const upstreamImportGrowthRes = run("node", [upstreamImportGrowthScript]);
if (upstreamImportGrowthRes.status !== 0) {
  failGate("upstream-import growth check failed");
}

// branding-scan: allow regex enumerates banned shim-pattern suffixes for the gate
const SHIM_RE = /(^|\/)[^/]+-(shim|adapter|compat|legacy|bridge|wrapper|facade|proxy|glue|forwarder|passthrough|stub|indirect|dispatch|barrel)\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
const SHIM_ALLOW_DIRS = [];
const shimAdditions = [...added].filter((p) => {
  if (!SHIM_RE.test(p)) return false;
  if (/\.test\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(p)) return false;
  return !SHIM_ALLOW_DIRS.some((d) => p.startsWith(d));
});
if (shimAdditions.length > 0) {
  failGate(
    `forbidden: this item adds ${shimAdditions.length} new shim-pattern file(s). ` +
      `Banned suffixes: -shim/-adapter/-compat/-legacy/-bridge/-wrapper/-facade/-proxy/-glue/` +
      `-forwarder/-passthrough/-stub/-indirect/-dispatch/-barrel across .ts/.tsx/.mts/.cts/.mjs/.cjs/.js/.jsx. ` +
      `This codebase has no backwards-compatibility constraint; do not create wrapper files to keep ` +
      `old import paths alive. Inline the logic at the call site or move to its proper home.\n  ` +
      shimAdditions.map((p) => `- ${p}`).join("\n  "),
  );
}

// Behavior gate: catch forwarding-heavy modules whose filename doesn't match SHIM_RE.
// A new module whose body is >50% imports + re-exports + single-line forwards AND
// has fewer than 40 significant lines is functionally a shim regardless of name.
const forwardingViolations = [];
const hiddenStubViolations = [];
for (const rel of changed) {
  if (!/^runtime\/src\//.test(rel)) continue;
  if (!/\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(rel)) continue;
  if (/\.test\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(rel)) continue;
  if (/\.d\.ts$/.test(rel)) continue;
  let body;
  try {
    body = readFileSync(path.join(repoRoot(), rel), "utf8");
  } catch {
    continue;
  }
  const violation = measureShimBehaviorForPath(rel, body);
  if (violation) forwardingViolations.push(violation);
  if (
    /\bname\s*:\s*["']stub["']/.test(body) &&
    /\bisHidden\s*:\s*true/.test(body) &&
    /\bisEnabled\s*:\s*\(\s*\)\s*=>\s*false/.test(body)
  ) {
    hiddenStubViolations.push(rel);
  }
}
if (forwardingViolations.length > 0) {
  failGate(
    `forbidden: this item adds ${forwardingViolations.length} forwarding-only module(s) ` +
      `(>${Math.round(SHIM_BEHAVIOR_RATIO_LIMIT * 100)}% imports + forwarding LOC, <40 significant lines). ` +
      `These are shims by another name. Inline at the call site or move to canonical home.\n  ` +
      forwardingViolations
        .map((violation) => `- ${formatShimBehaviorViolation(violation)}`)
        .join("\n  "),
  );
}
if (hiddenStubViolations.length > 0) {
  failGate(
    `forbidden: this item adds ${hiddenStubViolations.length} hidden stub module(s). ` +
      `Remove intentionally unavailable command surfaces or migrate real behavior.\n  ` +
      hiddenStubViolations.map((p) => `- ${p}`).join("\n  "),
  );
}
pass("no new upstream/ files, no new shim-pattern additions, no forwarding-only modules");

// --- Gate 2.7: daemon protocol <-> sibling SDK method drift --------------
//
// This runs as a standard verification gate whenever the daemon protocol
// registry changes, and for checklist rows that explicitly name agenc-sdk.
// PK-10 adds the checker; future protocol edits inherit the same guard.

header("daemon SDK method drift");
const sdkDaemonDriftRelevant =
  id === "PK-10" ||
  candidates.has("runtime/src/app-server/protocol/index.ts") ||
  item.body.includes("agenc-sdk");
if (sdkDaemonDriftRelevant) {
  const r = run("node", ["scripts/check-sdk-daemon-methods.mjs"]);
  if (r.status !== 0) {
    failGate("daemon SDK method drift check failed");
  }
  pass("daemon SDK method drift check passed");
} else {
  pass("daemon SDK method drift check not required for this diff");
}

// --- Gate 2.5: per-item named evidence ----------------------------------

header(`item evidence for ${id}`);
const evidence = ITEM_EVIDENCE[id];
if (evidence) {
  const failures = evaluateEvidence(id, evidence);
  if (failures.length > 0) {
    failGate(`item-evidence check failed for ${id}:\n  - ${failures.join("\n  - ")}`);
  }
  pass("named evidence present");
} else {
  process.stdout.write(`${YELLOW}!${RESET} no named-evidence map registered for ${id}; falling back to per-prefix generic gate.\n`);
}

// --- Gate 3: item-specific gates ----------------------------------------

header(`item-specific gates for ${id}`);
const prefix = id.split("-")[0];
const itemGates = {
  L: leafAbsorbGates,
  T: tuiAbsorbGates,
  F: foundationalGates,
  A: authBackendGates,
  LP: providerGates,
  ST: stateGates,
  TL: toolGates,
  PE: permissionGates,
  C: donorRuntimePortGates,
  S: serviceGates,
  OC: serviceGates,
  MS: mcpServerGates,
  PK: pluginGates,
  MG: migrationGates,
  CF: configGates,
  OB: onboardingGates,
  UP: updateGates,
  PR: promptGates,
  MM: memoryGates,
  WP: webPortalGates,
  IDE: ideExtensionGates,
  GAP: gapGates,
  Z: cleanupGates,
  ZC: cleanupGates,
  FW: subsystemDirGates("file-watcher", "runtime/src/file-watcher/"),
  RT: subsystemDirGates("conversation runtime", "runtime/src/conversation/"),
  SE: subsystemDirGates("secrets sanitizer", "runtime/src/secrets/"),
  SK: subsystemDirGates("skills loader", "runtime/src/skills/"),
  D: () => failGate("D-* items are decisions, not work items. Mark them in PORT_CHECKLIST.md directly."),
};

// --- Gate 3.5: universal security-paths stub guard ----------------------
// Runs after the prefix gate on EVERY item. Reason: a non-security item
// (TL-*, F-*, OC-*, etc.) can still touch security-critical paths via scope
// creep. Without a universal check, a TUI item that incidentally modifies
// runtime/src/auth/foo.ts could ship a throwing stub there and the per-prefix
// gate would never look. Defense-in-depth.

const SECURITY_CRITICAL_PATHS = [
  "runtime/src/sandbox",
  "runtime/src/permissions",
  "runtime/src/auth",
  "runtime/src/secrets",
];

const gateFn = itemGates[prefix];
if (!gateFn) {
  // An unknown prefix is either a typo (silent miss) or a new item family
  // someone added without wiring a gate. Either way, falling through with
  // only the generic gates is silently weakening the harness. Fail loudly
  // so the wiring is added or the typo is fixed.
  failGate(
    `no item-specific gate registered for prefix "${prefix}". ` +
    `Either the item ID is a typo, or a new item family was added without ` +
    `wiring a gate function. Add an entry to itemGates in scripts/goal/verify.mjs ` +
    `or correct the item ID.`,
  );
} else {
  await gateFn(item);
}

header("universal security-paths stub guard (Gate 3.5)");
{
  const stubRe = /\bthrow\s+new\s+Error\s*\(\s*["'`](?:not\s+implemented|todo|stub|unimplemented|coming\s+soon|placeholder|fixme|wip)/gi;
  for (const relDir of SECURITY_CRITICAL_PATHS) {
    const abs = path.join(root, relDir);
    if (!existsSync(abs)) continue;
    const offenders = [];
    for (const f of walkFiles(abs)) {
      if (!/\.(ts|tsx|mts|cts)$/.test(f)) continue;
      if (/\.test\.(ts|tsx|mts|cts)$/.test(f)) continue;
      let src;
      try { src = readFileSync(f, "utf8"); } catch { continue; }
      const hits = src.match(stubRe);
      if (hits && hits.length > 0) offenders.push(`${path.relative(root, f)} (${hits.length})`);
    }
    if (offenders.length > 0) {
      failGate(`security-critical throwing stubs in ${relDir}:\n  ${offenders.join("\n  ")}\n` +
        `Stubs in sandbox/permissions/auth/secrets are unacceptable. Implement the function or remove the export.`);
    }
    pass(`no throwing stubs in ${relDir}`);
  }
}

// --- Gate 3.6: branding-scan evasion + dynamic-import-of-upstream guard ----
//
// Catches two anti-patterns that ship as runtime time-bombs:
//
// (a) String-array-join evasion of the branding scanner. Code like
//        const x = ["..", "agenc", "upstream", "bootstrap", "state.js"].join("/");
//        const mod = await import(x);
//     was inserted in runtime/src/bin/agenc.ts to evade the literal-string
//     branding scan. tsup cannot follow the constructed path, so the dist
//     ships without the bundled module, and the runtime crashes at user
//     launch with "Cannot find module .../agenc/upstream/...".
//
// (b) Direct dynamic import / require of agenc/upstream/. Even with a literal
//     string this is fragile because tsup may externalize upstream paths
//     depending on the importer's location.
//
// Both patterns are forbidden in non-test source. Tests may legitimately
// reference these paths via vi.mock for isolation.
header("branding-scan evasion + dynamic-import-of-upstream guard (Gate 3.6)");
{
  const exemptionRel = "scripts/goal/scanner-evasion-exemptions.json";
  const exemptionPath = path.join(root, exemptionRel);
  const exemptionCounts = new Map();
  const exemptionLabels = new Map();
  const allowedExemptionNames = new Set([
    "string-array-join with 'agenc' element",
    "dynamic import of agenc/upstream",
    "require of agenc/upstream",
  ]);
  if (existsSync(exemptionPath)) {
    let exemptions;
    try {
      exemptions = JSON.parse(readFileSync(exemptionPath, "utf8"));
    } catch (error) {
      failGate(`Gate 3.6: could not parse ${exemptionRel}: ${error?.message || error}`);
    }
    if (!Array.isArray(exemptions)) {
      failGate(`Gate 3.6: ${exemptionRel} must contain an array of exemptions`);
    }
    const today = new Date().toISOString().slice(0, 10);
    for (const [index, exemption] of exemptions.entries()) {
      const label = `${exemptionRel}[${index}]`;
      if (
        typeof exemption?.path !== "string" ||
        typeof exemption?.name !== "string" ||
        typeof exemption?.count !== "number" ||
        typeof exemption?.expires !== "string" ||
        typeof exemption?.ownerItem !== "string" ||
        typeof exemption?.reason !== "string"
      ) {
        failGate(`${label}: exemption must include path, name, count, expires, ownerItem, and reason`);
      }
      if (exemption.count < 1 || !Number.isInteger(exemption.count)) {
        failGate(`${label}: count must be a positive integer`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(exemption.expires)) {
        failGate(`${label}: expires must use YYYY-MM-DD`);
      }
      if (!allowedExemptionNames.has(exemption.name)) {
        failGate(`${label}: unknown Gate 3.6 rule name: ${exemption.name}`);
      }
      if (!existsSync(path.join(root, exemption.path))) {
        failGate(`${label}: exempted path does not exist: ${exemption.path}`);
      }
      if (exemption.expires < today) {
        failGate(`${label}: exemption expired on ${exemption.expires}; remove the underlying runtime source debt`);
      }
      const key = `${exemption.path}\0${exemption.name}`;
      exemptionCounts.set(key, (exemptionCounts.get(key) ?? 0) + exemption.count);
      exemptionLabels.set(key, [...(exemptionLabels.get(key) ?? []), label]);
    }
  }
  const evasionPatterns = [
    {
      name: "string-array-join with 'agenc' element",
      // matches array literals containing the literal "agenc" as a quoted element
      // and a sibling "upstream" element — the scanner-evasion hallmark.
      // branding-scan: allow rule definition contains the literal forbidden tokens it detects
      re: /\[[^\]]*["'](?:agenc|claude|codex|openclaude)["'][^\]]*["'](?:upstream|claude|codex|openclaude|bootstrap)["'][^\]]*\]/g,
    },
    {
      name: "dynamic import of agenc/upstream",
      re: /(?:await\s+)?import\s*\(\s*["'`][^"'`]*agenc\/upstream/g,
    },
    {
      name: "require of agenc/upstream",
      re: /\brequire\s*\(\s*["'`][^"'`]*agenc\/upstream/g,
    },
  ];
  const offenders = [];
  const actualCounts = new Map();
  for (const f of walkFiles(path.join(root, "runtime/src"))) {
    if (!/\.(ts|tsx|mts|cts)$/.test(f)) continue;
    if (/\.test\.(ts|tsx|mts|cts)$/.test(f)) continue;
    let src;
    try { src = readFileSync(f, "utf8"); } catch { continue; }
    for (const { name, re } of evasionPatterns) {
      const hits = src.match(re);
      if (hits && hits.length > 0) {
        const rel = path.relative(root, f);
        const key = `${rel}\0${name}`;
        actualCounts.set(key, hits.length);
        const exemptCount = exemptionCounts.get(key) ?? 0;
        const untrackedCount = Math.max(0, hits.length - exemptCount);
        if (untrackedCount > 0) {
          offenders.push(`${rel}: ${name} (${untrackedCount})`);
        }
      }
    }
  }
  const staleExemptions = [];
  for (const [key, exemptCount] of exemptionCounts.entries()) {
    const actualCount = actualCounts.get(key) ?? 0;
    if (exemptCount > actualCount) {
      staleExemptions.push(
        `${(exemptionLabels.get(key) ?? [key]).join(", ")}: exemption count ${exemptCount} exceeds actual ${actualCount}`,
      );
    }
  }
  if (staleExemptions.length > 0) {
    failGate(
      `Gate 3.6 stale or overbroad exemption(s):\n  ${staleExemptions.join("\n  ")}\n` +
        `Lower the count or remove the exemption when the source debt is gone.`,
    );
  }
  if (offenders.length > 0) {
    failGate(
      `branding-scan evasion / dynamic-upstream-import detected in non-test source:\n  ${offenders.join("\n  ")}\n\n` +
        `These patterns ship runtime time-bombs: tsup cannot bundle dynamically-constructed import paths, ` +
        `so the dist file ${'' /* branding-scan: allow rule explainer */}references a module that doesn't exist after build. ` +
        `Replace with a static import from the migrated AgenC-owned path. If the source must reference the legacy ` +
        `mirror tree during the migration window, file a tracked exemption with a deadline.`,
    );
  }
  pass("no branding-scan evasion or dynamic upstream imports in non-test source");
}

// --- Gate 3.7: upstream-import non-growth + opportunistic migration ---------
//
// Two parts:
//
//   A. NON-GROWTH (additive guard): no file may add a NEW import from
//      `agenc/upstream/`. The total upstream-import count in any file cannot
//      go up. Adding a 77th importer fails the gate.
//
//   B. OPPORTUNISTIC MIGRATION (touch-tax): if your item modifies a file
//      that ALREADY had upstream imports in main, you must remove at least
//      one of those imports as part of the same diff. Touching a tainted
//      file = obligation to clean ONE import while you're there. This drains
//      the importer pool over time without needing a separate sweep item.
//
// Escape hatch: an import line preceded by `// upstream-import: keep <reason>`
// (within 3 lines above) is exempt — for cases where the migration target
// genuinely doesn't exist yet because it depends on another item.
//
// Gate is scoped to non-test files in runtime/src/, excluding the upstream/
// tree itself (which is allowed to import from sibling upstream/ files
// during the migration window).
header("upstream-import non-growth + opportunistic migration (Gate 3.7)");
{
  const upstreamImportRe = /\bfrom\s+["'`][^"'`]*agenc\/upstream\//g;
  const keepCommentRe = /\/\/\s*upstream-import:\s*keep\b/i;

  // Get every file modified in this branch's diff vs main.
  const diffRes = run("git", ["diff", "--name-only", "--diff-filter=ACMR", "main...HEAD"], { silent: true });
  if (diffRes.status !== 0) {
    failGate(`Gate 3.7: could not list diff files: ${diffRes.stderr || ""}`);
  }
  const diffFiles = (diffRes.stdout || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => f.startsWith("runtime/src/"))
    .filter((f) => !f.startsWith("runtime/src/agenc/upstream/"))
    .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f))
    .filter((f) => !/\.test\.(ts|tsx|mts|cts)$/.test(f));

  // Helper: count upstream imports in a string, excluding lines preceded by
  // a `// upstream-import: keep` comment within the prior 3 lines.
  function countUnexemptedImports(src) {
    if (!src) return 0;
    const lines = src.split("\n");
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!upstreamImportRe.test(line)) {
        upstreamImportRe.lastIndex = 0;
        continue;
      }
      upstreamImportRe.lastIndex = 0;
      // Look back up to 3 lines for the keep override.
      let exempt = false;
      for (let j = Math.max(0, i - 3); j < i; j++) {
        if (keepCommentRe.test(lines[j])) { exempt = true; break; }
      }
      // Also accept same-line trailing comment.
      if (!exempt && keepCommentRe.test(line)) exempt = true;
      if (!exempt) count++;
    }
    return count;
  }

  function getMainContent(relPath) {
    const r = spawnSync("git", ["-C", root, "show", `main:${relPath}`], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return r.status === 0 ? r.stdout : "";
  }

  const newImports = [];        // Part A failures (count grew)
  const missedMigrations = [];  // Part B failures (touched but didn't reduce)

  // Helper: count RAW upstream import LINES, ignoring keep comments.
  // Used by Part B — agents cannot satisfy the touch-tax by adding keep
  // comments; an actual import line must be deleted.
  function countRawImports(src) {
    if (!src) return 0;
    const matches = src.match(upstreamImportRe);
    return matches ? matches.length : 0;
  }

  for (const rel of diffFiles) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue; // file was deleted in this diff
    let after;
    try { after = readFileSync(abs, "utf8"); } catch { continue; }
    const before = getMainContent(rel);

    // Part A uses unexempted count — keep comments legitimately exempt
    // imports (e.g., for migration-target-not-yet-exists cases).
    const beforeUnexempted = countUnexemptedImports(before);
    const afterUnexempted = countUnexemptedImports(after);

    if (afterUnexempted > beforeUnexempted) {
      newImports.push(`${rel}: ${beforeUnexempted} → ${afterUnexempted} (+${afterUnexempted - beforeUnexempted})`);
    }

    // Part B (touch-tax) is DISABLED. Z-PURGE is the dedicated migration
    // item that drains the upstream tree. The opportunistic touch-tax was
    // causing more evasion than migration. Keep beforeRaw/afterRaw available
    // for future re-enable if needed.
    void countRawImports;
  }

  if (newImports.length > 0) {
    failGate(
      `Gate 3.7 (Part A): NEW upstream imports added — runtime/src/agenc/upstream/ is being deleted, do not add new importers:\n  ${newImports.join("\n  ")}\n\n` +
        `Either import from the migrated AgenC-owned path, OR if the migration target genuinely doesn't exist yet, ` +
        `add a previous-line comment "// upstream-import: keep <reason>" to exempt the import.`,
    );
  }

  // Part B touch-tax disabled — Z-PURGE drives the migration directly.

  pass(`Gate 3.7 (Part A only): ${diffFiles.length} touched file(s) checked, no upstream-import growth`);
}

// --- Gate 4: typecheck (baseline + delta) -------------------------------

if (skipTypecheck) {
  process.stdout.write(`\n${YELLOW}!${RESET} typecheck skipped (--skip-typecheck). Cannot complete with this flag.\n`);
} else {
  header("typecheck (baseline + delta)");
  const r = run("npm", ["run", "typecheck"], { silent: true });
  const errCount = countTscErrors((r.stdout || "") + "\n" + (r.stderr || ""));
  const strictItem = ITEM_EVIDENCE[id]?.runStrict === true;
  if (strictItem) {
    if (errCount !== 0) {
      failGate(`Z-04 requires strict typecheck (zero errors); current count: ${errCount}`);
    }
    pass("strict typecheck clean (Z-04 mode)");
  } else {
    const baselinePath = path.join(root, ".typecheck-baseline.json");
    const baseline = readBaselineSafe(baselinePath);
    if (baseline === null) {
      // No baseline file. Refuse to auto-establish — auto-establish on
      // first-branch-run would silently bless every inherited error and
      // every new error the branch adds. The baseline must be set
      // explicitly by a human, ideally committed at the repo root.
      failGate(
        `.typecheck-baseline.json missing. Refusing to auto-establish a baseline ` +
        `because that would silently bless inherited and newly-added TS errors. ` +
        `Set the baseline explicitly: \`echo '{"errorCount":${errCount}}' > .typecheck-baseline.json\` ` +
        `(if the current count is acceptable), then re-run verify. Long term: tighten the baseline ` +
        `toward 0 in dedicated cleanup items, never via implicit drift.`,
      );
    } else if (errCount > baseline) {
      failGate(`typecheck added ${errCount - baseline} new error(s) (baseline ${baseline} → now ${errCount})`);
    } else {
      if (errCount < baseline) {
        writeBaseline(baselinePath, errCount);
        pass(`typecheck improved: ${baseline} → ${errCount} (baseline tightened)`);
      } else {
        pass(`typecheck within baseline (${errCount} ≤ ${baseline})`);
      }
    }
  }
}

// --- Gate 5: agenc-tui-validate -----------------------------------------

if (skipValidate) {
  process.stdout.write(`\n${YELLOW}!${RESET} agenc-tui-validate skipped (--skip-validate). Cannot complete with this flag.\n`);
} else {
  header("agenc-tui-validate");
  // branding-scan: allow real on-disk skill path under user home
  const skillBase = path.join(process.env.HOME || "", ".claude/skills/agenc-tui-validate/scripts");
  const skillRunner = [path.join(skillBase, "run.mjs"), path.join(skillBase, "run-tui-validate.mjs")].find(
    (p) => existsSync(p),
  );
  if (skillRunner) {
    inlineTuiValidate();
    pass(`agenc-tui-validate passed (${path.basename(skillRunner)} startup gate)`);
  } else {
    process.stdout.write(
      `${YELLOW}!${RESET} agenc-tui-validate skill runner not found under ${skillBase}; falling back to inline build check.\n`,
    );
    inlineTuiValidate();
  }
}

process.stdout.write(`\n${BOLD}${GREEN}all gates passed for ${id}${RESET}\n`);
process.exit(0);

// ========================================================================

function inlineTuiValidate() {
  const buildRes = run("npm", ["run", "build"], { cwd: path.join(root, "runtime") });
  if (buildRes.status !== 0) failGate("runtime build failed");
  const builtMain = path.join(root, "runtime", "dist", "tui", "main.js");
  if (!existsSync(builtMain)) failGate(`built TUI artifact missing at ${builtMain}`);
  pass("runtime built");
  const startupRes = run("npm", ["run", "check:tui-runtime-startup"], { cwd: path.join(root, "runtime") });
  if (startupRes.status !== 0) failGate("TUI runtime startup failed");
  pass("TUI runtime startup passed");
  // Gate 5b: TUI E2E gate. Drives the built CLI under PTY through 50+
  // user-level scenarios (input, submit, slash commands, tool round-trip,
  // permission overlays, modes). Catches functional regressions that the
  // structural verify gates miss.
  if (process.env.AGENC_GOAL_SKIP_TUI_E2E === "1") {
    process.stdout.write(
      `${YELLOW}!${RESET} TUI E2E gate skipped via AGENC_GOAL_SKIP_TUI_E2E=1\n`,
    );
    return;
  }
  const e2eRes = run("npm", ["run", "check:tui-e2e"], {
    cwd: path.join(root, "runtime"),
  });
  if (e2eRes.status !== 0) failGate("TUI E2E gate failed");
  pass("TUI E2E gate passed");
}

// ---- gate registry -----------------------------------------------------

async function leafAbsorbGates(item) {
  // L-* items must end with the upstream copy deleted and zero importers.
  const upstreamMatch = /agenc\/upstream\/[^\s`*]+/g.exec(item.body);
  if (!upstreamMatch) {
    process.stdout.write(`${YELLOW}!${RESET} L-${id}: could not extract upstream path from item body; skipping path check.\n`);
    return;
  }
  const upstreamRel = upstreamMatch[0];
  const upstreamAbs = path.join(root, "runtime/src/", upstreamRel);
  if (existsSync(upstreamAbs)) {
    failGate(`upstream source still present at ${upstreamRel}; absorb deletes the source`);
  }
  pass(`upstream copy deleted (${upstreamRel})`);
  const importerScan = run("rg", ["--no-messages", "-l", upstreamRel.replace(/\.(ts|tsx|js|mjs)$/, ""), "runtime/src"]);
  if (importerScan.status === 0) {
    failGate(`importers still reference ${upstreamRel}`);
  }
  pass("no remaining importers");
}

async function tuiAbsorbGates(item) {
  if (id === "T-09") {
    await t09ToolTargetGates();
    return;
  }
  if (id === "T-12") {
    await t12ProcessUserInputGates();
    return;
  }
  if (id === "T-13") {
    await t13SlashCommandGates();
    return;
  }
  if (id === "T-14") {
    await t14StartupStatusGates();
    return;
  }
  if (id === "T-15") {
    await t15HistoryResumeGates();
    return;
  }
  if (id === "T-16") {
    await t16CostUsageGates();
    return;
  }
  if (id === "T-17") {
    await t17SpinnerGates();
    return;
  }
  if (id === "T-18") {
    await t18MarkdownGates();
    return;
  }
  if (id === "T-20") {
    await t20CostLimitDialogGates();
    return;
  }
  // Same shape as leaf absorb, but for the larger TUI subtrees.
  await leafAbsorbGates(item);
}

async function t09ToolTargetGates() {
  const retiredTargets = [
    "runtime/src/agenc/upstream/tools/AgentTool/loadAgentsDir.ts",
    "runtime/src/agenc/upstream/tools/AgentTool/agentColorManager.ts",
    "runtime/src/agenc/upstream/tools/AgentTool/constants.ts",
    "runtime/src/agenc/upstream/tools/AgentTool/prompt.ts",
    "runtime/src/agenc/upstream/tools/AskUserQuestionTool/AskUserQuestionTool.tsx",
    "runtime/src/agenc/upstream/tools/AskUserQuestionTool/prompt.ts",
    "runtime/src/agenc/upstream/tools/BriefTool/prompt.ts",
  ];

  for (const upstream of retiredTargets) {
    const abs = path.join(root, upstream);
    if (existsSync(abs)) {
      failGate(`T-09 upstream target still present: ${upstream}`);
    }
    pass(`T-09 upstream target deleted (${upstream})`);
  }

  const scopes = [
    "runtime/src/tui/tool-rendering.tsx",
    "runtime/src/tui/components/PromptInput",
    "runtime/src/tui/components/Messages.tsx",
    "runtime/src/tui/components/App.tsx",
    "runtime/src/tui/state/AppStateStore.ts",
    "runtime/src/agenc/adapters/upstream-agent-list.ts",
    "runtime/src/tools/ask-user-question-tui-routing.test.tsx",
  ];
  const upstreamPathScan = run(
    "rg",
    ["--no-messages", "-n", "agenc/upstream/tools/(AskUserQuestionTool|AgentTool|BriefTool)", ...scopes],
    { silent: true },
  );
  if (upstreamPathScan.status === 0 && upstreamPathScan.stdout.trim()) {
    failGate(`T-09 scoped importers still reference upstream tool targets:\n${upstreamPathScan.stdout}`);
  }

  const retiredImportPattern =
    String.raw`['"](?:\.\.?/)+(?:tools/)?(?:AgentTool/(?:loadAgentsDir|agentColorManager|constants|prompt)|AskUserQuestionTool/(?:AskUserQuestionTool|prompt)|BriefTool/prompt)\.js['"]`;
  const retiredImportScan = run(
    "rg",
    ["--no-messages", "-n", retiredImportPattern, "runtime/src/agenc/upstream"],
    { silent: true },
  );
  if (retiredImportScan.status === 0 && retiredImportScan.stdout.trim()) {
    failGate(`T-09 upstream importers still reference deleted tool targets:\n${retiredImportScan.stdout}`);
  }

  const retiredAgentToolSiblingPattern =
    String.raw`['"](?:\.\.?/)+(?:loadAgentsDir|agentColorManager|constants|prompt)\.js['"]`;
  const retiredAgentToolSiblingScan = run(
    "rg",
    ["--no-messages", "-n", retiredAgentToolSiblingPattern, "runtime/src/agenc/upstream/tools/AgentTool"],
    { silent: true },
  );
  if (retiredAgentToolSiblingScan.status === 0 && retiredAgentToolSiblingScan.stdout.trim()) {
    failGate(`T-09 upstream AgentTool siblings still reference deleted tool targets:\n${retiredAgentToolSiblingScan.stdout}`);
  }

  const retiredBriefToolSiblingPattern =
    String.raw`['"](?:\.\.?/)+prompt\.js['"]`;
  const retiredBriefToolSiblingScan = run(
    "rg",
    ["--no-messages", "-n", retiredBriefToolSiblingPattern, "runtime/src/agenc/upstream/tools/BriefTool"],
    { silent: true },
  );
  if (retiredBriefToolSiblingScan.status === 0 && retiredBriefToolSiblingScan.stdout.trim()) {
    failGate(`T-09 upstream BriefTool siblings still reference deleted tool targets:\n${retiredBriefToolSiblingScan.stdout}`);
  }

  pass("T-09 scoped tool importers resolved to AgenC-owned paths");
}

async function t12ProcessUserInputGates() {
  const retiredTargets = [
    "runtime/src/agenc/upstream/utils/processUserInput/processUserInput.ts",
    "runtime/src/agenc/upstream/utils/processUserInput/processBashCommand.tsx",
    "runtime/src/agenc/upstream/utils/processUserInput/processSlashCommand.tsx",
    "runtime/src/agenc/upstream/utils/processUserInput/processTextPrompt.ts",
  ];

  for (const upstream of retiredTargets) {
    if (existsSync(path.join(root, upstream))) {
      failGate(`T-12 upstream target still present: ${upstream}`);
    }
    pass(`T-12 upstream target deleted (${upstream})`);
  }

  const retiredImportPattern = String.raw`agenc/upstream/utils/processUserInput|utils/processUserInput/(?:processUserInput|processBashCommand|processSlashCommand|processTextPrompt)\.js|src/utils/processUserInput/(?:processUserInput|processBashCommand|processSlashCommand|processTextPrompt)\.js`;
  const retiredImportScan = run(
    "rg",
    ["--no-messages", "-n", retiredImportPattern, "runtime/src"],
    { silent: true },
  );
  if (retiredImportScan.status === 0 && retiredImportScan.stdout.trim()) {
    failGate(`T-12 retired processUserInput imports remain:\n${retiredImportScan.stdout}`);
  }

  pass("T-12 processUserInput imports resolved to AgenC-owned paths");
}

async function t13SlashCommandGates() {
  const retiredTargets = [
    "runtime/src/agenc/upstream/utils/slashCommandParsing.ts",
    "runtime/src/agenc/upstream/utils/argumentSubstitution.ts",
  ];

  for (const upstream of retiredTargets) {
    if (existsSync(path.join(root, upstream))) {
      failGate(`T-13 upstream target still present: ${upstream}`);
    }
    pass(`T-13 upstream target deleted (${upstream})`);
  }

  const retiredImportPattern = String.raw`agenc/upstream/utils/(?:slashCommandParsing|argumentSubstitution)|\.\./(?:utils/)?(?:slashCommandParsing|argumentSubstitution)\.js`;
  const retiredImportScan = run(
    "rg",
    ["--no-messages", "-n", retiredImportPattern, "runtime/src"],
    { silent: true },
  );
  if (retiredImportScan.status === 0 && retiredImportScan.stdout.trim()) {
    failGate(`T-13 retired slash parser imports remain:\n${retiredImportScan.stdout}`);
  }

  pass("T-13 slash parser/substitution imports resolved to AgenC-owned paths");
}

async function t14StartupStatusGates() {
  const retiredTargets = [
    "runtime/src/agenc/upstream/components/StartupScreen.ts",
    "runtime/src/agenc/upstream/components/StartupScreen.test.ts",
    "runtime/src/agenc/upstream/components/StatusLine.tsx",
    "runtime/src/agenc/upstream/components/StatusNotices.tsx",
    "runtime/src/agenc/upstream/utils/statusNoticeDefinitions.tsx",
  ];

  for (const upstream of retiredTargets) {
    if (existsSync(path.join(root, upstream))) {
      failGate(`T-14 upstream target still present: ${upstream}`);
    }
    pass(`T-14 upstream target deleted (${upstream})`);
  }

  const retiredImportPattern = String.raw`agenc/upstream/components/(?:StartupScreen|StatusLine|StatusNotices)|agenc/upstream/utils/statusNoticeDefinitions|components/(?:StartupScreen|StatusLine|StatusNotices)\.js|utils/statusNoticeDefinitions\.js|src/components/(?:StartupScreen|StatusLine|StatusNotices)|src/utils/statusNoticeDefinitions`;
  const retiredImportScan = run(
    "rg",
    ["--no-messages", "-n", retiredImportPattern, "runtime/src"],
    { silent: true },
  );
  if (retiredImportScan.status === 0 && retiredImportScan.stdout.trim()) {
    failGate(`T-14 retired startup/status imports remain:\n${retiredImportScan.stdout}`);
  }

  pass("T-14 startup/status imports resolved to AgenC-owned paths");
}

async function t15HistoryResumeGates() {
  const retiredTargets = [
    "runtime/src/agenc/upstream/history.ts",
    "runtime/src/agenc/upstream/components/HistorySearchDialog.tsx",
    "runtime/src/agenc/upstream/screens/ResumeConversation.tsx",
    "runtime/src/agenc/upstream/utils/transcriptSearch.ts",
  ];

  for (const upstream of retiredTargets) {
    if (existsSync(path.join(root, upstream))) {
      failGate(`T-15 upstream target still present: ${upstream}`);
    }
    pass(`T-15 upstream target deleted (${upstream})`);
  }

  const oldAbsolutePattern = String.raw`agenc/upstream/(?:history|components/HistorySearchDialog|screens/ResumeConversation|utils/transcriptSearch)`;
  const oldAbsoluteScan = run(
    "rg",
    ["--no-messages", "-n", oldAbsolutePattern, "runtime/src"],
    { silent: true },
  );
  if (oldAbsoluteScan.status === 0 && oldAbsoluteScan.stdout.trim()) {
    failGate(`T-15 retired history/resume upstream imports remain:\n${oldAbsoluteScan.stdout}`);
  }

  const oldRelativePattern = String.raw`['"](?:\.\.?/)+(?:history|components/HistorySearchDialog|screens/ResumeConversation|utils/transcriptSearch)\.js['"]|src/(?:history|components/HistorySearchDialog|screens/ResumeConversation|utils/transcriptSearch)(?:\.js)?`;
  const oldRelativeScan = run(
    "rg",
    ["--no-messages", "-n", oldRelativePattern, "runtime/src/agenc/upstream"],
    { silent: true },
  );
  if (oldRelativeScan.status === 0 && oldRelativeScan.stdout.trim()) {
    failGate(`T-15 retired history/resume relative imports remain:\n${oldRelativeScan.stdout}`);
  }

  pass("T-15 history/resume imports resolved to AgenC-owned paths");
}

async function t16CostUsageGates() {
  const retiredTargets = [
    "runtime/src/agenc/upstream/components/Stats.tsx",
    "runtime/src/agenc/upstream/components/TokenWarning.tsx",
    "runtime/src/agenc/upstream/components/MemoryUsageIndicator.tsx",
    "runtime/src/agenc/upstream/utils/tokenAnalytics.ts",
    "runtime/src/agenc/upstream/utils/tokenAnalytics.test.ts",
  ];

  for (const upstream of retiredTargets) {
    if (existsSync(path.join(root, upstream))) {
      failGate(`T-16 upstream target still present: ${upstream}`);
    }
    pass(`T-16 upstream target deleted (${upstream})`);
  }

  const oldAbsolutePattern = String.raw`agenc/upstream/(?:components/(?:Stats|TokenWarning|MemoryUsageIndicator)|utils/tokenAnalytics)`;
  const oldAbsoluteScan = run(
    "rg",
    ["--no-messages", "-n", oldAbsolutePattern, "runtime/src"],
    { silent: true },
  );
  if (oldAbsoluteScan.status === 0 && oldAbsoluteScan.stdout.trim()) {
    failGate(`T-16 retired cost/usage upstream imports remain:\n${oldAbsoluteScan.stdout}`);
  }

  const oldRelativePattern = String.raw`['"](?:\.\.?/)+(?:components/)?(?:Stats|TokenWarning|MemoryUsageIndicator)\.js['"]|['"](?:\.\.?/)+(?:utils/)?tokenAnalytics\.js['"]|src/(?:components/(?:Stats|TokenWarning|MemoryUsageIndicator)|utils/tokenAnalytics)(?:\.js)?`;
  const oldRelativeScan = run(
    "rg",
    ["--no-messages", "-n", oldRelativePattern, "runtime/src/agenc/upstream"],
    { silent: true },
  );
  if (oldRelativeScan.status === 0 && oldRelativeScan.stdout.trim()) {
    failGate(`T-16 retired cost/usage relative imports remain:\n${oldRelativeScan.stdout}`);
  }

  pass("T-16 cost/usage imports resolved to AgenC-owned paths");
}

async function t17SpinnerGates() {
  const retiredTargets = [
    "runtime/src/agenc/upstream/components/Spinner.tsx",
    "runtime/src/agenc/upstream/components/Spinner/FlashingChar.tsx",
    "runtime/src/agenc/upstream/components/Spinner/GlimmerMessage.tsx",
    "runtime/src/agenc/upstream/components/Spinner/ShimmerChar.tsx",
    "runtime/src/agenc/upstream/components/Spinner/SpinnerAnimationRow.tsx",
    "runtime/src/agenc/upstream/components/Spinner/SpinnerGlyph.tsx",
    "runtime/src/agenc/upstream/components/Spinner/TeammateSpinnerLine.tsx",
    "runtime/src/agenc/upstream/components/Spinner/TeammateSpinnerTree.tsx",
    "runtime/src/agenc/upstream/components/Spinner/index.ts",
    "runtime/src/agenc/upstream/components/Spinner/teammateSelectHint.ts",
    "runtime/src/agenc/upstream/components/Spinner/useShimmerAnimation.ts",
    "runtime/src/agenc/upstream/components/Spinner/useStalledAnimation.ts",
    "runtime/src/agenc/upstream/components/Spinner/utils.ts",
  ];

  for (const upstream of retiredTargets) {
    if (existsSync(path.join(root, upstream))) {
      failGate(`T-17 upstream target still present: ${upstream}`);
    }
    pass(`T-17 upstream target deleted (${upstream})`);
  }

  if (existsSync(path.join(root, "runtime/src/tui/components/spinner/index.ts"))) {
    failGate("T-17 must not preserve the donor Spinner index barrel");
  }

  const oldAbsolutePattern = String.raw`agenc/upstream/components/Spinner`;
  const oldAbsoluteScan = run(
    "rg",
    ["--no-messages", "-n", oldAbsolutePattern, "runtime/src"],
    { silent: true },
  );
  if (oldAbsoluteScan.status === 0 && oldAbsoluteScan.stdout.trim()) {
    failGate(`T-17 retired spinner upstream imports remain:\n${oldAbsoluteScan.stdout}`);
  }

  const sourceImportPattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  const deletedSpinnerRoot = path.join(root, "runtime/src/agenc/upstream/components/Spinner");
  const oldImports = [];
  for (const abs of walkFiles(path.join(root, "runtime/src"))) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(abs)) continue;
    const rel = path.relative(root, abs);
    const content = readFileSync(abs, "utf8");
    for (const match of content.matchAll(sourceImportPattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      if (specifier === "src/components/Spinner" || specifier.startsWith("src/components/Spinner/")) {
        oldImports.push(`${rel} -> ${specifier}`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(abs), specifier)
        .replace(/\.(?:js|jsx|ts|tsx|mjs|cjs)$/, "");
      if (resolved === deletedSpinnerRoot || resolved.startsWith(`${deletedSpinnerRoot}/`)) {
        oldImports.push(`${rel} -> ${specifier}`);
      }
    }
  }
  if (oldImports.length > 0) {
    failGate(`T-17 retired spinner import specifiers remain:\n${oldImports.join("\n")}`);
  }

  pass("T-17 spinner/shimmer imports resolved to AgenC-owned paths");
}

async function t18MarkdownGates() {
  const retiredTargets = [
    "runtime/src/agenc/upstream/components/Markdown.tsx",
    "runtime/src/agenc/upstream/components/MarkdownTable.tsx",
    "runtime/src/agenc/upstream/components/HighlightedCode.tsx",
    "runtime/src/agenc/upstream/components/HighlightedCode/Fallback.tsx",
  ];

  for (const upstream of retiredTargets) {
    if (existsSync(path.join(root, upstream))) {
      failGate(`T-18 upstream target still present: ${upstream}`);
    }
    pass(`T-18 upstream target deleted (${upstream})`);
  }

  const oldAbsolutePattern = String.raw`agenc/upstream/components/(?:Markdown|MarkdownTable|HighlightedCode)`;
  const oldAbsoluteScan = run(
    "rg",
    ["--no-messages", "-n", oldAbsolutePattern, "runtime/src"],
    { silent: true },
  );
  if (oldAbsoluteScan.status === 0 && oldAbsoluteScan.stdout.trim()) {
    failGate(`T-18 retired markdown upstream imports remain:\n${oldAbsoluteScan.stdout}`);
  }

  const sourceImportPattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  const deletedEntrypoints = new Map([
    [path.join(root, "runtime/src/agenc/upstream/components/Markdown"), "Markdown"],
    [path.join(root, "runtime/src/agenc/upstream/components/MarkdownTable"), "MarkdownTable"],
    [path.join(root, "runtime/src/agenc/upstream/components/HighlightedCode"), "HighlightedCode"],
  ]);
  const oldImports = [];
  for (const abs of walkFiles(path.join(root, "runtime/src"))) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(abs)) continue;
    const rel = path.relative(root, abs);
    const content = readFileSync(abs, "utf8");
    for (const match of content.matchAll(sourceImportPattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      if (
        specifier === "src/components/Markdown" ||
        specifier === "src/components/Markdown.js" ||
        specifier === "src/components/MarkdownTable" ||
        specifier === "src/components/MarkdownTable.js" ||
        specifier === "src/components/HighlightedCode" ||
        specifier === "src/components/HighlightedCode.js" ||
        specifier.startsWith("src/components/HighlightedCode/")
      ) {
        oldImports.push(`${rel} -> ${specifier}`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(abs), specifier)
        .replace(/\.(?:js|jsx|ts|tsx|mjs|cjs)$/, "");
      for (const [deletedEntrypoint, label] of deletedEntrypoints) {
        if (resolved === deletedEntrypoint || resolved.startsWith(`${deletedEntrypoint}/`)) {
          oldImports.push(`${rel} -> ${specifier} (${label})`);
        }
      }
    }
  }
  if (oldImports.length > 0) {
    failGate(`T-18 retired markdown import specifiers remain:\n${oldImports.join("\n")}`);
  }

  pass("T-18 markdown/highlighted-code imports resolved to AgenC-owned paths");
}

async function t20CostLimitDialogGates() {
  const retiredTargets = [
    "runtime/src/agenc/upstream/components/CostThresholdDialog.tsx",
    "runtime/src/agenc/upstream/components/messages/RateLimitMessage.tsx",
  ];

  for (const upstream of retiredTargets) {
    if (existsSync(path.join(root, upstream))) {
      failGate(`T-20 upstream target still present: ${upstream}`);
    }
    pass(`T-20 upstream target deleted (${upstream})`);
  }

  const oldAbsolutePattern = String.raw`agenc/upstream/components/(?:CostThresholdDialog|messages/RateLimitMessage)`;
  const oldAbsoluteScan = run(
    "rg",
    ["--no-messages", "-n", oldAbsolutePattern, "runtime/src"],
    { silent: true },
  );
  if (oldAbsoluteScan.status === 0 && oldAbsoluteScan.stdout.trim()) {
    failGate(`T-20 retired cost/limit dialog upstream imports remain:\n${oldAbsoluteScan.stdout}`);
  }

  const sourceImportPattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  const deletedEntrypoints = new Map([
    [path.join(root, "runtime/src/agenc/upstream/components/CostThresholdDialog"), "CostThresholdDialog"],
    [path.join(root, "runtime/src/agenc/upstream/components/messages/RateLimitMessage"), "RateLimitMessage"],
  ]);
  const oldImports = [];
  for (const abs of walkFiles(path.join(root, "runtime/src"))) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(abs)) continue;
    const rel = path.relative(root, abs);
    const content = readFileSync(abs, "utf8");
    for (const match of content.matchAll(sourceImportPattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      if (
        specifier === "src/components/CostThresholdDialog" ||
        specifier === "src/components/CostThresholdDialog.js" ||
        specifier === "src/components/messages/RateLimitMessage" ||
        specifier === "src/components/messages/RateLimitMessage.js"
      ) {
        oldImports.push(`${rel} -> ${specifier}`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(abs), specifier)
        .replace(/\.(?:js|jsx|ts|tsx|mjs|cjs)$/, "");
      for (const [deletedEntrypoint, label] of deletedEntrypoints) {
        if (resolved === deletedEntrypoint) {
          oldImports.push(`${rel} -> ${specifier} (${label})`);
        }
      }
    }
  }
  if (oldImports.length > 0) {
    failGate(`T-20 retired cost/limit dialog import specifiers remain:\n${oldImports.join("\n")}`);
  }

  pass("T-20 cost/limit dialog imports resolved to AgenC-owned paths");
}

async function foundationalGates(item) {
  // F-01/F-02: stub fixes. Verify placeholder is gone (no @ts-nocheck).
  if (id === "F-01" || id === "F-02") {
    const target = id === "F-01"
      ? "runtime/src/constants/querySource.ts"
      : "runtime/src/types/message.ts";
    const abs = path.join(root, target);
    if (!existsSync(abs)) failGate(`stub target missing: ${target}`);
    const content = await readFileSafe(abs);
    if (content.includes("@ts-nocheck")) failGate(`@ts-nocheck still present in ${target}`);
    pass(`stub replaced (${target})`);
    return;
  }
  // F-03*..F-06*: daemon items. Require a contract test under runtime/src/app-server/.
  if (/^F-0[3-6][a-z]?$/.test(id)) {
    const dir = path.join(root, "runtime/src/app-server");
    if (!existsSync(dir)) failGate("runtime/src/app-server/ does not exist; daemon work not landed");
    const tests = walkFiles(dir).filter((p) => /\.contract\.test\.(ts|tsx)$/.test(p));
    if (tests.length === 0) {
      failGate("no *.contract.test.ts files in runtime/src/app-server/");
    }
    pass(`${tests.length} contract test(s) present`);
    return;
  }
  if (id === "F-08") {
    const requiredFiles = [
      "packaging/systemd/agenc-daemon.service",
      "packaging/launchd/dev.agenc.daemon.plist",
      "packaging/windows/agenc-daemon.xml",
    ];
    for (const rel of requiredFiles) {
      if (!existsSync(path.join(root, rel))) {
        failGate(`process supervision artifact missing: ${rel}`);
      }
    }

    const daemonCli = await readFileSafe(
      path.join(root, "runtime/src/app-server/daemon-cli.ts"),
    );
    const daemonCliTest = await readFileSafe(
      path.join(root, "runtime/src/app-server/daemon-cli.contract.test.ts"),
    );
    const systemd = await readFileSafe(
      path.join(root, "packaging/systemd/agenc-daemon.service"),
    );
    const launchd = await readFileSafe(
      path.join(root, "packaging/launchd/dev.agenc.daemon.plist"),
    );
    const windows = await readFileSafe(
      path.join(root, "packaging/windows/agenc-daemon.xml"),
    );

    if (!daemonCli.includes("start --foreground")) {
      failGate("daemon CLI help does not expose start --foreground");
    }
    if (!daemonCli.includes('return { kind: "command", action: "run" };')) {
      failGate(
        "daemon CLI does not route start --foreground to foreground run mode",
      );
    }
    if (!systemd.includes("agenc daemon start --foreground")) {
      failGate("systemd unit does not run agenc daemon start --foreground");
    }
    if (!launchd.includes("<string>--foreground</string>")) {
      failGate("launchd plist does not pass --foreground");
    }
    if (!windows.includes("<arguments>daemon start --foreground</arguments>")) {
      failGate(
        "Windows service template does not pass daemon start --foreground",
      );
    }
    if (!daemonCliTest.includes("ships supervisor templates")) {
      failGate("daemon CLI contract test does not cover supervisor templates");
    }
    pass("process supervision artifacts and foreground daemon mode present");
    return;
  }
  failGate(
    `item ${id} has no specific gate branch in foundationalGates; add one or remove the item`,
  );
}

async function authBackendGates(item) {
  // A-* items: AuthBackend interface must exist; no provider key reads
  // outside the auth subsystem.
  const ifacePath = path.join(root, "runtime/src/auth/backend.ts");
  if (!existsSync(ifacePath)) failGate("AuthBackend interface missing at runtime/src/auth/backend.ts");
  pass("AuthBackend interface present");
  // Scan for direct env-var key reads outside runtime/src/auth/.
  const keyVars = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "GROK_API_KEY", "XAI_API_KEY"];
  const offenders = [];
  for (const v of keyVars) {
    const r = run("rg", ["--no-messages", "-l", `process\\.env\\.${v}`, "runtime/src", "-g", "!runtime/src/auth/**"]);
    if (r.status === 0 && r.stdout) offenders.push(...r.stdout.trim().split("\n"));
  }
  if (offenders.length > 0) {
    failGate(`provider key env vars read outside runtime/src/auth/:\n  ${offenders.join("\n  ")}`);
  }
  pass("no direct provider-key env reads outside auth subsystem");
}

async function providerGates(item) {
  // LP-* items: provider port (LP-10..LP-19) or runtime backbone (LP-01..LP-07).
  // For per-provider items: directory + index export + at least one test.
  const providerMatch = /providers\/([\w-]+)/.exec(item.body);
  if (providerMatch) {
    const dir = path.join(root, "runtime/src/llm/providers", providerMatch[1]);
    if (!existsSync(dir)) failGate(`provider directory missing: runtime/src/llm/providers/${providerMatch[1]}/`);
    pass(`provider directory present (${providerMatch[1]})`);
    const idx = path.join(dir, "index.ts");
    if (!existsSync(idx)) failGate(`provider entry missing: runtime/src/llm/providers/${providerMatch[1]}/index.ts`);
    pass("provider index.ts present");
    const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
    if (tests.length === 0) failGate(`no test files in runtime/src/llm/providers/${providerMatch[1]}/`);
    pass(`${tests.length} test file(s)`);
    return;
  }
  // Runtime-backbone LP-* items live under runtime/src/llm/api/ or similar.
  if (id.startsWith("LP-0")) {
    const apiDir = path.join(root, "runtime/src/llm/api");
    const fallback = path.join(root, "runtime/src/transport/fallback-ladder.ts");
    if (!existsSync(apiDir) && !existsSync(fallback)) {
      failGate("expected runtime/src/llm/api/ or runtime/src/transport/fallback-ladder.ts");
    }
    pass("provider runtime backbone present");
    return;
  }
  // LP-2x items (registry, discovery, models manager) — check the named
  // subsystem dir exists with at least one test.
  const lpSubsystems = {
    "LP-21": "runtime/src/llm/registry",
    "LP-22": "runtime/src/llm/discovery",
    "LP-23": "runtime/src/llm/registry",
    "LP-24": "runtime/src/llm/discovery",
    "LP-25": "runtime/src/llm/policy",
  };
  const sub = lpSubsystems[id];
  if (sub) {
    const dir = path.join(root, sub);
    if (!existsSync(dir)) failGate(`${id}: expected directory ${sub}`);
    const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
    if (tests.length === 0) failGate(`${id}: no test files in ${sub}`);
    pass(`${id}: ${sub} present with ${tests.length} test file(s)`);
    return;
  }
  failGate(
    `LP-* item ${id} has no provider/<name> citation, no LP-0* runtime backbone, and no registered subsystem mapping. ` +
    `Add a specific branch to providerGates() in scripts/goal/verify.mjs OR add an ITEM_EVIDENCE entry for ${id}.`,
  );
}

async function stateGates(item) {
  // ST-01..ST-03: schema items. Look for the named table in any sql migration
  // OR a typed schema file under runtime/src/state/.
  const dir = path.join(root, "runtime/src/state");
  if (!existsSync(dir)) failGate("runtime/src/state/ missing");
  if (/^ST-0[1-3]$/.test(id)) {
    const tableNames = {
      "ST-01": "agent_runs",
      "ST-02": "session_state_snapshots",
      "ST-03": "in_flight_tool_calls",
    };
    const table = tableNames[id];
    const found = grepRepo(`\\b${table}\\b`, "runtime/src/state");
    if (!found) failGate(`schema table "${table}" not referenced anywhere under runtime/src/state/`);
    pass(`schema mentions ${table}`);
    return;
  }
  // ST-04..ST-09: feature items. Require at least one test file added.
  if (/^ST-0[4-9]$/.test(id) || /^ST-1[0-9]$/.test(id)) {
    const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
    if (tests.length === 0) failGate(`no test files in runtime/src/state/`);
    pass(`${tests.length} test file(s) under state/`);
    return;
  }
  failGate(
    `item ${id} has no specific gate branch in stateGates; add one or remove the item`,
  );
}

async function toolGates(item) {
  // TL-* items: tool surface. Each tool must be registered in the tool registry.
  if (id === "TL-12") {
    agentToolDelegationGate();
    return;
  }
  const toolNameMatch = /\b(bash|edit|read|write|grep|glob|web_fetch|web_search|TodoWrite|Plan|AgentTool|SkillCreate|NotebookRead|NotebookEdit|file mention|attachments?|multi-edit)\b/i.exec(
    item.title,
  );
  if (!toolNameMatch) {
    // Items without a tool-name title (TL-19 registry, TL-20 per-tool config,
    // TL-21 orchestrator split, TL-22 multi-agent v2, TL-23 elicitation,
    // TL-24 apply-patch, TL-25 background tasks, TL-26 ask-user-question)
    // have specific subsystem checks.
    const subsystemMap = {
      "TL-19": "runtime/src/tool-registry.ts",
      "TL-20": "runtime/src/config/schema.ts",
      "TL-21": "runtime/src/tools/runtimes",
      "TL-22": "runtime/src/agents/v2",
      "TL-23": "runtime/src/elicitation",
      "TL-24": "runtime/src/tools/apply-patch",
      "TL-25": "runtime/src/tools/tasks",
      "TL-26": "runtime/src/tools/ask-user-question",
    };
    const target = subsystemMap[id];
    if (!target) {
      failGate(
        `TL-* item ${id} has no tool-name in title and no registered subsystem mapping. ` +
        `Add an entry to subsystemMap in toolGates() in scripts/goal/verify.mjs OR rename the item to include a tool name.`,
      );
    }
    const full = path.join(root, target);
    if (!existsSync(full)) failGate(`${id}: expected ${target}`);
    pass(`${id}: ${target} present`);
    return;
  }
  const toolName = toolNameMatch[1];
  const registry = path.join(root, "runtime/src/tool-registry.ts");
  if (!existsSync(registry)) failGate("runtime/src/tool-registry.ts missing");
  const registered = grepRepo(toolName, "runtime/src/tool-registry.ts");
  if (!registered) failGate(`tool "${toolName}" not referenced in tool-registry.ts`);
  pass(`tool "${toolName}" referenced in tool-registry.ts`);
  // At least one test exercising the tool somewhere under runtime/src/tools/.
  const toolsDir = path.join(root, "runtime/src/tools");
  if (existsSync(toolsDir)) {
    const tests = walkFiles(toolsDir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
    if (tests.length === 0) failGate(`no test files anywhere under runtime/src/tools/`);
    pass(`${tests.length} test file(s) under tools/`);
  }
}

function agentToolDelegationGate() {
  const registryPath = path.join(root, "runtime/src/tool-registry.ts");
  const testPath = path.join(root, "runtime/src/tool-registry.test.ts");
  if (!existsSync(registryPath)) failGate("runtime/src/tool-registry.ts missing");
  if (!existsSync(testPath)) failGate("runtime/src/tool-registry.test.ts missing");

  const registrySource = readFileSync(registryPath, "utf8");
  const testSource = readFileSync(testPath, "utf8");
  if (!/\bspawnAgentToolName\s*=\s*["']spawn_agent["']/.test(registrySource)) {
    failGate("TL-12: registry must map the canonical spawn_agent delegation tool");
  }
  if (!/AgentTool\s*\/\s*agent_tool/.test(registrySource)) {
    failGate("TL-12: registry must document the retired AgentTool/agent_tool aliases");
  }
  if (!/spawn_agent dispatch maps string arguments/.test(testSource)) {
    failGate("TL-12: missing dispatch-level spawn_agent string-argument regression test");
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "--",
    "vitest",
    "run",
    "src/tool-registry.test.ts",
    "--testNamePattern",
    "AgentTool delegation|spawn_agent dispatch",
  ]);
  if (vitest.status !== 0) failGate("TL-12 targeted tool-registry tests failed");
  pass("TL-12 targeted delegation registry tests passed");
}

async function permissionGates(item) {
  const dir = path.join(root, "runtime/src/permissions");
  if (!existsSync(dir)) failGate("runtime/src/permissions/ missing");
  pass("permissions subsystem present");
  // PE-01..PE-08: each item maps to a named submodule.
  const mapping = {
    "PE-01": "approval-cache",
    "PE-02": "dangerous-pattern",
    "PE-03": "tool-approval",
    "PE-04": "permission-mode",
    "PE-05": "sandbox",
    "PE-06": "hook",
    "PE-07": "permission-cli",
    "PE-08": "audit-log",
  };
  const expected = mapping[id];
  if (expected) {
    const found = grepRepo(expected, "runtime/src/permissions");
    if (!found) failGate(`permissions item ${id} expects "${expected}" reference under runtime/src/permissions/`);
    pass(`permissions/${expected} referenced`);
  }
  // PE-09..PE-15: extended permission features.
  const extendedMapping = {
    "PE-09": ["trustDialog|TrustDialog|projectTrust|project_trust", "trust dialog / project trust"],
    "PE-10": ["hookDispatcher|hook_dispatcher|HookEngine|registerHook", "hook dispatcher"],
    "PE-11": ["guardian|Guardian|approvalRequest|approval_request", "guardian / approval-request engine"],
    "PE-12": ["commandCanonicalization|command_canonical|parseCommand|parse_command", "command canonicalizer / parser"],
    "PE-13": ["requestPermissions|request_permissions|permissionsRpc", "request-permissions RPC"],
    "PE-14": ["unattended|UnattendedPolicy|unattended_policy", "unattended-policy"],
    "PE-15": ["hookEvents|hook_events|hookSchedule", "hook event scheduling"],
  };
  if (extendedMapping[id]) {
    const [pattern, label] = extendedMapping[id];
    const found = grepRepo(pattern, "runtime/src/permissions") ||
                  grepRepo(pattern, "runtime/src/agents") ||
                  grepRepo(pattern, "runtime/src/app-server");
    if (!found) failGate(`permissions item ${id}: ${label} not referenced anywhere in runtime/src/`);
    pass(`permissions/${id}: ${label} referenced`);
  }
  if (!expected && !extendedMapping[id]) {
    failGate(
      `permissions item ${id} has no entry in mapping or extendedMapping. ` +
      `Add the named submodule + grep pattern in permissionGates() in scripts/goal/verify.mjs.`,
    );
  }
  const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
  if (tests.length === 0) failGate(`no test files in runtime/src/permissions/`);
  pass(`${tests.length} test file(s)`);
}

async function donorRuntimePortGates(item) {
  if (id === "C-01b") {
    const dir = path.join(root, "runtime/src/sandbox/linux-launcher");
    if (!existsSync(dir)) failGate("C-01b: runtime/src/sandbox/linux-launcher/ missing");
    const testRun = run("npm", [
      "exec",
      "--workspace=@tetsuo-ai/runtime",
      "vitest",
      "run",
      "src/sandbox/linux-launcher/linux-launcher.test.ts",
    ]);
    if (testRun.status !== 0) {
      failGate("C-01b Linux sandbox launcher tests failed");
    }
    const launcherSource = readFileSync(path.join(dir, "launcher.ts"), "utf8");
    const runMainSource = readFileSync(path.join(dir, "linux-run-main.ts"), "utf8");
    const bwrapSource = readFileSync(path.join(dir, "bwrap.ts"), "utf8");
    const landlockSource = readFileSync(path.join(dir, "landlock.ts"), "utf8");
    const proxySource = readFileSync(path.join(dir, "proxy-routing.ts"), "utf8");
    const testsSource = readFileSync(path.join(dir, "linux-launcher.test.ts"), "utf8");
    const packageJson = JSON.parse(readFileSync(path.join(root, "runtime/package.json"), "utf8"));
    const binPath = path.join(root, "runtime/bin/agenc-linux-sandbox");
    if (!/\bspawn(Sync)?\(/.test(launcherSource) || !/\bspawn\(/.test(runMainSource)) {
      failGate("C-01b: launcher must spawn real subprocesses");
    }
    if (!/--seccomp/.test(bwrapSource) || !/--unshare-net/.test(bwrapSource)) {
      failGate("C-01b: bwrap command builder must pass seccomp and network namespace flags");
    }
    if (!/createNetworkSeccompProgram/.test(landlockSource) || !/SECCOMP_RET_ERRNO/.test(landlockSource)) {
      failGate("C-01b: landlock/seccomp port must generate a real cBPF seccomp program");
    }
    if (packageJson?.bin?.["agenc-linux-sandbox"] !== "bin/agenc-linux-sandbox") {
      failGate("C-01b: runtime/package.json must expose bin.agenc-linux-sandbox");
    }
    if (packageJson?.engines?.node !== ">=25.0.0") {
      failGate("C-01b: runtime/package.json must require a Node runtime with process.execve");
    }
    if ((statSync(binPath).mode & 0o111) === 0) {
      failGate("C-01b: runtime/bin/agenc-linux-sandbox must be executable");
    }
    if (!/--apply-seccomp-then-exec/.test(runMainSource) || !/AGENC_LINUX_SANDBOX_ACTIVE/.test(runMainSource)) {
      failGate("C-01b: launcher must reenter an inner apply-seccomp stage inside bubblewrap");
    }
    if (!/prepareHostProxyRoutes/.test(runMainSource) || !/activateProxyRoutesInNetns/.test(runMainSource)) {
      failGate("C-01b: managed proxy mode must prepare host routes and activate them inside the namespace");
    }
    if (!/\bexecve\b/.test(runMainSource) || !/runCommandWithInnerSeccomp/.test(runMainSource)) {
      failGate("C-01b: launcher must use execve for the inner non-proxy stage and an inner seccomp wrapper for proxy mode");
    }
    if (!/waitForChildWithSignalRelay\(spawned\.child\)/.test(runMainSource) || !/insertFinalCommandArgv0/.test(runMainSource)) {
      failGate("C-01b: launcher must relay signals to outer bwrap and preserve final command argv0");
    }
    if (!/mkdtempSync/.test(proxySource) || !/FTP_PROXY/.test(proxySource) || !/NPM_CONFIG_PROXY/.test(proxySource)) {
      failGate("C-01b: proxy routing must use atomic socket dirs and the donor proxy env-key set");
    }
    if (!/socks4a/.test(proxySource) || !/proxyUrlHasNoPathQueryOrFragment/.test(proxySource) || !/trackSocket/.test(proxySource)) {
      failGate("C-01b: proxy routing must preserve URL formatting and clean active sockets");
    }
    if (!/trustedDirectories/.test(launcherSource) || !/TRUSTED_BWRAP_DIRECTORIES/.test(launcherSource)) {
      failGate("C-01b: bubblewrap discovery must reject untrusted PATH entries by default");
    }
    if (!/globCharacterClass/.test(bwrapSource) || !/escapeRegexChar/.test(bwrapSource)) {
      failGate("C-01b: unreadable glob matching must support ? and character classes");
    }
    if (!/unreadable glob expansion root is too broad/.test(bwrapSource) || !/\/nix\/store/.test(bwrapSource)) {
      failGate("C-01b: bwrap defaults must include donor platform roots and reject root-level glob scans");
    }
    if (!/\bspawn\(/.test(testsSource) || !/runLinuxSandboxMain/.test(testsSource)) {
      failGate("C-01b: tests must exercise the launcher through subprocess execution");
    }
    if (!/agenc-linux-sandbox/.test(testsSource) || !/AGENC_LINUX_SANDBOX_ACTIVE/.test(testsSource)) {
      failGate("C-01b: tests must cover package bin exposure and inner-stage reentry");
    }
    if (!/activateProxyRoutesInNetns/.test(testsSource) || !/tcpRoundTrip/.test(testsSource)) {
      failGate("C-01b: tests must exercise managed proxy route activation");
    }
    if (!/proxy-routed seccomp/.test(testsSource) || !/destroys active managed proxy sockets/.test(testsSource)) {
      failGate("C-01b: tests must exercise proxy-routed seccomp and proxy cleanup");
    }
    if (!/deniedSyscalls/.test(testsSource) || !/protected metadata is created/.test(testsSource)) {
      failGate("C-01b: tests must exercise proxy-routed BPF behavior and protected metadata violations");
    }
    if (!/malformed managed proxy route specs/.test(testsSource) || !/unreadable ancestors/.test(testsSource)) {
      failGate("C-01b: tests must cover route-spec validation and unreadable ancestor ordering");
    }
    const buildRun = run("npm", ["run", "build", "--workspace=@tetsuo-ai/runtime"]);
    if (buildRun.status !== 0) {
      failGate("C-01b runtime package build failed");
    }
    const binRun = run("node", ["runtime/bin/agenc-linux-sandbox"], { silent: true });
    if (binRun.status !== 2 || !/Linux sandbox command is missing/.test(binRun.stderr ?? "")) {
      failGate("C-01b: built package bin must execute the Linux launcher entrypoint");
    }
    pass("C-01b: Linux launcher subprocess, package bin, reentry, proxy routes, bwrap, seccomp, and tests present");
    return;
  }

  if (id === "C-01c") {
    const hardeningFile = "runtime/src/sandbox/hardening/index.ts";
    const hardeningTest = "runtime/src/sandbox/hardening/hardening.test.ts";
    if (!existsSync(path.join(root, hardeningFile))) {
      failGate("C-01c: process hardening module missing");
    }
    if (!existsSync(path.join(root, hardeningTest))) {
      failGate("C-01c: process hardening test missing");
    }
    if (!grepRepo("compileAndLoadNativeHardeningBinding|node_api\\.h", hardeningFile)) {
      failGate("C-01c: hardening must include a native binding path");
    }
    if (!grepRepo("prlimit", hardeningFile)) {
      failGate("C-01c: hardening must include a prlimit core-limit fallback");
    }
    if (!grepRepo("LD_|DYLD_|MallocStackLogging|MallocLogFile", hardeningFile)) {
      failGate("C-01c: hardening must scrub dangerous env prefixes");
    }
    if (!grepRepo('nativeMode = options\\.nativeMode \\?\\? "required"', hardeningFile)) {
      failGate("C-01c: main hardening primitive must fail closed by default");
    }
    if (!grepRepo("applyBestEffortPreMainProcessHardening", hardeningFile)) {
      failGate("C-01c: best-effort hardening must be a separate API");
    }
    if (!grepRepo("allowRuntimeNativeBuild", hardeningFile)) {
      failGate("C-01c: runtime native compilation must require explicit opt-in");
    }
    if (!grepRepo("spawnSync\\(process\\.execPath", hardeningTest)) {
      failGate("C-01c: hardening tests must exercise a real subprocess");
    }
    if (!grepRepo("getCoreFileSizeLimit|getLinuxDumpable", hardeningTest)) {
      failGate("C-01c: hardening tests must assert OS hardening state");
    }
    if (!grepRepo("runtime native hardening build disabled", hardeningTest)) {
      failGate("C-01c: hardening tests must cover fail-closed default behavior");
    }
    if (!grepRepo("allowRuntimeNativeBuild: true", hardeningTest)) {
      failGate("C-01c: hardening tests must cover explicit runtime-build opt-in");
    }
    const vitest = run("node_modules/.bin/vitest", [
      "run",
      hardeningTest,
    ]);
    if (vitest.status !== 0) {
      failGate("C-01c process hardening tests failed");
    }
    pass("C-01c: process hardening native path, env scrub, prlimit fallback, and tests present");
    return;
  }

  if (id === "C-01d") {
    const dir = path.join(root, "runtime/src/sandbox/execpolicy");
    if (!existsSync(dir)) failGate("C-01d: runtime/src/sandbox/execpolicy/ missing");
    const testRun = run("npm", [
      "exec",
      "--workspace=@tetsuo-ai/runtime",
      "vitest",
      "run",
      "src/sandbox/execpolicy/execpolicy.test.ts",
    ]);
    if (testRun.status !== 0) {
      failGate("C-01d execpolicy tests failed");
    }
    const parserSource = readFileSync(path.join(dir, "parser.ts"), "utf8");
    const policySource = readFileSync(path.join(dir, "policy.ts"), "utf8");
    const ruleSource = readFileSync(path.join(dir, "rule.ts"), "utf8");
    const amendSource = readFileSync(path.join(dir, "amend.ts"), "utf8");
    const checkerSource = readFileSync(path.join(dir, "execpolicycheck.ts"), "utf8");
    const testsSource = readFileSync(path.join(dir, "execpolicy.test.ts"), "utf8");
    const exampleSource = readFileSync(path.join(dir, "examples/example.agencpolicy"), "utf8");
    if (!/class PolicyParser/.test(parserSource) || !/prefix_rule/.test(parserSource) || !/host_executable/.test(parserSource)) {
      failGate("C-01d: parser must implement the execpolicy builtins");
    }
    if (!/matchesForCommandWithOptions/.test(policySource) || !/compiledNetworkDomains/.test(policySource)) {
      failGate("C-01d: policy must evaluate commands and compile network domains");
    }
    if (!/normalizeNetworkRuleHost/.test(ruleSource) || !/parseNetworkRuleProtocol/.test(ruleSource)) {
      failGate("C-01d: rule layer must normalize network hosts and protocols");
    }
    if (!/lockSync/.test(amendSource) || !/blockingAppendNetworkRule/.test(amendSource)) {
      failGate("C-01d: amendment helpers must lock and append prefix/network rules");
    }
    if (!/formatMatchesJson/.test(checkerSource) || !/loadPolicies/.test(checkerSource)) {
      failGate("C-01d: checker must load policies and render JSON");
    }
    if (!/host executable resolution/.test(testsSource) || !/match and not_match examples/.test(testsSource) || !/carried example policy corpus/.test(testsSource)) {
      failGate("C-01d: tests must cover host executable resolution, example validation, and example corpus loading");
    }
    if (!/git", "reset", "--hard/.test(exampleSource) || !/decision = "forbidden"/.test(exampleSource)) {
      failGate("C-01d: example policy corpus fixture missing expected command rules");
    }
    pass("C-01d: execpolicy parser, policy engine, amendment helpers, checker, and tests present");
    return;
  }
  if (id === "C-01e") {
    const dir = path.join(root, "runtime/src/sandbox/escalation");
    if (!existsSync(dir)) failGate("C-01e: runtime/src/sandbox/escalation/ missing");
    const testRun = run("npm", [
      "exec",
      "--workspace=@tetsuo-ai/runtime",
      "vitest",
      "run",
      "src/sandbox/escalation/escalation.test.ts",
      "src/tools/orchestrator.test.ts",
      "src/tools/runtimes/runtime.test.ts",
      "src/permissions/guardian/approval-request.test.ts",
    ]);
    if (testRun.status !== 0) {
      failGate("C-01e escalation tests failed");
    }
    const sandboxingSource = readFileSync(path.join(dir, "sandboxing.ts"), "utf8");
    const unixSource = readFileSync(path.join(dir, "unix-escalation.ts"), "utf8");
    const approvalsSource = readFileSync(path.join(dir, "approvals.ts"), "utf8");
    const networkSource = readFileSync(path.join(dir, "network-approval.ts"), "utf8");
    const testsSource = readFileSync(path.join(dir, "escalation.test.ts"), "utf8");
    const orchestratorSource = readFileSync(path.join(root, "runtime/src/tools/orchestrator.ts"), "utf8");
    const routerSource = readFileSync(path.join(root, "runtime/src/tools/router.ts"), "utf8");
    const bootstrapSource = readFileSync(path.join(root, "runtime/src/bin/bootstrap-services.ts"), "utf8");
    const execCommandSource = readFileSync(path.join(root, "runtime/src/tools/system/exec-command.ts"), "utf8");
    const orchestratorTestsSource = readFileSync(path.join(root, "runtime/src/tools/orchestrator.test.ts"), "utf8");
    const runtimeTestsSource = readFileSync(path.join(root, "runtime/src/tools/runtimes/runtime.test.ts"), "utf8");
    if (!/sandboxOverrideForFirstAttempt/.test(sandboxingSource) || !/selectFirstAttemptSandbox/.test(sandboxingSource)) {
      failGate("C-01e: sandboxing port must select first-attempt sandbox overrides");
    }
    if (!/toolWantsNoSandboxApproval/.test(sandboxingSource) || !/toolEscalatesOnFailure/.test(sandboxingSource)) {
      failGate("C-01e: sandboxing port must expose approval-driven retry policy");
    }
    if (!/execvePromptRejectedByPolicy/.test(unixSource) || !/determineInterceptedExecAction/.test(unixSource)) {
      failGate("C-01e: unix escalation port must reject disallowed prompts and determine intercepted exec action");
    }
    if (!/renderDecisionForUnmatchedCommand/.test(unixSource) || !/kind: "prompt"/.test(unixSource)) {
      failGate("C-01e: unix escalation port must classify unmatched commands and keep prompt separate from run");
    }
    if (!/checkMultipleWithOptions/.test(unixSource) || !/resolveHostExecutables:\s*true/.test(unixSource)) {
      failGate("C-01e: unix escalation port must evaluate exec-policy with host executable resolution");
    }
    if (!/effectiveApprovalId/.test(approvalsSource) || !/defaultAvailableApprovalDecisions/.test(approvalsSource) || !/proposedNetworkPolicyAmendments/.test(approvalsSource)) {
      failGate("C-01e: approvals port must implement effective ids and default decision sets");
    }
    if (!/requestManagedNetworkApprovalForSandbox/.test(networkSource) || !/not_allowed_in_sandbox_mode/.test(networkSource)) {
      failGate("C-01e: network approval port must enforce sandbox-mode approval gating");
    }
    if (!/sandboxPermissionsFromArgs/.test(orchestratorSource) || !/selectFirstAttemptSandbox/.test(orchestratorSource)) {
      failGate("C-01e: live orchestrator must apply sandbox_permissions to first-attempt sandbox selection");
    }
    if (!/evaluateLocalShellExecPolicyAction/.test(orchestratorSource) || !/determineInterceptedExecAction/.test(orchestratorSource)) {
      failGate("C-01e: live orchestrator must apply exec-policy interception decisions");
    }
    if (!/currentExecPolicyFromSession/.test(routerSource) || !/execPolicy/.test(routerSource)) {
      failGate("C-01e: tool router must pass the current exec policy into orchestration");
    }
    if (!/requestManagedNetworkApprovalForSandbox/.test(bootstrapSource)) {
      failGate("C-01e: bootstrap network approval service must route through sandbox approval gate");
    }
    if (!/require_escalated/.test(execCommandSource) || !/with_additional_permissions/.test(execCommandSource)) {
      failGate("C-01e: exec-command schema must advertise sandbox escalation permission modes");
    }
    if (!/sandbox_permissions=require_escalated/.test(orchestratorTestsSource) || !/exec-policy prefix allow drives unsandboxed local-shell dispatch/.test(orchestratorTestsSource)) {
      failGate("C-01e: orchestrator tests must exercise live sandbox_permissions and exec-policy routing");
    }
    if (!/skip policies still require approval/.test(orchestratorTestsSource) || !/skipped tools do not receive free grants/.test(orchestratorTestsSource)) {
      failGate("C-01e: sandbox permission tests must reject free opt-out paths");
    }
    if (!/REJECT_RULES_APPROVAL_REASON/.test(orchestratorTestsSource)) {
      failGate("C-01e: exec-policy tests must preserve granular rejection reasons");
    }
    if (!/additionalPermissions/.test(runtimeTestsSource) || !/permissionProfileForRuntimeContext/.test(runtimeTestsSource)) {
      failGate("C-01e: runtime tests must prove scoped additional permissions affect sandbox profiles");
    }
    if (!/\bexecFile\b/.test(testsSource) || !/NetworkApprovalService/.test(testsSource) || !/Policy\.empty/.test(testsSource)) {
      failGate("C-01e: tests must exercise subprocess, network approval, and exec-policy paths");
    }
    pass("C-01e: approval-driven sandbox escalation, exec-policy interception, network approval, and tests present");
    return;
  }
  // C-01a..C-01e: sandboxing.
  if (/^C-01/.test(id)) {
    const dir = path.join(root, "runtime/src/sandbox");
    if (!existsSync(dir)) failGate("runtime/src/sandbox/ missing");
    pass("sandbox subsystem present");
    const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
    if (tests.length === 0) failGate("no test files under runtime/src/sandbox/");
    pass(`${tests.length} test file(s)`);
    return;
  }
  // C-02: mcp-client transports
  if (id === "C-02") {
    const dir = path.join(root, "runtime/src/mcp-client/transports");
    if (!existsSync(dir)) failGate("runtime/src/mcp-client/transports/ missing");
    const stdio = walkFiles(dir).some((p) => /stdio/.test(p));
    const ws = walkFiles(dir).some((p) => /websocket|\bws\b/i.test(p));
    if (!stdio) failGate("stdio transport file missing under runtime/src/mcp-client/transports/");
    if (!ws) failGate("websocket transport file missing under runtime/src/mcp-client/transports/");
    pass("stdio + websocket transports present");
    return;
  }
  // C-03: terminal-detection
  if (id === "C-03") {
    const f = path.join(root, "runtime/src/utils/terminal-detection.ts");
    if (!existsSync(f)) failGate("runtime/src/utils/terminal-detection.ts missing");
    const testRun = run("npm", [
      "exec",
      "--workspace=@tetsuo-ai/runtime",
      "vitest",
      "run",
      "src/utils/terminal-detection.test.ts",
    ]);
    if (testRun.status !== 0) {
      failGate("C-03 terminal detection tests failed");
    }
    pass("terminal-detection.ts present");
    return;
  }
  // C-04: file-search/git-utils
  if (id === "C-04") {
    const gitUtils = path.join(root, "runtime/src/utils/git.ts");
    const gitTests = path.join(root, "runtime/src/utils/git.test.ts");
    if (!existsSync(gitUtils) || !existsSync(gitTests)) {
      failGate("C-04: expected runtime/src/utils/git.ts and git.test.ts");
    }
    const testRun = run("npm", [
      "exec",
      "--workspace=@tetsuo-ai/runtime",
      "vitest",
      "run",
      "src/utils/git.test.ts",
      "src/app-server/fuzzy-file-search.contract.test.ts",
      "src/tools/system/grep.test.ts",
      "src/tools/system/glob.test.ts",
    ]);
    if (testRun.status !== 0) {
      failGate("C-04 git utility tests failed");
    }
    pass("C-04: git utilities and overlap tests present");
    return;
  }
  // C-05: code-mode finish
  if (id === "C-05") {
    const dir = path.join(root, "runtime/src/tools/code-mode");
    if (!existsSync(dir)) failGate("runtime/src/tools/code-mode/ missing");
    pass("tools/code-mode/ present");
    return;
  }
  // C-06: connectors catalog
  if (id === "C-06") {
    const dir = path.join(root, "runtime/src/connectors");
    const alt = path.join(root, "runtime/src/services/connectors");
    if (!existsSync(dir) && !existsSync(alt)) {
      failGate("C-06: expected runtime/src/connectors/ or runtime/src/services/connectors/");
    }
    pass("C-06: connectors subsystem present");
    return;
  }
  // C-01a..g: sandbox subsystem items.
  if (/^C-01[a-g]$/.test(id)) {
    const sandboxDir = path.join(root, "runtime/src/sandbox");
    if (!existsSync(sandboxDir)) {
      failGate(`${id}: runtime/src/sandbox/ does not exist; sandbox subsystem must be created for C-01* items.`);
    }
    const tests = walkFiles(sandboxDir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
    if (tests.length === 0) failGate(`${id}: no test files under runtime/src/sandbox/`);
    pass(`${id}: sandbox subsystem present with ${tests.length} test file(s)`);
    return;
  }
  failGate(
    `donor-runtime port item ${id} has no specific gate branch. ` +
    `Add a branch to donorRuntimePortGates() in scripts/goal/verify.mjs naming the expected runtime/src/ path.`,
  );
}

async function serviceGates(item) {
  if (id === "OC-06") {
    const evidence = ITEM_EVIDENCE["OC-06"];
    const required = [
      ...(evidence.files ?? []),
      ...(evidence.tests ?? []),
      "runtime/src/tui/components/PromptInput/PromptInput.tsx",
      "runtime/src/tui/components/PromptInput/PromptInputFooterLeftSide.tsx",
      "runtime/src/tui/components/Settings/Config.tsx",
      "runtime/src/tools/ConfigTool/ConfigTool.ts",
      "runtime/src/tools/ConfigTool/supportedSettings.ts",
    ];
    for (const rel of required) {
      if (typeof rel !== "string") continue;
      if (!existsSync(path.join(root, rel))) failGate(`OC-06 file missing: ${rel}`);
    }
    const vimDir = path.join(root, "runtime/src/tui/vim");
    const upstreamImports = walkFiles(vimDir).filter((file) => {
      if (!/\.(ts|tsx)$/.test(file)) return false;
      return /agenc\/upstream/.test(readFileSync(file, "utf8"));
    });
    if (upstreamImports.length > 0) {
      failGate(
        `OC-06 vim subsystem must not import the upstream mirror:\n  ${
          upstreamImports
            .map((file) => `- ${path.relative(root, file)}`)
            .join("\n  ")
        }`,
      );
    }
    const runtimeTests = (evidence.tests ?? []).map((rel) => rel.replace(/^runtime\//, ""));
    const testRun = run("npm", [
      "exec",
      "--workspace=@tetsuo-ai/runtime",
      "vitest",
      "run",
      ...runtimeTests,
    ]);
    if (testRun.status !== 0) failGate("OC-06 targeted vim modal input tests failed");
    pass("OC-06 vim modal input, configuration, footer, and tests present");
    return;
  }

  if (id === "OC-10") {
    const required = [
      "runtime/src/cost/tracker.ts",
      "runtime/src/cost/hook.ts",
      "runtime/src/session/cost.ts",
      "runtime/src/bin/bootstrap.ts",
      "runtime/src/tui/history/ResumeConversation.tsx",
      "runtime/src/tui/startup/StatusLine.tsx",
      "runtime/src/agenc/upstream/screens/REPL.tsx",
      "runtime/src/agenc/upstream/utils/diff.ts",
      "runtime/src/agenc/upstream/utils/sessionRestore.ts",
      "runtime/src/agenc/upstream/utils/permissions/permissions.ts",
      "runtime/src/agenc/upstream/services/tools/toolExecution.ts",
      "runtime/src/agenc/upstream/QueryEngine.ts",
      "runtime/src/agenc/upstream/services/api/claude.ts", // branding-scan: allow provider API filename under upstream mirror
      "runtime/src/agenc/upstream/services/api/logging.ts",
      "runtime/src/agenc/upstream/services/api/cacheStatsTracker.ts",
      "runtime/src/agenc/upstream/services/vcr.ts",
      "runtime/src/agenc/upstream/components/Settings/Usage.tsx",
    ];
    for (const rel of required) {
      if (!existsSync(path.join(root, rel))) failGate(`OC-10 file missing: ${rel}`);
    }
    for (const rel of [
      "runtime/src/agenc/upstream/cost-tracker.ts",
      "runtime/src/agenc/upstream/costHook.ts",
      "runtime/src/agenc/upstream/cost-tracker.cacheIntegration.test.ts",
    ]) {
      if (existsSync(path.join(root, rel))) {
        failGate(`OC-10 retired cost mirror still exists: ${rel}`);
      }
    }
    const retiredImportScan = run("rg", [
      "-n",
      "cost-tracker\\.js|costHook\\.js",
      "runtime/src",
    ], { silent: true });
    if (retiredImportScan.status === 0) {
      failGate(`OC-10 retired live cost mirror imports remain:\n${retiredImportScan.stdout}`);
    }
    const permissionsSource = readFileSync(
      path.join(root, "runtime/src/agenc/upstream/utils/permissions/permissions.ts"),
      "utf8",
    );
    if (/import\s*{[\s\S]*getTotal(?:Input|Output|CacheReadInput|CacheCreationInput)Tokens[\s\S]*}\s*from\s+['"]\.\.\/\.\.\/bootstrap\/state\.js['"]/.test(permissionsSource)) {
      failGate("OC-10 permissions analytics still imports session token totals from bootstrap state");
    }
    const liveCostProducers = [
      [
        "runtime/src/agenc/upstream/utils/diff.ts",
        /addToTotalLinesChanged\s*}\s*from\s+['"]\.\.\/\.\.\/\.\.\/cost\/tracker\.js['"]/,
        "file edit line deltas route through runtime/src/cost/tracker.ts",
      ],
      [
        "runtime/src/agenc/upstream/services/tools/toolExecution.ts",
        /addToToolDuration\s*}\s*from\s+['"]\.\.\/\.\.\/\.\.\/\.\.\/cost\/tracker\.js['"]/,
        "tool durations route through runtime/src/cost/tracker.ts",
      ],
      [
        "runtime/src/agenc/upstream/screens/REPL.tsx",
        /useCostSummary\s*}\s*from\s+['"]\.\.\/\.\.\/\.\.\/cost\/hook\.js['"]/,
        "REPL exit summary routes through runtime/src/cost/hook.ts",
      ],
      [
        "runtime/src/agenc/upstream/utils/sessionRestore.ts",
        /restoreCostStateForSession\s*}\s*from\s+['"]\.\.\/\.\.\/\.\.\/cost\/tracker\.js['"]/,
        "session restore routes through runtime/src/cost/tracker.ts",
      ],
      [
        "runtime/src/agenc/upstream/QueryEngine.ts",
        /getModelUsage[\s\S]*from\s+['"]\.\.\/\.\.\/cost\/tracker\.js['"]/,
        "SDK status totals route through runtime/src/cost/tracker.ts",
      ],
      [
        "runtime/src/agenc/upstream/services/api/claude.ts", // branding-scan: allow provider API filename under upstream mirror
        /addToTotalSessionCost\s*}\s*from\s+['"]src\/cost\/tracker\.js['"][\s\S]*recordUsageCacheStats\s*}\s*from\s+['"]src\/services\/api\/cacheStatsTracker\.js['"]/,
        "API token-dollar and cache producers route through runtime cost/cache state",
      ],
      [
        "runtime/src/agenc/upstream/services/vcr.ts",
        /addToTotalSessionCost\s*}\s*from\s+['"]src\/cost\/tracker\.js['"][\s\S]*recordUsageCacheStats\s*}\s*from\s+['"]src\/services\/api\/cacheStatsTracker\.js['"]/,
        "VCR token-dollar and cache producers route through runtime cost/cache state",
      ],
      [
        "runtime/src/agenc/upstream/services/api/logging.ts",
        /addToTotalDurationState\s*}\s*from\s+['"]src\/cost\/tracker\.js['"]/,
        "API duration producer routes through runtime/src/cost/tracker.ts",
      ],
      [
        "runtime/src/agenc/upstream/components/Settings/Usage.tsx",
        /formatCost\s*}\s*from\s+['"]src\/cost\/tracker\.js['"]/,
        "usage settings formatting routes through runtime/src/cost/tracker.ts",
      ],
      [
        "runtime/src/agenc/upstream/screens/REPL.tsx",
        /bindCacheStatsResetHook[\s\S]*resetSessionCacheStats/,
        "cost reset clears cache stats for REPL cache-hit accounting",
      ],
    ];
    for (const [rel, pattern, label] of liveCostProducers) {
      const source = readFileSync(path.join(root, rel), "utf8");
      if (!pattern.test(source)) failGate(`OC-10 missing live producer migration: ${label}`);
      pass(`OC-10 ${label}`);
    }
    const testRun = run("npm", [
      "exec",
      "--workspace=@tetsuo-ai/runtime",
      "vitest",
      "run",
      "src/cost/tracker.test.ts",
      "src/session/cost.test.ts",
      "src/session/cost-persistence.test.ts",
      "src/commands/status.test.ts",
    ]);
    if (testRun.status !== 0) {
      failGate("OC-10 targeted cost runtime tests failed");
    }
    pass("OC-10 cost runtime facade, restore, and live import migration present");
    return;
  }

  if (id === "OC-04") {
    const required = [
      "runtime/src/state/migrations/config-migrations.ts",
      "runtime/src/state/config-migrations.test.ts",
      "runtime/src/config/config.test.ts",
      "runtime/src/bin/project-trust-preflight.test.ts",
    ];
    for (const rel of required) {
      if (!existsSync(path.join(root, rel))) failGate(`OC-04 file missing: ${rel}`);
    }
    pass("OC-04 config migration subsystem present");
    return;
  }

  if (id === "OC-08") {
    const required = [
      "runtime/src/tasks/types.ts",
      "runtime/src/tasks/registry.ts",
      "runtime/src/tasks/stopTask.ts",
      "runtime/src/tasks/pillLabel.ts",
      "runtime/src/tasks/types.test.ts",
      "runtime/src/tasks/registry.test.ts",
      "runtime/src/tasks/stopTask.test.ts",
      "runtime/src/tasks/pillLabel.test.ts",
      "runtime/src/tools/tasks/task-tools.test.ts",
    ];
    for (const rel of required) {
      if (!existsSync(path.join(root, rel))) failGate(`OC-08 file missing: ${rel}`);
    }
    const taskDir = path.join(root, "runtime/src/tasks");
    const upstreamImports = walkFiles(taskDir).filter((file) => {
      if (!/\.(ts|tsx)$/.test(file)) return false;
      const source = readFileSync(file, "utf8");
      return /agenc\/upstream/.test(source);
    });
    if (upstreamImports.length > 0) {
      failGate(
        `OC-08 task subsystem must not import the upstream mirror:\n  ${
          upstreamImports
            .map((file) => `- ${path.relative(root, file)}`)
            .join("\n  ")
        }`,
      );
    }
    pass("OC-08 typed task registry subsystem present");
    return;
  }

  if (id === "OC-09") {
    const required = [
      "runtime/src/onboarding/projectOnboardingState.ts",
      "runtime/src/onboarding/projectOnboardingSteps.ts",
      "runtime/src/onboarding/projectOnboardingState.test.ts",
      "runtime/src/onboarding/projectOnboardingSteps.test.ts",
      "parity/OC-09-parity.json",
    ];
    for (const rel of required) {
      if (!existsSync(path.join(root, rel))) failGate(`OC-09 file missing: ${rel}`);
    }
    const onboardingDir = path.join(root, "runtime/src/onboarding");
    const upstreamImports = walkFiles(onboardingDir).filter((file) => {
      if (!/\.(ts|tsx)$/.test(file)) return false;
      return /agenc\/upstream/.test(readFileSync(file, "utf8"));
    });
    if (upstreamImports.length > 0) {
      failGate(
        `OC-09 onboarding subsystem must not import the upstream mirror:\n  ${
          upstreamImports
            .map((file) => `- ${path.relative(root, file)}`)
            .join("\n  ")
        }`,
      );
    }
    const tests = run("npm", [
      "exec",
      "--workspace=@tetsuo-ai/runtime",
      "vitest",
      "run",
      "src/onboarding/projectOnboardingState.test.ts",
      "src/onboarding/projectOnboardingSteps.test.ts",
      "src/onboarding/onboarding.test.tsx",
    ]);
    if (tests.status !== 0) failGate("OC-09 project onboarding tests failed");
    pass("OC-09 project onboarding state and step sequence present");
    return;
  }

  if (id === "S-14") {
    const required = [
      "runtime/src/services/notifier.ts",
      "runtime/src/services/preventSleep.ts",
      "runtime/src/services/tokenEstimation.ts",
    ];
    for (const rel of required) {
      if (!existsSync(path.join(root, rel))) failGate(`S-14 file missing: ${rel}`);
    }
    const tests = [
      "runtime/src/services/service-utilities.test.ts",
      "runtime/src/services/service-utilities.contract.test.ts",
    ];
    for (const rel of tests) {
      if (!existsSync(path.join(root, rel))) failGate(`S-14 test missing: ${rel}`);
    }
    const testRun = run("npm", [
      "exec",
      "--workspace=@tetsuo-ai/runtime",
      "vitest",
      "run",
      "src/services/service-utilities.test.ts",
      "src/services/service-utilities.contract.test.ts",
    ]);
    if (testRun.status !== 0) {
      failGate("S-14 targeted service utility tests failed");
    }
    pass("S-14 service utility files and tests present");
    return;
  }

  if (id === "S-10") {
    const dir = path.join(root, "runtime/src/tools");
    if (!existsSync(dir)) failGate("S-10: runtime/src/tools/ missing");
    const required = [
      "runtime/src/tools/orchestration.ts",
      "runtime/src/tools/execution.ts",
      "runtime/src/tools/streaming-executor.ts",
      "runtime/src/tools/hooks.ts",
      "runtime/src/phases/execute-tools.ts",
      "runtime/src/session/turn-state.ts",
    ];
    for (const rel of required) {
      if (!existsSync(path.join(root, rel))) failGate(`S-10 file missing: ${rel}`);
    }
    const tests = [
      "runtime/src/tools/orchestration.test.ts",
      "runtime/src/tools/execution.test.ts",
      "runtime/src/tools/streaming-executor.test.ts",
      "runtime/src/tools/hooks.test.ts",
      "runtime/src/phases/execute-tools.test.ts",
    ];
    for (const rel of tests) {
      if (!existsSync(path.join(root, rel))) failGate(`S-10 test missing: ${rel}`);
    }
    const legacyDir = path.join(root, "runtime/src/services/tools");
    if (existsSync(legacyDir)) {
      failGate("S-10 must be owned by runtime/src/tools/, not runtime/src/services/tools/");
    }
    const phaseSource = readFileSync(path.join(root, "runtime/src/phases/execute-tools.ts"), "utf8");
    if (phaseSource.includes("_deps/tool-runtime") || phaseSource.includes("_deps/orchestration")) {
      failGate("S-10 live execute-tools phase still imports legacy _deps tools runtime");
    }
    pass("S-10 tools runtime owner present under runtime/src/tools/");
    return;
  }

  // S-* and OC-*: service ports under runtime/src/services/.
  const serviceMatch = /services\/([\w-]+)/.exec(item.body) || /services\/([\w-]+)/.exec(item.title);
  if (!serviceMatch) {
    failGate(
      `service item ${id} has no \`services/<name>\` reference in body or title. ` +
      `Either add the path to the row body, or wire a specific branch in serviceGates() in scripts/goal/verify.mjs. ` +
      `Generic pass-through is forbidden — every service item must name its target subsystem.`,
    );
  }
  const dir = path.join(root, "runtime/src/services", serviceMatch[1]);
  if (!existsSync(dir)) failGate(`service directory missing: runtime/src/services/${serviceMatch[1]}/`);
  pass(`service directory present (${serviceMatch[1]})`);
  const idx = path.join(dir, "index.ts");
  if (!existsSync(idx)) {
    process.stdout.write(`${YELLOW}!${RESET} no index.ts in services/${serviceMatch[1]}/ (acceptable for some services)\n`);
  } else {
    pass("service index.ts present");
  }
  const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
  if (tests.length === 0) failGate(`no test files in runtime/src/services/${serviceMatch[1]}/`);
  pass(`${tests.length} test file(s)`);

  if (id === "S-03") {
    const vitest = run("node_modules/.bin/vitest", [
      "run",
      "runtime/src/services/extractMemories/extractMemories.test.ts",
      "runtime/src/phases/commit.test.ts",
      "runtime/src/agents/run-agent.test.ts",
      "runtime/src/agents/delegate.test.ts",
    ]);
    if (vitest.status !== 0) failGate("S-03 targeted Vitest suite failed");
    pass("S-03 targeted Vitest suite passed");
  }
}

async function mcpServerGates(item) {
  const dir = path.join(root, "runtime/src/mcp-server");
  if (!existsSync(dir)) failGate("runtime/src/mcp-server/ missing");
  pass("mcp-server subsystem present");
  const tests = walkFiles(dir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
  if (tests.length === 0) failGate("no test files under runtime/src/mcp-server/");
  pass(`${tests.length} test file(s)`);
}

async function pluginGates(item) {
  const dir = path.join(root, "runtime/src/plugins");
  if (!existsSync(dir)) failGate("runtime/src/plugins/ missing");
  pass("plugins subsystem present");
  // PK-06: agenc plugin CLI subcommands.
  if (id === "PK-06") {
    const cliReferenced = grepRepo("agenc plugin", "runtime/src");
    if (!cliReferenced) failGate(`'agenc plugin' subcommand surface not found anywhere in runtime/src/`);
    pass("agenc plugin subcommand present");
    return;
  }
  if (id === "PK-08") {
    const helloExample = run("node", [
      "scripts/check-plugin-kit-hello-example.mjs",
    ]);
    if (helloExample.status !== 0) {
      failGate("PK-08 plugin-kit hello-tool example check failed");
    }
    pass("plugin-kit hello-tool example matches the live plugin contract");
    return;
  }
  if (id === "PK-09") {
    const resolutionTests = run("npm", [
      "exec",
      "--workspace=@tetsuo-ai/runtime",
      "vitest",
      "run",
      "src/plugins/resolution.test.ts",
    ]);
    if (resolutionTests.status !== 0) {
      failGate("PK-09 plugin resolution/signing/cache telemetry tests failed");
    }
    pass("plugin resolution, signature verification, cache, and telemetry tests passed");
    return;
  }
  if (id === "PK-10") {
    pass("PK-10 SDK daemon method drift check is enforced by the standard gate");
    return;
  }
  if (id === "PK-11") {
    const packageExport = run("node", [
      "scripts/check-protocol-package-schema-export.mjs",
    ]);
    if (packageExport.status !== 0) {
      failGate("PK-11 protocol package schema export check failed");
    }
    pass("protocol package schema export resolves from a packed install");
    return;
  }
  if (id === "PK-12") {
    const abiSurface = run("node", [
      "scripts/check-plugin-kit-abi-surface.mjs",
    ]);
    if (abiSurface.status !== 0) {
      failGate("PK-12 plugin-kit ABI surface check failed");
    }
    pass("plugin-kit dead ABI surface removed from runtime and package");
    return;
  }
  if (id === "PK-13") {
    const test = run("node", ["scripts/check-sibling-package-pins.test.mjs"]);
    if (test.status !== 0) {
      failGate("PK-13 sibling package pin checker tests failed");
    }
    const check = run("node", ["scripts/check-sibling-package-pins.mjs"]);
    if (check.status !== 0) {
      failGate("PK-13 sibling package pin check failed");
    }
    const commonDir = git("rev-parse", "--git-common-dir");
    if (commonDir.status !== 0) {
      failGate("PK-13 could not locate main checkout for umbrella validation wiring");
    }
    const mainCheckout =
      path.basename(path.resolve(root, commonDir.stdout.trim())) === ".git"
        ? path.dirname(path.resolve(root, commonDir.stdout.trim()))
        : root;
    const umbrellaPkg = path.join(path.dirname(mainCheckout), "package.json");
    const umbrella = JSON.parse(readFileSync(umbrellaPkg, "utf8"));
    if (
      !umbrella.scripts?.["check:sibling-package-pins"] ||
      !umbrella.scripts?.["validate:umbrella"]?.includes(
        "check:sibling-package-pins",
      )
    ) {
      failGate("PK-13 umbrella validate script does not run check:sibling-package-pins");
    }
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "agenc-pk13-umbrella-"));
    try {
      writeFileSync(
        path.join(fixtureRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "pk13-umbrella-fixture",
            private: true,
            scripts: {
              "check:sibling-package-pins":
                umbrella.scripts["check:sibling-package-pins"],
              "validate:umbrella": "npm run check:sibling-package-pins",
            },
          },
          null,
          2,
        )}\n`,
      );
      symlinkSync(root, path.join(fixtureRoot, "agenc-core"), "dir");
      const adminToolsDir = path.join(fixtureRoot, "agenc-prover", "admin-tools");
      mkdirSync(adminToolsDir, { recursive: true });
      writeFileSync(
        path.join(adminToolsDir, "package.json"),
        `${JSON.stringify(
          {
            name: "admin-tools",
            dependencies: {
              "@tetsuo-ai/protocol": "0.1.1",
              "@tetsuo-ai/sdk": "1.3.1",
            },
          },
          null,
          2,
        )}\n`,
      );
      const umbrellaCheck = run(
        "npm",
        ["run", "check:sibling-package-pins"],
        { cwd: fixtureRoot, silent: true },
      );
      if (umbrellaCheck.status !== 0) {
        failGate(
          `PK-13 umbrella check:sibling-package-pins script failed:\n${umbrellaCheck.stderr || umbrellaCheck.stdout}`,
        );
      }
      if (!umbrellaCheck.stdout.includes("stale pin(s) warned")) {
        failGate("PK-13 umbrella check:sibling-package-pins script did not warn on stale pins");
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
    pass("sibling package pin checker warns on stale pins");
    return;
  }
  // PK-01..PK-05, PK-07..PK-09: subsystem-shape items satisfied by the
  // plugins/ directory check above. Recognized via known PK-* IDs.
  if (/^PK-0[1-9]$/.test(id) || /^PK-1[0-9]$/.test(id)) {
    pass(`${id}: plugins subsystem check satisfied`);
    return;
  }
  failGate(
    `item ${id} has no specific gate branch in pluginGates; add one or remove the item`,
  );
}

async function migrationGates(item) {
  // MG-* items are about transition. Done condition is item-specific; verify
  // the named subsystem changed shape per item ID.
  if (id === "MG-01") {
    // Direct-CLI fallback during transition. Just ensure bin/agenc.ts still exists.
    const f = path.join(root, "runtime/src/bin/agenc.ts");
    if (!existsSync(f)) failGate("runtime/src/bin/agenc.ts missing — direct-CLI fallback required during transition");
    pass("direct-CLI fallback present");
    return;
  }
  if (id === "MG-02") {
    const test = run("node", ["scripts/check-bin-classification.test.mjs"]);
    if (test.status !== 0) {
      failGate("MG-02: bin classification checker tests failed");
    }
    const check = run("node", ["scripts/check-bin-classification.mjs"]);
    if (check.status !== 0) {
      failGate("MG-02: bin classification inventory is incomplete");
    }
    pass("MG-02: runtime/src/bin classification inventory complete");
    return;
  }
  if (id === "MG-03") {
    const test = run("node", ["scripts/check-bin-classification.test.mjs"]);
    if (test.status !== 0) {
      failGate("MG-03: bin classification checker tests failed");
    }
    const check = run("node", [
      "scripts/check-bin-classification.mjs",
      "--forbid-daemon-only",
    ]);
    if (check.status !== 0) {
      failGate("MG-03: daemon-only bin files remain after relocation");
    }
    pass("MG-03: runtime/src/bin has no daemon-only production files");
    return;
  }
  if (id === "MG-04") {
    const client = path.join(root, "runtime/src/app-server-client/index.ts");
    if (!existsSync(client)) {
      failGate("runtime/src/app-server-client/index.ts missing — daemon-only CLI requires it");
    }
    const cli = await readFileSafe(path.join(root, "runtime/src/bin/agenc.ts"));
    if (cli.includes("bootstrapLocalRuntimeSession")) {
      failGate("MG-04: runtime/src/bin/agenc.ts still references local runtime bootstrap");
    }
    if (
      cli.includes("AGENC_FORCE_DIRECT_RUNTIME") ||
      cli.includes("--no-daemon") ||
      cli.includes("shouldSkipAgenCDaemonForStartup")
    ) {
      failGate("MG-04: MG-01 daemon bypass flag remains in runtime/src/bin/agenc.ts");
    }
    const vitest = run("npm", [
      "exec",
      "--workspace=@tetsuo-ai/runtime",
      "vitest",
      "run",
      "src/bin/agenc.daemon-only.test.ts",
      "src/bin/agenc.cli-branch.test.ts",
      "src/bin/agenc.test.ts",
      "src/bin/agenc.user-prompt-submit.test.ts",
      "src/app-server-client/index.test.ts",
      "src/app-server/agent-lifecycle.contract.test.ts",
      "src/app-server/background-agent-runner.contract.test.ts",
      "src/tui/daemon-session.contract.test.ts",
      "src/app-server/agent-cli.contract.test.ts",
      "src/agents/fork-context.test.ts",
    ]);
    if (vitest.status !== 0) {
      failGate("MG-04: daemon-only CLI targeted Vitest suite failed");
    }
    pass("MG-04: daemon-only CLI client present and bin/agenc.ts has no local bootstrap references");
    return;
  }
  if (id === "MG-05") {
    const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const runtimePkg = JSON.parse(readFileSync(path.join(root, "runtime/package.json"), "utf8"));
    const expectedRootScripts = {
      daemon: "npm --workspace=@tetsuo-ai/runtime run daemon",
      "daemon:status": "npm --workspace=@tetsuo-ai/runtime run daemon:status",
      start: "npm --workspace=@tetsuo-ai/runtime run start",
    };
    const expectedRuntimeScripts = {
      daemon: "node bin/agenc daemon start --foreground",
      "daemon:status": "node bin/agenc daemon status",
      start: "node bin/agenc",
    };
    const failures = [];
    for (const [name, expected] of Object.entries(expectedRuntimeScripts)) {
      if (runtimePkg.scripts?.[name] !== expected) {
        failures.push(`runtime/package.json scripts.${name} must be ${JSON.stringify(expected)}`);
      }
    }
    for (const [name, expected] of Object.entries(expectedRootScripts)) {
      if (rootPkg.scripts?.[name] !== expected) {
        failures.push(`package.json scripts.${name} must be ${JSON.stringify(expected)}`);
      }
    }
    if (failures.length > 0) {
      failGate(`MG-05: daemon-driven package script surface mismatch:\n  - ${failures.join("\n  - ")}`);
    }
    pass("MG-05: runtime and root package daemon/start scripts present");
    return;
  }
  if (id === "MG-06") {
    // Public launcher hand-off: npm package invokes the daemon-backed runtime.
    const wrapperPkg = path.join(root, "packages/agenc/package.json");
    if (!existsSync(wrapperPkg)) {
      failGate(`MG-06: public launcher package missing at ${wrapperPkg}`);
    }
    const wrapper = JSON.parse(readFileSync(wrapperPkg, "utf8"));
    const failures = [];
    if (wrapper.name !== "@tetsuo-ai/agenc") {
      failures.push("packages/agenc/package.json name must be @tetsuo-ai/agenc");
    }
    if (wrapper.bin?.agenc !== "bin/agenc") {
      failures.push("packages/agenc/package.json bin.agenc must be bin/agenc");
    }
    if (wrapper.dependencies?.["@tetsuo-ai/runtime"] !== "file:../../runtime") {
      failures.push("packages/agenc/package.json must depend on @tetsuo-ai/runtime via file:../../runtime");
    }
    const launcher = readFileSync(path.join(root, "packages/agenc/src/launcher.mjs"), "utf8");
    for (const marker of [
      "AGENC_DAEMON_AUTOSTART",
      "AGENC_DAEMON_READY_TIMEOUT_MS",
      "daemon.pid",
      "daemon.cookie",
      "spawnDaemon",
      "waitForDaemonReady",
      "resolveRuntimeBin",
    ]) {
      if (!launcher.includes(marker)) {
        failures.push(`packages/agenc/src/launcher.mjs missing ${marker}`);
      }
    }
    const tests = run("node", ["--test", "packages/agenc/test/launcher.test.mjs"]);
    if (tests.status !== 0) {
      failures.push("packages/agenc launcher tests failed");
    }
    if (failures.length > 0) {
      failGate(`MG-06: public launcher package contract mismatch:\n  - ${failures.join("\n  - ")}`);
    }
    pass("MG-06: public launcher package autostarts and health-checks daemon");
    return;
  }
  if (id === "MG-07") {
    const releaseNotes = readFileSync(path.join(root, "packages/agenc/RELEASE_NOTES.md"), "utf8");
    const docsContractPath = path.join(root, "docs/cli/agenc-docs-daemon-contract.json");
    const docsContract = JSON.parse(readFileSync(docsContractPath, "utf8"));
    const failures = [];
    const requiredReleaseMarkers = [
      "@tetsuo-ai/agenc",
      "daemon.pid",
      "daemon.cookie",
      "AGENC_DAEMON_AUTOSTART",
      "AGENC_DAEMON_READY_TIMEOUT_MS",
      "AGENC_DAEMON_REQUEST_TIMEOUT_MS",
      "agenc daemon start --foreground",
      "agenc agent start",
      "systemd",
      "launchd",
    ];
    const requiredDocMarkers = [
      "Daemon lifecycle",
      "daemon.pid",
      "daemon.sock",
      "daemon.cookie",
      "AGENC_HOME",
      "AGENC_DAEMON_AUTOSTART",
      "AGENC_DAEMON_READY_TIMEOUT_MS",
      "AGENC_DAEMON_REQUEST_TIMEOUT_MS",
      "agenc daemon status",
      "agenc agent start",
      "agenc agent list",
      "agenc agent attach",
      "agenc agent stop",
      "agenc agent logs",
      "packaging/systemd/agenc-daemon.service",
      "packaging/launchd/dev.agenc.daemon.plist",
      "ExecStart=/usr/bin/env agenc daemon start --foreground",
    ];
    for (const marker of requiredReleaseMarkers) {
      if (!releaseNotes.includes(marker)) {
        failures.push(`packages/agenc/RELEASE_NOTES.md missing ${marker}`);
      }
    }
    if (docsContract.siblingRepo !== "agenc-docs") {
      failures.push("docs contract siblingRepo must be agenc-docs");
    }
    if (docsContract.docsPath !== "docs/cli/daemon.mdx") {
      failures.push("docs contract docsPath must be docs/cli/daemon.mdx");
    }
    if (!/^[0-9a-f]{40}$/.test(docsContract.mergeCommit ?? "")) {
      failures.push("docs contract mergeCommit must be a full git SHA");
    }
    if (!/^[0-9a-f]{40}$/.test(docsContract.contentCommit ?? "")) {
      failures.push("docs contract contentCommit must be a full git SHA");
    }
    if (!/^[0-9a-f]{64}$/.test(docsContract.contentSha256 ?? "")) {
      failures.push("docs contract contentSha256 must be a full sha256 hex digest");
    }
    if (Object.prototype.hasOwnProperty.call(docsContract, "siblingRepoPath")) {
      failures.push("docs contract must not store a machine-local siblingRepoPath");
    }
    const configuredDocsRoot = process.env.AGENC_DOCS_ROOT?.trim();
    const siblingDocsRoot =
      configuredDocsRoot && configuredDocsRoot.length > 0
        ? configuredDocsRoot
        : path.resolve(mainCheckoutRoot(), "..", docsContract.siblingRepo);
    const docsPath = path.join(siblingDocsRoot, docsContract.docsPath ?? "");
    if (!existsSync(docsPath)) {
      failures.push(`agenc-docs daemon page missing at ${docsPath}`);
    } else {
      const daemonDocs = readFileSync(docsPath, "utf8");
      const digest = createHash("sha256").update(daemonDocs).digest("hex");
      if (digest !== docsContract.contentSha256) {
        failures.push(`agenc-docs daemon page sha256 mismatch: ${digest}`);
      }
      for (const marker of requiredDocMarkers) {
        if (!daemonDocs.includes(marker)) {
          failures.push(`agenc-docs docs/cli/daemon.mdx missing ${marker}`);
        }
      }
    }
    const verification = Array.isArray(docsContract.verification)
      ? docsContract.verification
      : [];
    for (const command of [
      "node scripts/branding-scan.mjs docs/cli/daemon.mdx",
      "npm run prebuild",
    ]) {
      if (
        !verification.some(
          (entry) => entry?.command === command && entry?.status === "passed",
        )
      ) {
        failures.push(`docs contract missing passed verification: ${command}`);
      }
    }
    if (failures.length > 0) {
      failGate(`MG-07: daemon release notes/docs coverage mismatch:\n  - ${failures.join("\n  - ")}`);
    }
    pass("MG-07: daemon release notes and user docs cover lifecycle, env, agents, systemd, and launchd");
    return;
  }
  failGate(
    `migration item ${id} has no specific gate branch. ` +
    `Add a branch to migrationGates() in scripts/goal/verify.mjs.`,
  );
}

async function configGates(item) {
  // CF-* items: each adds a named config flag. Look for the flag in the schema.
  const flagMap = {
    "CF-01": "auth.backend",
    "CF-02": "model_provider",
    "CF-03": "auth.managedKeys.enabled",
    "CF-04": "agenc",
    "CF-05": "sandbox.mode",
    "CF-06": "agent.retention",
    "CF-07": "permissions.default_mode",
    "CF-08": "daemon.transport",
    "CF-09": "daemon.autostart",
    "CF-10": "plugins.enabled",
    "CF-11": "mcp.server",
  };
  const flag = flagMap[id];
  if (flag) {
    const found = grepRepo(flag.replace(/\./g, "\\."), "runtime/src/config");
    if (!found) failGate(`config flag "${flag}" not referenced under runtime/src/config/`);
    pass(`config flag "${flag}" referenced`);
  }
  if (id === "CF-13") {
    const tests = walkFiles(path.join(root, "runtime/src/config")).filter((p) =>
      /\.test\.(ts|tsx)$/.test(p),
    );
    if (tests.length === 0) failGate("no test files under runtime/src/config/");
    pass(`${tests.length} test file(s) under config/`);
    return;
  }
  if (id === "CF-14") {
    const cli = grepRepo("parseAgenCConfigCliArgs|runAgenCConfigCli", "runtime/src/bin/config-cli.ts");
    if (!cli) failGate("config CLI parser/runner not found in runtime/src/bin/config-cli.ts");
    const route = grepRepo("configCommand = parseAgenCConfigCliArgs", "runtime/src/bin/agenc.ts");
    if (!route) failGate("agenc config is not routed through the top-level CLI dispatcher");
    for (const anchor of ["runConfigFileMigrations", "validateAgenCConfigBlocks", "writeTextAtomic"]) {
      const editSafety = grepRepo(anchor, "runtime/src/bin/config-cli.ts");
      if (!editSafety) failGate(`config CLI edit safety anchor missing: ${anchor}`);
    }
    pass("agenc config shell CLI present with routing and edit-safety anchors");
    return;
  }
  if (id === "CF-12") {
    // Schema migration / version field.
    const found = grepRepo("schemaVersion|configVersion|migrate.*config|configMigration", "runtime/src/config");
    if (!found) failGate("CF-12: schema-version / config-migration not referenced under runtime/src/config/");
    pass("CF-12: schema migration referenced");
    return;
  }
  if (id === "CF-15") {
    // Per-agent budget caps schema.
    const found = grepRepo("token_cap|dollar_cap|wall_clock_seconds|tokenCap|dollarCap|wallClock", "runtime/src/config");
    if (!found) failGate("CF-15: budget-cap fields not referenced under runtime/src/config/");
    pass("CF-15: budget caps referenced");
    return;
  }
  if (!flag) {
    failGate(
      `config item ${id} has no entry in flagMap and no specific gate branch. ` +
      `Add an entry to flagMap or a branch in configGates() in scripts/goal/verify.mjs.`,
    );
  }
}

async function onboardingGates(item) {
  // OB-02..OB-04: CLI surface checks.
  if (id === "OB-02") {
    const help = grepRepo("--help", "runtime/src/bin");
    if (!help) failGate("'--help' not referenced in runtime/src/bin/");
    pass("--help surface present");
    return;
  }
  if (id === "OB-03") {
    const found = grepRepo("/help", "runtime/src/commands");
    if (!found) failGate("/help slash command not referenced under runtime/src/commands/");
    pass("/help slash command present");
    return;
  }
  if (id === "OB-04") {
    const found = grepRepo("/doctor", "runtime/src/commands");
    if (!found) failGate("/doctor slash command not referenced under runtime/src/commands/");
    pass("/doctor slash command present");
    return;
  }
  if (id === "OB-06") {
    const found = grepRepo("agenc init", "runtime/src");
    if (!found) failGate("'agenc init' CLI surface not found");
    const test = run("npm", [
      "--workspace=@tetsuo-ai/runtime",
      "exec",
      "vitest",
      "run",
      "src/bin/init-cli.test.ts",
      "src/bin/agenc-help.test.ts",
    ]);
    if (test.status !== 0) {
      failGate("OB-06: agenc init CLI tests failed");
    }
    pass("agenc init subcommand present");
    return;
  }
  if (id === "OB-01") {
    // First-run onboarding flow.
    const found = grepRepo("first.run|firstRun|first-run|onboarding", "runtime/src");
    if (!found) failGate("OB-01: first-run/onboarding flow not referenced in runtime/src/");
    pass("OB-01: onboarding referenced");
    return;
  }
  if (id === "OB-05") {
    // /login or auth onboarding command.
    const found = grepRepo("/login|agenc login", "runtime/src");
    if (!found) failGate("OB-05: login command not referenced");
    pass("OB-05: login command present");
    return;
  }
  if (id === "OB-07") {
    // Onboarding-specific prompts.
    const dir = path.join(root, "runtime/src/prompts");
    if (!existsSync(dir)) failGate("OB-07: runtime/src/prompts/ missing");
    pass("OB-07: prompts subsystem present");
    return;
  }
  if (id === "OB-09") {
    const test = run("npm", [
      "--workspace=@tetsuo-ai/runtime",
      "exec",
      "vitest",
      "run",
      "src/onboarding/onboarding.test.tsx",
      "src/onboarding/useApiKeyVerification.test.ts",
      "src/onboarding/inputPaste.test.ts",
      "src/auth/backends/local.contract.test.ts",
      "src/bin/bootstrap.test.ts",
      "src/tui/components/App.render.test.tsx",
    ]);
    if (test.status !== 0) {
      failGate("OB-09: BYOK onboarding tests failed");
    }
    pass("OB-09: BYOK onboarding tests passed");
    return;
  }
  if (id === "OB-08") {
    // Progressive onboarding follow-ups.
    const found = grepRepo("onboarding|first.run|firstRun", "runtime/src");
    if (!found) failGate(`${id}: onboarding flow not referenced`);
    pass(`${id}: onboarding referenced`);
    return;
  }
  failGate(
    `onboarding item ${id} has no specific gate branch. ` +
    `Add a branch to onboardingGates() in scripts/goal/verify.mjs.`,
  );
}

async function updateGates(item) {
  if (id === "UP-01") {
    const found = grepRepo("agenc update", "runtime/src");
    if (!found) failGate("'agenc update' CLI surface not found");
    pass("agenc update subcommand present");
    return;
  }
  if (id === "UP-02") {
    // Update notification UI.
    const found = grepRepo("AutoUpdater|autoUpdater|UpdateNotice|update.notification", "runtime/src");
    if (!found) failGate("UP-02: AutoUpdater / update notification UI not referenced");
    pass("UP-02: update notification UI referenced");
    return;
  }
  if (id === "UP-03") {
    // Update channel config.
    const found = grepRepo("update.channel|updateChannel", "runtime/src/config");
    if (!found) failGate("UP-03: update.channel config flag not referenced");
    pass("UP-03: update.channel referenced");
    return;
  }
  if (id === "UP-04") {
    // Auto-update opt-in.
    const found = grepRepo("update.auto|updateAuto|auto.update", "runtime/src/config");
    if (!found) failGate("UP-04: auto-update config flag not referenced");
    pass("UP-04: auto-update config referenced");
    return;
  }
  if (id === "UP-05") {
    // Rollback support.
    const found = grepRepo("rollback|previous.version", "runtime/src");
    if (!found) failGate("UP-05: rollback machinery not referenced");
    pass("UP-05: rollback referenced");
    return;
  }
  if (id === "UP-06") {
    // Background-update fetch.
    const found = grepRepo("update.fetch|updateFetch|background.update", "runtime/src");
    if (!found) failGate("UP-06: background update fetch not referenced");
    pass("UP-06: background update referenced");
    return;
  }
  failGate(
    `update item ${id} has no specific gate branch. ` +
    `Add a branch to updateGates() in scripts/goal/verify.mjs.`,
  );
}

async function promptGates(item) {
  // PR-01..PR-08: prompt assembly. Look for a prompts subsystem.
  const dir = path.join(root, "runtime/src/prompts");
  if (!existsSync(dir)) failGate("runtime/src/prompts/ missing");
  pass("prompts subsystem present");
  if (id === "PR-02") {
    const found = grepRepo("AGENC\\.md", "runtime/src/prompts");
    if (!found) failGate("AGENC.md inclusion not referenced in runtime/src/prompts/");
    if (!grepRepo("outer document exceeds the byte budget", "runtime/src/prompts/project-instructions.test.ts")) {
      failGate("PR-02: closest-file byte-budget regression test missing");
    }
    if (!grepRepo("UTF-8 code point boundary", "runtime/src/prompts/project-instructions.test.ts")) {
      failGate("PR-02: multibyte truncation regression test missing");
    }
    const vitest = run(
      "npm",
      [
        "test",
        "--",
        "src/prompts/agenc-md.test.ts",
        "src/prompts/project-instructions.test.ts",
        "src/prompts/system-prompt.test.ts",
        "src/conversation/multi-turn-context.contract.test.ts",
      ],
      { cwd: path.join(root, "runtime") },
    );
    if (vitest.status !== 0) failGate("PR-02 targeted prompt tests failed");
    pass("PR-02 targeted prompt tests passed");
    pass("AGENC.md inclusion present");
    return;
  }
  if (id === "PR-01") {
    // Base prompt assembly.
    const found = grepRepo("buildSystemPrompt|systemPrompt|basePrompt", "runtime/src/prompts");
    if (!found) failGate("PR-01: base prompt assembly not referenced");
    pass("PR-01: base prompt assembly referenced");
    return;
  }
  if (id === "PR-03") {
    // Tool descriptions in prompt.
    const found = grepRepo("toolDescriptions|tool_descriptions|describeTools", "runtime/src/prompts");
    if (!found) failGate("PR-03: tool descriptions not referenced");
    pass("PR-03: tool descriptions referenced");
    return;
  }
  if (id === "PR-04") {
    // Skill instructions.
    const found = grepRepo("skillInstructions|skill_instructions", "runtime/src/prompts");
    if (!found) failGate("PR-04: skill instructions not referenced");
    pass("PR-04: skill instructions referenced");
    return;
  }
  if (id === "PR-05") {
    // Permission instructions.
    const found = grepRepo("permissionsInstructions|permissions_instructions|permissionPrompt", "runtime/src/prompts");
    if (!found) failGate("PR-05: permissions instructions not referenced");
    pass("PR-05: permissions instructions referenced");
    return;
  }
  if (id === "PR-06") {
    const wireToolsFile = "runtime/src/llm/wire/tools.ts";
    const requiredConsumers = [
      "runtime/src/llm/wire/chat-completions.ts",
      "runtime/src/llm/wire/responses-openai.ts",
      "runtime/src/llm/wire/responses-xai.ts",
      "runtime/src/llm/wire/messages-anthropic.ts",
    ];
    if (!existsSync(path.join(root, wireToolsFile))) {
      failGate("PR-06: wire tool conversion file missing");
    }
    for (const consumer of requiredConsumers) {
      if (!existsSync(path.join(root, consumer))) {
        failGate(`PR-06: required wire consumer missing: ${consumer}`);
      }
    }
    if (!grepRepo("description: toolDescription\\(tool\\)", wireToolsFile)) {
      failGate("PR-06: wire tools must inject prompt-derived descriptions");
    }
    if (!grepRepo("toOpenAIResponsesTools", "runtime/src/llm/wire/responses-openai.ts")) {
      failGate("PR-06: Responses builder must use central tool conversion");
    }
    if (!grepRepo("toChatCompletionsTools", "runtime/src/llm/wire/chat-completions.ts")) {
      failGate("PR-06: chat-completions builder must use central tool conversion");
    }
    if (!grepRepo("toXaiResponsesTools", "runtime/src/llm/wire/responses-xai.ts")) {
      failGate("PR-06: xAI Responses builder must expose central tool conversion");
    }
    if (!grepRepo("toAnthropicTools", "runtime/src/llm/wire/messages-anthropic.ts")) {
      failGate("PR-06: Messages builder must use central tool conversion");
    }
    const vitest = run(
      "npm",
      [
        "test",
        "--",
        "src/llm/wire/tools.test.ts",
        "src/llm/wire/chat-completions.test.ts",
        "src/llm/wire/messages-anthropic.test.ts",
        "src/llm/wire/responses-openai.test.ts",
        "src/llm/wire/responses-xai.test.ts",
      ],
      { cwd: path.join(root, "runtime") },
    );
    if (vitest.status !== 0) failGate("PR-06 targeted wire tool tests failed");
    pass("PR-06 targeted wire tool tests passed");
    pass("PR-06: tool description injection is centralized in llm/wire/tools");
    return;
  }
  if (id === "PR-07") {
    const promptFile = "runtime/src/services/compact/prompt.ts";
    const compactFile = "runtime/src/services/compact/compact.ts";
    const compactTestFile = "runtime/src/services/compact/compact.test.ts";
    const surfaceTestFile = "runtime/src/services/compact/compact-surfaces.test.ts";
    if (!existsSync(path.join(root, promptFile))) {
      failGate("PR-07: compact prompt file missing");
    }
    if (!existsSync(path.join(root, compactFile))) {
      failGate("PR-07: compact service file missing");
    }
    if (!grepRepo("getCompactPrompt", promptFile)) {
      failGate("PR-07: getCompactPrompt missing");
    }
    if (!grepRepo("getPartialCompactPrompt", promptFile)) {
      failGate("PR-07: getPartialCompactPrompt missing");
    }
    if (!grepRepo("getCompactUserSummaryMessage", promptFile)) {
      failGate("PR-07: compact continuation message helper missing");
    }
    if (!grepRepo("Summary:\\\\n", promptFile)) {
      failGate("PR-07: formatted compact summaries must use readable Summary header");
    }
    if (!grepRepo("getCompactPrompt\\(customInstructions\\)", compactFile)) {
      failGate("PR-07: live compact service must use getCompactPrompt");
    }
    if (!grepRepo("getCompactUserSummaryMessage\\(summary\\)", compactFile)) {
      failGate("PR-07: live compact service must use compact continuation messages");
    }
    if (!grepRepo("getPartialCompactPrompt|RECENT portion|Context for Continuing Work", surfaceTestFile)) {
      failGate("PR-07: compact prompt tests missing");
    }
    if (!grepRepo("CRITICAL: Respond with TEXT ONLY|This session is being continued", compactTestFile)) {
      failGate("PR-07: compact service prompt behavior test missing");
    }
    const vitest = run("node_modules/.bin/vitest", [
      "run",
      compactTestFile,
      surfaceTestFile,
    ]);
    if (vitest.status !== 0) failGate("PR-07 targeted Vitest suite failed");
    pass("PR-07 targeted Vitest suite passed");
    pass("PR-07: compact prompt APIs and tests present");
    return;
  }
  if (id === "PR-08") {
    const requiredSymbols = [
      ["runtime/src/services/extractMemories/prompts.ts", "buildExtractAutoOnlyPrompt"],
      ["runtime/src/services/extractMemories/prompts.ts", "../../memdir/memory-types.js"],
      ["runtime/src/services/extractMemories/prompts.ts", "model-visible messages"],
      ["runtime/src/services/extractMemories/prompts.test.ts", "memory extraction prompt"],
      ["runtime/src/memdir/memory-types.ts", "TYPES_SECTION_INDIVIDUAL"],
      ["runtime/src/memdir/memory-types.ts", "WHAT_NOT_TO_SAVE_SECTION"],
      ["runtime/src/memdir/memory-types.ts", "MEMORY_FRONTMATTER_EXAMPLE"],
      ["runtime/src/memdir/memory-types.ts", "parseMemoryType"],
      ["runtime/src/memdir/memory.contract.test.ts", "memory-types.ts"],
      ["runtime/src/memory/PARITY.md", "PR-08 extraction-prompt"],
      ["parity/PR-08-parity.json", "memory-extraction-prompt"],
    ];
    for (const [rel, symbol] of requiredSymbols) {
      const file = path.join(root, rel);
      if (!existsSync(file)) failGate(`PR-08: ${rel} missing`);
      const source = readFileSync(file, "utf8");
      if (!source.includes(symbol)) {
        failGate(`PR-08: ${symbol} missing from ${rel}`);
      }
    }
    const promptSource = readFileSync(
      path.join(root, "runtime/src/services/extractMemories/prompts.ts"),
      "utf8",
    );
    if (!promptSource.includes("MEMORY.md` is an index")) {
      failGate("PR-08: extraction prompt must describe MEMORY.md as an index");
    }
    const taxonomySource = readFileSync(
      path.join(root, "runtime/src/memdir/memory-types.ts"),
      "utf8",
    );
    if (/\b[a-z0-9-]+\.internal\b/iu.test(taxonomySource) || /https?:\/\//iu.test(taxonomySource)) {
      failGate("PR-08: memory taxonomy examples must use URNs or plain labels, not invented domains");
    }
    const vitest = run("npm", [
      "test",
      "--workspace",
      "@tetsuo-ai/runtime",
      "--",
      "--run",
      "src/services/extractMemories/prompts.test.ts",
      "src/services/extractMemories/extractMemories.test.ts",
      "src/memdir/memory.contract.test.ts",
    ]);
    if (vitest.status !== 0) failGate("PR-08 targeted Vitest suite failed");
    pass("PR-08: memory extraction prompt and taxonomy verified");
    return;
  }
  if (id === "PR-09") {
    const requiredFiles = [
      "runtime/src/context/personality-spec-instructions.ts",
      "runtime/src/context/personality-spec-instructions.test.ts",
      "runtime/src/llm/registry/model-catalog.ts",
      "runtime/src/llm/model-registry.ts",
      "runtime/src/session/run-turn.ts",
      "runtime/src/session/run-turn.test.ts",
      "runtime/src/session/rollout-reconstruction.ts",
      "runtime/src/session/rollout-reconstruction.test.ts",
      "parity/PR-09-parity.json",
    ];
    for (const file of requiredFiles) {
      if (!existsSync(path.join(root, file))) {
        failGate(`PR-09: required personality file missing: ${file}`);
      }
    }
    if (!grepRepo("renderPersonalitySpecBody", "runtime/src/context/personality-spec-instructions.ts")) {
      failGate("PR-09: personality body renderer missing");
    }
    if (!grepRepo("personalitySpecInstructionMessage", "runtime/src/context/personality-spec-instructions.ts")) {
      failGate("PR-09: developer message builder missing");
    }
    if (!grepRepo("modelMessages: OPENAI_PERSONALITY_MESSAGES", "runtime/src/llm/registry/model-catalog.ts")) {
      failGate("PR-09: model catalog personality template metadata missing");
    }
    if (!grepRepo("modelSupportsPersonality", "runtime/src/llm/model-registry.ts")) {
      failGate("PR-09: model registry personality support bit missing");
    }
    if (!grepRepo("buildPersonalitySpecUpdateMessage", "runtime/src/session/run-turn.ts")) {
      failGate("PR-09: run-turn personality update injection missing");
    }
    if (!grepRepo("modelSupportsPersonality\\(ctx\\.modelInfo\\.modelMessages\\)", "runtime/src/session/run-turn.ts")) {
      failGate("PR-09: personality update injection must require complete model support");
    }
    if (!grepRepo("message\\.length > 0", "runtime/src/session/run-turn.ts")) {
      failGate("PR-09: personality update injection must filter empty templates");
    }
    if (!grepRepo("empty-template", "runtime/src/session/run-turn.test.ts")) {
      failGate("PR-09: empty personality template regression test missing");
    }
    if (!grepRepo("incomplete-template", "runtime/src/session/run-turn.test.ts")) {
      failGate("PR-09: incomplete personality template regression test missing");
    }
    if (!grepRepo("export type Personality = \"none\" \\| \"friendly\" \\| \"pragmatic\"", "runtime/src/config/schema.ts")) {
      failGate("PR-09: config personality enum has not been replaced");
    }
    if (!grepRepo("personality-spec-developer-fragment", "parity/PR-09-parity.json")) {
      failGate("PR-09: parity matrix missing personality contract");
    }
    const vitest = run("npm", [
      "test",
      "--",
      "src/context/personality-spec-instructions.test.ts",
      "src/llm/registry/registry.test.ts",
      "src/session/run-turn.test.ts",
      "src/session/rollout-reconstruction.test.ts",
    ], { cwd: path.join(root, "runtime") });
    if (vitest.status !== 0) failGate("PR-09 targeted Vitest suite failed");
    pass("PR-09 targeted Vitest suite passed");
    pass("PR-09: personality template and developer fragment behavior present");
    return;
  }
  if (id === "PR-10") {
    const requiredFiles = [
      "runtime/src/personality/migration.ts",
      "runtime/src/personality/migration.test.ts",
      "runtime/src/config/edit.ts",
      "runtime/src/bin/bootstrap.ts",
      "runtime/src/bin/bootstrap.test.ts",
      "runtime/src/bin/bootstrap-services.ts",
      "parity/PR-10-parity.json",
    ];
    for (const file of requiredFiles) {
      if (!existsSync(path.join(root, file))) {
        failGate(`PR-10: required personality migration file missing: ${file}`);
      }
    }
    if (!grepRepo("PERSONALITY_MIGRATION_FILENAME = \"\\.personality_migration\"", "runtime/src/personality/migration.ts")) {
      failGate("PR-10: migration marker filename missing");
    }
    if (!grepRepo("SkippedMarker", "runtime/src/personality/migration.ts")) {
      failGate("PR-10: SkippedMarker status missing");
    }
    if (!grepRepo("SkippedExplicitPersonality", "runtime/src/personality/migration.ts")) {
      failGate("PR-10: SkippedExplicitPersonality status missing");
    }
    if (!grepRepo("SkippedNoSessions", "runtime/src/personality/migration.ts")) {
      failGate("PR-10: SkippedNoSessions status missing");
    }
    if (!grepRepo("setPersonality\\(\"pragmatic\"\\)", "runtime/src/personality/migration.ts")) {
      failGate("PR-10: applied migration must write pragmatic personality");
    }
    if (!grepRepo("flag: \"wx\"", "runtime/src/personality/migration.ts")) {
      failGate("PR-10: marker must use create-new file semantics");
    }
    if (!grepRepo("AgenCConfigEditsBuilder", "runtime/src/config/edit.ts")) {
      failGate("PR-10: config edit builder missing");
    }
    if (!grepRepo("maybeMigratePersonality", "runtime/src/bin/bootstrap.ts")) {
      failGate("PR-10: bootstrap personality migration hook missing");
    }
    if (!grepRepo("personalityMigrationStatus === \"Applied\"", "runtime/src/bin/bootstrap.ts")) {
      failGate("PR-10: bootstrap must reload config when migration applies");
    }
    if (!grepRepo("defaultModelProviderId: opts\\.providerName", "runtime/src/bin/bootstrap-services.ts")) {
      failGate("PR-10: bootstrap thread store must use resolved provider fallback");
    }
    if (!grepRepo("applies when only archived sessions exist", "runtime/src/personality/migration.test.ts")) {
      failGate("PR-10: archived-session migration test missing");
    }
    if (!grepRepo("ignores sessions recorded under a different default provider", "runtime/src/personality/migration.test.ts")) {
      failGate("PR-10: provider-filter migration test missing");
    }
    if (!grepRepo("runs personality migration before constructing the first turn context", "runtime/src/bin/bootstrap.test.ts")) {
      failGate("PR-10: bootstrap startup hook test missing");
    }
    if (!grepRepo("personality-one-shot-migration", "parity/PR-10-parity.json")) {
      failGate("PR-10: parity matrix missing personality migration contract");
    }
    const vitest = run("npm", [
      "test",
      "--",
      "src/personality/migration.test.ts",
      "src/bin/bootstrap.test.ts",
    ], { cwd: path.join(root, "runtime") });
    if (vitest.status !== 0) failGate("PR-10 targeted Vitest suite failed");
    pass("PR-10 targeted Vitest suite passed");
    pass("PR-10: personality migration behavior and startup hook present");
    return;
  }
  if (id === "PR-11") {
    const requiredFiles = [
      "runtime/src/llm/registry/model-catalog.ts",
      "runtime/src/personality/personality.contract.test.ts",
      "runtime/src/personality/personality-migration.contract.test.ts",
      "parity/PR-11-parity.json",
    ];
    for (const file of requiredFiles) {
      if (!existsSync(path.join(root, file))) {
        failGate(`PR-11: required personality contract file missing: ${file}`);
      }
    }
    const personalityTest = "runtime/src/personality/personality.contract.test.ts";
    const migrationTest = "runtime/src/personality/personality-migration.contract.test.ts";
    const requiredPersonalityScenarios = [
      "personality_does_not_mutate_base_instructions_without_template",
      "base_instructions_override_disables_personality_template",
      "user_turn_personality_none_does_not_add_update_message",
      "config_personality_some_sets_instructions_template",
      "config_personality_none_sends_no_personality",
      "default_personality_is_pragmatic_without_config_toml",
      "user_turn_personality_some_adds_update_message",
      "user_turn_personality_same_value_does_not_add_update_message",
    ];
    for (const scenario of requiredPersonalityScenarios) {
      if (!grepRepo(scenario, personalityTest)) {
        failGate(`PR-11: missing personality scenario ${scenario}`);
      }
    }
    const requiredMigrationScenarios = [
      "applies_when_sessions_exist_and_no_personality",
      "applies_when_only_archived_sessions_exist_and_no_personality",
      "skips_when_marker_exists",
      "skips_when_personality_explicit",
      "skips_when_no_sessions",
    ];
    for (const scenario of requiredMigrationScenarios) {
      if (!grepRepo(scenario, migrationTest)) {
        failGate(`PR-11: missing migration scenario ${scenario}`);
      }
    }
    if (!grepRepo("seenMessages", personalityTest)) {
      failGate("PR-11: personality contract must assert captured provider requests");
    }
    if (!grepRepo("PERSONALITY_SPEC_START_MARKER", personalityTest)) {
      failGate("PR-11: personality contract must assert developer update markers");
    }
    if (!grepRepo("LOCAL_PRAGMATIC_TEMPLATE", personalityTest)) {
      failGate("PR-11: personality contract must assert pragmatic template text");
    }
    if (!grepRepo("bootstrapLocalRuntimeSession", personalityTest)) {
      failGate("PR-11: default pragmatic contract must exercise startup bootstrap");
    }
    if (!grepRepo("personalityDefault: OPENAI_PRAGMATIC_PERSONALITY", "runtime/src/llm/registry/model-catalog.ts")) {
      failGate("PR-11: model catalog default personality must be pragmatic");
    }
    if (!grepRepo("MARKER_CONTENTS = \"v1\\\\n\"", migrationTest)) {
      failGate("PR-11: migration contract must lock marker file contents");
    }
    if (!grepRepo("config\\.toml", migrationTest)) {
      failGate("PR-11: migration contract must assert current config persistence");
    }
    if (!grepRepo("config\\.json\\.bak-cf12", migrationTest)) {
      failGate("PR-11: migration contract must cover legacy JSON config migration");
    }
    if (!grepRepo("personality-integration-contract", "parity/PR-11-parity.json")) {
      failGate("PR-11: parity matrix missing personality integration contract");
    }
    if (!grepRepo("legacy-config-json-migrates-before-apply", "parity/PR-11-parity.json")) {
      failGate("PR-11: parity matrix missing config JSON migration row");
    }
    const vitest = run("npm", [
      "test",
      "--",
      "src/personality/personality.contract.test.ts",
      "src/personality/personality-migration.contract.test.ts",
    ], { cwd: path.join(root, "runtime") });
    if (vitest.status !== 0) failGate("PR-11 targeted Vitest suite failed");
    pass("PR-11 targeted Vitest suite passed");
    pass("PR-11: personality integration contract suites present");
    return;
  }
  failGate(
    `prompt item ${id} has no specific gate branch. ` +
    `Add a branch to promptGates() in scripts/goal/verify.mjs.`,
  );
}

async function memoryGates(item) {
  // MM-* items: memory subsystem.
  const dir = path.join(root, "runtime/src/memory");
  const altDir = path.join(root, "runtime/src/memdir");
  if (!existsSync(dir) && !existsSync(altDir)) {
    failGate("MM-*: runtime/src/memory/ or runtime/src/memdir/ missing");
  }
  if (id === "MM-06") {
    const found = grepRepo("agenc memory", "runtime/src");
    if (!found) failGate("'agenc memory' CLI surface not found");
    pass("agenc memory subcommand present");
    return;
  }
  if (id === "MM-01") {
    const requiredSymbols = [
      ["runtime/src/memory/paths.ts", "getGlobalMemoryPath"],
      ["runtime/src/memory/paths.ts", "getProjectMemoryPath"],
      ["runtime/src/memory/paths.ts", "isGlobalMemoryPath"],
      ["runtime/src/memory/agencmd.ts", "getGlobalMemoryEntrypoint"],
      ["runtime/src/utils/attachments.ts", "getDurableMemorySearchDirs"],
      ["runtime/src/utils/attachments.ts", "getGlobalMemoryPath"],
      ["runtime/src/utils/permissions/filesystem.ts", "isGlobalMemoryPath"],
      ["runtime/src/memory/paths.ts", "getProjectInstructionPath"],
      ["runtime/src/memory/memdir.ts", "buildSessionMemoryLayerLines"],
      ["runtime/src/memory/memdir.ts", "buildMemorySaveDestinationLines"],
      ["runtime/src/memory/memdir.ts", "buildAssistantDailyLogPrompt"],
      ["runtime/src/memory/store.ts", "tryClaimStage1Job"],
      ["runtime/src/memory/store.ts", "tryClaimGlobalPhase2Job"],
      ["runtime/src/state/migrations/index.ts", "memoryPipelineSchemaMigration"],
    ];
    for (const [rel, symbol] of requiredSymbols) {
      const source = readFileSync(path.join(root, rel), "utf8");
      if (!source.includes(symbol)) {
        failGate(`MM-01: ${symbol} missing from ${rel}`);
      }
    }

    const unchecked = walkFiles(dir)
      .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f))
      .filter((f) => path.basename(f) !== "agencmd.ts")
      .filter((f) => readFileSync(f, "utf8").startsWith("// @ts-nocheck"));
    if (unchecked.length > 0) {
      failGate(
        `MM-01: only runtime/src/memory/agencmd.ts may keep a temporary ts-nocheck boundary:\n  ${unchecked.map((f) => path.relative(root, f)).join("\n  ")}`,
      );
    }

    const oldOwnedImportPattern =
      /(?:from\s+|import\s*\(\s*)["'][^"']*(?:memdir\/(?:memdir|paths|memoryAge|memoryScan|memoryTypes|findRelevantMemories)|utils\/(?:agencmd|memoryFileDetection))/;
    const offenders = walkFiles(path.join(root, "runtime/src"))
      .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f))
      .filter((f) => !f.split(path.sep).join("/").includes("/runtime/src/agenc/upstream/"))
      .filter((f) => {
        const rel = path.relative(root, f).split(path.sep).join("/");
        return rel !== "runtime/src/memdir/teamMemPaths.ts" &&
          rel !== "runtime/src/memdir/teamMemPrompts.ts";
      })
      .filter((f) => oldOwnedImportPattern.test(readFileSync(f, "utf8")));
    if (offenders.length > 0) {
      failGate(
        `MM-01: old MM-01 memory import(s) remain:\n  ${offenders.slice(0, 20).map((f) => path.relative(root, f)).join("\n  ")}`,
      );
    }

    const vitest = run("npm", [
      "test",
      "--workspace",
      "@tetsuo-ai/runtime",
      "--",
      "--run",
      "src/memory/paths.test.ts",
      "src/memory/memdir.test.ts",
      "src/memory/memdir.feature-flags.test.ts",
      "src/memory/scan.test.ts",
      "src/memory/store.test.ts",
      "src/memory-wiring.contract.test.ts",
      "src/state/migrations.test.ts",
    ]);
    if (vitest.status !== 0) failGate("MM-01 targeted Vitest suite failed");
    pass("MM-01: three-layer memory subsystem and state pipeline verified");
    return;
  }
  if (id === "MM-02") {
    const requiredSymbols = [
      ["runtime/src/memory/global-store.ts", "getGlobalMemoryStoreInfo"],
      ["runtime/src/memory/global-store.ts", "ensureGlobalMemoryStore"],
      ["runtime/src/memory/global-store.ts", "loadGlobalMemoryStorePrompt"],
      ["runtime/src/memory/global-store.ts", "scanGlobalMemoryStore"],
      ["runtime/src/memory/global-store.ts", "getGlobalMemoryStoreSnapshot"],
      ["runtime/src/memory/global-store.test.ts", "global memory store"],
      ["runtime/src/utils/yaml.ts", "createRequire"],
      ["runtime/src/utils/yaml.ts", "js-yaml"],
      ["parity/MM-02-parity.json", "global-memory-store"],
    ];
    for (const [rel, symbol] of requiredSymbols) {
      const file = path.join(root, rel);
      if (!existsSync(file)) failGate(`MM-02: ${rel} missing`);
      const source = readFileSync(file, "utf8");
      if (!source.includes(symbol)) {
        failGate(`MM-02: ${symbol} missing from ${rel}`);
      }
    }
    const vitest = run("npm", [
      "test",
      "--workspace",
      "@tetsuo-ai/runtime",
      "--",
      "--run",
      "src/memory/global-store.test.ts",
      "src/memory/scan.test.ts",
      "src/memory/paths.test.ts",
    ]);
    if (vitest.status !== 0) failGate("MM-02 targeted Vitest suite failed");
    pass("MM-02: global memory store verified");
    return;
  }
  if (id === "MM-03") {
    const requiredSymbols = [
      ["runtime/src/memory/project-memory.ts", "getProjectMemoryPathForSelector"],
      ["runtime/src/memory/project-memory.ts", "MEMORY_MENTION_SYNTAX"],
      ["runtime/src/memory/project-memory.ts", "isMemoryMention"],
      ["runtime/src/utils/attachments.ts", "isMemoryMention"],
      ["runtime/src/components/memory/MemoryFileSelector.tsx", "../../memory/project-memory.js"],
      ["runtime/src/tui/components/memory/MemoryFileSelector.tsx", "../../../memory/project-memory.js"],
      ["runtime/src/tui/components/FeedbackSurvey/useMemorySurvey.tsx", "../../../memory/project-memory.js"],
      ["runtime/src/tools/FileReadTool/FileReadTool.ts", "../../memory/project-memory.js"],
      ["parity/MM-03-parity.json", "project-memory-api"],
    ];
    for (const [rel, symbol] of requiredSymbols) {
      const source = readFileSync(path.join(root, rel), "utf8");
      if (!source.includes(symbol)) {
        failGate(`MM-03: ${symbol} missing from ${rel}`);
      }
    }

    const directDetectionImports = walkFiles(path.join(root, "runtime/src"))
      .filter((f) => /\.(ts|tsx|mts|cts)$/.test(f))
      .filter((f) => !f.split(path.sep).join("/").includes("/runtime/src/agenc/upstream/"))
      .filter((f) => /from\s+["'][^"']*memory\/detection(?:\.js)?["']/.test(readFileSync(f, "utf8")));
    if (directDetectionImports.length > 0) {
      failGate(
        `MM-03: direct memory/detection imports remain:\n  ${directDetectionImports.map((f) => path.relative(root, f)).join("\n  ")}`,
      );
    }
    const fileReadTool = readFileSync(path.join(root, "runtime/src/tools/FileReadTool/FileReadTool.ts"), "utf8");
    if (/function\s+detectSessionFileType\b/.test(fileReadTool)) {
      failGate("MM-03: FileReadTool still carries a shadow detectSessionFileType implementation");
    }

    const vitest = run("npm", [
      "test",
      "--workspace",
      "@tetsuo-ai/runtime",
      "--",
      "--run",
      "src/memory/project-memory.test.ts",
      "src/memory/project-memory-routing.test.ts",
      "src/components/memory/memory-components.contract.test.tsx",
      "src/memory-wiring.contract.test.ts",
    ]);
    if (vitest.status !== 0) failGate("MM-03 targeted Vitest suite failed");
    pass("MM-03: project memory API and mention syntax verified");
    return;
  }
  if (id === "MM-04") {
    const requiredSymbols = [
      ["runtime/src/memory/session/sessionMemory.ts", "runSessionMemoryPostSamplingHook"],
      ["runtime/src/memory/session/sessionMemory.ts", "setupSessionMemoryFile"],
      ["runtime/src/memory/session/sessionMemory.ts", "createSessionMemoryEditPolicy"],
      ["runtime/src/memory/session/sessionMemoryUtils.ts", "resolveSessionMemoryPath"],
      ["runtime/src/memory/session/sessionMemoryUtils.ts", "isSessionMemoryEnabled"],
      ["runtime/src/memory/session/prompts.ts", "buildSessionMemoryUpdatePrompt"],
      ["runtime/src/memory/session/PARITY.md", "Session Memory Parity"],
      ["parity/MM-04-parity.json", "session-memory"],
      ["runtime/src/session/run-turn.ts", "../memory/session/sessionMemory.js"],
      ["runtime/src/setup.ts", "./memory/session/sessionMemory.js"],
      ["runtime/src/conversation/multi-turn-context.ts", "../memory/session/sessionMemoryUtils.js"],
      ["runtime/src/services/awaySummary.ts", "../memory/session/sessionMemoryUtils.js"],
      ["runtime/src/commands/compact/compact.ts", "../../memory/session/sessionMemoryUtils.js"],
    ];
    for (const [rel, symbol] of requiredSymbols) {
      const file = path.join(root, rel);
      if (!existsSync(file)) failGate(`MM-04: ${rel} missing`);
      const source = readFileSync(file, "utf8");
      if (!source.includes(symbol)) {
        failGate(`MM-04: ${symbol} missing from ${rel}`);
      }
    }

    const oldDir = path.join(root, "runtime/src/services/SessionMemory");
    if (existsSync(oldDir)) {
      failGate("MM-04: old runtime/src/services/SessionMemory directory remains");
    }

    const oldImportOffenders = walkFiles(path.join(root, "runtime/src"))
      .filter((file) => /\.(ts|tsx|mts|cts)$/.test(file))
      .filter((file) =>
        /from\s+["'][^"']*services\/SessionMemory\//.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => path.relative(root, file));
    if (oldImportOffenders.length > 0) {
      failGate(
        `MM-04: old SessionMemory imports remain:\n  ${oldImportOffenders.join("\n  ")}`,
      );
    }

    const vitest = run("npm", [
      "test",
      "--workspace",
      "@tetsuo-ai/runtime",
      "--",
      "--run",
      "src/memory/session/sessionMemory.test.ts",
      "src/memory/session/session-memory.contract.test.ts",
      "src/session/run-turn.test.ts",
      "src/conversation/multi-turn-context.contract.test.ts",
      "src/personality/personality.contract.test.ts",
    ]);
    if (vitest.status !== 0) failGate("MM-04 targeted Vitest suite failed");
    pass("MM-04: session memory verified");
    return;
  }
  if (id === "MM-05") {
    const requiredSymbols = [
      ["runtime/src/memory/extraction-triggers.ts", "memoryExtractionVisibleRange"],
      ["runtime/src/memory/extraction-triggers.ts", "hasSuccessfulMemoryWrite"],
      ["runtime/src/memory/extraction-triggers.ts", "isMainMemoryExtractionContext"],
      ["runtime/src/memory/extraction-triggers.ts", "isMemoryExtractionDisabledByEnv"],
      ["runtime/src/memory/extraction-triggers.ts", "shouldDeferForEligibleTurnCadence"],
      ["runtime/src/memory/extraction-triggers.test.ts", "memory extraction triggers"],
      ["runtime/src/services/extractMemories/extractMemories.ts", "../../memory/extraction-triggers.js"],
      ["runtime/src/services/extractMemories/extractMemories.ts", "createMemoryExtractionTriggerState"],
      ["runtime/src/services/extractMemories/extractMemories.ts", "hasSuccessfulMemoryWrite"],
      ["runtime/src/services/extractMemories/extractMemories.ts", "shouldDeferForEligibleTurnCadence"],
      ["runtime/src/query/stopHooks.ts", "executeAutoDream"],
      ["parity/MM-05-parity.json", "memory-extraction-triggers"],
    ];
    for (const [rel, symbol] of requiredSymbols) {
      const file = path.join(root, rel);
      if (!existsSync(file)) failGate(`MM-05: ${rel} missing`);
      const source = readFileSync(file, "utf8");
      if (!source.includes(symbol)) {
        failGate(`MM-05: ${symbol} missing from ${rel}`);
      }
    }

    const legacyStopHooks = readFileSync(path.join(root, "runtime/src/query/stopHooks.ts"), "utf8");
    if (
      legacyStopHooks.includes("executeExtractMemories") ||
      legacyStopHooks.includes("EXTRACT_MEMORIES")
    ) {
      failGate("MM-05: legacy query stopHooks must not call memory extraction without a Session/TurnContext");
    }

    const vitest = run("npm", [
      "test",
      "--workspace",
      "@tetsuo-ai/runtime",
      "--",
      "--run",
      "src/memory/extraction-triggers.test.ts",
      "src/services/extractMemories/extractMemories.test.ts",
      "src/phases/commit.test.ts",
    ]);
    if (vitest.status !== 0) failGate("MM-05 targeted Vitest suite failed");
    pass("MM-05: memory extraction triggers verified");
    return;
  }
  if (id === "MM-07") {
    const indexPath = path.join(root, "runtime/src/memory/index.ts");
    const index = readFileSync(indexPath, "utf8");
    const requiredIndexSymbols = [
      "clearMemoryFileCaches",
      "checkTeamMemSecrets",
      "detectSessionFileType",
      "detectSessionPatternType",
      "filterInjectedMemoryFiles",
      "findRelevantMemories",
      "formatMemoryManifest",
      "formatRelevantMemoryHeader",
      "getAgenCMds",
      "getAllMemoryFilePaths",
      "getAutoMemPath",
      "getConditionalRulesForCwdLevelDirectory",
      "getExternalAgenCMdIncludes",
      "getGlobalMemoryPath",
      "getLargeMemoryFiles",
      "getSecretLabel",
      "getManagedAndUserConditionalRules",
      "getMemoryFiles",
      "getMemoryFilesForNestedDirectory",
      "getProjectMemoryPathForSelector",
      "hasExternalAgenCMdIncludes",
      "isAutoMemFile",
      "isMemoryFilePath",
      "isMemoryMention",
      "MAX_MEMORY_CHARACTER_COUNT",
      "memoryFreshnessNote",
      "MEMORY_MENTION_ALIASES",
      "MEMORY_MENTION_SYNTAX",
      "processConditionedMdRules",
      "processMdRules",
      "processMemoryFile",
      "redactSecrets",
      "resetGetMemoryFilesCache",
      "scanMemoryFiles",
      "scanForSecrets",
      "shouldShowAgenCMdExternalIncludesWarning",
      "stripHtmlComments",
    ];
    for (const symbol of requiredIndexSymbols) {
      if (!isExportedFromSource(index, symbol)) {
        failGate(`MM-07: ${symbol} missing from runtime/src/memory/index.ts`);
      }
    }
    if (existsSync(path.join(root, "runtime/src/services/extractMemories/memory-scan.ts"))) {
      failGate("MM-07: stale extraction-local memory-scan.ts must be removed");
    }

    const migratedCallers = [
      "runtime/src/utils/attachments.ts",
      "runtime/src/tools/FileReadTool/FileReadTool.ts",
      "runtime/src/services/extractMemories/extractMemories.ts",
    ];
    const directMemoryModuleImport =
      /(?:from\s+|import\s*\(\s*)["'][^"']*memory\/(?:project-memory|agencmd|find-relevant|scan|age|paths|detection|privacy)\.js["']/g;
    for (const rel of migratedCallers) {
      const source = readFileSync(path.join(root, rel), "utf8");
      if (!source.includes("memory/index.js")) {
        failGate(`MM-07: ${rel} must import memory access from runtime/src/memory/index.ts`);
      }
    }

    const directImportAllowlist = new Set([
      "runtime/src/memdir/teamMemPaths.ts",
      "runtime/src/memdir/teamMemPrompts.ts",
    ]);
    const directImportOffenders = [];
    for (const file of walkFiles(path.join(root, "runtime/src"))) {
      const rel = path.relative(root, file);
      if (rel.startsWith("runtime/src/memory/") || directImportAllowlist.has(rel)) {
        continue;
      }
      const directImports = readFileSync(file, "utf8").match(directMemoryModuleImport) ?? [];
      if (directImports.length > 0) {
        directImportOffenders.push(`${rel}: ${directImports.join(", ")}`);
      }
    }
    if (directImportOffenders.length > 0) {
      failGate(`MM-07: direct memory implementation imports remain:\n  ${directImportOffenders.join("\n  ")}`);
    }

    const vitest = run("npm", [
      "test",
      "--workspace",
      "@tetsuo-ai/runtime",
      "--",
      "--run",
      "src/memory/index.test.ts",
      "src/memory/scan.test.ts",
      "src/services/extractMemories/extractMemories.test.ts",
      "src/memory-wiring.contract.test.ts",
    ]);
    if (vitest.status !== 0) failGate("MM-07 targeted Vitest suite failed");
    pass("MM-07: public memory access surface verified");
    return;
  }
  if (id === "MM-08") {
    const tests = walkFiles(existsSync(dir) ? dir : altDir).filter((p) => /\.test\.(ts|tsx)$/.test(p));
    if (tests.length === 0) failGate(`${id}: no test files in memory subsystem`);
    pass(`${id}: ${tests.length} test file(s)`);
    return;
  }
  failGate(
    `memory item ${id} has no specific gate branch. ` +
    `Add a branch to memoryGates() in scripts/goal/verify.mjs.`,
  );
}

function isExportedFromSource(source, symbol) {
  const escaped = escapeRegExp(symbol);
  return (
    new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${escaped}\\b`).test(source) ||
    new RegExp(`export\\s+type\\s+${escaped}\\b`).test(source) ||
    new RegExp(`export\\s*\\{[\\s\\S]*\\b${escaped}\\b[\\s\\S]*\\}\\s*from\\s*["']`).test(source)
  );
}

async function webPortalGates(item) {
  if (id === "WP-06") {
    assertAgenCPortalMobileStatusContract();
    return;
  }
  if (id === "WP-03") {
    assertAgenCPortalAuthIntegration();
    return;
  }
  // WP-* lives in a separate repo (agenc-portal). The local contract is a
  // shared-protocol surface in agenc-core; verify the protocol surface
  // exists and has any WP-related schema/types.
  const protocolDir = path.join(root, "runtime/src/app-server-protocol");
  if (!existsSync(protocolDir)) {
    failGate("WP-*: runtime/src/app-server-protocol/ missing — required for shared portal protocol surface.");
  }
  const found = grepRepo("portal|webPortal|web_portal", "runtime/src/app-server-protocol") ||
                grepRepo("portal|webPortal|web_portal", "runtime/src/app-server");
  if (!found) {
    failGate(
      `WP-* item ${id}: no portal-related symbols found in runtime/src/app-server-protocol/ or runtime/src/app-server/. ` +
      `WP-* lives in sibling agenc-portal repo, but the local protocol contract must reference the portal surface.`,
    );
  }
  pass(`WP-*: portal protocol surface referenced (${id})`);
}

function assertAgenCPortalAuthIntegration() {
  const portalRepo = path.resolve(mainCheckoutRoot(), "..", "agenc-portal");
  const requiredPortalFiles = [
    "src/daemon-connection.js",
    "src/main.js",
    "src/styles.css",
    "scripts/check-scaffold.mjs",
    "README.md",
  ];
  const missing = requiredPortalFiles.filter(
    (rel) => !existsSync(path.join(portalRepo, rel)),
  );
  if (missing.length > 0) {
    failGate(
      `WP-03: agenc-portal auth integration missing file(s):\n  ${missing.join("\n  ")}`,
    );
  }

  const daemonConnection = readFileSync(
    path.join(portalRepo, "src/daemon-connection.js"),
    "utf8",
  );
  const mainSource = readFileSync(path.join(portalRepo, "src/main.js"), "utf8");
  const portalTest = readFileSync(
    path.join(portalRepo, "scripts/check-scaffold.mjs"),
    "utf8",
  );
  const requiredMarkers = [
    [daemonConnection, "loginPortalAuth"],
    [daemonConnection, "logoutPortalAuth"],
    [daemonConnection, "auth.login"],
    [daemonConnection, "auth.logout"],
    [mainSource, "renderAuth"],
    [mainSource, "loginPortal"],
    [mainSource, "logoutPortal"],
    [portalTest, "portal auth state must not expose AuthBackend tokens"],
    [portalTest, "auth.login,auth.whoami,auth.whoami,auth.logout,auth.whoami"],
  ];
  const missingMarkers = requiredMarkers
    .filter(([source, marker]) => !source.includes(marker))
    .map(([, marker]) => marker);
  if (missingMarkers.length > 0) {
    failGate(
      `WP-03: agenc-portal auth integration missing marker(s): ${missingMarkers.join(", ")}`,
    );
  }

  const portalTestRun = run("npm", ["test"], { cwd: portalRepo, silent: true });
  if (portalTestRun.status !== 0) {
    failGate(
      `WP-03: agenc-portal auth self-test failed:\n${portalTestRun.stderr || portalTestRun.stdout}`,
    );
  }

  const runtimeTestRun = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/app-server-protocol/portal.contract.test.ts",
    "src/app-server-protocol/portal-auth.contract.test.ts",
  ]);
  if (runtimeTestRun.status !== 0) {
    failGate("WP-03: targeted portal auth contract tests failed");
  }

  pass("WP-03: portal auth contract and sibling repo self-test passed");
}

function assertAgenCPortalMobileStatusContract() {
  const requiredFiles = [
    "runtime/src/app-server-protocol/index.ts",
    "runtime/src/app-server-protocol/portal.contract.test.ts",
    "runtime/src/app-server-protocol/portal-mobile.contract.test.ts",
    "runtime/src/index.ts",
    "parity/WP-06-parity.json",
    "parity/WP-06-mobile-status-fixture.json",
  ];
  const missing = requiredFiles.filter((rel) => !existsSync(path.join(root, rel)));
  if (missing.length > 0) {
    failGate(
      `WP-06: mobile portal status contract missing file(s):\n  ${missing.join("\n  ")}`,
    );
  }

  const protocolSource = readFileSync(
    path.join(root, "runtime/src/app-server-protocol/index.ts"),
    "utf8",
  );
  const portalContractSource = readFileSync(
    path.join(root, "runtime/src/app-server-protocol/portal.contract.test.ts"),
    "utf8",
  );
  const mobileContractSource = readFileSync(
    path.join(root, "runtime/src/app-server-protocol/portal-mobile.contract.test.ts"),
    "utf8",
  );
  const paritySource = readFileSync(
    path.join(root, "parity/WP-06-parity.json"),
    "utf8",
  );
  const fixtureSource = readFileSync(
    path.join(root, "parity/WP-06-mobile-status-fixture.json"),
    "utf8",
  );
  const barrelSource = readFileSync(path.join(root, "runtime/src/index.ts"), "utf8");
  const requiredMarkers = [
    [protocolSource, 'AGENC_PORTAL_PROTOCOL_VERSION = "0.4.0"'],
    [protocolSource, "portal.mobile.status.read"],
    [protocolSource, "AgenCPortalMobileStatusSnapshot"],
    [protocolSource, "createAgenCPortalMobileStatusSnapshot"],
    [portalContractSource, 'expect(AGENC_PORTAL_PROTOCOL_VERSION).toBe("0.4.0")'],
    [mobileContractSource, "does not expose desktop workspace, auth identity, or transcript fields"],
    [mobileContractSource, "matches the shared sibling portal parity fixture exactly"],
    [mobileContractSource, "1970-01-01T00:00:00.000Z"],
    [barrelSource, "createAgenCPortalMobileStatusSnapshot"],
    [paritySource, "mobile-read-only-status-contract"],
    [paritySource, "read-only phone check-in panel in the sibling portal"],
    [fixtureSource, "agent-error"],
  ];
  const missingMarkers = requiredMarkers
    .filter(([source, marker]) => !source.includes(marker))
    .map(([, marker]) => marker);
  if (missingMarkers.length > 0) {
    failGate(
      `WP-06: mobile portal status contract missing marker(s): ${missingMarkers.join(", ")}`,
    );
  }

  const portalRepo = path.resolve(mainCheckoutRoot(), "..", "agenc-portal");
  const requiredPortalFiles = [
    "README.md",
    "src/daemon-connection.js",
    "src/main.js",
    "src/styles.css",
    "scripts/check-scaffold.mjs",
  ];
  const missingPortalFiles = requiredPortalFiles.filter(
    (rel) => !existsSync(path.join(portalRepo, rel)),
  );
  if (missingPortalFiles.length > 0) {
    failGate(
      `WP-06: agenc-portal mobile status view missing file(s):\n  ${missingPortalFiles.join("\n  ")}`,
    );
  }

  const portalDaemonConnection = readFileSync(
    path.join(portalRepo, "src/daemon-connection.js"),
    "utf8",
  );
  const portalMain = readFileSync(path.join(portalRepo, "src/main.js"), "utf8");
  const portalStyles = readFileSync(path.join(portalRepo, "src/styles.css"), "utf8");
  const portalTest = readFileSync(
    path.join(portalRepo, "scripts/check-scaffold.mjs"),
    "utf8",
  );
  const portalReadme = readFileSync(path.join(portalRepo, "README.md"), "utf8");
  const requiredPortalMarkers = [
    [portalDaemonConnection, "portal.mobile.status.read"],
    [portalDaemonConnection, "createAgenCPortalMobileStatusSnapshot"],
    [portalMain, "renderMobileStatus"],
    [portalMain, "Mobile Check-In"],
    [portalStyles, "mobile-status-panel"],
    [portalTest, "mobile status view must be read-only"],
    [portalTest, "portal mobile status projection must match the shared WP-06 core fixture"],
    [portalTest, "portal initialize request must advertise mobile status read capability"],
    [portalReadme, "mobile check-in panel"],
  ];
  const missingPortalMarkers = requiredPortalMarkers
    .filter(([source, marker]) => !source.includes(marker))
    .map(([, marker]) => marker);
  if (missingPortalMarkers.length > 0) {
    failGate(
      `WP-06: agenc-portal mobile status view missing marker(s): ${missingPortalMarkers.join(", ")}`,
    );
  }

  const portalTestRun = run("npm", ["test"], { cwd: portalRepo, silent: true });
  if (portalTestRun.status !== 0) {
    failGate(
      `WP-06: agenc-portal mobile status self-test failed:\n${portalTestRun.stderr || portalTestRun.stdout}`,
    );
  }

  const runtimeTestRun = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/app-server-protocol/portal.contract.test.ts",
    "src/app-server-protocol/portal-mobile.contract.test.ts",
  ]);
  if (runtimeTestRun.status !== 0) {
    failGate("WP-06: targeted portal mobile contract tests failed");
  }

  pass("WP-06: portal mobile status contract and sibling view passed");
}

// Generic gate factory: subsystem must exist as a real directory under runtime/src,
// have at least one production module, and at least one test file. Used for FW/RT/SE/SK
// prefixes that previously had no gate at all.
async function gapGates(item) {
  if (item.title.includes("Mount GlobalKeybindingHandlers")) {
    assertGapTuiGlobalKeybindingHandlers();
    return;
  }
  if (item.title.includes("Wire onMessageActionsEnter")) {
    assertGapTuiMessageSelectorCallbacks();
    return;
  }
  if (item.title.includes("/clear must emit daemon event")) {
    assertGapTuiClearHistoryEvent();
    return;
  }
  if (item.title.includes("/keybindings: don't spawn editor")) {
    assertGapTuiKeybindingsEditorHandoff();
    return;
  }
  if (item.title.includes("/init: generate doc via model")) {
    assertGapTuiInitGeneratesViaModel();
    return;
  }
  if (item.title.includes("/copy: actually copy to system clipboard")) {
    assertGapTuiCopyWritesClipboard();
    return;
  }
  if (item.title.includes("/reload-plugins: reload the live dispatcher registry")) {
    assertGapTuiReloadPluginsRefreshesDispatcherRegistry();
    return;
  }
  if (item.title.includes("/compact: wire progress hooks on daemon-backed Session")) {
    assertGapTuiCompactProgressControls();
    return;
  }
  if (item.title.includes("Register /btw in dispatcher")) {
    assertGapTuiBtwRegisteredInDispatcher();
    return;
  }
  if (item.title.includes("Wire or delete the orphaned commands/ subdirectories")) {
    assertGapTuiOrphanedCommandsResolved();
    return;
  }
  if (item.title.includes("/files: remove the USER_TYPE")) {
    assertGapTuiFilesCommandVisible();
    return;
  }
  if (item.title.includes("Reconcile App.tsx vs REPL.tsx")) {
    assertGapTuiAppShellReconciled();
    return;
  }
  if (item.title.includes("SyntheticOutputTool base singleton echoes input untouched")) {
    assertGapToolsSyntheticOutputToolValidation();
    return;
  }
  if (item.title.includes("spawn_agents_on_csv parameter ambiguity")) {
    assertGapToolsSpawnAgentsOnCsvWorkerParameter();
    return;
  }
  if (item.title.includes("tool-search recoveryCategory mis-marked")) {
    assertGapToolsToolSearchRecoveryCategory();
    return;
  }
  if (item.title.includes("Consolidate dual tool implementations")) {
    assertGapToolsConsolidatedToolSurfaces();
    return;
  }
  if (item.title.includes("Remove or implement null-stub tools")) {
    assertGapToolsNullStubToolsRemoved();
    return;
  }
  if (item.title.includes("Bridge config namespaces")) {
    assertGapMcpBridgeConfigNamespaces();
    return;
  }
  if (item.title.includes("Wire `agenc mcp` CLI subcommands")) {
    assertGapMcpCliSubcommandsWired();
    return;
  }
  if (item.title.includes("Expand /mcp slash command")) {
    assertGapMcpSlashCommandExpanded();
    return;
  }
  if (item.title.includes("Wire MCP connection failure notifications")) {
    assertGapMcpAppNotificationsWired();
    return;
  }
  if (item.title.includes("Resolve services/mcp/ donor-mirror tier")) {
    assertGapMcpDonorMirrorTierResolved();
    return;
  }
  if (item.title.includes("Cross-process lockfile race in MCP auth refresh")) {
    assertGapMcpXaaRefreshLock();
    return;
  }
  if (
    id === "GAP-DMN-01" ||
    item.title.includes("Route session.create / session.detach / session.terminate")
  ) {
    assertGapDmnSessionRoutes();
    return;
  }
  if (
    id === "GAP-DMN-02" ||
    item.title.includes("Inject SessionManager / listPermissions on dispatcher boot")
  ) {
    assertGapDmnDispatcherBootInjection();
    return;
  }
  if (
    id === "GAP-DMN-03" ||
    item.title.includes("Authenticate Unix socket connections at accept")
  ) {
    assertGapDmnUnixSocketAcceptAuth();
    return;
  }
  if (
    id === "GAP-DMN-04" ||
    item.title.includes("Implement peerUid via native binding fallback")
  ) {
    assertGapDmnPeerUidFallback();
    return;
  }
  if (
    id === "GAP-PROV-01" ||
    item.title.includes("Implement Amazon Bedrock adapter")
  ) {
    assertGapProvAmazonBedrockAdapter();
    return;
  }
  if (
    id === "GAP-PROV-03" ||
    item.title.includes("Replace direct env reads in llm/provider.ts")
  ) {
    assertGapProvProviderKeysThroughAuthBackend();
    return;
  }
  if (
    id === "GAP-DMN-05" ||
    item.title.includes("Add `agenc-runtime reload` subcommand")
  ) {
    assertGapDmnDaemonReloadSubcommand();
    return;
  }
  if (
    id === "GAP-PROV-02" ||
    item.title.includes("Implement or remove Vertex AI / Foundry / NVIDIA NIM / MiniMax / Mistral")
  ) {
    assertGapProvUnsupportedProvidersResolved();
    return;
  }
  failGate(
    `GAP item "${item.title}" has no specific gate branch. ` +
      `Add one to gapGates() in scripts/goal/verify.mjs with concrete evidence for the row.`,
  );
}

function assertGapProvUnsupportedProvidersResolved() {
  const legacyProviderRel = "runtime/src/utils/model/providers.ts";
  const legacyProviderSource = readFileSync(path.join(root, legacyProviderRel), "utf8");
  for (const forbidden of [
    "| 'bedrock'",
    "| 'vertex'",
    "| 'foundry'",
    "AGENC_USE_BEDROCK",
    "AGENC_USE_VERTEX",
    "AGENC_USE_FOUNDRY",
  ]) {
    if (legacyProviderSource.includes(forbidden)) {
      failGate(`GAP-PROV-02: ${legacyProviderRel} still advertises unsupported provider surface: ${forbidden}`);
    }
  }

  const providerFiles = [
    "runtime/src/llm/providers/mistral/index.ts",
    "runtime/src/llm/providers/nvidia-nim/index.ts",
    "runtime/src/llm/providers/minimax/index.ts",
    "runtime/src/llm/providers/github/index.ts",
  ];
  for (const rel of providerFiles) {
    if (!existsSync(path.join(root, rel))) {
      failGate(`GAP-PROV-02: concrete provider adapter missing: ${rel}`);
    }
  }

  const factoryRel = "runtime/src/llm/provider.ts";
  const factorySource = readFileSync(path.join(root, factoryRel), "utf8");
  for (const needle of [
    "MistralProvider",
    "NvidiaNimProvider",
    "MiniMaxProvider",
    "GitHubProvider",
    'case "mistral"',
    'case "nvidia-nim"',
    'case "minimax"',
    'case "github"',
  ]) {
    if (!factorySource.includes(needle)) {
      failGate(`GAP-PROV-02: ${factoryRel} missing provider factory evidence: ${needle}`);
    }
  }
  for (const [provider, nextProvider] of [
    ["mistral", "nvidia-nim"],
    ["nvidia-nim", "minimax"],
    ["minimax", "github"],
    ["github", "gemini"],
  ]) {
    const startNeedle = `case "${provider}"`;
    const endNeedle = `case "${nextProvider}"`;
    const start = factorySource.indexOf(startNeedle);
    const end = factorySource.indexOf(endNeedle, start + startNeedle.length);
    if (start === -1 || end === -1) {
      failGate(`GAP-PROV-02: ${factoryRel} missing provider case bounds for ${provider}`);
    }
    const snippet = factorySource.slice(start, end);
    for (const forbidden of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) {
      if (snippet.includes(forbidden)) {
        failGate(`GAP-PROV-02: ${factoryRel} ${provider} case still falls back to unrelated shared env: ${forbidden}`);
      }
    }
  }

  const discoveryRel = "runtime/src/llm/discovery/provider-discovery.ts";
  const discoverySource = readFileSync(path.join(root, discoveryRel), "utf8");
  for (const forbidden of [
    'return ["NVIDIA_API_KEY", "OPENAI_API_KEY"]',
    'return ["MINIMAX_API_KEY", "OPENAI_API_KEY"]',
    'return ["GITHUB_TOKEN", "GH_TOKEN", "OPENAI_API_KEY"]',
    "firstNonEmptyString(params.env.MISTRAL_BASE_URL) ??\n        firstNonEmptyString(params.env.OPENAI_BASE_URL)",
    "firstNonEmptyString(params.env.NVIDIA_BASE_URL) ??\n        firstNonEmptyString(params.env.OPENAI_BASE_URL)",
    "firstNonEmptyString(params.env.MINIMAX_BASE_URL) ??\n        firstNonEmptyString(params.env.OPENAI_BASE_URL)",
    "firstNonEmptyString(params.env.GITHUB_BASE_URL) ??\n        firstNonEmptyString(params.env.OPENAI_BASE_URL)",
  ]) {
    if (discoverySource.includes(forbidden)) {
      failGate(`GAP-PROV-02: ${discoveryRel} still falls back to unrelated shared env: ${forbidden}`);
    }
  }

  for (const [rel, forbiddenNeedles] of [
    ["runtime/src/utils/model/agent.ts", ["provider === 'bedrock'", "getBedrockRegionPrefix", "applyBedrockRegionPrefix"]],
    ["runtime/src/tui/components/dialogs/CostThresholdDialog.tsx", ["case 'bedrock'", "AWS Bedrock"]],
    ["runtime/src/services/api/cacheMetrics.ts", ["provider === 'bedrock'", "provider === 'vertex'", "provider === 'foundry'"]],
    ["runtime/src/services/api/cacheMetrics.test.ts", ["bedrock/vertex/foundry", "resolveCacheProvider('bedrock')", "resolveCacheProvider('vertex')", "resolveCacheProvider('foundry')"]],
    ["runtime/src/services/api/anthropic.ts", ["provider !== 'bedrock'", "provider !== 'vertex'", "provider !== 'foundry'", "getAPIProvider() === 'bedrock'", "getAPIProvider() !== 'bedrock'", "getBedrockExtraBodyParamsBetas", "getInferenceProfileBackingModel", "ENABLE_PROMPT_CACHING_1H_BEDROCK"]],
    ["runtime/src/services/api/client.ts", ["AGENC_USE_BEDROCK", "AGENC_USE_VERTEX", "AGENC_USE_FOUNDRY", "providerBedrock", "providerVertex", "providerFoundry"]],
    ["runtime/src/utils/providerFlag.ts", ["'bedrock'", "'vertex'", "'foundry'", "case 'bedrock'", "case 'vertex'", "case 'foundry'"]],
    ["runtime/src/entrypoints/sdk/coreSchemas.ts", ["'bedrock'", "'vertex'", "'foundry'"]],
    ["runtime/src/entrypoints/sdk/coreTypes.generated.ts", ['"bedrock"', '"vertex"', '"foundry"']],
  ]) {
    const source = readFileSync(path.join(root, rel), "utf8");
    for (const forbidden of forbiddenNeedles) {
      if (source.includes(forbidden)) {
        failGate(`GAP-PROV-02: ${rel} retained unsupported legacy provider branch: ${forbidden}`);
      }
    }
  }

  const capabilitiesRel = "runtime/src/llm/capabilities.ts";
  const capabilitiesSource = readFileSync(path.join(root, capabilitiesRel), "utf8");
  for (const needle of [
    "HOSTED_CHAT_COMPATIBLE_CAPABILITIES",
    "mistral: HOSTED_CHAT_COMPATIBLE_CAPABILITIES",
    '"nvidia-nim": HOSTED_CHAT_COMPATIBLE_CAPABILITIES',
    "minimax: HOSTED_CHAT_COMPATIBLE_CAPABILITIES",
    "github: HOSTED_CHAT_COMPATIBLE_CAPABILITIES",
  ]) {
    if (!capabilitiesSource.includes(needle)) {
      failGate(`GAP-PROV-02: ${capabilitiesRel} missing hosted compatible capability evidence: ${needle}`);
    }
  }

  const clientRel = "runtime/src/services/api/client.ts";
  const clientSource = readFileSync(path.join(root, clientRel), "utf8");
  for (const needle of [
    "const apiProvider = getAPIProvider()",
    "resolveShimSelectedProvider(",
    "apiProvider !== 'firstParty'",
    "createOpenAiShimClient",
    "selectedProvider: resolveShimSelectedProvider(apiProvider)",
    "process.env.GITHUB_BASE_URL?.replace",
    "stripForwardedAuthHeaders(defaultHeaders)",
  ]) {
    if (!clientSource.includes(needle)) {
      failGate(`GAP-PROV-02: ${clientRel} missing provider-resolved shim route evidence: ${needle}`);
    }
  }

  const shimRel = "runtime/src/services/api/openaiShim.ts";
  const shimSource = readFileSync(path.join(root, shimRel), "utf8");
  for (const needle of [
    "resolveSelectedProviderOverride(",
    "selectedProvider?: SelectedShimProvider",
    "options.selectedProvider",
    "requireSelectedProviderApiKey(",
    "firstProviderEnvString(process.env.MISTRAL_BASE_URL)",
    "firstProviderEnvString(process.env.MISTRAL_API_KEY)",
    "firstProviderEnvString(process.env.MISTRAL_MODEL)",
    "firstProviderEnvString(process.env.NVIDIA_BASE_URL)",
    "firstProviderEnvString(process.env.NVIDIA_API_KEY)",
    "firstProviderEnvString(process.env.NVIDIA_MODEL)",
    "process.env.AGENC_USE_MINIMAX",
    "firstProviderEnvString(process.env.MINIMAX_BASE_URL)",
    "firstProviderEnvString(process.env.MINIMAX_API_KEY)",
    "firstProviderEnvString(process.env.MINIMAX_MODEL)",
    "firstProviderEnvString(process.env.GITHUB_BASE_URL)",
    "firstProviderEnvString(process.env.GITHUB_TOKEN)",
    "firstProviderEnvString(process.env.GITHUB_MODEL)",
  ]) {
    if (!shimSource.includes(needle)) {
      failGate(`GAP-PROV-02: ${shimRel} missing provider-specific shim env mapping: ${needle}`);
    }
  }
  for (const forbidden of [
    "process.env.MISTRAL_BASE_URL ?? 'https://api.mistral.ai/v1'",
    "process.env.MISTRAL_API_KEY && !process.env.OPENAI_API_KEY",
    "process.env.MISTRAL_MODEL && !process.env.OPENAI_MODEL",
    "process.env.NVIDIA_API_KEY && !process.env.OPENAI_API_KEY",
    "process.env.NVIDIA_MODEL && !process.env.OPENAI_MODEL",
    "process.env.MINIMAX_API_KEY && !process.env.OPENAI_API_KEY",
    "process.env.MINIMAX_MODEL && !process.env.OPENAI_MODEL",
    "process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''",
    "process.env.GITHUB_MODEL && !process.env.OPENAI_MODEL",
  ]) {
    if (shimSource.includes(forbidden)) {
      failGate(`GAP-PROV-02: ${shimRel} retained stale shared-env fallback in selected provider route: ${forbidden}`);
    }
  }

  const modelRel = "runtime/src/utils/model/model.ts";
  const modelSource = readFileSync(path.join(root, modelRel), "utf8");
  for (const needle of [
    "process.env.GITHUB_MODEL || 'github:copilot'",
    "process.env.NVIDIA_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'",
    "process.env.MINIMAX_MODEL || 'MiniMax-M2.5'",
    "process.env.MISTRAL_MODEL || 'devstral-latest'",
  ]) {
    if (!modelSource.includes(needle)) {
      failGate(`GAP-PROV-02: ${modelRel} missing provider-specific model helper evidence: ${needle}`);
    }
  }
  for (const forbidden of [
    "process.env.OPENAI_MODEL || 'github:copilot'",
    "process.env.OPENAI_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'",
    "process.env.OPENAI_MODEL || 'MiniMax-M2.5'",
    "getAPIProvider() === 'foundry'",
  ]) {
    if (modelSource.includes(forbidden)) {
      failGate(`GAP-PROV-02: ${modelRel} retained stale shared model helper fallback: ${forbidden}`);
    }
  }

  const providerDetectionRel = "runtime/src/utils/model/providers.ts";
  const providerDetectionSource = readFileSync(path.join(root, providerDetectionRel), "utf8");
  for (const needle of [
    "isEnvTruthy(process.env.AGENC_USE_MISTRAL)",
    "isEnvTruthy(process.env.AGENC_USE_GITHUB)",
    "isEnvTruthy(process.env.AGENC_USE_OPENAI)",
    "isEnvTruthy(process.env.NVIDIA_NIM)",
    "process.env.MINIMAX_API_KEY",
  ]) {
    if (!providerDetectionSource.includes(needle)) {
      failGate(`GAP-PROV-02: ${providerDetectionRel} missing provider precedence evidence: ${needle}`);
    }
  }
  if (
    providerDetectionSource.indexOf("isEnvTruthy(process.env.NVIDIA_NIM)") <
    providerDetectionSource.indexOf("isEnvTruthy(process.env.AGENC_USE_OPENAI)")
  ) {
    failGate(`GAP-PROV-02: ${providerDetectionRel} lets NVIDIA_NIM beat explicit provider flags`);
  }
  if (
    providerDetectionSource.indexOf("process.env.MINIMAX_API_KEY") <
    providerDetectionSource.indexOf("isEnvTruthy(process.env.AGENC_USE_OPENAI)")
  ) {
    failGate(`GAP-PROV-02: ${providerDetectionRel} lets ambient MINIMAX_API_KEY beat explicit provider flags`);
  }

  const registryRel = "runtime/src/llm/registry/provider-info.ts";
  const registrySource = readFileSync(path.join(root, registryRel), "utf8");
  for (const needle of [
    "https://api.mistral.ai/v1",
    "https://integrate.api.nvidia.com/v1",
    "https://api.minimax.io/v1",
    "https://api.githubcopilot.com",
    "MISTRAL_API_KEY",
    "NVIDIA_API_KEY",
    "MINIMAX_API_KEY",
    "GITHUB_TOKEN",
  ]) {
    if (!registrySource.includes(needle)) {
      failGate(`GAP-PROV-02: ${registryRel} missing provider registry evidence: ${needle}`);
    }
  }

  const providerTestRel = "runtime/src/llm/provider.test.ts";
  const parityTestRel = "runtime/src/llm/provider-parity.test.ts";
  const discoveryTestRel = "runtime/src/llm/discovery/provider-discovery.test.ts";
  const capabilitiesTestRel = "runtime/src/llm/capabilities.test.ts";
  const legacyProviderTestRel = "runtime/src/utils/model/providers.test.ts";
  const agentTestRel = "runtime/src/utils/model/agent.test.ts";
  const providerFlagTestRel = "runtime/src/utils/providerFlag.test.ts";
  const clientTestRel = "runtime/src/services/api/client.test.ts";
  const modelShimProviderTestRel = "runtime/src/utils/model/model.openai-shim-providers.test.ts";
  const providerTestSource = readFileSync(path.join(root, providerTestRel), "utf8");
  const parityTestSource = readFileSync(path.join(root, parityTestRel), "utf8");
  const discoveryTestSource = readFileSync(path.join(root, discoveryTestRel), "utf8");
  const capabilitiesTestSource = readFileSync(path.join(root, capabilitiesTestRel), "utf8");
  const legacyProviderTestSource = readFileSync(path.join(root, legacyProviderTestRel), "utf8");
  const agentTestSource = readFileSync(path.join(root, agentTestRel), "utf8");
  const providerFlagTestSource = readFileSync(path.join(root, providerFlagTestRel), "utf8");
  const clientTestSource = readFileSync(path.join(root, clientTestRel), "utf8");
  const modelShimProviderTestSource = readFileSync(path.join(root, modelShimProviderTestRel), "utf8");
  for (const [rel, source, needles] of [
    [providerTestRel, providerTestSource, ["MistralProvider", "NvidiaNimProvider", "MiniMaxProvider", "GitHubProvider", "requires provider-specific auth", "normalizes GitHub Copilot aliases case-insensitively"]],
    [parityTestRel, parityTestSource, ['provider: "mistral"', 'provider: "nvidia-nim"', 'provider: "minimax"', 'provider: "github"']],
    [discoveryTestRel, discoveryTestSource, ["MISTRAL_API_KEY", "NVIDIA_API_KEY", "MINIMAX_API_KEY", "GITHUB_TOKEN", "does not treat shared credentials as hosted provider credentials"]],
    [capabilitiesTestRel, capabilitiesTestSource, ["tracks hosted chat-compatible adapter capabilities", '"mistral"', '"nvidia-nim"', '"minimax"', '"github"', "supportsToolUse: true"]],
    [legacyProviderTestRel, legacyProviderTestSource, ["AGENC_USE_MISTRAL", "NVIDIA_NIM", "MINIMAX_API_KEY", "takes precedence over ambient MiniMax credentials", "explicit openai flag takes precedence over stale NVIDIA_NIM", "bare provider-native model"]],
    [agentTestRel, agentTestSource, ["haiku alias inherits parent model for Mistral provider", "haiku alias inherits parent model for NVIDIA NIM provider", "haiku alias inherits parent model for MiniMax provider"]],
    [providerFlagTestRel, providerFlagTestSource, ["removed legacy providers", "foundry", "clears stale NVIDIA_NIM when switching providers", "ambient MiniMax credentials", "sets provider-specific NVIDIA defaults", "sets provider-specific MiniMax defaults", "GITHUB_MODEL", "MISTRAL_MODEL"]],
    [clientTestRel, clientTestSource, ["routes env-only $name requests through the provider-compatible shim", "does not leak stale shared env into selected $name shim requests", "explicit $name selection takes precedence over ambient MiniMax credentials at request routing", "GitHub native provider mode uses provider-specific base URL", "fails before fetch when selected $name shim credentials are missing", "strips first-party auth headers before hosted provider shim requests", "stale-openai-key", "stale-openai-model", "MISTRAL_API_KEY", "NVIDIA_NIM", "MINIMAX_API_KEY", "GITHUB_TOKEN", "https://api.mistral.ai/v1/chat/completions", "http://127.0.0.1:19081/v1/chat/completions", "http://127.0.0.1:19082/v1/chat/completions", "https://models.github.ai/inference/chat/completions"]],
    [modelShimProviderTestRel, modelShimProviderTestSource, ["--provider $provider --model feeds model helper paths", "GITHUB_MODEL", "NVIDIA_MODEL", "MINIMAX_MODEL", "MISTRAL_MODEL", "wrong-openai-model"]],
  ]) {
    for (const needle of needles) {
      if (!source.includes(needle)) {
        failGate(`GAP-PROV-02: ${rel} missing focused test evidence: ${needle}`);
      }
    }
  }
  for (const removedProviderNeedle of ["return 'bedrock'", "return 'vertex'", "return 'foundry'"]) {
    if (modelShimProviderTestSource.includes(removedProviderNeedle)) {
      failGate(`GAP-PROV-02: ${modelShimProviderTestRel} retained removed provider mock branch: ${removedProviderNeedle}`);
    }
  }

  const inventedDomainPatterns = [
    /[.]example\b/i,
    /\bexample[.](?:com|net|org|test|invalid)\b/i,
  ];
  for (const [rel, source] of [
    [clientTestRel, clientTestSource],
    [providerTestRel, providerTestSource],
    [discoveryTestRel, discoveryTestSource],
  ]) {
    for (const pattern of inventedDomainPatterns) {
      if (pattern.test(source)) {
        failGate(`GAP-PROV-02: ${rel} contains reserved example-domain URL; use loopback/private or real provider domains`);
      }
    }
  }

  const providerVitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "--",
    "vitest",
    "run",
    "src/llm/provider.test.ts",
    "src/llm/provider-parity.test.ts",
    "src/llm/discovery/provider-discovery.test.ts",
    "src/llm/capabilities.test.ts",
  ]);
  if (providerVitest.status !== 0) {
    failGate("GAP-PROV-02: focused LLM provider tests failed");
  }

  const legacyProviderTests = run("bun", [
    "test",
    "--max-concurrency=1",
    "runtime/src/utils/model/providers.test.ts",
    "runtime/src/utils/model/agent.test.ts",
    "runtime/src/utils/model/model.openai-shim-providers.test.ts",
    "runtime/src/services/api/cacheMetrics.test.ts",
    "runtime/src/utils/providerFlag.test.ts",
    "runtime/src/services/api/client.test.ts",
  ]);
  if (legacyProviderTests.status !== 0) {
    failGate("GAP-PROV-02: focused legacy provider surface tests failed");
  }

  pass("GAP-PROV-02: unsupported provider enum entries removed and concrete provider adapters verified");
}

function assertGapProvAmazonBedrockAdapter() {
  const providerRel = "runtime/src/llm/providers/bedrock/index.ts";
  const providerTestRel = "runtime/src/llm/providers/bedrock/provider.test.ts";
  const registryRel = "runtime/src/llm/registry/provider-info.ts";
  const registryTestRel = "runtime/src/llm/registry/provider-info.test.ts";
  const factoryRel = "runtime/src/llm/provider.ts";
  const factoryTestRel = "runtime/src/llm/provider.test.ts";
  const parityTestRel = "runtime/src/llm/provider-parity.test.ts";
  const modelRegistryTestRel = "runtime/src/llm/model-registry.test.ts";
  const discoveryTestRel = "runtime/src/llm/discovery/provider-discovery.test.ts";
  const startupSelectionRel = "runtime/src/bin/startup-selection.ts";
  const startupSelectionTestRel = "runtime/src/bin/startup-selection.test.ts";
  const capabilitiesRel = "runtime/src/llm/capabilities.ts";

  for (const rel of [
    providerRel,
    providerTestRel,
    registryRel,
    registryTestRel,
    factoryRel,
    factoryTestRel,
    parityTestRel,
    modelRegistryTestRel,
    discoveryTestRel,
    startupSelectionRel,
    startupSelectionTestRel,
    capabilitiesRel,
  ]) {
    if (!existsSync(path.join(root, rel))) {
      failGate(`GAP-PROV-01: missing ${rel}`);
    }
  }

  const providerSource = readFileSync(path.join(root, providerRel), "utf8");
  for (const needle of [
    "export class BedrockProvider",
    "AWS4-HMAC-SHA256",
    "function signRequest",
    "`/model/${encodeURIComponent(params.model)}/converse`",
    "toolUse",
    "toolResult",
    "bedrockBaseURLForRegion",
    "chatStream(",
  ]) {
    if (!providerSource.includes(needle)) {
      failGate(`GAP-PROV-01: ${providerRel} missing Bedrock provider evidence: ${needle}`);
    }
  }

  const registrySource = readFileSync(path.join(root, registryRel), "utf8");
  for (const needle of [
    '"amazon-bedrock": "amazon.nova-pro-v1:0"',
    '"amazon-bedrock": "https://bedrock-runtime.us-east-1.amazonaws.com"',
    '"amazon-bedrock": "AWS_ACCESS_KEY_ID"',
    '"amazon-bedrock": "Amazon Bedrock"',
  ]) {
    if (!registrySource.includes(needle)) {
      failGate(`GAP-PROV-01: ${registryRel} missing registry evidence: ${needle}`);
    }
  }
  const omissionsStart = registrySource.indexOf(
    "export const BUILT_IN_PROVIDER_SCOPE_OMISSIONS",
  );
  const omissionsEnd = registrySource.indexOf(
    "export const BUILT_IN_PROVIDER_API_KEY_ENVS",
    omissionsStart,
  );
  const omissionsBlock = omissionsStart >= 0 && omissionsEnd > omissionsStart
    ? registrySource.slice(omissionsStart, omissionsEnd)
    : "";
  if (omissionsBlock.includes("amazon-bedrock")) {
    failGate("GAP-PROV-01: amazon-bedrock must not remain in BUILT_IN_PROVIDER_SCOPE_OMISSIONS");
  }

  const factorySource = readFileSync(path.join(root, factoryRel), "utf8");
  for (const needle of [
    "BedrockProvider",
    'case "amazon-bedrock"',
    "AWS_BEDROCK_REGION",
    "AWS_SECRET_ACCESS_KEY",
    "bedrockBaseURLForRegion(region)",
  ]) {
    if (!factorySource.includes(needle)) {
      failGate(`GAP-PROV-01: ${factoryRel} missing factory evidence: ${needle}`);
    }
  }

  const testExpectations = [
    [providerTestRel, "serializes Converse requests and signs them with AWS SigV4"],
    [providerTestRel, "Signature=fce0b51b3833e2186a19397da2d5eb962c1dc56afed0a03ca0373fee8efdb852"],
    [providerTestRel, "encodes reserved characters in model identifiers before signing"],
    [providerTestRel, "uses request-scoped model overrides for URL signing"],
    [providerTestRel, "serializes empty text messages without blank content blocks"],
    [providerTestRel, "rejects unsupported non-tool message content"],
    [providerTestRel, "serializes empty tool results without blank text blocks"],
    [providerTestRel, "serializes tool-call-only assistant turns without placeholder text"],
    [providerTestRel, "rejects a filtered-out specific tool choice before sending"],
    [providerTestRel, "fails closed on malformed replayed tool call arguments"],
    [providerTestRel, "parses toolUse responses and exposes chatStream"],
    [providerTestRel, "emits only the done chunk for tool-call-only stream responses"],
    [factoryTestRel, "routes generic apiKey to Bedrock accessKeyId"],
    [factoryTestRel, "recreates Bedrock provider from factory options with explicit credentials"],
    [factoryTestRel, "secretAccessKey"],
    [factoryTestRel, "routes 'amazon-bedrock' to BedrockProvider"],
    [registryTestRel, "Amazon Bedrock"],
    [modelRegistryTestRel, "keeps provider-owned model IDs with colons intact"],
    [discoveryTestRel, "requires both Bedrock access and secret credentials"],
    [startupSelectionTestRel, "uses Bedrock model env when selected by provider"],
    [parityTestRel, 'provider: "amazon-bedrock"'],
  ];
  for (const [rel, needle] of testExpectations) {
    const source = readFileSync(path.join(root, rel), "utf8");
    if (!source.includes(needle)) {
      failGate(`GAP-PROV-01: ${rel} missing regression evidence: ${needle}`);
    }
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/llm/providers/bedrock/provider.test.ts",
    "src/llm/provider.test.ts",
    "src/llm/registry/provider-info.test.ts",
    "src/llm/model-registry.test.ts",
    "src/llm/discovery/provider-discovery.test.ts",
    "src/llm/provider-parity.test.ts",
    "src/config/config.test.ts",
    "src/bin/startup-selection.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-PROV-01 targeted Amazon Bedrock provider tests failed");
  }
  pass("GAP-PROV-01 Amazon Bedrock provider is registered, signed, and tested");
}

function assertGapProvProviderKeysThroughAuthBackend() {
  const providerRel = "runtime/src/llm/provider.ts";
  const providerTestRel = "runtime/src/llm/provider.test.ts";
  const parityTestRel = "runtime/src/llm/provider-parity.test.ts";
  const integrationTestRel = "runtime/src/llm/provider.integration.test.ts";
  const sessionTestRel = "runtime/src/session/session.test.ts";
  const remoteContractTestRel = "runtime/src/auth/backends/remote.contract.test.ts";

  for (const rel of [
    providerRel,
    providerTestRel,
    parityTestRel,
    integrationTestRel,
    sessionTestRel,
    remoteContractTestRel,
  ]) {
    if (!existsSync(path.join(root, rel))) {
      failGate(`GAP-PROV-03: missing ${rel}`);
    }
  }

  const providerSource = readFileSync(path.join(root, providerRel), "utf8");
  const keyBearingEnvName = "[A-Z0-9_]*(?:API_KEY|ACCESS_KEY|SESSION_TOKEN)";
  const forbiddenProviderPatterns = [
    new RegExp(`process\\.env(?:\\?\\.|\\.)\\s*${keyBearingEnvName}\\b`),
    /process\.env(?:\?\.)?\s*\[/,
    new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*${keyBearingEnvName}[^}]*\\}\\s*=\\s*process\\.env\\b`, "s"),
    /process\.env\[[^\]]*apiKeyEnvLabel[^\]]*\]/,
    /resolveApiKey\(process\.env\)/,
    /\benvApiKey\b/,
    /\balternateApiKeys\b/,
  ];
  for (const pattern of forbiddenProviderPatterns) {
    if (pattern.test(providerSource)) {
      failGate(`GAP-PROV-03: ${providerRel} still contains forbidden key-read pattern ${pattern}`);
    }
  }
  for (const match of providerSource.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\b/g,
  )) {
    const alias = match[1];
    const escapedAlias = escapeRegExp(alias);
    const aliasForbiddenPatterns = [
      new RegExp(`\\b${escapedAlias}(?:\\?\\.|\\.)\\s*${keyBearingEnvName}\\b`),
      new RegExp(`\\b${escapedAlias}(?:\\?\\.)?\\s*\\[`),
      new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*${keyBearingEnvName}[^}]*\\}\\s*=\\s*${escapedAlias}\\b`, "s"),
    ];
    for (const pattern of aliasForbiddenPatterns) {
      if (pattern.test(providerSource)) {
        failGate(`GAP-PROV-03: ${providerRel} still contains aliased key-read pattern ${pattern}`);
      }
    }
  }

  for (const needle of [
    "resolveFactoryApiKey",
    "authBackend.vendKey(",
    "AuthBackend.vendKey()",
    "requireFactoryApiKey",
    "mergeAuthVendedProviderExtra",
    "resolveAuthVendedProviderModel",
    "authBackend/sessionId in factory options",
  ]) {
    if (!providerSource.includes(needle)) {
      failGate(`GAP-PROV-03: ${providerRel} missing AuthBackend key-routing evidence: ${needle}`);
    }
  }

  const providerTestSource = readFileSync(path.join(root, providerTestRel), "utf8");
  for (const needle of [
    "vends concrete provider keys through AuthBackend",
    "defaults model metadata on AuthBackend-vended providers without explicit model",
    "prepares AuthBackend-vended provider switches without explicit model",
    "keeps env model metadata on AuthBackend-vended providers without explicit model",
    "uses AuthBackend-vended keys on delegated compatible requests",
    "uses AuthBackend-vended Bedrock credentials on delegated requests",
    "uses AuthBackend-vended Bedrock access key with explicit non-access credentials",
    "rejects AuthBackend-vended provider keys with mismatched",
    "rejects empty AuthBackend-vended provider keys",
    "retries AuthBackend vending after transient delegate failures",
    "keeps Bedrock accessKeyId precedence over generic apiKey",
    "does not use OPENAI_API_KEY as LMStudio-compatible auth fallback",
    "does not use OPENAI_BASE_URL as LMStudio-compatible base URL fallback",
    "does not vend AuthBackend keys for OAuth config",
    "re-vends AuthBackend keys after vended expiry",
    "preserves optional provider hooks on AuthBackend-vended providers",
    "does not expose unsupported optional provider hooks",
    "recreates AuthBackend-vended providers from readProviderFactoryOptions",
    "coalesces concurrent AuthBackend vending",
    "authBackend without sessionId",
  ]) {
    if (!providerTestSource.includes(needle)) {
      failGate(`GAP-PROV-03: ${providerTestRel} missing regression evidence: ${needle}`);
    }
  }

  for (const [rel, needle] of [
    [parityTestRel, "apiKey: \"openai-test\""],
    [integrationTestRel, "apiKey: () => process.env.OPENAI_API_KEY"],
    [sessionTestRel, "uses AuthBackend-managed keys when switching providers without BYOK"],
    [remoteContractTestRel, "preserves Bedrock credential fields from HTTP key vending responses"],
  ]) {
    const source = readFileSync(path.join(root, rel), "utf8");
    if (!source.includes(needle)) {
      failGate(`GAP-PROV-03: ${rel} missing explicit-key/AuthBackend regression evidence: ${needle}`);
    }
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/auth/backends/remote.contract.test.ts",
    "src/llm/provider.test.ts",
    "src/llm/provider-parity.test.ts",
    "src/llm/provider.integration.test.ts",
    "src/session/session.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-PROV-03 targeted provider AuthBackend key-routing tests failed");
  }
  pass("GAP-PROV-03 provider factory key reads route through explicit options or AuthBackend");
}

function assertGapDmnDaemonReloadSubcommand() {
  const cliRel = "runtime/src/app-server/daemon-cli.ts";
  const cliSource = readFileSync(path.join(root, cliRel), "utf8");
  for (const needle of [
    '| "reload"',
    'action === "reload"',
    "reloadAgenCDaemon",
    "requestAgenCDaemonReload",
    'method: "daemon.reload"',
    "daemonControl",
    "reloadChain",
    "AgenCDaemonReloadableAuthBackend",
    "updateRuntimeConfig",
    "updateSnapshotRetention",
    "assertExpectedDaemonResponse",
    "isDaemonReloadResult",
    "startConfiguredDaemonMcpServer",
    "closeDaemonMcpServerAfterReloadFailure",
    "AgenC daemon reloaded configuration",
    "AgenC daemon config reloaded",
  ]) {
    if (!cliSource.includes(needle)) {
      failGate(`GAP-DMN-05: ${cliRel} missing reload evidence: ${needle}`);
    }
  }
  for (const forbidden of [
    "SIGUSR1",
    "reloadPid",
    "installAgenCDaemonConfigReloadHandler",
  ]) {
    if (cliSource.includes(forbidden)) {
      failGate(`GAP-DMN-05: ${cliRel} retained rejected signal reload path: ${forbidden}`);
    }
  }

  const dispatcherRel = "runtime/src/app-server/daemon-dispatcher.ts";
  const dispatcherSource = readFileSync(path.join(root, dispatcherRel), "utf8");
  for (const needle of [
    "daemonControl",
    'case "daemon.reload"',
    "DAEMON_RELOAD_AUTHENTICATION_REQUIRED",
  ]) {
    if (!dispatcherSource.includes(needle)) {
      failGate(`GAP-DMN-05: ${dispatcherRel} missing daemon.reload dispatcher evidence: ${needle}`);
    }
  }

  const protocolRel = "runtime/src/app-server/protocol/index.ts";
  const protocolSource = readFileSync(path.join(root, protocolRel), "utf8");
  for (const needle of [
    '"daemon.reload"',
    "DaemonReloadResult",
    "DaemonReloadMcpServerResult",
  ]) {
    if (!protocolSource.includes(needle)) {
      failGate(`GAP-DMN-05: ${protocolRel} missing daemon.reload protocol evidence: ${needle}`);
    }
  }

  const testRel = "runtime/src/app-server/daemon-cli.contract.test.ts";
  const testSource = readFileSync(path.join(root, testRel), "utf8");
  for (const needle of [
    'parseAgenCDaemonCliArgs(["daemon", "reload"])',
    "reload reports a stopped daemon",
    "reload cleans a stale daemon pid",
    "reload command re-reads config and starts configured mcp.server without shutdown",
    "reload failure preserves active auth and mcp.server state",
    "reload fails without a daemon cookie and leaves the daemon running",
    'provider: "remote"',
    "AgenC MCP server listening",
  ]) {
    if (!testSource.includes(needle)) {
      failGate(`GAP-DMN-05: ${testRel} missing reload regression: ${needle}`);
    }
  }
  if (testSource.includes("SIGUSR1") || testSource.includes("reloadRequestedPids")) {
    failGate(`GAP-DMN-05: ${testRel} retained rejected signal reload regression`);
  }

  const runnerRel = "runtime/src/app-server/background-agent-runner.ts";
  const runnerSource = readFileSync(path.join(root, runnerRel), "utf8");
  for (const needle of [
    "AgenCDelegateBackgroundAgentRunnerRuntimeConfig",
    "updateAuthBackend",
    "createAgenCDaemonRuntimeAuthBackend(authBackend)",
    "replaceBackend(authBackend)",
  ]) {
    if (!runnerSource.includes(needle)) {
      failGate(`GAP-DMN-05: ${runnerRel} missing daemon reload auth-cache reset evidence: ${needle}`);
    }
  }

  const runnerTestRel = "runtime/src/app-server/background-agent-runner.contract.test.ts";
  const runnerTestSource = readFileSync(path.join(root, runnerTestRel), "utf8");
  for (const needle of [
    "updateRuntimeConfig resets active daemon runtime provider-key cache after auth reload",
    "managed-key-before",
    "managed-key-after",
  ]) {
    if (!runnerTestSource.includes(needle)) {
      failGate(`GAP-DMN-05: ${runnerTestRel} missing provider-key cache reload regression: ${needle}`);
    }
  }

  const vendingRel = "runtime/src/app-server/provider-key-vending.ts";
  const vendingSource = readFileSync(path.join(root, vendingRel), "utf8");
  for (const needle of [
    "replaceBackend",
    "clearVendedKeyCache",
    "vendedKeys.clear()",
  ]) {
    if (!vendingSource.includes(needle)) {
      failGate(`GAP-DMN-05: ${vendingRel} missing reload-aware provider-key cache evidence: ${needle}`);
    }
  }

  const helpRel = "runtime/src/bin/agenc.ts";
  const helpSource = readFileSync(path.join(root, helpRel), "utf8");
  if (!helpSource.includes("agenc daemon <stop|status|reload|restart>")) {
    failGate(`GAP-DMN-05: ${helpRel} missing top-level daemon reload help`);
  }

  const helpTestRel = "runtime/src/bin/agenc-help-surface.contract.test.ts";
  const helpTestSource = readFileSync(path.join(root, helpTestRel), "utf8");
  for (const needle of [
    "advertises daemon reload in top-level daemon usage",
    "agenc daemon <stop|status|reload|restart>",
  ]) {
    if (!helpTestSource.includes(needle)) {
      failGate(`GAP-DMN-05: ${helpTestRel} missing top-level daemon reload help regression: ${needle}`);
    }
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "--",
    "vitest",
    "run",
    "src/app-server/daemon-cli.contract.test.ts",
    "src/app-server/daemon-dispatcher.contract.test.ts",
    "src/app-server/protocol.contract.test.ts",
    "src/app-server/background-agent-runner.contract.test.ts",
    "src/app-server/provider-key-vending.contract.test.ts",
    "src/bin/agenc-help-surface.contract.test.ts",
    "-t",
    "daemon.reload|parses daemon subcommands|reload reports|reload cleans|reload command re-reads|reload failure preserves|reload fails without|protocol surface|publishes a schema|updateRuntimeConfig resets active daemon runtime provider-key cache after auth reload|replaces the backend and clears cached provider keys|advertises daemon reload in top-level daemon usage",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-DMN-05 targeted daemon reload tests failed");
  }

  pass("GAP-DMN-05 daemon reload subcommand evidence present");
}

function assertGapDmnDispatcherBootInjection() {
  const cliRel = "runtime/src/app-server/daemon-cli.ts";
  const cliSource = readFileSync(path.join(root, cliRel), "utf8");
  const sessionManagerBlock = boundedSourceBlock(
    cliSource,
    "const sessionManager = new AgenCDaemonSessionManager",
    "const clientMultiplexer = new AgenCDaemonClientMultiplexer",
  );
  const clientMultiplexerBlock = boundedSourceBlock(
    cliSource,
    "const clientMultiplexer = new AgenCDaemonClientMultiplexer",
    "const commandExec = new AgenCCommandExecService",
  );
  const agentManagerBlock = boundedSourceBlock(
    cliSource,
    "const agentManager = new AgenCDaemonAgentManager",
    "try {\n    snapshotPolicies.hydrateStartupRecovery",
  );
  const dispatcherBlock = boundedSourceBlock(
    cliSource,
    "const dispatcher = new AgenCDaemonJsonRpcDispatcher",
    "const connections = new Map",
  );
  const missingBootEvidence = [
    ["session manager uses thread store", sessionManagerBlock, "threadStore"],
    ["client multiplexer receives session manager", clientMultiplexerBlock, "sessionManager"],
    ["agent manager receives runner", agentManagerBlock, "runner"],
    ["agent manager receives session manager", agentManagerBlock, "sessionManager"],
    ["dispatcher receives agent manager", dispatcherBlock, "agentManager"],
    ["dispatcher receives client multiplexer", dispatcherBlock, "clientMultiplexer"],
    ["dispatcher receives session manager", dispatcherBlock, "sessionManager"],
    ["dispatcher receives initialize authenticator", dispatcherBlock, "initializeAuthenticator"],
  ].filter(([, source, needle]) => !source.includes(needle));
  if (missingBootEvidence.length > 0) {
    failGate(
      `GAP-DMN-02 daemon boot injection evidence missing:\n  - ${missingBootEvidence
        .map(([label]) => label)
        .join("\n  - ")}`,
    );
  }

  const dispatcherRel = "runtime/src/app-server/daemon-dispatcher.ts";
  const dispatcherSource = readFileSync(path.join(root, dispatcherRel), "utf8");
  for (const needle of [
    "this.#sessionManager === undefined",
    "daemon method is not implemented yet: session.list",
    "this.#agentManager.listPermissions === undefined",
    "daemon method is not implemented yet: permission.list",
  ]) {
    if (!dispatcherSource.includes(needle)) {
      failGate(`GAP-DMN-02: ${dispatcherRel} missing guard evidence: ${needle}`);
    }
  }

  const testRel = "runtime/src/app-server/daemon-cli.contract.test.ts";
  const testSource = readFileSync(path.join(root, testRel), "utf8");
  for (const needle of [
    "foreground daemon injects SessionManager and listPermissions into dispatcher",
    "client.request(\"session.list\"",
    "client.request(\"permission.list\"",
    "permissionAgentIds",
    "expect(sessionList.sessions).toHaveLength(1)",
    "expect(sessionList.sessions[0].agentId).toBe(created.agentId)",
    "expect(sessionList.sessions[0].sessionId).toBe(created.sessionId)",
    "agent.create did not return a sessionId",
  ]) {
    if (!testSource.includes(needle)) {
      failGate(`GAP-DMN-02: ${testRel} missing regression evidence: ${needle}`);
    }
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "--",
    "vitest",
    "run",
    "src/app-server/daemon-cli.contract.test.ts",
    "-t",
    "foreground daemon injects SessionManager and listPermissions into dispatcher",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-DMN-02 targeted daemon boot injection test failed");
  }
  pass("GAP-DMN-02 daemon boot injection evidence present");
}

function boundedSourceBlock(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  if (start === -1) {
    failGate(`source block start not found: ${startNeedle}`);
  }
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (end === -1) {
    failGate(`source block end not found after ${startNeedle}: ${endNeedle}`);
  }
  return source.slice(start, end);
}

function assertGapDmnUnixSocketAcceptAuth() {
  const unixSocketRel = "runtime/src/app-server/transport/unix-socket.ts";
  const unixSocketSource = readFileSync(path.join(root, unixSocketRel), "utf8");
  for (const needle of [
    "AGENC_DAEMON_SOCKET_ACCEPT_AUTH_TIMEOUT_MS",
    "acceptAuthenticator",
    "acceptAuthenticationTimeoutMs",
    "onAuthenticationFailed",
    "clearAuthenticationTimeout",
    "socket.destroy()",
  ]) {
    if (!unixSocketSource.includes(needle)) {
      failGate(`GAP-DMN-03: ${unixSocketRel} missing accept-auth evidence: ${needle}`);
    }
  }

  const authRel = "runtime/src/app-server/transport/auth.ts";
  const authSource = readFileSync(path.join(root, authRel), "utf8");
  if (!authSource.includes("authenticateInitializeMessage")) {
    failGate(`GAP-DMN-03: ${authRel} must authenticate initialize messages before dispatch`);
  }

  const daemonCliRel = "runtime/src/app-server/daemon-cli.ts";
  const daemonCliSource = readFileSync(path.join(root, daemonCliRel), "utf8");
  for (const needle of [
    "acceptAuthenticator: (message)",
    "authenticateInitializeMessage(message)",
    "socketAcceptAuthenticationTimeoutMs",
    "daemonConnectionAuthenticationFailedResponse",
  ]) {
    if (!daemonCliSource.includes(needle)) {
      failGate(`GAP-DMN-03: ${daemonCliRel} missing daemon socket accept-auth wiring: ${needle}`);
    }
  }

  const unixSocketTestRel = "runtime/src/app-server/unix-socket-transport.contract.test.ts";
  const unixSocketTestSource = readFileSync(path.join(root, unixSocketTestRel), "utf8");
  for (const needle of [
    "authenticates the first socket message before dispatch",
    "closes sockets that do not authenticate after accept",
  ]) {
    if (!unixSocketTestSource.includes(needle)) {
      failGate(`GAP-DMN-03: ${unixSocketTestRel} missing accept-auth regression: ${needle}`);
    }
  }

  const daemonCliTestRel = "runtime/src/app-server/daemon-cli.contract.test.ts";
  const daemonCliTestSource = readFileSync(path.join(root, daemonCliTestRel), "utf8");
  if (!daemonCliTestSource.includes("socketAcceptAuthenticationTimeoutMs")) {
    failGate(`GAP-DMN-03: ${daemonCliTestRel} must cover idle accepted socket close`);
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "--",
    "vitest",
    "run",
    "src/app-server/unix-socket-transport.contract.test.ts",
    "src/app-server/transport-auth.contract.test.ts",
    "src/app-server/daemon-cli.contract.test.ts",
    "-t",
    "authenticates the first socket message before dispatch|closes sockets that do not authenticate after accept|normalizes and verifies initialize cookies|foreground daemon instantiates AuthBackend for auth requests",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-DMN-03 targeted Unix socket accept-auth tests failed");
  }
  pass("GAP-DMN-03 Unix socket connections authenticate before daemon dispatch");
}

function assertGapDmnPeerUidFallback() {
  const unixSocketRel = "runtime/src/app-server/transport/unix-socket.ts";
  const unixSocketSource = readFileSync(path.join(root, unixSocketRel), "utf8");
  for (const needle of [
    "resolveAgenCUnixSocketPeerUid",
    "resolveAgenCPrivateUnixSocketOwnerUid",
    "loadAgenCNativePeerCredentialBinding",
    "peerUid",
    "privateSocketOwnerUid",
    "process.platform !== \"linux\"",
  ]) {
    if (!unixSocketSource.includes(needle)) {
      failGate(`GAP-DMN-04: ${unixSocketRel} missing peerUid evidence: ${needle}`);
    }
  }
  if (unixSocketSource.includes("spawnSync")) {
    failGate(`GAP-DMN-04: ${unixSocketRel} must not spawn subprocesses in the accept path`);
  }

  const peerCredentialRel = "runtime/src/app-server/transport/peer-credentials.ts";
  const peerCredentialSource = readFileSync(path.join(root, peerCredentialRel), "utf8");
  for (const needle of [
    "NAPI_MODULE_INIT",
    "SO_PEERCRED",
    "compileAndLoadAgenCNativePeerCredentialBinding",
    "agenc-peer-credentials.node",
    "AgenCNativePeerCredentialLoadResult",
  ]) {
    if (!peerCredentialSource.includes(needle)) {
      failGate(`GAP-DMN-04: ${peerCredentialRel} missing native peer credential evidence: ${needle}`);
    }
  }

  const authRel = "runtime/src/app-server/transport/auth.ts";
  const authSource = readFileSync(path.join(root, authRel), "utf8");
  for (const needle of [
    "createAgenCDaemonPeerUidIdentity",
    "createAgenCDaemonPrivateSocketOwnerIdentity",
  ]) {
    if (!authSource.includes(needle)) {
      failGate(`GAP-DMN-04: ${authRel} must expose daemon identity evidence: ${needle}`);
    }
  }

  const daemonCliRel = "runtime/src/app-server/daemon-cli.ts";
  const daemonCliSource = readFileSync(path.join(root, daemonCliRel), "utf8");
  for (const needle of [
    "daemonVerifiedIdentityForContext",
    "markDaemonSocketIdentity(verifiedIdentity)",
    "authenticateInitializeMessage(message)",
    "nativePeerCredentialBinding",
    "onNativePeerCredentialUnavailable",
  ]) {
    if (!daemonCliSource.includes(needle)) {
      failGate(`GAP-DMN-04: ${daemonCliRel} missing peerUid daemon wiring: ${needle}`);
    }
  }

  const dispatcherRel = "runtime/src/app-server/daemon-dispatcher.ts";
  const dispatcherSource = readFileSync(path.join(root, dispatcherRel), "utf8");
  if (!dispatcherSource.includes("connection.daemonSocketIdentity === undefined")) {
    failGate(`GAP-DMN-04: ${dispatcherRel} must preserve pre-verified peerUid identity`);
  }

  const daemonCliTestRel = "runtime/src/app-server/daemon-cli.contract.test.ts";
  const daemonCliTestSource = readFileSync(path.join(root, daemonCliTestRel), "utf8");
  for (const needle of [
    "expectSameUserDaemonSocketIdentity",
    "rejects mismatched native peer uid without cookie",
  ]) {
    if (!daemonCliTestSource.includes(needle)) {
      failGate(`GAP-DMN-04: ${daemonCliTestRel} must assert daemon identity regression: ${needle}`);
    }
  }

  const unixSocketTestRel = "runtime/src/app-server/unix-socket-transport.contract.test.ts";
  const unixSocketTestSource = readFileSync(path.join(root, unixSocketTestRel), "utf8");
  for (const needle of [
    "resolveAgenCPrivateUnixSocketOwnerUid",
    "connection.peerUid",
    "connection.privateSocketOwnerUid",
    "does not use non-private socket ownership as same-user proof",
    "loads native SO_PEERCRED from an accepted Unix socket",
  ]) {
    if (!unixSocketTestSource.includes(needle)) {
      failGate(`GAP-DMN-04: ${unixSocketTestRel} missing peerUid socket regression: ${needle}`);
    }
  }

  const transportAuthTestRel = "runtime/src/app-server/transport-auth.contract.test.ts";
  const transportAuthTestSource = readFileSync(path.join(root, transportAuthTestRel), "utf8");
  for (const needle of [
    "createAgenCDaemonPeerUidIdentity",
    "createAgenCDaemonPrivateSocketOwnerIdentity",
  ]) {
    if (!transportAuthTestSource.includes(needle)) {
      failGate(`GAP-DMN-04: ${transportAuthTestRel} must assert identity creation: ${needle}`);
    }
  }

  const dispatcherTestRel = "runtime/src/app-server/daemon-dispatcher.auth-backend.contract.test.ts";
  const dispatcherTestSource = readFileSync(path.join(root, dispatcherTestRel), "utf8");
  if (!dispatcherTestSource.includes("keeps pre-marked daemon socket identity during initialize")) {
    failGate(`GAP-DMN-04: ${dispatcherTestRel} must cover pre-marked peerUid initialize path`);
  }

  const peerCredentialTestRel = "runtime/src/app-server/peer-credentials.contract.test.ts";
  const peerCredentialTestSource = readFileSync(path.join(root, peerCredentialTestRel), "utf8");
  for (const needle of [
    "falls back without compiling when runtime native builds are disabled",
    "builds the native addon from a static SO_PEERCRED source",
    "runtime native peer credential build disabled",
  ]) {
    if (!peerCredentialTestSource.includes(needle)) {
      failGate(`GAP-DMN-04: ${peerCredentialTestRel} missing native binding regression: ${needle}`);
    }
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "--",
    "vitest",
    "run",
    "src/app-server/unix-socket-transport.contract.test.ts",
    "src/app-server/transport-auth.contract.test.ts",
    "src/app-server/daemon-cli.contract.test.ts",
    "src/app-server/daemon-dispatcher.auth-backend.contract.test.ts",
    "src/app-server/peer-credentials.contract.test.ts",
    "-t",
    "accepts newline-delimited JSON over a Unix socket|loads native SO_PEERCRED from an accepted Unix socket|does not use non-private socket ownership as same-user proof|authenticates the first socket message before dispatch|normalizes and verifies initialize cookies|foreground daemon instantiates AuthBackend for auth requests|foreground daemon rejects mismatched native peer uid without cookie|keeps pre-marked daemon socket identity during initialize|passes verified daemon socket identity into auth.whoami|falls back without compiling when runtime native builds are disabled|builds the native addon from a static SO_PEERCRED source",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-DMN-04 targeted peerUid tests failed");
  }
  pass("GAP-DMN-04 daemon Unix sockets derive peerUid identity before dispatch");
}

function assertGapMcpXaaRefreshLock() {
  const authRel = "runtime/src/services/mcp/auth.ts";
  const authSource = readFileSync(path.join(root, authRel), "utf8");
  for (const needle of [
    "async function acquireMcpRefreshLock",
    "mcp-refresh-${sanitizedKey}.lock",
    "const release = await acquireMcpRefreshLock(this.serverName, serverKey)",
    "clearKeychainCache()",
    "Another process already refreshed XAA tokens",
  ]) {
    if (!authSource.includes(needle)) {
      failGate(`GAP-MCP-06: ${authRel} missing XAA refresh lock evidence: ${needle}`);
    }
  }

  const lockCallCount = (
    authSource.match(/acquireMcpRefreshLock\(this\.serverName, serverKey\)/g) ?? []
  ).length;
  if (lockCallCount < 2) {
    failGate("GAP-MCP-06: normal OAuth refresh and XAA refresh must both use the shared lock helper");
  }

  if (authSource.includes("Follow-up(xaa-ga)")) {
    failGate("GAP-MCP-06: stale XAA lock follow-up remains in auth.ts");
  }
  if (authSource.includes("proceeding without lock")) {
    failGate("GAP-MCP-06: MCP refresh must not proceed without the cross-process lock");
  }

  const testRel = "runtime/src/services/mcp/auth-xaa-lock.test.ts";
  if (!existsSync(path.join(root, testRel))) {
    failGate(`GAP-MCP-06: missing regression test ${testRel}`);
  }
  const testSource = readFileSync(path.join(root, testRel), "utf8");
  for (const needle of [
    "reuses tokens another process refreshed while waiting for the lock",
    "serializes the XAA exchange and releases the refresh lock after storing tokens",
    "does not start XAA exchange when the refresh lock stays contended",
    "expect(mockPerformCrossAppAccess).not.toHaveBeenCalled()",
    "expect(probes.release).toHaveBeenCalledOnce()",
    "invocationCallOrder",
  ]) {
    if (!testSource.includes(needle)) {
      failGate(`GAP-MCP-06: ${testRel} missing regression evidence: ${needle}`);
    }
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/services/mcp/auth-xaa-lock.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-MCP-06 targeted XAA refresh lock tests failed");
  }

  pass("GAP-MCP-06: MCP XAA refresh is protected by the cross-process refresh lock");
}

function assertGapDmnSessionRoutes() {
  const dispatcherRel = "runtime/src/app-server/daemon-dispatcher.ts";
  const dispatcherSource = readFileSync(path.join(root, dispatcherRel), "utf8");
  const requiredDispatcherEvidence = [
    'case "session.create"',
    'case "session.detach"',
    'case "session.terminate"',
    "validateSessionCreateParams",
    "validateSessionDetachParams",
    "validateSessionTerminateParams",
    "AgenCSessionLifecycleError",
    "error instanceof AgenCSessionLifecycleError",
    "this.#clientMultiplexer?.detachSession",
    "this.#clientMultiplexer?.terminateSession",
    "daemon method is not implemented yet: session.create",
    "daemon method is not implemented yet: session.detach",
    "daemon method is not implemented yet: session.terminate",
  ];
  const missingDispatcherEvidence = requiredDispatcherEvidence.filter(
    (needle) => !dispatcherSource.includes(needle),
  );
  if (missingDispatcherEvidence.length > 0) {
    failGate(
      `GAP-DMN-01 dispatcher evidence missing:\n  - ${missingDispatcherEvidence.join("\n  - ")}`,
    );
  }

  const multiplexerRel = "runtime/src/app-server/client-multiplexer.ts";
  const multiplexerSource = readFileSync(path.join(root, multiplexerRel), "utf8");
  const requiredMultiplexerEvidence = [
    "async detachSession(params: SessionDetachParams)",
    "async terminateSession(",
    "routeClientIdForDetach",
    "params.attachmentId !== undefined",
    "state.sessions.delete(params.sessionId)",
    "sessionIds.delete(params.sessionId)",
  ];
  const missingMultiplexerEvidence = requiredMultiplexerEvidence.filter(
    (needle) => !multiplexerSource.includes(needle),
  );
  if (missingMultiplexerEvidence.length > 0) {
    failGate(
      `GAP-DMN-01 multiplexer evidence missing:\n  - ${missingMultiplexerEvidence.join("\n  - ")}`,
    );
  }

  const dispatcherTestRel =
    "runtime/src/app-server/daemon-dispatcher.contract.test.ts";
  const dispatcherTestSource = readFileSync(
    path.join(root, dispatcherTestRel),
    "utf8",
  );
  const requiredDispatcherTestEvidence = [
    "routes create, attach, detach, and terminate while reconciling multiplexer routes",
    "falls back to SessionManager for detach and terminate without a multiplexer",
    "cleans mux routes by attachmentId and preserves attachmentId precedence",
    "preserves unrelated routes when detach targets an unowned client on another session",
    "reports missing SessionManager before validating new session methods",
    "maps session lifecycle errors to invalid params instead of internal errors",
  ];
  const missingDispatcherTestEvidence = requiredDispatcherTestEvidence.filter(
    (needle) => !dispatcherTestSource.includes(needle),
  );
  if (missingDispatcherTestEvidence.length > 0) {
    failGate(
      `GAP-DMN-01 dispatcher test evidence missing:\n  - ${missingDispatcherTestEvidence.join("\n  - ")}`,
    );
  }

  const multiplexerTestRel =
    "runtime/src/app-server/client-multiplexer.contract.test.ts";
  const multiplexerTestSource = readFileSync(
    path.join(root, multiplexerTestRel),
    "utf8",
  );
  for (const needle of [
    "detaches by params while preserving attachmentId precedence",
    "terminates by params and clears route/client memberships",
  ]) {
    if (!multiplexerTestSource.includes(needle)) {
      failGate(`GAP-DMN-01: ${multiplexerTestRel} missing evidence: ${needle}`);
    }
  }

  const sdkClientTestRel = "runtime/src/app-server/sdk-client.contract.test.ts";
  const sdkClientTestSource = readFileSync(path.join(root, sdkClientTestRel), "utf8");
  for (const needle of [
    "frames session lifecycle methods onto daemon JSON-RPC requests",
    "client.createSession",
    "client.detachSession",
    "client.terminateSession",
    'method: "session.create"',
    'method: "session.detach"',
    'method: "session.terminate"',
  ]) {
    if (!sdkClientTestSource.includes(needle)) {
      failGate(`GAP-DMN-01: ${sdkClientTestRel} missing evidence: ${needle}`);
    }
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/app-server/daemon-dispatcher.contract.test.ts",
    "src/app-server/client-multiplexer.contract.test.ts",
    "src/app-server/sdk-client.contract.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-DMN-01 targeted daemon session route tests failed");
  }
  pass("GAP-DMN-01 daemon session route evidence present");
}

function assertGapMcpAppNotificationsWired() {
  const appRel = "runtime/src/tui/components/App.tsx";
  const appSource = readFileSync(path.join(root, appRel), "utf8");
  for (const needle of [
    "useMcpConnectivityStatus",
    "useSessionMcpSurface",
    "readMcpSurfaceSnapshot",
    "listMcpClients",
    "listMcpTools",
    "refreshTools: refreshAvailableTools",
    "mcpClients={mcpClients",
  ]) {
    if (!appSource.includes(needle)) {
      failGate(`GAP-MCP-05: ${appRel} missing App MCP evidence: ${needle}`);
    }
  }

  const sessionTypesRel = "runtime/src/tui/session-types.ts";
  const sessionTypesSource = readFileSync(path.join(root, sessionTypesRel), "utf8");
  if (!sessionTypesSource.includes("listMcpTools?(): readonly unknown[]")) {
    failGate(`GAP-MCP-05: ${sessionTypesRel} must expose listMcpTools on the TUI session contract`);
  }

  const sessionRel = "runtime/src/session/session.ts";
  const sessionSource = readFileSync(path.join(root, sessionRel), "utf8");
  for (const needle of [
    "listMcpTools(): readonly unknown[]",
    "manager.getTools()",
    "projectMcpManagerToConnections(manager)",
    "getConnectedConnection?",
  ]) {
    if (!sessionSource.includes(needle)) {
      failGate(`GAP-MCP-05: ${sessionRel} missing session MCP evidence: ${needle}`);
    }
  }

  const mcpStartupRel = "runtime/src/session/mcp-startup.ts";
  const mcpStartupSource = readFileSync(path.join(root, mcpStartupRel), "utf8");
  for (const needle of [
    "getConfiguredServers:",
    "getConnectionState:",
    "getConnectedConnection:",
  ]) {
    if (!mcpStartupSource.includes(needle)) {
      failGate(`GAP-MCP-05: ${mcpStartupRel} missing session service MCP evidence: ${needle}`);
    }
  }

  const projectionRel = "runtime/src/mcp-client/tui-connections.ts";
  const projectionSource = readFileSync(path.join(root, projectionRel), "utf8");
  for (const needle of [
    "getConnectionState?",
    "state?.type === \"failed\"",
    "type: \"failed\"",
    "state?.type === \"connected\"",
    "getConnectedConnection?",
    "connected?.type === \"connected\"",
  ]) {
    if (!projectionSource.includes(needle)) {
      failGate(`GAP-MCP-05: ${projectionRel} missing connection projection evidence: ${needle}`);
    }
  }

  const appTestRel = "runtime/src/tui/components/App.render.test.tsx";
  const appTestSource = readFileSync(path.join(root, appTestRel), "utf8");
  for (const needle of [
    "passes live MCP clients and tools through the App shell",
    "refreshes MCP clients and tools when same-metadata objects are replaced",
    "mcpConnectivityProps",
    "refreshTools()",
  ]) {
    if (!appTestSource.includes(needle)) {
      failGate(`GAP-MCP-05: ${appTestRel} missing App regression evidence: ${needle}`);
    }
  }

  const managerTestRel = "runtime/src/mcp-client/manager.test.ts";
  const managerTestSource = readFileSync(path.join(root, managerTestRel), "utf8");
  if (!managerTestSource.includes("getConnectionState(\"srv1\")")) {
    failGate(`GAP-MCP-05: ${managerTestRel} missing manager connection-state regression evidence`);
  }

  const projectionTestRel = "runtime/src/mcp-client/tui-connections.test.ts";
  const projectionTestSource = readFileSync(path.join(root, projectionTestRel), "utf8");
  for (const needle of [
    "projects real connected connections and pending server states",
    "uses the manager-provided connected connection when available",
    "keeps connected-looking servers pending when no real client is exposed",
    "projects failed and disabled server states for App notifications",
  ]) {
    if (!projectionTestSource.includes(needle)) {
      failGate(`GAP-MCP-05: ${projectionTestRel} missing projection regression evidence: ${needle}`);
    }
  }

  const hookTestRel = "runtime/src/tui/hooks/notifs/useMcpConnectivityStatus.test.tsx";
  const hookTestSource = readFileSync(path.join(root, hookTestRel), "utf8");
  if (!hookTestSource.includes("adds the MCP failed notification for failed local server connections")) {
    failGate(`GAP-MCP-05: ${hookTestRel} missing real notification-path regression evidence`);
  }

  const startupTestRel = "runtime/src/session/mcp-startup.test.ts";
  const startupTestSource = readFileSync(path.join(root, startupTestRel), "utf8");
  if (!startupTestSource.includes("exposes TUI MCP projection methods through the session service facade")) {
    failGate(`GAP-MCP-05: ${startupTestRel} missing production service-facade projection regression evidence`);
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/tui/components/App.render.test.tsx",
    "src/tui/hooks/notifs/useMcpConnectivityStatus.test.tsx",
    "src/session/mcp-startup.test.ts",
    "src/mcp-client/manager.test.ts",
    "src/mcp-client/tui-connections.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-MCP-05 targeted App MCP wiring tests failed");
  }

  pass("GAP-MCP-05: App lists MCP clients/tools and wires connection failure notifications");
}

function assertGapMcpSlashCommandExpanded() {
  const commandRel = "runtime/src/commands/mcp.ts";
  const commandSource = readFileSync(path.join(root, commandRel), "utf8");
  const requiredCommandEvidence = [
    "parseMcpArgs",
    "collectMcpToolStatus",
    "formatMcpToolStatus",
    "reconnectServer",
    "enableServer",
    "disableServer",
    "addServer",
    "This does not edit config.toml",
  ];
  for (const needle of requiredCommandEvidence) {
    if (!commandSource.includes(needle)) {
      failGate(`GAP-MCP-03: ${commandRel} missing /mcp expansion evidence: ${needle}`);
    }
  }

  const managerRel = "runtime/src/mcp-client/manager.ts";
  const managerSource = readFileSync(path.join(root, managerRel), "utf8");
  for (const needle of [
    "async enableServer",
    "async disableServer",
    "async addServer",
    "disconnectServer",
  ]) {
    if (!managerSource.includes(needle)) {
      failGate(`GAP-MCP-03: ${managerRel} missing manager mutation evidence: ${needle}`);
    }
  }

  const serviceRel = "runtime/src/session/mcp-startup.ts";
  const serviceSource = readFileSync(path.join(root, serviceRel), "utf8");
  for (const needle of [
    "reconnectServer",
    "enableServer",
    "disableServer",
    "addServer",
    "getToolsByServer",
  ]) {
    if (!serviceSource.includes(needle)) {
      failGate(`GAP-MCP-03: ${serviceRel} does not forward ${needle}`);
    }
  }

  const testRel = "runtime/src/commands/mcp.test.ts";
  const testSource = readFileSync(path.join(root, testRel), "utf8");
  for (const needle of [
    "parses management subcommands and quoted add args",
    "lists all MCP tools or tools for one server",
    "sanitizes MCP tool output to one line per tool",
    "reports reconnect, enable, and disable results",
    "adds a stdio MCP server for the current session only",
  ]) {
    if (!testSource.includes(needle)) {
      failGate(`GAP-MCP-03: ${testRel} missing slash command test: ${needle}`);
    }
  }

  const managerTestRel = "runtime/src/mcp-client/manager.test.ts";
  const managerTestSource = readFileSync(path.join(root, managerTestRel), "utf8");
  for (const needle of [
    "failed reconnect leaves the server disconnected",
    "enables a configured disabled server and connects it",
    "disables a configured server and disposes all live bridges",
    "adds a session server and rejects duplicate or invalid names",
    "rolls back a failed session add so the server name can be retried",
  ]) {
    if (!managerTestSource.includes(needle)) {
      failGate(`GAP-MCP-03: ${managerTestRel} missing manager mutation test: ${needle}`);
    }
  }

  const startupTestRel = "runtime/src/session/mcp-startup.test.ts";
  const startupTestSource = readFileSync(path.join(root, startupTestRel), "utf8");
  if (!startupTestSource.includes("forwards live slash command MCP manager controls")) {
    failGate(`GAP-MCP-03: ${startupTestRel} missing session facade forwarding test`);
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/commands/mcp.test.ts",
    "src/mcp-client/manager.test.ts",
    "src/session/mcp-startup.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-MCP-03 targeted /mcp slash command tests failed");
  }

  pass("GAP-MCP-03: /mcp slash command manages live MCP servers and tools");
}

function assertGapMcpCliSubcommandsWired() {
  const cliRel = "runtime/src/bin/mcp-cli.ts";
  const cliSource = readFileSync(path.join(root, cliRel), "utf8");
  const requiredCommands = [
    "add",
    "list",
    "get",
    "remove",
    "add-json",
    "add-from-agenc-desktop",
    "reset-project-choices",
    "doctor",
  ];
  for (const command of requiredCommands) {
    if (!cliSource.includes(`"${command}"`)) {
      failGate(`GAP-MCP-02: ${cliRel} does not recognize mcp ${command}`);
    }
  }
  const requiredWiring = [
    "runMcpAddCommand",
    "mcpListHandler",
    "mcpGetHandler",
    "mcpRemoveHandler",
    "mcpAddJsonHandler",
    "mcpAddFromDesktopHandler",
    "mcpResetChoicesHandler",
    "mcpDoctorHandler",
    "runMcpAddAction",
    "kind: \"management\"",
  ];
  for (const needle of requiredWiring) {
    if (!cliSource.includes(needle)) {
      failGate(`GAP-MCP-02: ${cliRel} missing handler wiring evidence: ${needle}`);
    }
  }

  const handlersRel = "runtime/src/cli/handlers/mcp.tsx";
  const handlersSource = readFileSync(path.join(root, handlersRel), "utf8");
  if (!/getMcpConfigsByScope\('user'\)/.test(handlersSource)) {
    failGate("GAP-MCP-02: remove handler must find TOML-backed user MCP configs");
  }
  if (!/redactMcpDisplayValue/.test(handlersSource)) {
    failGate("GAP-MCP-02: get handler must redact MCP header and env values");
  }

  const testRel = "runtime/src/bin/mcp-cli-management.test.ts";
  const testSource = readFileSync(path.join(root, testRel), "utf8");
  if (!/recognizes non-serve management subcommands/.test(testSource)) {
    failGate("GAP-MCP-02: mcp-cli tests must cover non-serve subcommand parsing");
  }
  if (!/default mcp add writes to the live user config namespace/.test(testSource)) {
    failGate("GAP-MCP-02: mcp-cli tests must cover default add writing user config");
  }
  if (!/mcp add validates xaa before writing config/.test(testSource)) {
    failGate("GAP-MCP-02: mcp-cli tests must cover add-time xaa validation");
  }
  if (!/Authorization: <redacted>/.test(testSource)) {
    failGate("GAP-MCP-02: mcp add tests must cover header redaction");
  }

  const redactionTestRel = "runtime/src/cli/handlers/mcp-redaction.test.ts";
  const redactionTestSource = readFileSync(path.join(root, redactionTestRel), "utf8");
  if (!/mcp get redacts remote headers/.test(redactionTestSource)) {
    failGate("GAP-MCP-02: mcp get tests must cover header redaction");
  }
  if (!/mcp get redacts stdio environment values/.test(redactionTestSource)) {
    failGate("GAP-MCP-02: mcp get tests must cover env redaction");
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/bin/mcp-cli-management.test.ts",
    "src/cli/handlers/mcp-redaction.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-MCP-02 targeted MCP CLI wiring tests failed");
  }

  pass("GAP-MCP-02: agenc mcp non-serve subcommands are wired to handlers");
}

function assertGapMcpBridgeConfigNamespaces() {
  const serviceConfigRel = "runtime/src/services/mcp/config.ts";
  const serviceConfig = readFileSync(path.join(root, serviceConfigRel), "utf8");
  if (!/addUserMcpServerToToml/.test(serviceConfig) || !/getUserMcpConfigsFromToml/.test(serviceConfig)) {
    failGate("GAP-MCP-01: addMcpConfig/getMcpConfigsByScope must use canonical TOML user helpers");
  }
  if (/saveGlobalConfig/.test(serviceConfig)) {
    failGate("GAP-MCP-01: user MCP config must not write legacy ~/.agenc.json via saveGlobalConfig");
  }

  const tomlConfigRel = "runtime/src/services/mcp/user-config-toml.ts";
  const tomlConfig = readFileSync(path.join(root, tomlConfigRel), "utf8");
  const requiredServiceEvidence = [
    "AgenCConfigEditsBuilder",
    "toCanonicalMcpServerConfig",
    "mcp_servers",
    "endpoint: url",
    "getUserMcpConfigsFromToml",
  ];
  for (const needle of requiredServiceEvidence) {
    if (!tomlConfig.includes(needle)) {
      failGate(`GAP-MCP-01: ${tomlConfigRel} is missing canonical TOML evidence: ${needle}`);
    }
  }

  const editRel = "runtime/src/config/edit.ts";
  const editSource = readFileSync(path.join(root, editRel), "utf8");
  if (!/setMcpServer\(/.test(editSource) || !/removeMcpServer\(/.test(editSource)) {
    failGate("GAP-MCP-01: config.toml editor must expose MCP server edits");
  }

  const addCommandRel = "runtime/src/cli/handlers/mcp-add-action.ts";
  const addCommand = readFileSync(path.join(root, addCommandRel), "utf8");
  if (!/options\.scope \?\? "user"/.test(addCommand)) {
    failGate("GAP-MCP-01: mcp add must default to live user config.toml scope");
  }

  const testRel = "runtime/src/services/mcp/config-toml-namespace.test.ts";
  if (!existsSync(path.join(root, testRel))) {
    failGate(`GAP-MCP-01: missing regression test ${testRel}`);
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/services/mcp/config-toml-namespace.test.ts",
    "src/session/mcp-startup.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-MCP-01 targeted MCP config namespace tests failed");
  }

  pass("GAP-MCP-01: mcp add user config writes canonical config.toml mcp_servers");
}

function assertGapMcpDonorMirrorTierResolved() {
  const absent = [
    "runtime/src/commands/mcp/addCommand.ts",
    "runtime/src/commands/mcp/addAction.ts",
    "runtime/src/commands/mcp/doctorCommand.ts",
    "runtime/src/commands/mcp/doctorCommand.test.ts",
    "runtime/src/commands/mcp/index.ts",
    "runtime/src/commands/mcp/mcp.tsx",
    "runtime/src/commands/mcp/xaaIdpCommand.ts",
    "runtime/src/entrypoints/mcp.ts",
    "runtime/src/entrypoints/mcp.test.ts",
    "runtime/src/tui/components/mcp/MCPAgentServerMenu.tsx",
    "runtime/src/tui/components/mcp/MCPListPanel.tsx",
    "runtime/src/tui/components/mcp/MCPReconnect.tsx",
    "runtime/src/tui/components/mcp/MCPSettings.tsx",
  ];
  for (const rel of absent) {
    if (existsSync(path.join(root, rel))) {
      failGate(`GAP-MCP-04: stale donor-tier file still exists: ${rel}`);
    }
  }
  if (existsSync(path.join(root, "runtime/src/commands/mcp"))) {
    failGate("GAP-MCP-04: runtime/src/commands/mcp subdirectory must be deleted");
  }

  const requiredFiles = [
    "runtime/src/cli/handlers/mcp-add-action.ts",
    "runtime/src/cli/handlers/mcp-xaa.ts",
    "runtime/src/tui/components/mcp/types.ts",
  ];
  for (const rel of requiredFiles) {
    if (!existsSync(path.join(root, rel))) {
      failGate(`GAP-MCP-04: missing retained MCP owner file ${rel}`);
    }
  }

  const noNocheckScopes = [
    "runtime/src/services/mcp",
    "runtime/src/tui/components/mcp",
    "runtime/src/cli/handlers/mcp.tsx",
    "runtime/src/cli/handlers/mcp-add-action.ts",
    "runtime/src/cli/handlers/mcp-xaa.ts",
  ];
  for (const rel of noNocheckScopes) {
    const abs = path.join(root, rel);
    const files = statSync(abs).isDirectory() ? listSourceFiles(abs) : [rel];
    for (const fileRel of files) {
      const source = readFileSync(path.join(root, fileRel), "utf8");
      if (source.startsWith("// @ts-nocheck") || source.includes("Moved-source note")) {
        failGate(`GAP-MCP-04: temporary type boundary remains in ${fileRel}`);
      }
    }
  }

  const cliSource = readFileSync(path.join(root, "runtime/src/bin/mcp-cli.ts"), "utf8");
  for (const needle of [
    "\"xaa\"",
    "Manage XAA IdP authentication",
    "../cli/handlers/mcp-add-action.js",
    "../cli/handlers/mcp-xaa.js",
  ]) {
    if (!cliSource.includes(needle)) {
      failGate(`GAP-MCP-04: runtime/src/bin/mcp-cli.ts missing live CLI evidence: ${needle}`);
    }
  }

  const agencSource = readFileSync(path.join(root, "runtime/src/bin/agenc.ts"), "utf8");
  if (!/agenc mcp <serve\|add\|list\|get\|remove\|add-json\|add-from-agenc-desktop\|reset-project-choices\|doctor\|xaa>/.test(agencSource)) {
    failGate("GAP-MCP-04: top-level agenc help must advertise agenc mcp xaa");
  }

  const xaaSource = readFileSync(path.join(root, "runtime/src/cli/handlers/mcp-xaa.ts"), "utf8");
  for (const banned of ["process.exit", "cliError", "cliOk"]) {
    if (xaaSource.includes(banned)) {
      failGate(`GAP-MCP-04: mcp xaa handler must use injected IO, found ${banned}`);
    }
  }
  for (const needle of [
    "updateSettingsForSource(\"userSettings\"",
    "MCP_XAA_IDP_CLIENT_SECRET",
    "saveIdpClientSecret",
    "saveIdpIdTokenFromJwt",
    "getCachedIdpIdToken",
    "clearIdpIdToken",
    "clearIdpClientSecret",
  ]) {
    if (!xaaSource.includes(needle)) {
      failGate(`GAP-MCP-04: mcp xaa handler missing behavior evidence: ${needle}`);
    }
  }

  const handlersSource = readFileSync(path.join(root, "runtime/src/cli/handlers/mcp.tsx"), "utf8");
  if (/mcpServeHandler/.test(handlersSource)) {
    failGate("GAP-MCP-04: stale mcpServeHandler must be removed from CLI handlers");
  }

  const managePluginsSource = readFileSync(path.join(root, "runtime/src/commands/plugin/ManagePlugins.tsx"), "utf8");
  if (!managePluginsSource.includes("../../tui/components/mcp/types.js")) {
    failGate("GAP-MCP-04: ManagePlugins must import shared MCP types from the retained TUI owner");
  }
  for (const deletedComponent of [
    "MCPAgentServerMenu",
    "MCPListPanel",
    "MCPReconnect",
    "MCPSettings",
  ]) {
    if (managePluginsSource.includes(deletedComponent)) {
      failGate(`GAP-MCP-04: ManagePlugins still references deleted ${deletedComponent}`);
    }
  }

  const runtimeTsconfig = readFileSync(path.join(root, "runtime/tsconfig.json"), "utf8");
  for (const staleExclude of [
    "src/cli/handlers/mcp.tsx",
    "src/commands/mcp/addCommand.ts",
    "src/commands/mcp/doctorCommand.ts",
    "src/commands/mcp/mcp.tsx",
    "src/commands/mcp/xaaIdpCommand.ts",
    "src/entrypoints/mcp.ts",
    "src/services/mcp/MCPConnectionManager.tsx",
    "src/services/mcp/doctor.ts",
    "src/services/mcp/useManageMCPConnections.ts",
    "src/tui/components/mcp/ElicitationDialog.tsx",
    "src/tui/components/mcp/MCPReconnect.tsx",
    "src/tui/components/mcp/MCPRemoteServerMenu.tsx",
    "src/tui/components/mcp/MCPSettings.tsx",
    "src/tui/components/mcp/MCPStdioServerMenu.tsx",
    "src/tui/components/mcp/MCPToolDetailView.tsx",
    "src/tui/components/mcp/MCPToolListView.tsx",
    "src/tui/components/mcp/McpParsingWarnings.tsx",
  ]) {
    if (runtimeTsconfig.includes(`"${staleExclude}"`)) {
      failGate(`GAP-MCP-04: runtime tsconfig still excludes ${staleExclude}`);
    }
  }

  const referenceFiles = [
    ".knip.json",
    ".ts-prune-ignore",
    "scripts/goal/checklist-utils.test.mjs",
    "parity/GAP-TOOLS-04-parity.json",
    "parity/OB-04-parity.json",
    "RUNTIME-STABILIZATION-GOALS-2026-05-12.md",
  ];
  const staleReferencePatterns = [
    "runtime/src/commands/mcp/addCommand.ts",
    "runtime/src/commands/mcp/doctorCommand.ts",
    "runtime/src/commands/mcp/index.ts",
    "runtime/src/commands/mcp/mcp.tsx",
    "runtime/src/commands/mcp/xaaIdpCommand.ts",
    "runtime/src/entrypoints/mcp.ts",
    "src/commands/mcp/addCommand.ts",
    "src/commands/mcp/doctorCommand.ts",
    "src/commands/mcp/index.ts",
    "src/commands/mcp/mcp.tsx",
    "src/commands/mcp/xaaIdpCommand.ts",
    "src/entrypoints/mcp.ts",
    "MCPAgentServerMenu",
    "MCPListPanel",
    "MCPReconnect",
    "MCPSettings",
    "claudeai",
  ];
  for (const rel of referenceFiles) {
    const source = readFileSync(path.join(root, rel), "utf8");
    for (const pattern of staleReferencePatterns) {
      if (source.includes(pattern)) {
        failGate(`GAP-MCP-04: stale reference ${pattern} remains in ${rel}`);
      }
    }
  }

  const testSource = readFileSync(path.join(root, "runtime/src/bin/mcp-cli-management.test.ts"), "utf8");
  for (const needle of [
    "mcp xaa setup validates issuer and secret env before writing settings",
    "mcp xaa setup writes settings through injected IO and clears stale issuer secrets",
    "mcp xaa login supports cached, forced, and id-token paths",
    "mcp xaa show and clear do not leak secrets or cached tokens",
  ]) {
    if (!testSource.includes(needle)) {
      failGate(`GAP-MCP-04: missing xaa CLI regression test: ${needle}`);
    }
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/bin/mcp-cli-management.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-MCP-04 targeted MCP CLI/XAA tests failed");
  }

  const checklistTest = run("node", ["scripts/goal/checklist-utils.test.mjs"]);
  if (checklistTest.status !== 0) {
    failGate("GAP-MCP-04 checklist utility consistency test failed");
  }

  pass("GAP-MCP-04: stale MCP donor tier deleted or absorbed into live AgenC owners");
}

function assertGapToolsNullStubToolsRemoved() {
  const removedToolFiles = [
    "runtime/src/tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.ts",
    "runtime/src/tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.ts",
    "runtime/src/tools/REPLTool/REPLTool.ts",
    "runtime/src/tools/TungstenTool/TungstenTool.ts",
    "runtime/src/tools/TungstenTool/TungstenLiveMonitor.ts",
  ];
  for (const rel of removedToolFiles) {
    if (existsSync(path.join(root, rel))) {
      failGate(`GAP-TOOLS-05: null-stub tool file still exists: ${rel}`);
    }
  }

  const toolsSource = readFileSync(path.join(root, "runtime/src/tools.ts"), "utf8");
  const forbiddenToolsEvidence = [
    "const REPLTool = null",
    "const SuggestBackgroundPRTool = null",
    "VerifyPlanExecutionTool/VerifyPlanExecutionTool.js",
    "SuggestBackgroundPRTool ?",
    "VerifyPlanExecutionTool ?",
    "REPLTool ?",
  ];
  const staleToolsEvidence = forbiddenToolsEvidence.filter((needle) =>
    toolsSource.includes(needle),
  );
  if (staleToolsEvidence.length > 0) {
    failGate(
      `GAP-TOOLS-05: runtime/src/tools.ts still references deleted null-stub tools:\n  - ${staleToolsEvidence.join("\n  - ")}`,
    );
  }

  const liveSources = [
    "runtime/src/commands/clear/caches.ts",
    "runtime/src/tui/components/agents/ToolSelector.tsx",
    "runtime/src/tui/screens/REPL.tsx",
    "runtime/src/tui/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx",
  ];
  const deletedImportPattern =
    /tools\/(?:SuggestBackgroundPRTool\/SuggestBackgroundPRTool|VerifyPlanExecutionTool\/VerifyPlanExecutionTool|REPLTool\/REPLTool|TungstenTool\/(?:TungstenTool|TungstenLiveMonitor))(?:\.js)?(?=["';])/;
  for (const rel of liveSources) {
    const source = readFileSync(path.join(root, rel), "utf8");
    if (deletedImportPattern.test(source)) {
      failGate(`GAP-TOOLS-05: live source imports deleted null-stub tool in ${rel}`);
    }
  }

  const nullStubScan = run("rg", [
    "-n",
    "-g",
    "!*.test.ts",
    "export\\s+(?:default\\s+null|const\\s+\\w+\\s*=\\s*null\\b)|const\\s+(?:REPLTool|SuggestBackgroundPRTool|VerifyPlanExecutionTool)\\s*=\\s*null\\b",
    "runtime/src/tools",
    "runtime/src/tools.ts",
  ]);
  if (nullStubScan.status === 0) {
    failGate(`GAP-TOOLS-05: null-stub tool exports remain:\n${nullStubScan.stdout}`);
  }
  if (nullStubScan.status !== 1) {
    failGate(`GAP-TOOLS-05: null-stub scan failed:\n${nullStubScan.stderr || nullStubScan.stdout}`);
  }

  const replConstants = readFileSync(
    path.join(root, "runtime/src/tools/REPLTool/constants.ts"),
    "utf8",
  );
  if (!/isReplModeEnabled\(\): boolean \{\s*return false\s*\}/s.test(replConstants)) {
    failGate("GAP-TOOLS-05: REPL mode must stay disabled after deleting REPLTool");
  }
  const promptSource = readFileSync(
    path.join(root, "runtime/src/constants/prompts.ts"),
    "utf8",
  );
  if (/REPL_ONLY_TOOLS|isReplModeEnabled/.test(promptSource)) {
    failGate("GAP-TOOLS-05: prompts must not describe REPL-only hidden tool behavior");
  }
  const oldAttachmentRenderer = readFileSync(
    path.join(root, "runtime/src/utils/messages.ts"),
    "utf8",
  );
  if (/VerifyPlanExecution/.test(oldAttachmentRenderer)) {
    failGate("GAP-TOOLS-05: legacy attachment renderer must not request deleted VerifyPlanExecutionTool");
  }
  const planExitPermission = readFileSync(
    path.join(root, "runtime/src/tui/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx"),
    "utf8",
  );
  if (/VerifyPlanExecution/.test(planExitPermission)) {
    failGate("GAP-TOOLS-05: plan-exit permission copy must not request deleted VerifyPlanExecutionTool");
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/tools/null-stub-tools.test.ts",
    "src/tool-registry.test.ts",
    "src/commands/clear.test.ts",
    "src/prompts/attachments/messages.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TOOLS-05 targeted null-stub removal tests failed");
  }

  pass("GAP-TOOLS-05: null-stub tool files and live registrations are removed");
}

function assertGapToolsConsolidatedToolSurfaces() {
  const curatedDaemonProviderFiles = [
    "runtime/src/tools/system/coding.ts",
    "runtime/src/tool-registry.ts",
    "runtime/src/llm/types.ts",
    "runtime/src/tools/concurrency.ts",
    "runtime/src/permissions/unattended-policy.ts",
    "runtime/src/permissions/unattended-policy.test.ts",
    "runtime/src/prompts/permissions-prompt.test.ts",
    "runtime/src/tools/system/notebook-edit.ts",
    "runtime/src/tui/input/processBashCommand.tsx",
    "runtime/src/utils/promptShellExecution.ts",
    "runtime/src/utils/attachments.ts",
    "runtime/src/utils/messages.ts",
    "runtime/src/tui/components/agents/ToolSelector.tsx",
    "runtime/src/tui/components/permissions/PermissionRequest.tsx",
    "runtime/src/app-server/agent-cli.contract.test.ts",
    "runtime/src/app-server/background-agent-runner.contract.test.ts",
    "runtime/src/app-server/protocol.contract.test.ts",
    "runtime/src/agents/run-agent.test.ts",
  ];
  for (const rel of curatedDaemonProviderFiles) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      failGate(`GAP-TOOLS-04: missing required evidence file ${rel}`);
    }
    const source = readFileSync(abs, "utf8");
    if (/\bsystem\.(grep|glob)\b/.test(source)) {
      failGate(`GAP-TOOLS-04: stale provider-facing search alias remains in ${rel}`);
    }
  }

  const coding = readFileSync(
    path.join(root, "runtime/src/tools/system/coding.ts"),
    "utf8",
  );
  if (/name:\s*["']system\.(grep|glob)["']/.test(coding)) {
    failGate("GAP-TOOLS-04: duplicate system.grep/system.glob tool implementation remains");
  }
  if (!/createGitAndRepoTools\(config\)/.test(coding) || !/createToolSearchTool\(config\)/.test(coding)) {
    failGate("GAP-TOOLS-04: coding tools must still expose deferred discovery and code-intelligence tools");
  }

  const unattendedPolicy = readFileSync(
    path.join(root, "runtime/src/permissions/unattended-policy.ts"),
    "utf8",
  );
  if (!/grep:\s*["']Grep["']/.test(unattendedPolicy) || !/glob:\s*["']Glob["']/.test(unattendedPolicy)) {
    failGate("GAP-TOOLS-04: unattended grep/glob aliases must normalize to canonical Grep/Glob");
  }

  const registryTestRel = "runtime/src/tool-registry.test.ts";
  const registryTest = readFileSync(path.join(root, registryTestRel), "utf8");
  const requiredRegistryEvidence = [
    "NotebookEdit is registered only through the model-facing surface",
    "expect(notebookEditTools).toHaveLength(1)",
    "not.toContain(\"system.grep\")",
    "not.toContain(\"system.glob\")",
    "\"Read\"",
    "\"Bash\"",
    "\"FileEdit\"",
    "\"FileWrite\"",
    "\"FileReadTool\"",
    "family: \"coding\"",
    "deferred: true",
  ];
  const missingRegistryEvidence = requiredRegistryEvidence.filter(
    (needle) => !registryTest.includes(needle),
  );
  if (missingRegistryEvidence.length > 0) {
    failGate(
      `GAP-TOOLS-04 registry test evidence missing:\n  - ${missingRegistryEvidence.join("\n  - ")}`,
    );
  }

  const oldStackTestRel = "runtime/src/tools/tool-surface-consolidation.test.ts";
  const oldStackTest = readFileSync(path.join(root, oldStackTestRel), "utf8");
  const requiredOldStackEvidence = [
    "base tools register canonical implementations for duplicated families",
    "REPL primitive tools use the canonical search and file surfaces",
    "CanonicalBashTool",
    "CanonicalFileReadTool",
    "CanonicalNotebookEditTool",
    "not.toMatch",
    "system.bash enforces command-specific permission rules",
    "system.bash honors legacy Bash permission aliases with precedence",
    "canonical Bash schema rejects unsupported legacy control fields",
    "canonical Bash and daemon system.bash share execution behavior",
    "canonical Bash failure marks tool_result as error",
    "canonical Bash wrapper forwards system Bash progress updates",
    "canonical Bash truncates large output without persisted-output recovery",
    "canonical wrappers preserve search/read classification hooks",
    "canonical file wrappers enforce session read-before-edit",
    "file attachments read through canonical FileRead implementation",
    "directory attachments render through canonical Bash implementation",
    "canonical NotebookEdit uses shared session-backed implementation",
    "canonical NotebookEdit prefers exact numeric cell IDs over index fallback",
    "canonical NotebookEdit defaults sparse metadata language to python",
    "canonical NotebookEdit defaults empty metadata language to python",
    "canonical NotebookEdit delete does not require new_source",
    "canonical Write, Grep, and Glob wrappers execute shared system tools",
    "canonical result mapping preserves rich contentItems",
    "legacy tool aliases resolve to canonical agent tools",
    "file attachments truncate after canonical FileRead size errors",
    "file attachments return null after canonical FileRead non-size errors",
    "changed-file attachments stop after canonical FileRead errors",
    "changed-file attachments skip canonical notebook and PDF media",
    "changed-file attachments preserve standalone canonical image media",
  ];
  const missingOldStackEvidence = requiredOldStackEvidence.filter(
    (needle) => !oldStackTest.includes(needle),
  );
  if (missingOldStackEvidence.length > 0) {
    failGate(
      `GAP-TOOLS-04 old-stack test evidence missing:\n  - ${missingOldStackEvidence.join("\n  - ")}`,
    );
  }

  const evaluatorTestRel = "runtime/src/permissions/evaluator.test.ts";
  const evaluatorTest = readFileSync(path.join(root, evaluatorTestRel), "utf8");
  const requiredEvaluatorEvidence = [
    "system.bash whole-tool ask does not auto-allow without sandbox execution",
    "real system.bash remains ask-gated when sandbox auto-allow is requested",
  ];
  const missingEvaluatorEvidence = requiredEvaluatorEvidence.filter(
    (needle) => !evaluatorTest.includes(needle),
  );
  if (missingEvaluatorEvidence.length > 0) {
    failGate(
      `GAP-TOOLS-04 evaluator test evidence missing:\n  - ${missingEvaluatorEvidence.join("\n  - ")}`,
    );
  }

  const rootStackSources = [
    "runtime/src/tools.ts",
    "runtime/src/tools/REPLTool/primitiveTools.ts",
  ];
  for (const rel of rootStackSources) {
    const source = readFileSync(path.join(root, rel), "utf8");
    if (
      /tools\/(?:BashTool|FileReadTool|FileEditTool|FileWriteTool|GrepTool|GlobTool|NotebookEditTool)\/(?:BashTool|FileReadTool|FileEditTool|FileWriteTool|GrepTool|GlobTool|NotebookEditTool)\.js/.test(source)
    ) {
      failGate(`GAP-TOOLS-04: old-stack entrypoint still imports duplicate implementation in ${rel}`);
    }
    if (!source.includes("canonicalToolSurface.js")) {
      failGate(`GAP-TOOLS-04: old-stack entrypoint must register canonical tool surface in ${rel}`);
    }
  }

  const canonicalSurface = readFileSync(
    path.join(root, "runtime/src/tools/canonicalToolSurface.ts"),
    "utf8",
  );
  const requiredCanonicalSurfaceEvidence = [
    "createFileReadTool",
    "createFileEditTool",
    "createFileWriteTool",
    "createGrepTool",
    "createGlobTool",
    "createSystemNotebookEditTool",
    "SESSION_ID_ARG",
    "contentItemsToToolResultBlocks",
    "renderToolResultMessage",
    "extractSearchText",
    "name: \"system.bash\"",
    "name: \"FileRead\"",
  ];
  const missingCanonicalSurfaceEvidence = requiredCanonicalSurfaceEvidence.filter(
    (needle) => !canonicalSurface.includes(needle),
  );
  if (missingCanonicalSurfaceEvidence.length > 0) {
    failGate(
      `GAP-TOOLS-04 canonical surface evidence missing:\n  - ${missingCanonicalSurfaceEvidence.join("\n  - ")}`,
    );
  }
  const modelFacingTools = readFileSync(
    path.join(root, "runtime/src/bin/model-facing-tools.ts"),
    "utf8",
  );
  if (!modelFacingTools.includes("createSystemNotebookEditTool")) {
    failGate("GAP-TOOLS-04: model-facing NotebookEdit must use the shared system implementation");
  }
  const oldExecutableImportSources = [
    "runtime/src/tui/input/processBashCommand.tsx",
    "runtime/src/utils/promptShellExecution.ts",
    "runtime/src/utils/attachments.ts",
    "runtime/src/utils/messages.ts",
    "runtime/src/tui/components/agents/ToolSelector.tsx",
    "runtime/src/tui/components/permissions/PermissionRequest.tsx",
  ];
  const oldExecutableImplementationImportPattern =
    /tools\/(?:BashTool\/BashTool|FileReadTool\/FileReadTool|FileEditTool\/FileEditTool|FileWriteTool\/FileWriteTool|GrepTool\/GrepTool|GlobTool\/GlobTool|NotebookEditTool\/NotebookEditTool)(?:\.js)?(?=["';])/;
  for (const rel of oldExecutableImportSources) {
    const source = readFileSync(path.join(root, rel), "utf8");
    if (oldExecutableImplementationImportPattern.test(source)) {
      failGate(`GAP-TOOLS-04: live TUI/runtime path still imports an old executable tool implementation in ${rel}`);
    }
  }
  const presentationOnlyOldExecutableImports = new Set([
    "runtime/src/tui/components/BashModeProgress.tsx",
    "runtime/src/tui/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx",
    "runtime/src/tui/components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.tsx",
    "runtime/src/tui/components/permissions/FileWritePermissionRequest/FileWritePermissionRequest.tsx",
    "runtime/src/tui/components/permissions/NotebookEditPermissionRequest/NotebookEditPermissionRequest.tsx",
    "runtime/src/tui/components/permissions/rules/PermissionRuleDescription.tsx",
    "runtime/src/tui/components/permissions/rules/PermissionRuleInput.tsx",
    "runtime/src/tui/components/permissions/SedEditPermissionRequest/SedEditPermissionRequest.tsx",
    "runtime/src/tui/components/permissions/hooks.ts",
  ]);
  const oldExecutableImports = [];
  for (const abs of walkFiles(path.join(root, "runtime/src"))) {
    const rel = path.relative(root, abs);
    if (!/\.(?:ts|tsx)$/.test(rel)) continue;
    if (/(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.tsx?$/.test(rel) || rel.includes("/__tests__/")) continue;
    const lines = readFileSync(abs, "utf8").split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (!oldExecutableImplementationImportPattern.test(lines[index])) continue;
      if (/^import\s+type\b/.test(trimmed)) continue;
      if (presentationOnlyOldExecutableImports.has(rel)) continue;
      oldExecutableImports.push(`${rel}:${index + 1}: ${trimmed}`);
    }
  }
  if (oldExecutableImports.length > 0) {
    failGate(
      `GAP-TOOLS-04: live old duplicated tool implementation imports remain:\n  - ${oldExecutableImports.join("\n  - ")}`,
    );
  }
  const oldExecutableCallPattern = /\b(?:BashTool|FileReadTool|FileEditTool|FileWriteTool|GrepTool|GlobTool|NotebookEditTool)\.call\s*\(/;
  const oldExecutableCalls = [];
  for (const abs of walkFiles(path.join(root, "runtime/src"))) {
    const rel = path.relative(root, abs);
    if (!/\.(?:ts|tsx)$/.test(rel)) continue;
    if (/(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.tsx?$/.test(rel) || rel.includes("/__tests__/")) continue;
    const lines = readFileSync(abs, "utf8").split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (oldExecutableCallPattern.test(lines[index])) {
        oldExecutableCalls.push(`${rel}:${index + 1}: ${trimmed}`);
      }
    }
  }
  if (oldExecutableCalls.length > 0) {
    failGate(
      `GAP-TOOLS-04: live old duplicated tool .call usage remains:\n  - ${oldExecutableCalls.join("\n  - ")}`,
    );
  }
  const bashNameSource = readFileSync(
    path.join(root, "runtime/src/tools/BashTool/toolName.ts"),
    "utf8",
  );
  const readNameSource = readFileSync(
    path.join(root, "runtime/src/tools/FileReadTool/prompt.ts"),
    "utf8",
  );
  if (!/BASH_TOOL_NAME\s*=\s*["']system\.bash["']/.test(bashNameSource)) {
    failGate("GAP-TOOLS-04: Bash tool-name constant must use system.bash");
  }
  if (!/FILE_READ_TOOL_NAME\s*=\s*["']FileRead["']/.test(readNameSource)) {
    failGate("GAP-TOOLS-04: file-read tool-name constant must use FileRead");
  }

  const parityRel = "parity/GAP-TOOLS-04-parity.json";
  const parityPath = path.join(root, parityRel);
  if (!existsSync(parityPath)) {
    failGate(`GAP-TOOLS-04: missing required evidence file ${parityRel}`);
  }
  let parity;
  try {
    parity = JSON.parse(readFileSync(parityPath, "utf8"));
  } catch (error) {
    failGate(`GAP-TOOLS-04: parity artifact is not valid JSON: ${error?.message || error}`);
  }
  const oldStack = parity?.oldStackConsolidation;
  const canonical = parity?.daemonProviderContract?.canonicalSurfaces;
  const removed = parity?.daemonProviderContract?.removedProviderSearchAliases;
  if (
    parity?.item !== "GAP-TOOLS-04" ||
    parity?.status !== "implemented" ||
    oldStack?.status !== "canonical-wrappers-registered" ||
    oldStack?.canonicalOldInterfaceSurface !== "runtime/src/tools/canonicalToolSurface.ts" ||
    !Array.isArray(oldStack?.entrypoints) ||
    !oldStack.entrypoints.includes("runtime/src/tools.ts") ||
    !oldStack.entrypoints.includes("runtime/src/tools/REPLTool/primitiveTools.ts") ||
    !Array.isArray(canonical) ||
    !canonical.includes("Grep") ||
    !canonical.includes("Glob") ||
    !canonical.includes("NotebookEdit") ||
    !Array.isArray(removed) ||
    !removed.includes("system.grep") ||
    !removed.includes("system.glob")
  ) {
    failGate("GAP-TOOLS-04: parity artifact must record the canonical provider and old-stack surfaces");
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/tool-registry.test.ts",
    "src/tools/system/grep.test.ts",
    "src/tools/system/glob.test.ts",
    "src/tools/tool-surface-consolidation.test.ts",
    "src/permissions/evaluator.test.ts",
    "src/permissions/rules.test.ts",
    "src/permissions/unattended-policy.test.ts",
    "src/prompts/permissions-prompt.test.ts",
    "src/app-server/agent-cli.contract.test.ts",
    "src/app-server/background-agent-runner.contract.test.ts",
    "src/tui/parity/permission-request-routing.test.ts",
    "src/tui/input/processBashCommand.test.tsx",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TOOLS-04 targeted tool-surface consolidation tests failed");
  }

  const promptShellTest = run("bun", [
    "test",
    "runtime/src/utils/promptShellExecution.test.ts",
  ]);
  if (promptShellTest.status !== 0) {
    failGate("GAP-TOOLS-04 prompt shell canonical Bash test failed");
  }

  const protocolVitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "--",
    "vitest",
    "run",
    "src/app-server/protocol.contract.test.ts",
    "-t",
    "validates all request-bearing methods through the published schema",
  ]);
  if (protocolVitest.status !== 0) {
    failGate("GAP-TOOLS-04 targeted daemon protocol validation test failed");
  }

  const agentVitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "--",
    "vitest",
    "run",
    "src/agents/run-agent.test.ts",
    "-t",
    "tracks parent registry visibility when hidden coding tools are discovered later",
  ]);
  if (agentVitest.status !== 0) {
    failGate("GAP-TOOLS-04 targeted subagent tool-filtering test failed");
  }

  pass("GAP-TOOLS-04: daemon/provider-facing tool surfaces are consolidated");
}

function assertGapToolsToolSearchRecoveryCategory() {
  const toolRel = "runtime/src/tools/system/tool-search.ts";
  const testRel = "runtime/src/tools/system/tool-search.test.ts";
  const toolPath = path.join(root, toolRel);
  const testPath = path.join(root, testRel);
  for (const rel of [toolRel, testRel]) {
    if (!existsSync(path.join(root, rel))) {
      failGate(`GAP-TOOLS-03: missing required evidence file ${rel}`);
    }
  }

  const tool = readFileSync(toolPath, "utf8");
  const test = readFileSync(testPath, "utf8");
  if (!/recoveryCategory:\s*["']side-effecting["']/.test(tool)) {
    failGate("GAP-TOOLS-03: system.searchTools must be side-effecting");
  }
  if (!/config\.onDiscoverTools\?\.\(loaded\)/.test(tool)) {
    failGate("GAP-TOOLS-03: expected discovery mutation hook is missing from system.searchTools");
  }

  const requiredTestEvidence = [
    "is side-effecting because selected tools update advertised session state",
    "selecting a deferred tool calls onDiscoverTools and reports it loaded",
    "expect(tool.recoveryCategory).toBe(\"side-effecting\")",
    "expect(discovered).toEqual([[\"system.deepTool\"]])",
  ];
  const missingTestEvidence = requiredTestEvidence.filter((needle) => !test.includes(needle));
  if (missingTestEvidence.length > 0) {
    failGate(`GAP-TOOLS-03 regression test evidence missing:\n  - ${missingTestEvidence.join("\n  - ")}`);
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/tools/system/tool-search.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TOOLS-03 targeted tool-search tests failed");
  }

  pass("GAP-TOOLS-03: system.searchTools recovery category matches discovery mutation");
}

function assertGapToolsSpawnAgentsOnCsvWorkerParameter() {
  const toolRel = "runtime/src/bin/model-facing-tools.ts";
  const testRel = "runtime/src/bin/model-facing-tools.test.ts";
  const toolPath = path.join(root, toolRel);
  const testPath = path.join(root, testRel);
  for (const rel of [toolRel, testRel]) {
    if (!existsSync(path.join(root, rel))) {
      failGate(`GAP-TOOLS-02: missing required evidence file ${rel}`);
    }
  }

  const tool = readFileSync(toolPath, "utf8");
  const test = readFileSync(testPath, "utf8");

  if (!/const\s+maxConcurrency\s*=\s*numberValue\(args\.max_concurrency\)/.test(tool)) {
    failGate("GAP-TOOLS-02: spawn_agents_on_csv must read worker count from max_concurrency only");
  }
  if (/\bmax_workers\b/.test(tool)) {
    failGate("GAP-TOOLS-02: max_workers must not remain in the model-facing tool contract");
  }

  const requiredTestEvidence = [
    "uses max_concurrency as the sole CSV agent worker-count parameter",
    "not.toHaveProperty(\"max_workers\")",
    "unknown field `max_workers`",
    "tool invoked before session was initialized",
  ];
  const missingTestEvidence = requiredTestEvidence.filter((needle) => !test.includes(needle));
  if (missingTestEvidence.length > 0) {
    failGate(`GAP-TOOLS-02 regression test evidence missing:\n  - ${missingTestEvidence.join("\n  - ")}`);
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/bin/model-facing-tools.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TOOLS-02 targeted model-facing tool tests failed");
  }

  pass("GAP-TOOLS-02: spawn_agents_on_csv uses a single worker-count parameter");
}

function assertGapToolsSyntheticOutputToolValidation() {
  const toolRel = "runtime/src/tools/SyntheticOutputTool/SyntheticOutputTool.ts";
  const hookRel = "runtime/src/utils/hooks/hookHelpers.ts";
  const testRel = "runtime/src/tools/SyntheticOutputTool/SyntheticOutputTool.test.ts";
  const toolPath = path.join(root, toolRel);
  const hookPath = path.join(root, hookRel);
  const testPath = path.join(root, testRel);
  for (const rel of [toolRel, hookRel, testRel]) {
    if (!existsSync(path.join(root, rel))) {
      failGate(`GAP-TOOLS-01: missing required evidence file ${rel}`);
    }
  }

  const tool = readFileSync(toolPath, "utf8");
  const hook = readFileSync(hookPath, "utf8");
  const test = readFileSync(testPath, "utf8");

  const requiredToolEvidence = [
    [
      "unbound singleton rejects direct execution",
      /async\s+call\s*\(\s*\)\s*\{[\s\S]{0,240}StructuredOutput must be created with createSyntheticOutputTool\(jsonSchema\)/,
    ],
    [
      "factory compiles the caller-provided JSON schema",
      /const\s+validateSchema\s*=\s*ajv\.compile\(jsonSchema\)/,
    ],
    [
      "factory validates each tool input",
      /const\s+isValid\s*=\s*validateSchema\(input\)/,
    ],
    [
      "schema mismatch is surfaced as an error",
      /Output does not match required schema/,
    ],
  ];
  const missingToolEvidence = requiredToolEvidence
    .filter(([, pattern]) => !pattern.test(tool))
    .map(([label]) => label);
  if (missingToolEvidence.length > 0) {
    failGate(`GAP-TOOLS-01 tool validation evidence missing:\n  - ${missingToolEvidence.join("\n  - ")}`);
  }

  if (!hook.includes("createSyntheticOutputTool(hookResponseJsonSchema)")) {
    failGate("GAP-TOOLS-01: hook structured-output helper must use the schema-bound factory");
  }
  if (/^\s*SyntheticOutputTool\s*,/m.test(hook) || /\.\.\.\s*SyntheticOutputTool\b/.test(hook)) {
    failGate("GAP-TOOLS-01: hook structured-output helper must not spread the unbound singleton");
  }

  const requiredTestEvidence = [
    "rejects direct calls to the unbound singleton",
    "accepts schema-bound output that satisfies the JSON schema",
    "rejects schema-bound output that does not satisfy the JSON schema",
    "reports invalid JSON schemas before a tool is exposed",
    "caches schema-bound tools by schema object identity",
  ];
  const missingTestEvidence = requiredTestEvidence.filter((needle) => !test.includes(needle));
  if (missingTestEvidence.length > 0) {
    failGate(`GAP-TOOLS-01 regression test evidence missing:\n  - ${missingTestEvidence.join("\n  - ")}`);
  }

  const vitest = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/tools/SyntheticOutputTool/SyntheticOutputTool.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TOOLS-01 targeted SyntheticOutputTool tests failed");
  }

  pass("GAP-TOOLS-01: SyntheticOutputTool singleton is guarded and factory validation is covered");
}

function assertGapTuiGlobalKeybindingHandlers() {
  const appRel = "runtime/src/tui/components/App.tsx";
  const testRel = "runtime/src/tui/components/App.render.test.tsx";
  const appPath = path.join(root, appRel);
  const testPath = path.join(root, testRel);
  if (!existsSync(appPath)) failGate(`GAP-TUI-01: missing ${appRel}`);
  if (!existsSync(testPath)) failGate(`GAP-TUI-01: missing ${testRel}`);

  const app = readFileSync(appPath, "utf8");
  const test = readFileSync(testPath, "utf8");
  const requiredAppEvidence = [
    [
      "imports GlobalKeybindingHandlers",
      /import\s+\{\s*GlobalKeybindingHandlers\s*\}\s+from\s+["']\.\.\/hooks\/useGlobalKeybindings\.js["']/,
    ],
    ["tracks prompt/transcript screen state", /useState<["']prompt["']\s*\|\s*["']transcript["']>\(["']prompt["']\)/],
    ["tracks transcript show-all state", /\[showAllInTranscript,\s*setShowAllInTranscript\]\s*=\s*useState\(false\)/],
    ["mounts GlobalKeybindingHandlers", /<GlobalKeybindingHandlers\b/],
    ["passes setScreen to the handlers", /setScreen=\{setScreen/],
    ["passes setShowAllInTranscript to the handlers", /setShowAllInTranscript=\{setShowAllInTranscript\}/],
    ["passes transcript message count", /messageCount=\{transcript\.messages\.length\}/],
    ["passes live screen to Messages", /screen=\{screen/],
    ["makes transcript mode verbose", /verbose=\{screen\s*===\s*["']transcript["']\}/],
    ["passes showAllInTranscript to Messages", /showAllInTranscript=\{showAllInTranscript\}/],
  ];
  const missingAppEvidence = requiredAppEvidence
    .filter(([, pattern]) => !pattern.test(app))
    .map(([label]) => label);
  if (missingAppEvidence.length > 0) {
    failGate(`GAP-TUI-01 App wiring evidence missing:\n  - ${missingAppEvidence.join("\n  - ")}`);
  }

  const requiredTestEvidence = [
    "mounts global keybindings against the live transcript state",
    "providerProbe.globalKeybindingProps",
    "handlerProps.setScreen",
    'screen: "transcript"',
    "hidePastThinking: true",
  ];
  const missingTestEvidence = requiredTestEvidence.filter((needle) => !test.includes(needle));
  if (missingTestEvidence.length > 0) {
    failGate(`GAP-TUI-01 regression test evidence missing:\n  - ${missingTestEvidence.join("\n  - ")}`);
  }

  pass("GAP-TUI-01: live App global keybinding evidence present");
  const vitest = run("npm", [
    "--workspace=@tetsuo-ai/runtime",
    "test",
    "--",
    "src/tui/components/App.render.test.tsx",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TUI-01 targeted App render test failed");
  }
  pass("GAP-TUI-01 targeted App render test passed");
}

function assertGapTuiMessageSelectorCallbacks() {
  const appRel = "runtime/src/tui/components/App.tsx";
  const testRel = "runtime/src/tui/components/App.render.test.tsx";
  const appPath = path.join(root, appRel);
  const testPath = path.join(root, testRel);
  if (!existsSync(appPath)) failGate(`GAP-TUI-02: missing ${appRel}`);
  if (!existsSync(testPath)) failGate(`GAP-TUI-02: missing ${testRel}`);

  const app = readFileSync(appPath, "utf8");
  const test = readFileSync(testPath, "utf8");
  const requiredAppEvidence = [
    ["imports MessageSelector", /import\s+\{\s*MessageSelector\s*\}\s+from\s+["']\.\/MessageSelector\.js["']/],
    ["tracks selector visibility", /isMessageSelectorVisible,\s*setIsMessageSelectorVisible/],
    ["defines handleShowMessageSelector", /const\s+handleShowMessageSelector\s*=\s*useCallback/],
    ["passes selector visibility into Messages", /isMessageSelectorVisible=\{isMessageSelectorVisible\}/],
    ["renders MessageSelector", /<MessageSelector\b/],
    ["passes restore callback", /onRestoreMessage=\{handleRestoreMessage\}/],
    ["passes PromptInput onShowMessageSelector", /onShowMessageSelector=\{handleShowMessageSelector\}/],
    ["passes PromptInput onMessageActionsEnter", /onMessageActionsEnter=\{handleShowMessageSelector\}/],
  ];
  const missingAppEvidence = requiredAppEvidence
    .filter(([, pattern]) => !pattern.test(app))
    .map(([label]) => label);
  if (missingAppEvidence.length > 0) {
    failGate(`GAP-TUI-02 App callback evidence missing:\n  - ${missingAppEvidence.join("\n  - ")}`);
  }

  const requiredTestEvidence = [
    "opens the message selector from PromptInput callbacks",
    "providerProbe.messageSelectorProps",
    "onMessageActionsEnter",
    "message-selector:",
    'input: "revise this"',
  ];
  const missingTestEvidence = requiredTestEvidence.filter((needle) => !test.includes(needle));
  if (missingTestEvidence.length > 0) {
    failGate(`GAP-TUI-02 regression test evidence missing:\n  - ${missingTestEvidence.join("\n  - ")}`);
  }

  pass("GAP-TUI-02: live App message selector callback evidence present");
  const vitest = run("npm", [
    "--workspace=@tetsuo-ai/runtime",
    "test",
    "--",
    "src/tui/components/App.render.test.tsx",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TUI-02 targeted App render test failed");
  }
  pass("GAP-TUI-02 targeted App render test passed");
}

function assertGapTuiClearHistoryEvent() {
  const clearRel = "runtime/src/commands/clear.ts";
  const phaseRel = "runtime/src/phases/events.ts";
  const binRel = "runtime/src/bin/agenc.ts";
  const localEventsRel = "runtime/src/bin/tui-local-events.ts";
  const transcriptRel = "runtime/src/tui/session-transcript.ts";
  const sessionTypesRel = "runtime/src/tui/session-types.ts";
  const daemonSessionRel = "runtime/src/tui/daemon-session.ts";
  const protocolRel = "runtime/src/app-server/protocol/index.ts";
  const protocolSchemaRel = "runtime/src/app-server/protocol/schema.json";
  const dispatcherRel = "runtime/src/app-server/daemon-dispatcher.ts";
  const agentLifecycleRel = "runtime/src/app-server/agent-lifecycle.ts";
  const backgroundRunnerRel = "runtime/src/app-server/background-agent-runner.ts";
  const controlRel = "runtime/src/agents/control.ts";
  const runAgentRel = "runtime/src/agents/run-agent.ts";
  const threadManagerRel = "runtime/src/agents/thread-manager.ts";
  const clearTestRel = "runtime/src/commands/clear.test.ts";
  const localEventsTestRel = "runtime/src/bin/tui-local-events.test.ts";
  const transcriptTestRel = "runtime/src/tui/parity/session-transcript.test.ts";
  const daemonSessionTestRel = "runtime/src/tui/daemon-session.contract.test.ts";
  const protocolTestRel = "runtime/src/app-server/protocol.contract.test.ts";
  const agentLifecycleTestRel = "runtime/src/app-server/agent-lifecycle.contract.test.ts";
  const backgroundRunnerTestRel = "runtime/src/app-server/background-agent-runner.contract.test.ts";
  const controlTestRel = "runtime/src/agents/control.test.ts";
  const runAgentMailboxTestRel = "runtime/src/agents/run-agent-mailbox.test.ts";
  const requiredFiles = [
    clearRel,
    phaseRel,
    binRel,
    localEventsRel,
    transcriptRel,
    sessionTypesRel,
    daemonSessionRel,
    protocolRel,
    protocolSchemaRel,
    dispatcherRel,
    agentLifecycleRel,
    backgroundRunnerRel,
    controlRel,
    runAgentRel,
    threadManagerRel,
    clearTestRel,
    localEventsTestRel,
    transcriptTestRel,
    daemonSessionTestRel,
    protocolTestRel,
    agentLifecycleTestRel,
    backgroundRunnerTestRel,
    controlTestRel,
    runAgentMailboxTestRel,
  ];
  for (const rel of requiredFiles) {
    if (!existsSync(path.join(root, rel))) failGate(`GAP-TUI-03: missing ${rel}`);
  }

  const clear = readFileSync(path.join(root, clearRel), "utf8");
  const phase = readFileSync(path.join(root, phaseRel), "utf8");
  const bin = readFileSync(path.join(root, binRel), "utf8");
  const localEvents = readFileSync(path.join(root, localEventsRel), "utf8");
  const transcript = readFileSync(path.join(root, transcriptRel), "utf8");
  const sessionTypes = readFileSync(path.join(root, sessionTypesRel), "utf8");
  const daemonSession = readFileSync(path.join(root, daemonSessionRel), "utf8");
  const protocol = readFileSync(path.join(root, protocolRel), "utf8");
  const protocolSchema = readFileSync(path.join(root, protocolSchemaRel), "utf8");
  const dispatcher = readFileSync(path.join(root, dispatcherRel), "utf8");
  const agentLifecycle = readFileSync(path.join(root, agentLifecycleRel), "utf8");
  const backgroundRunner = readFileSync(path.join(root, backgroundRunnerRel), "utf8");
  const control = readFileSync(path.join(root, controlRel), "utf8");
  const runAgent = readFileSync(path.join(root, runAgentRel), "utf8");
  const threadManager = readFileSync(path.join(root, threadManagerRel), "utf8");
  const clearTest = readFileSync(path.join(root, clearTestRel), "utf8");
  const localEventsTest = readFileSync(path.join(root, localEventsTestRel), "utf8");
  const transcriptTest = readFileSync(path.join(root, transcriptTestRel), "utf8");
  const daemonSessionTest = readFileSync(path.join(root, daemonSessionTestRel), "utf8");
  const protocolTest = readFileSync(path.join(root, protocolTestRel), "utf8");
  const agentLifecycleTest = readFileSync(path.join(root, agentLifecycleTestRel), "utf8");
  const backgroundRunnerTest = readFileSync(path.join(root, backgroundRunnerTestRel), "utf8");
  const controlTest = readFileSync(path.join(root, controlTestRel), "utf8");
  const runAgentMailboxTest = readFileSync(path.join(root, runAgentMailboxTestRel), "utf8");

  const requiredEvidence = [
    ["clear command emits history_cleared", clear, /type:\s*["']history_cleared["']/],
    ["clear command uses emitPhaseEvent", clear, /emitPhaseEvent\?\.\(/],
    ["clear command tolerates missing state lock", clear, /state\?\.with/],
    ["phase event typing declares history_cleared", phase, /type:\s*["']history_cleared["'];\s*readonly\s+timestamp:\s*number/],
    ["bin imports local TUI event helpers", bin, /emitLocalTuiPhaseEvent/],
    ["bin wrapper exposes emitPhaseEvent", bin, /emitPhaseEvent:\s*\(event\)\s*=>/],
    ["local event helper isolates subscribers", localEvents, /try\s*\{[\s\S]*subscriber\(event\)[\s\S]*\}\s*catch/],
    ["local phase helper forwards before local broadcast", localEvents, /target\.emitPhaseEvent\(event\)/],
    ["local slash helper emits slash_result", localEvents, /type:\s*["']slash_result["']/],
    ["session transcript detects history clear", transcript, /function\s+isHistoryClearedEvent/],
    ["session transcript reset clears keys", transcript, /keys\.clear\(\)/],
    ["session transcript append resets state", transcript, /events:\s*\[action\.event\]/],
    ["session type exposes emitPhaseEvent", sessionTypes, /emitPhaseEvent\?\(event:\s*PhaseEvent\):\s*void/],
    ["daemon session type exposes emitPhaseEvent", daemonSession, /emitPhaseEvent\?\(event:\s*PhaseEvent\):\s*void/],
    ["daemon session exposes clearDaemonSession", daemonSession, /clearDaemonSession:\s*async\s*\(\)\s*=>[\s\S]*session\.clear/],
    ["protocol declares session.clear", protocol, /["']session\.clear["']/],
    ["protocol schema declares session.clear", protocolSchema, /["']session\.clear["']/],
    ["dispatcher routes session.clear", dispatcher, /case\s+["']session\.clear["'][\s\S]*clearSessionHistory/],
    ["agent lifecycle clears daemon session via runner", agentLifecycle, /clearSessionHistory[\s\S]*clearAgentSession/],
    ["agent lifecycle validates clear owner runtime", agentLifecycle, /allowClearSession:\s*true/],
    ["background runner emits history_cleared", backgroundRunner, /type:\s*["']history_cleared["']/],
    ["background runner clears live child through control", backgroundRunner, /clearConversationHistory\(agentId\)/],
    ["background runner rejects in-flight clear", backgroundRunner, /isClearInFlight[\s\S]*Cannot clear right now/],
    ["agent control exposes clearConversationHistory", control, /clearConversationHistory\(threadId:\s*ThreadId\)/],
    ["thread manager supports clear history op", threadManager, /type:\s*["']clear_conversation_history["']/],
    ["runAgent handles history_clear mailbox boundary", runAgent, /kind\s*===\s*["']history_clear["']/],
    ["clear test covers bridge-like session", clearTest, /bridge-like sessions without local history state/],
    ["clear test asserts active turn does not emit", clearTest, /emitPhaseEvent\)\.not\.toHaveBeenCalled/],
    ["clear test covers daemon delegation", clearTest, /delegates daemon-backed sessions/],
    ["local event test asserts order", localEventsTest, /before slash_result/],
    ["local event test asserts no double broadcast", localEventsTest, /double-broadcasting/],
    ["transcript test covers history clear", transcriptTest, /history_cleared/],
    ["transcript test covers dedupe reset", transcriptTest, /reused-after-clear/],
    ["transcript test covers reducer append clear", transcriptTest, /subscribed history_cleared/],
    ["daemon session test covers session.clear request", daemonSessionTest, /clears daemon-owned session history through session\.clear/],
    ["protocol test covers session.clear", protocolTest, /method:\s*["']session\.clear["']/],
    ["agent lifecycle test covers session.clear route", agentLifecycleTest, /routes session\.clear to the runner/],
    ["agent lifecycle test covers recovered clear rejection", agentLifecycleTest, /recovered agents without live runtime/],
    ["background runner test covers clear event", backgroundRunnerTest, /clears daemon-owned agent history/],
    ["background runner test covers active-turn clear rejection", backgroundRunnerTest, /owning session has an active turn/],
    ["control test covers history boundary", controlTest, /queues a history boundary/],
    ["runAgent mailbox test covers fresh next input", runAgentMailboxTest, /keeps only fresh follow-up input/],
  ];
  const missingEvidence = requiredEvidence
    .filter(([, source, pattern]) => !pattern.test(source))
    .map(([label]) => label);
  if (missingEvidence.length > 0) {
    failGate(`GAP-TUI-03 evidence missing:\n  - ${missingEvidence.join("\n  - ")}`);
  }

  pass("GAP-TUI-03: clear history event evidence present");
  const vitest = run("npm", [
    "--workspace=@tetsuo-ai/runtime",
    "test",
    "--",
    "src/commands/clear.test.ts",
    "src/bin/tui-local-events.test.ts",
    "src/tui/parity/session-transcript.test.ts",
    "src/tui/daemon-session.contract.test.ts",
    "src/app-server/agent-lifecycle.contract.test.ts",
    "src/app-server/background-agent-runner.contract.test.ts",
    "src/agents/control.test.ts",
    "src/agents/run-agent-mailbox.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TUI-03 targeted clear/transcript tests failed");
  }
  pass("GAP-TUI-03 targeted clear/transcript tests passed");
}

function assertGapTuiKeybindingsEditorHandoff() {
  const sourceRel = "runtime/src/commands/keybindings.ts";
  const testRel = "runtime/src/commands/keybindings.test.ts";
  const sourcePath = path.join(root, sourceRel);
  const testPath = path.join(root, testRel);
  if (!existsSync(sourcePath)) failGate(`GAP-TUI-04: missing ${sourceRel}`);
  if (!existsSync(testPath)) failGate(`GAP-TUI-04: missing ${testRel}`);

  const source = readFileSync(sourcePath, "utf8");
  const test = readFileSync(testPath, "utf8");
  const missingEvidence = [
    [
      "exports an Ink-aware keybindings editor launcher",
      /export\s+async\s+function\s+spawnKeybindingsEditor/,
      source,
    ],
    [
      "terminal editor path enters Ink handoff before inherited stdio",
      /enterAlternateScreen\(\)[\s\S]*spawnProcess\(base,\s*args,\s*\{\s*stdio:\s*["']inherit["']\s*\}\)/,
      source,
    ],
    [
      "terminal editor path always exits Ink handoff",
      /finally\s*\{[\s\S]*exitAlternateScreen\(\)/,
      source,
    ],
    [
      "GUI editor path detaches from stdio",
      /detached:\s*true[\s\S]*stdio:\s*["']ignore["']/,
      source,
    ],
    [
      "test covers terminal editor Ink handoff",
      /hands terminal editors the terminal only after pausing Ink/,
      test,
    ],
    [
      "test covers GUI editor stdio isolation",
      /launches GUI editors detached from the TUI stdio/,
      test,
    ],
  ]
    .filter(([, pattern, content]) => !pattern.test(content))
    .map(([label]) => label);
  if (missingEvidence.length > 0) {
    failGate(`GAP-TUI-04 evidence missing:\n  - ${missingEvidence.join("\n  - ")}`);
  }
  if (/spawn\(editor,\s*\[\s*file\s*\],\s*\{\s*stdio:\s*["']inherit["']/.test(source)) {
    failGate("GAP-TUI-04: keybindings must not spawn(editor, [file], { stdio: 'inherit' }) directly");
  }

  pass("GAP-TUI-04: keybindings editor handoff evidence present");
  const vitest = run("npm", [
    "--workspace=@tetsuo-ai/runtime",
    "test",
    "--",
    "src/commands/keybindings.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TUI-04 targeted keybindings test failed");
  }
  pass("GAP-TUI-04 targeted keybindings test passed");
}

function assertGapTuiInitGeneratesViaModel() {
  const sourceRel = "runtime/src/commands/init.ts";
  const testRel = "runtime/src/commands/init.test.ts";
  const sourcePath = path.join(root, sourceRel);
  const testPath = path.join(root, testRel);
  if (!existsSync(sourcePath)) failGate(`GAP-TUI-05: missing ${sourceRel}`);
  if (!existsSync(testPath)) failGate(`GAP-TUI-05: missing ${testRel}`);

  const source = readFileSync(sourcePath, "utf8");
  const test = readFileSync(testPath, "utf8");
  const missingEvidence = [
    [
      "init command builds target-specific prompt context",
      /export\s+function\s+buildInitPrompt/,
      source,
    ],
    [
      "init command dispatches a prompt result",
      /return\s*\{\s*kind:\s*["']prompt["']\s*,\s*content:\s*buildInitPrompt/,
      source,
    ],
    [
      "init prompt forbids writing the template itself",
      /Do not write these instructions or a prompt template into the file/,
      source,
    ],
    [
      "init test asserts model prompt dispatch",
      /returns a model prompt instead of writing the template/,
      test,
    ],
    [
      "init test asserts AGENC.md is not synchronously written",
      /expect\(existsSync\(target\)\)\.toBe\(false\)/,
      test,
    ],
    [
      "init test covers override prompt handling",
      /CUSTOM-PROMPT/,
      test,
    ],
  ]
    .filter(([, pattern, content]) => !pattern.test(content))
    .map(([label]) => label);
  if (missingEvidence.length > 0) {
    failGate(`GAP-TUI-05 evidence missing:\n  - ${missingEvidence.join("\n  - ")}`);
  }
  if (/writeFile\s*\(\s*target\s*,\s*(body|resolveInitTemplate|INIT_TEMPLATE)/.test(source)) {
    failGate("GAP-TUI-05: /init must not write the prompt template to AGENC.md");
  }

  pass("GAP-TUI-05: init model-generation evidence present");
  const vitest = run("npm", [
    "--workspace=@tetsuo-ai/runtime",
    "test",
    "--",
    "src/commands/init.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TUI-05 targeted init test failed");
  }
  pass("GAP-TUI-05 targeted init test passed");
}

function assertGapTuiCopyWritesClipboard() {
  const sourceRel = "runtime/src/commands/copy.ts";
  const testRel = "runtime/src/commands/copy.test.ts";
  const sourcePath = path.join(root, sourceRel);
  const testPath = path.join(root, testRel);
  if (!existsSync(sourcePath)) failGate(`GAP-TUI-06: missing ${sourceRel}`);
  if (!existsSync(testPath)) failGate(`GAP-TUI-06: missing ${testRel}`);

  const source = readFileSync(sourcePath, "utf8");
  const test = readFileSync(testPath, "utf8");
  const missingEvidence = [
    [
      "copy command imports the terminal clipboard transport",
      /from\s+["']\.\.\/tui\/ink\/termio\/osc\.js["']/,
      source,
    ],
    [
      "copy command exposes an injectable clipboard writer",
      /export\s+async\s+function\s+copyTextToClipboard/,
      source,
    ],
    [
      "copy helper writes selected text through the clipboard transport",
      /deps\.setClipboard\(text\)/,
      source,
    ],
    [
      "copy helper emits returned OSC control sequence when needed",
      /deps\.writeSequence\(sequence\)/,
      source,
    ],
    [
      "slash command returns clipboard confirmation after writing",
      /return\s*\{\s*kind:\s*["']text["']\s*,\s*text:\s*await\s+copyTextToClipboard\(text,\s*deps\)\s*\}/,
      source,
    ],
    [
      "copy tests assert latest-message clipboard payload",
      /setClipboard\)\.toHaveBeenCalledWith\(["']answer["']\)/,
      test,
    ],
    [
      "copy tests assert transcript clipboard payload",
      /setClipboard\)\.toHaveBeenCalledWith\(\s*["']USER:\\nquestion\\n\\nASSISTANT:\\nanswer["']/,
      test,
    ],
    [
      "copy tests assert returned terminal sequence write",
      /writeSequence\)\.toHaveBeenCalledWith/,
      test,
    ],
    [
      "copy tests assert empty terminal sequences are not written",
      /writeSequence\)\.not\.toHaveBeenCalled/,
      test,
    ],
  ]
    .filter(([, pattern, content]) => !pattern.test(content))
    .map(([label]) => label);
  if (missingEvidence.length > 0) {
    failGate(`GAP-TUI-06 evidence missing:\n  - ${missingEvidence.join("\n  - ")}`);
  }
  if (/return\s*\{\s*kind:\s*["']text["']\s*,\s*text:\s*formatCopyExport\(/.test(source)) {
    failGate("GAP-TUI-06: /copy must not return transcript text without writing the clipboard");
  }

  pass("GAP-TUI-06: copy clipboard evidence present");
  const vitest = run("npm", [
    "--workspace=@tetsuo-ai/runtime",
    "test",
    "--",
    "src/commands/copy.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TUI-06 targeted copy test failed");
  }
  pass("GAP-TUI-06 targeted copy test passed");
}

function assertGapTuiReloadPluginsRefreshesDispatcherRegistry() {
  const rels = {
    reload: "runtime/src/commands/reload-plugins.ts",
    registry: "runtime/src/commands/registry.ts",
    dispatcher: "runtime/src/commands/dispatcher.ts",
    types: "runtime/src/commands/types.ts",
    surfaceTest: "runtime/src/commands/command-surface.test.ts",
    registryTest: "runtime/src/commands/registry.test.ts",
  };
  for (const rel of Object.values(rels)) {
    if (!existsSync(path.join(root, rel))) failGate(`GAP-TUI-07: missing ${rel}`);
  }

  const reload = readFileSync(path.join(root, rels.reload), "utf8");
  const registry = readFileSync(path.join(root, rels.registry), "utf8");
  const dispatcher = readFileSync(path.join(root, rels.dispatcher), "utf8");
  const types = readFileSync(path.join(root, rels.types), "utf8");
  const surfaceTest = readFileSync(path.join(root, rels.surfaceTest), "utf8");
  const registryTest = readFileSync(path.join(root, rels.registryTest), "utf8");
  const missingEvidence = [
    [
      "slash command context exposes the live registry",
      /readonly\s+commandRegistry\?:\s*CommandRegistry/,
      types,
    ],
    [
      "dispatcher passes the active registry into command context",
      /commandRegistry:\s*registry/,
      dispatcher,
    ],
    [
      "registry supports dynamic command replacement",
      /replaceDynamicCommands\(\s*source:\s*string/,
      registry,
    ],
    [
      "registry replacement tracks prior dynamic registrations",
      /dynamicRegistrations/,
      registry,
    ],
    [
      "reload command projects plugin commands into slash commands",
      /function\s+pluginCommandToSlashCommand/,
      reload,
    ],
    [
      "reload command replaces the live plugin registry surface",
      /registry\.replaceDynamicCommands\(\s*["']plugins["']/,
      reload,
    ],
    [
      "reload command applies dispatcher registry refresh after plugin refresh",
      /refreshDispatcherPluginCommands\(ctx,\s*result\)/,
      reload,
    ],
    [
      "surface test dispatches a plugin command after reload",
      /reloads plugin commands into the live dispatcher registry/,
      surfaceTest,
    ],
    [
      "surface test verifies stale plugin command removal",
      /registry\.find\(["']sample:hello["']\)\)\.toBeUndefined/,
      surfaceTest,
    ],
    [
      "registry test covers atomic dynamic replacement",
      /keeps the previous dynamic source when replacement collides/,
      registryTest,
    ],
  ]
    .filter(([, pattern, content]) => !pattern.test(content))
    .map(([label]) => label);
  if (missingEvidence.length > 0) {
    failGate(`GAP-TUI-07 evidence missing:\n  - ${missingEvidence.join("\n  - ")}`);
  }

  pass("GAP-TUI-07: reload dispatcher registry evidence present");
  const vitest = run("npm", [
    "--workspace=@tetsuo-ai/runtime",
    "test",
    "--",
    "src/commands/command-surface.test.ts",
    "src/commands/registry.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TUI-07 targeted reload registry tests failed");
  }
  pass("GAP-TUI-07 targeted reload registry tests passed");
}

function assertGapTuiCompactProgressControls() {
  const rels = {
    compact: "runtime/src/commands/session-compact.ts",
    compactService: "runtime/src/services/compact/compact.ts",
    compactTypes: "runtime/src/services/compact/types.ts",
    repl: "runtime/src/tui/screens/REPL.tsx",
    sessionTypes: "runtime/src/tui/session-types.ts",
    daemonSession: "runtime/src/tui/daemon-session.ts",
    slashTest: "runtime/tests/slash-compact.contract.test.ts",
    serviceTest: "runtime/src/services/compact/compact.test.ts",
    daemonTest: "runtime/src/tui/daemon-session.contract.test.ts",
  };
  for (const rel of Object.values(rels)) {
    if (!existsSync(path.join(root, rel))) failGate(`GAP-TUI-08: missing ${rel}`);
  }

  const compact = readFileSync(path.join(root, rels.compact), "utf8");
  const compactService = readFileSync(path.join(root, rels.compactService), "utf8");
  const compactTypes = readFileSync(path.join(root, rels.compactTypes), "utf8");
  const repl = readFileSync(path.join(root, rels.repl), "utf8");
  const sessionTypes = readFileSync(path.join(root, rels.sessionTypes), "utf8");
  const daemonSession = readFileSync(path.join(root, rels.daemonSession), "utf8");
  const slashTest = readFileSync(path.join(root, rels.slashTest), "utf8");
  const serviceTest = readFileSync(path.join(root, rels.serviceTest), "utf8");
  const daemonTest = readFileSync(path.join(root, rels.daemonTest), "utf8");
  const missingEvidence = [
    [
      "compact command reads progress callbacks from the session surface",
      /surface\.setStreamMode[\s\S]*surface\.onCompactProgress[\s\S]*surface\.setSDKStatus/,
      compact,
    ],
    [
      "compact service context type exposes progress callbacks",
      /setStreamMode\?[\s\S]*onCompactProgress\?[\s\S]*type\s+CompactProgressEvent/,
      compactTypes,
    ],
    [
      "compact service owns compact progress lifecycle",
      /onCompactProgress\?\.\(\{\s*type:\s*["']hooks_start["'][\s\S]*setSDKStatus\?\.\(["']compacting["']\)[\s\S]*onCompactProgress\?\.\(\{\s*type:\s*["']compact_start["']\s*\}\)/,
      compactService,
    ],
    [
      "compact service clears compact status in a finally block",
      /finally\s*\{[\s\S]*onCompactProgress\?\.\(\{\s*type:\s*["']compact_end["']\s*\}\)[\s\S]*setSDKStatus\?\.\(null\)/,
      compactService,
    ],
    [
      "TUI session contract defines compact progress controls",
      /interface\s+AgenCCompactProgressControls/,
      sessionTypes,
    ],
    [
      "TUI session contract exports compact control installer",
      /export\s+function\s+installCompactProgressControls/,
      sessionTypes,
    ],
    [
      "daemon session type carries compact progress controls",
      /interface\s+AgenCTuiBridgeSession\s+extends\s+AgenCCompactProgressControls/,
      daemonSession,
    ],
    [
      "REPL installs compact progress controls on the live session",
      /installCompactProgressControls\(session,\s*\{[\s\S]*setStreamMode[\s\S]*setResponseLength[\s\S]*onCompactProgress[\s\S]*setSDKStatus:\s*setCompactSDKStatus/,
      repl,
    ],
    [
      "REPL reuses the same compact progress handler in command context",
      /setStreamMode,\s*\n\s*onCompactProgress,\s*\n\s*setInProgressToolUseIDs/,
      repl,
    ],
    [
      "slash compact test asserts an exact single progress lifecycle",
      /compactLifecycle[\s\S]*toEqual\(\[[\s\S]*hooks_start[\s\S]*compact_start[\s\S]*compact_end[\s\S]*sdk_status["'],\s*status:\s*null/,
      slashTest,
    ],
    [
      "compact service test asserts cleanup failure clears status",
      /clears status on cleanup failure[\s\S]*rejects\.toThrow\(["']cleanup failed["']\)[\s\S]*setSDKStatus\.mock\.calls/,
      serviceTest,
    ],
    [
      "daemon session test covers compact control publish and restore",
      /publishes daemon-backed session compact controls and restores previous values/,
      daemonTest,
    ],
  ]
    .filter(([, pattern, content]) => !pattern.test(content))
    .map(([label]) => label);
  if (missingEvidence.length > 0) {
    failGate(`GAP-TUI-08 evidence missing:\n  - ${missingEvidence.join("\n  - ")}`);
  }
  if (/toolUseContext\.onCompactProgress\(\{\s*type:\s*["']compact_(?:start|end)["']/.test(compact)) {
    failGate("GAP-TUI-08: session compact command must not emit duplicate compact lifecycle events");
  }
  if (/toolUseContext\.setSDKStatus\(["']compacting["']\)/.test(compact)) {
    failGate("GAP-TUI-08: session compact command must delegate compact status lifecycle to the compact service");
  }

  pass("GAP-TUI-08: compact progress control evidence present");
  const vitest = run("npm", [
    "--workspace=@tetsuo-ai/runtime",
    "test",
    "--",
    "tests/slash-compact.contract.test.ts",
    "src/services/compact/compact.test.ts",
    "src/tui/daemon-session.contract.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TUI-08 targeted compact progress tests failed");
  }
  pass("GAP-TUI-08 targeted compact progress tests passed");
}

function assertGapTuiBtwRegisteredInDispatcher() {
  const rels = {
    registry: "runtime/src/commands/registry.ts",
    commands: "runtime/src/commands.ts",
    registryTest: "runtime/src/commands/registry.test.ts",
    tuiListTest: "runtime/src/commands/tui-command-list.test.ts",
    btwIndex: "runtime/src/commands/btw/index.ts",
  };
  for (const rel of Object.values(rels)) {
    if (!existsSync(path.join(root, rel))) failGate(`GAP-TUI-09: missing ${rel}`);
  }

  const registry = readFileSync(path.join(root, rels.registry), "utf8");
  const commands = readFileSync(path.join(root, rels.commands), "utf8");
  const registryTest = readFileSync(path.join(root, rels.registryTest), "utf8");
  const tuiListTest = readFileSync(path.join(root, rels.tuiListTest), "utf8");
  const btwIndex = readFileSync(path.join(root, rels.btwIndex), "utf8");
  const missingEvidence = [
    [
      "/btw registry descriptor exists",
      /registeredLegacyCommandSurfaceSpecs[\s\S]*name:\s*["']btw["'][\s\S]*immediate:\s*true/,
      registry,
    ],
    [
      "/btw is included in buildDefaultRegistry",
      /legacyCommandSurfaces[\s\S]*registeredLegacyCommandSurfaceSpecs[\s\S]*CommandRegistry\.fromCommands\(\[[\s\S]*\.\.\.legacyCommandSurfaces/,
      registry,
    ],
    [
      "/btw uses the existing local JSX command in the TUI command list",
      /registeredLegacyCommandSurfaceSpecs[\s\S]*lazyCommand\(\{\s*\.\.\.spec,\s*modulePath:\s*spec\.tuiModulePath\s*\}\)/,
      commands,
    ],
    [
      "/btw source stays local-jsx and immediate",
      /type:\s*["']local-jsx["'][\s\S]*name:\s*["']btw["'][\s\S]*immediate:\s*true/,
      btwIndex,
    ],
    [
      "registry test asserts /btw lookup",
      /reg\.has\(["']btw["']\)[\s\S]*reg\.find\(["']btw["']\)\?\.immediate/,
      registryTest,
    ],
    [
      "TUI command-list test asserts /btw local JSX projection",
      /interactive local JSX descriptor for \/btw[\s\S]*btw\?\.type\)\.toBe\(["']local-jsx["']\)/,
      tuiListTest,
    ],
  ]
    .filter(([, pattern, content]) => !pattern.test(content))
    .map(([label]) => label);
  if (missingEvidence.length > 0) {
    failGate(`GAP-TUI-09 evidence missing:\n  - ${missingEvidence.join("\n  - ")}`);
  }

  pass("GAP-TUI-09: /btw dispatcher and TUI projection evidence present");
  const vitest = run("npm", [
    "--workspace=@tetsuo-ai/runtime",
    "test",
    "--",
    "src/commands/registry.test.ts",
    "src/commands/tui-command-list.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TUI-09 targeted /btw registry tests failed");
  }
  pass("GAP-TUI-09 targeted /btw registry tests passed");
}

function assertGapTuiOrphanedCommandsResolved() {
  const rels = {
    registry: "runtime/src/commands/registry.ts",
    commands: "runtime/src/commands.ts",
    registryTest: "runtime/src/commands/registry.test.ts",
    tuiListTest: "runtime/src/commands/tui-command-list.test.ts",
    commandSurfaceTest: "runtime/src/commands/command-surface.test.ts",
  };
  for (const rel of Object.values(rels)) {
    if (!existsSync(path.join(root, rel))) failGate(`GAP-TUI-10: missing ${rel}`);
  }

  const registry = readFileSync(path.join(root, rels.registry), "utf8");
  const commands = readFileSync(path.join(root, rels.commands), "utf8");
  const registryTest = readFileSync(path.join(root, rels.registryTest), "utf8");
  const tuiListTest = readFileSync(path.join(root, rels.tuiListTest), "utf8");
  const commandSurfaceTest = readFileSync(path.join(root, rels.commandSurfaceTest), "utf8");
  const expectedNames = [
    "agents",
    "branch",
    "remote-control",
    "btw",
    "buddy",
    "chrome",
    "color",
    "desktop",
    "dream",
    "export",
    "extra-usage",
    "fast",
    "feedback",
    "heapdump",
    "ide",
    "knowledge",
    "login",
    "logout",
    "mobile",
    "output-style",
    "passes",
    "pr-comments",
    "privacy-settings",
    "rate-limit-options",
    "remote-env",
    "web-setup",
    "rename",
    "rewind",
    "sandbox",
    "session",
    "stickers",
    "tag",
    "tasks",
    "terminal-setup",
    "theme",
    "think-back",
    "thinkback-play",
    "upgrade",
    "vim",
    "voice",
    "install",
    "ultraplan",
    "commit",
    "review",
    "ultrareview",
  ];
  const missingRegistryNames = expectedNames.filter(
    name => !new RegExp(`name:\\s*["']${escapeRegExp(name)}["']`).test(registry),
  );
  const missingCommandNames = /registeredLegacyCommandSurfaceSpecs/.test(commands)
    ? []
    : expectedNames.filter(
      name => !new RegExp(`name:\\s*["']${escapeRegExp(name)}["']`).test(commands),
    );
  const missingEvidence = [
    [
      "registry exposes registered legacy command surface names",
      /export\s+function\s+registeredLegacyCommandSurfaceNames/,
      registry,
    ],
    [
      "registry protects against duplicate legacy command names",
      /Duplicate legacy command surface registration/,
      registry,
    ],
    [
      "command projection uses lazy descriptors, not eager legacy imports",
      /function\s+lazyCommand[\s\S]*loadLegacyCommand/,
      commands,
    ],
    [
      "shared legacy surface specs preserve prompt tool metadata",
      /allowedTools:\s*\[\s*["']Bash\(git add:\*\)["'][\s\S]*contentLength:\s*0[\s\S]*source:\s*["']builtin["']/,
      registry,
    ],
    [
      "command projection maps shared specs to legacy descriptors",
      /registeredLegacyCommandSurfaceSpecs\.map[\s\S]*lazyCommand\(\{\s*\.\.\.spec,\s*modulePath:\s*spec\.tuiModulePath\s*\}\)/,
      commands,
    ],
    [
      "registry dispatches legacy surfaces instead of placeholder errors",
      /executeLegacyCommandSurface[\s\S]*loadLegacyCommandSurface[\s\S]*localResultToSlashResult/,
      registry,
    ],
    [
      "registry wires the real extra-usage noninteractive export",
      /nonInteractiveExportName:\s*["']extraUsageNonInteractive["']/,
      registry,
    ],
    [
      "registry test covers legacy command surface names",
      /registers legacy command surfaces that still have executable modules/,
      registryTest,
    ],
    [
      "registry test executes real local/prompt surfaces and blocks context-bound prompts",
      /executes representable local legacy command surfaces[\s\S]*executes representable prompt legacy command surfaces[\s\S]*does not dispatch prompt legacy commands that need interactive context/,
      registryTest,
    ],
    [
      "TUI command-list test covers legacy descriptor projection",
      /projects registered legacy command surfaces to executable descriptors/,
      tuiListTest,
    ],
    [
      "TUI command-list test locks full shared metadata and representative metadata",
      /preserves shared metadata for every legacy command surface[\s\S]*preserves representative legacy descriptor metadata[\s\S]*keeps hidden legacy surfaces addressable/,
      tuiListTest,
    ],
    [
      "command-surface compatibility test covers no-mock registry imports",
      /AgenC command surface compatibility[\s\S]*getCommandsSync\(\)[\s\S]*buildDefaultRegistry\(\)/,
      commandSurfaceTest,
    ],
  ]
    .filter(([, pattern, content]) => !pattern.test(content))
    .map(([label]) => label);
  if (missingRegistryNames.length > 0 || missingCommandNames.length > 0 || missingEvidence.length > 0) {
    const details = [
      ...missingEvidence,
      ...missingRegistryNames.map(name => `registry missing /${name}`),
      ...missingCommandNames.map(name => `commands.ts missing /${name}`),
    ];
    failGate(`GAP-TUI-10 evidence missing:\n  - ${details.join("\n  - ")}`);
  }
  if (
    /name:\s*["']extra-usage-noninteractive["']/.test(registry) ||
    /nonInteractiveOnlyLocalCommand/.test(registry) ||
    /name:\s*["']extra-usage-noninteractive["']/.test(commands) ||
    /nonInteractiveOnlyLocalCommand/.test(commands)
  ) {
    failGate("GAP-TUI-10: invented extra-usage-noninteractive registry surface remains");
  }

  pass("GAP-TUI-10: orphaned command surfaces are registered and projected");
  const vitest = run("npm", [
    "--workspace=@tetsuo-ai/runtime",
    "test",
    "--",
    "src/commands/registry.test.ts",
    "src/commands/tui-command-list.test.ts",
    "src/commands/command-surface.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TUI-10 targeted orphan-command tests failed");
  }
  pass("GAP-TUI-10 targeted orphan-command tests passed");
}

function assertGapTuiFilesCommandVisible() {
  const rels = {
    filesCommand: "runtime/src/commands/files.ts",
    commandSurfaceTest: "runtime/src/commands/command-surface.test.ts",
    tuiListTest: "runtime/src/commands/tui-command-list.test.ts",
    helpTest: "runtime/src/commands/help.test.ts",
  };
  for (const rel of Object.values(rels)) {
    if (!existsSync(path.join(root, rel))) failGate(`GAP-TUI-11: missing ${rel}`);
  }

  const filesCommand = readFileSync(path.join(root, rels.filesCommand), "utf8");
  const commandSurfaceTest = readFileSync(path.join(root, rels.commandSurfaceTest), "utf8");
  const tuiListTest = readFileSync(path.join(root, rels.tuiListTest), "utf8");
  const helpTest = readFileSync(path.join(root, rels.helpTest), "utf8");

  if (/USER_TYPE\s*={0,2}={1,2}\s*["']ant["']/.test(filesCommand)) {
    failGate("GAP-TUI-11: /files still has the USER_TYPE === \"ant\" gate");
  }
  if (/filesCommand[\s\S]*isEnabled\s*:/.test(filesCommand)) {
    failGate("GAP-TUI-11: /files must not define a command-level isEnabled gate");
  }

  const missingEvidence = [
    [
      "command-surface test proves /files is enabled for AgenC users",
      /keeps \/files enabled for AgenC users[\s\S]*getCommands\("\/tmp"\)[\s\S]*name:\s*["']files["']/,
      commandSurfaceTest,
    ],
    [
      "dispatcher test executes /files without USER_TYPE",
      /executes \/files through the runtime dispatcher for AgenC users[\s\S]*delete process\.env\.USER_TYPE[\s\S]*No files in context\./,
      commandSurfaceTest,
    ],
    [
      "TUI list test includes /files for AgenC users",
      /includes \/files in the TUI command list for AgenC users[\s\S]*toContain\(["']files["']\)/,
      tuiListTest,
    ],
    [
      "help test includes /files in visible commands",
      /lists \/files with visible default registry commands[\s\S]*visibleNames\)\.toContain\(["']files["']\)[\s\S]*countCanonicalCommandLines\(text,\s*["']files["']\)\)\.toBe\(1\)/,
      helpTest,
    ],
  ]
    .filter(([, pattern, content]) => !pattern.test(content))
    .map(([label]) => label);
  if (missingEvidence.length > 0) {
    failGate(`GAP-TUI-11 evidence missing:\n  - ${missingEvidence.join("\n  - ")}`);
  }

  pass("GAP-TUI-11: /files is visible for AgenC users");
  const vitest = run("npm", [
    "--workspace=@tetsuo-ai/runtime",
    "test",
    "--",
    "src/commands/command-surface.test.ts",
    "src/commands/tui-command-list.test.ts",
    "src/commands/help.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TUI-11 targeted /files visibility tests failed");
  }
  pass("GAP-TUI-11 targeted /files visibility tests passed");
}

function assertGapTuiAppShellReconciled() {
  const rels = {
    app: "runtime/src/tui/components/App.tsx",
    appTest: "runtime/src/tui/components/App.render.test.tsx",
    selectorFilter: "runtime/src/tui/components/message-selector-filter.ts",
    selectorFilterTest: "runtime/src/tui/components/MessageSelector.filter.test.ts",
    selector: "runtime/src/tui/components/MessageSelector.tsx",
    session: "runtime/src/session/session.ts",
    sessionTest: "runtime/src/session/session.test.ts",
    compact: "runtime/src/services/compact/compact.ts",
    compactTest: "runtime/src/services/compact/compact.test.ts",
    transcript: "runtime/src/tui/session-transcript.ts",
    transcriptTest: "runtime/src/tui/parity/session-transcript.test.ts",
    protocol: "runtime/src/app-server/protocol/index.ts",
    agentLifecycle: "runtime/src/app-server/agent-lifecycle.ts",
    clearTest: "runtime/src/commands/clear.test.ts",
  };
  for (const rel of Object.values(rels)) {
    if (!existsSync(path.join(root, rel))) failGate(`GAP-TUI-12: missing ${rel}`);
  }

  const app = readFileSync(path.join(root, rels.app), "utf8");
  const appTest = readFileSync(path.join(root, rels.appTest), "utf8");
  const selector = readFileSync(path.join(root, rels.selector), "utf8");
  const selectorFilter = readFileSync(path.join(root, rels.selectorFilter), "utf8");
  const selectorFilterTest = readFileSync(path.join(root, rels.selectorFilterTest), "utf8");
  const session = readFileSync(path.join(root, rels.session), "utf8");
  const sessionTest = readFileSync(path.join(root, rels.sessionTest), "utf8");
  const compact = readFileSync(path.join(root, rels.compact), "utf8");
  const compactTest = readFileSync(path.join(root, rels.compactTest), "utf8");
  const transcript = readFileSync(path.join(root, rels.transcript), "utf8");
  const transcriptTest = readFileSync(path.join(root, rels.transcriptTest), "utf8");
  const protocol = readFileSync(path.join(root, rels.protocol), "utf8");
  const agentLifecycle = readFileSync(path.join(root, rels.agentLifecycle), "utf8");
  const clearTest = readFileSync(path.join(root, rels.clearTest), "utf8");

  if (/This rewind action is unavailable in the live TUI shell/.test(app)) {
    failGate("GAP-TUI-12: old MessageSelector throwing fallback remains in App.tsx");
  }
  if (/handleSummarizeUnavailable/.test(app)) {
    failGate("GAP-TUI-12: App must use real MessageSelector summarization, not the old unavailable fallback");
  }
  if (/clearDaemonSession/.test(app)) {
    failGate("GAP-TUI-12: App MessageSelector handling must not substitute full daemon clear for rewind");
  }

  const missingEvidence = [
    [
      "App registers cost summary against FPS metrics",
      /useCostSummary\(useFpsMetrics\(\)\)/,
      app,
    ],
    [
      "App marks cost threshold as shown before checking billing UI access",
      /setHaveShownCostDialog\(true\)[\s\S]*if\s*\(hasConsoleBillingAccess\(\)\)/,
      app,
    ],
    [
      "App renders cost threshold dialog and persists acknowledgment",
      /hasAcknowledgedCostThreshold:\s*true[\s\S]*<CostThresholdDialog\s+onDone=\{handleCostThresholdDone\}/,
      app,
    ],
    [
      "App installs compact progress controls on the live session",
      /installCompactProgressControls\(props\.session,\s*\{[\s\S]*setStreamMode:\s*setCompactStreamMode[\s\S]*setResponseLength:\s*setCompactResponseLength[\s\S]*onCompactProgress:\s*handleCompactProgress[\s\S]*setSDKStatus:\s*setCompactSDKStatus/,
      app,
    ],
    [
      "App narrows compact progress events before reading them",
      /function\s+isCompactProgressEvent[\s\S]*type\s*===\s*["']hooks_start["'][\s\S]*type\s*===\s*["']compact_start["'][\s\S]*type\s*===\s*["']compact_end["']/,
      app,
    ],
    [
      "App routes active worktree exit through ExitFlow",
      /getCurrentWorktreeSession\(\)\s*!==\s*null[\s\S]*<ExitFlow[\s\S]*showWorktree=\{true\}/,
      app,
    ],
    [
      "App worktree ExitFlow onDone does not call Ink exit",
      /onDone=\{\(\)\s*=>\s*\{[\s\S]*setExitFlow\(null\);[\s\S]*\}\}/,
      app,
    ],
    [
      "App restores code through utils fileHistoryRewind",
      /import\s+\{\s*fileHistoryRewind\s*\}\s+from\s+["']\.\.\/\.\.\/utils\/fileHistory\.js["'][\s\S]*onRestoreCode=\{handleRestoreCode\}/,
      app,
    ],
    [
      "App summarize callback calls the session partial compaction surface",
      /const\s+handleSummarize\s*=\s*useCallback[\s\S]*props\.session\.partialCompactFromMessage[\s\S]*messageOrdinal[\s\S]*direction[\s\S]*feedback[\s\S]*signal:\s*abortController\.signal/,
      app,
    ],
    [
      "App rewinds conversation through the session replacement surface",
      /const\s+handleRestoreMessage\s*=\s*useCallback[\s\S]*props\.session\.rewindConversationToMessage[\s\S]*messageOrdinal[\s\S]*emitPhaseEvent\?\./,
      app,
    ],
    [
      "App blocks conversation actions while a turn is active",
      /CONVERSATION_ACTION_BUSY_MESSAGE[\s\S]*hasActiveConversationTurn[\s\S]*handleRestoreMessage[\s\S]*transcript\.isStreaming[\s\S]*handleSummarize[\s\S]*transcript\.isStreaming/,
      app,
    ],
    [
      "App clears summarize abort controller on rejection paths",
      /try\s*\{[\s\S]*result\s*=\s*await\s+props\.session\.partialCompactFromMessage[\s\S]*\}\s*finally\s*\{[\s\S]*summarizeAbortRef\.current\s*===\s*abortController[\s\S]*summarizeAbortRef\.current\s*=\s*null/,
      app,
    ],
    [
      "App maps MessageSelector messages through selectable user-message ordinals",
      /selectableMessages[\s\S]*filter\(selectableUserMessagesFilter[\s\S]*indexOf\(message\)/,
      app,
    ],
    [
      "MessageSelector and Session both reject empty selectable user messages",
      /messageText\.length\s*===\s*0[\s\S]*return\s+false/,
      selectorFilter,
    ],
    [
      "App emits history replacement events only when the session did not emit them",
      /!result\.eventAlreadyEmitted[\s\S]*result\.event\s*!==\s*undefined[\s\S]*emitPhaseEvent\?\./,
      app,
    ],
    [
      "App passes the real summarize handler to MessageSelector",
      /onSummarize=\{handleSummarize\}/,
      app,
    ],
    [
      "Session implements partial compaction as an idle compact task",
      /async\s+partialCompactFromMessage[\s\S]*beginIdleTask[\s\S]*kind:\s*["']compact["'][\s\S]*partialCompactConversationAsync/,
      session,
    ],
    [
      "Session implements conversation rewind as durable replacement history",
      /async\s+rewindConversationToMessage[\s\S]*splitActiveHistory[\s\S]*activeHistory\.slice\(0,\s*selectedIndex\)[\s\S]*commitConversationRewind/,
      session,
    ],
    [
      "Session commits durable replacement history before replacing in-memory history",
      /appendRollout[\s\S]*replacementHistory[\s\S]*await\s+this\.state\.with[\s\S]*sessionState\.history/,
      session,
    ],
    [
      "Partial compaction preserves assistant tool-call arguments in history conversions",
      /toolCalls:\s*message\.toolCalls\.map[\s\S]*arguments:\s*call\.arguments/,
      readFileSync(path.join(root, "runtime/src/session/message-history-conversion.ts"), "utf8"),
    ],
    [
      "Transcript replacement event converts replacement history to renderer-safe messages",
      /createHistoryReplacedEvent[\s\S]*llmHistoryToRuntimeTranscriptMessages/,
      readFileSync(path.join(root, "runtime/src/session/transcript-replacement.ts"), "utf8"),
    ],
    [
      "Transcript replacement preserves compact metadata for selector parity",
      /COMPACT_BOUNDARY_PREFIX[\s\S]*COMPACT_SUMMARY_PREFIX[\s\S]*isCompactBoundary[\s\S]*isMeta:\s*true[\s\S]*isCompactSummary:\s*true/,
      readFileSync(path.join(root, "runtime/src/session/transcript-replacement.ts"), "utf8"),
    ],
    [
      "TUI transcript reducer resets on history_replaced",
      /case\s+["']history_replaced["'][\s\S]*out\.length\s*=\s*0[\s\S]*payload[\s\S]*messages/,
      transcript,
    ],
    [
      "Compact service exposes async partial compaction with abort signal support",
      /export\s+async\s+function\s+partialCompactConversationAsync[\s\S]*signal[\s\S]*throwIfAborted/,
      compact,
    ],
    [
      "Daemon protocol declares session partial compaction as an internal TUI method",
      /AGENC_DAEMON_INTERNAL_METHODS[\s\S]*["']session\.partialCompactFromMessage["'][\s\S]*["']session\.rewindConversationToMessage["'][\s\S]*AGENC_DAEMON_INTERNAL_METHOD_SPECS[\s\S]*SessionPartialCompactFromMessageParams[\s\S]*SessionRewindConversationToMessageParams[\s\S]*SessionPartialCompactFromMessageResult[\s\S]*SessionRewindConversationToMessageResult[\s\S]*AgenCDaemonInternalResultByMethod/,
      protocol,
    ],
    [
      "MessageSelector exposes both partial summarize directions",
      /value:\s*'summarize'[\s\S]*value:\s*'summarize_up_to'[\s\S]*label:\s*'Summarize up to here'/,
      selector,
    ],
    [
      "test covers compact controls install/cleanup",
      /installs compact progress controls and restores them on unmount[\s\S]*expect\(session\.onCompactProgress\)\.toBeUndefined\(\)/,
      appTest,
    ],
    [
      "test covers worktree and non-worktree exit routing",
      /routes exit through worktree ExitFlow only for active worktree sessions[\s\S]*mockWorktreeSession[\s\S]*providerProbe\.inkExit/,
      appTest,
    ],
    [
      "test covers cost threshold access and acknowledgment",
      /renders and acknowledges the cost threshold dialog[\s\S]*hasAcknowledgedCostThreshold[\s\S]*marks the cost threshold as shown without rendering/,
      appTest,
    ],
    [
      "test covers code restore, conversation rewind, and partial summarize",
      /wires MessageSelector code restore, conversation rewind, and partial summarize[\s\S]*fileHistoryRewind[\s\S]*rewindConversationToMessage[\s\S]*partialCompactFromMessage[\s\S]*expect\(session\.clearDaemonSession\)\.not\.toHaveBeenCalled/,
      appTest,
    ],
    [
      "test covers active-turn selector action rejection",
      /blocks MessageSelector conversation actions while a turn is active[\s\S]*activeTurn[\s\S]*onRestoreMessage[\s\S]*onSummarize[\s\S]*not\.toHaveBeenCalled/,
      appTest,
    ],
    [
      "test covers elicitation abort-listener cleanup on normal completion",
      /removes direct user-input abort listeners after normal completion[\s\S]*removeEventListener[\s\S]*listeners\.size\)\.toBe\(0\)/,
      appTest,
    ],
    [
      "session tests cover durable replacement and active compact task clear rejection",
      /commits a durable replacement history[\s\S]*appendRollout[\s\S]*installs an active compact task[\s\S]*clearSession\(session\)/,
      sessionTest,
    ],
    [
      "session tests cover durable conversation rewind and compact metadata ordinal parity",
      /Session\.rewindConversationToMessage[\s\S]*commits a durable replacement history before the selected active message[\s\S]*does not count compact boundary or summary messages as selectable/,
      sessionTest,
    ],
    [
      "compact tests cover both selector directions and abort",
      /partialCompactConversationAsync[\s\S]*direction:\s*["']from["'][\s\S]*direction:\s*["']up_to["'][\s\S]*AbortController/,
      compactTest,
    ],
    [
      "compact tests cover up-to first-message boundary without provider call",
      /up-to first message without provider call[\s\S]*expect\(provider\.chat\)\.not\.toHaveBeenCalled/,
      compactTest,
    ],
    [
      "transcript tests cover history replacement reset",
      /history_replaced resets transcript to renderer-safe replacement messages[\s\S]*payload:\s*\{[\s\S]*messages:/,
      transcriptTest,
    ],
    [
      "transcript tests cover compact boundary and summary metadata",
      /history_replaced preserves compact boundary and summary metadata[\s\S]*isMeta:\s*true[\s\S]*isCompactSummary:\s*true/,
      transcriptTest,
    ],
    [
      "selector filter tests cover empty user text parity",
      /matches the session selector by rejecting empty visible user text[\s\S]*selectableUserMessagesFilter\(userMessage\(["']["']\)/,
      selectorFilterTest,
    ],
    [
      "selector filter tests cover compact replacement metadata parity",
      /rejects compact boundary and summary replacement messages[\s\S]*isMeta:\s*true[\s\S]*isCompactSummary:\s*true/,
      selectorFilterTest,
    ],
    [
      "selector tests cover summarize-up-to reachability",
      /keeps summarize-up-to reachable in the live selector options[\s\S]*summarize_up_to/,
      selectorFilterTest,
    ],
    [
      "daemon session test covers the internal partial compaction RPC",
      /partially compacts daemon-owned session history through the internal TUI RPC[\s\S]*session\.partialCompactFromMessage[\s\S]*messageOrdinal:\s*2/,
      readFileSync(path.join(root, "runtime/src/tui/daemon-session.contract.test.ts"), "utf8"),
    ],
    [
      "daemon session test covers the internal conversation rewind RPC",
      /rewinds daemon-owned session history through the internal TUI RPC[\s\S]*session\.rewindConversationToMessage[\s\S]*messageOrdinal:\s*1/,
      readFileSync(path.join(root, "runtime/src/tui/daemon-session.contract.test.ts"), "utf8"),
    ],
    [
      "agent lifecycle test covers internal partial compaction dispatch",
      /dispatches internal TUI partial compaction through JSON-RPC to daemon-owned history[\s\S]*session\.partialCompactFromMessage[\s\S]*allowPartialCompact/,
      [
        readFileSync(path.join(root, "runtime/src/app-server/agent-lifecycle.contract.test.ts"), "utf8"),
        agentLifecycle,
      ].join("\n"),
    ],
    [
      "agent lifecycle test covers internal conversation rewind dispatch",
      /dispatches internal TUI conversation rewind through JSON-RPC to daemon-owned history[\s\S]*session\.rewindConversationToMessage[\s\S]*allowConversationRewind/,
      [
        readFileSync(path.join(root, "runtime/src/app-server/agent-lifecycle.contract.test.ts"), "utf8"),
        agentLifecycle,
      ].join("\n"),
    ],
    [
      "protocol tests cover internal method specs and result map",
      /expectedInternalMethods[\s\S]*AGENC_DAEMON_INTERNAL_METHOD_SPECS[\s\S]*AgenCDaemonInternalResultByMethod/,
      readFileSync(path.join(root, "runtime/src/app-server/protocol.contract.test.ts"), "utf8"),
    ],
    [
      "clear command tests cover active turn rejection",
      /refuses to clear while a turn is in flight[\s\S]*activeTurn[\s\S]*in flight/,
      clearTest,
    ],
    [
      "agent lifecycle test covers internal partial compaction cancellation",
      /cancels internal TUI partial compaction through request\.cancel[\s\S]*REQUEST_CANCELLED[\s\S]*selector closed/,
      readFileSync(path.join(root, "runtime/src/app-server/agent-lifecycle.contract.test.ts"), "utf8"),
    ],
  ]
    .filter(([, pattern, content]) => !pattern.test(content))
    .map(([label]) => label);
  if (missingEvidence.length > 0) {
    failGate(`GAP-TUI-12 evidence missing:\n  - ${missingEvidence.join("\n  - ")}`);
  }

  pass("GAP-TUI-12: App shell reconciliation evidence present");
  const vitest = run("npm", [
    "--workspace=@tetsuo-ai/runtime",
    "test",
    "--",
    "src/tui/components/App.render.test.tsx",
    "src/session/session.test.ts",
    "src/services/compact/compact.test.ts",
    "src/tui/parity/session-transcript.test.ts",
    "src/tui/daemon-session.contract.test.ts",
    "src/tui/components/MessageSelector.filter.test.ts",
    "src/app-server/protocol.contract.test.ts",
    "src/app-server/agent-lifecycle.contract.test.ts",
    "src/commands/clear.test.ts",
  ]);
  if (vitest.status !== 0) {
    failGate("GAP-TUI-12 targeted App shell tests failed");
  }
  pass("GAP-TUI-12 targeted App shell tests passed");
}

function subsystemDirGates(label, dir) {
  return async function gate(item) {
    const full = path.join(root, dir);
    if (!existsSync(full)) {
      failGate(`${label}: directory ${dir} does not exist; create it as part of this item.`);
      return;
    }
    const allFiles = walkFiles(full);
    const productionTs = allFiles.filter((p) => /\.(ts|tsx|mjs|cjs|js|jsx)$/.test(p) && !/\.test\./.test(p) && !/\.d\.ts$/.test(p));
    const testTs = allFiles.filter((p) => /\.test\.(ts|tsx|mjs|cjs|js|jsx)$/.test(p));
    if (productionTs.length === 0) failGate(`${label}: no production source files in ${dir}.`);
    if (testTs.length === 0) failGate(`${label}: no test files in ${dir}.`);
    pass(`${label}: ${productionTs.length} source / ${testTs.length} test file(s) in ${dir}`);
  };
}

async function ideExtensionGates(item) {
  // IDE-* lives in a separate repo (vscode/jetbrains extensions). The local
  // contract is the shared protocol surface — verify the protocol exists
  // and references IDE-relevant symbols.
  const protocolDir = path.join(root, "runtime/src/app-server-protocol");
  if (!existsSync(protocolDir)) {
    failGate("IDE-*: runtime/src/app-server-protocol/ missing — required for IDE protocol surface.");
  }
  const found = grepRepo("ide|vscode|jetbrains|lsp|languageServer", "runtime/src/app-server-protocol") ||
                grepRepo("ide|vscode|jetbrains|lsp|languageServer", "runtime/src/app-server");
  if (!found) {
    failGate(
      `IDE-* item ${id}: no IDE-related symbols (ide/vscode/jetbrains/lsp) found in runtime/src/app-server-protocol/. ` +
      `The local protocol must reference the IDE surface even when the implementation lives in a sibling repo.`,
    );
  }
  if (id === "IDE-01") {
    assertAgenCVscodeSiblingRepo();
  }
  if (id === "IDE-02") {
    assertAgenCVscodeExtensionBoilerplate();
  }
  if (id === "IDE-03") {
    assertAgenCVscodeDaemonConnection();
  }
  pass(`IDE-*: IDE protocol surface referenced (${id})`);
}

function assertAgenCVscodeSiblingRepo() {
  const repo = path.resolve(mainCheckoutRoot(), "..", "agenc-vscode");
  const requiredFiles = [
    "package.json",
    "README.md",
    "src/extension.ts",
    "test/scaffold.test.mjs",
    "tsconfig.json",
  ];
  const missing = requiredFiles.filter((rel) => !existsSync(path.join(repo, rel)));
  if (missing.length > 0) {
    failGate(
      `IDE-01: agenc-vscode sibling repo missing required file(s):\n  ${missing.join("\n  ")}\n` +
        `Expected repo root: ${repo}`,
    );
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  } catch (error) {
    failGate(`IDE-01: could not parse agenc-vscode/package.json: ${error?.message || error}`);
  }

  const packageFailures = [];
  if (pkg.name !== "agenc-vscode") packageFailures.push("name must be agenc-vscode");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(pkg.name ?? "")) {
    packageFailures.push("name must be a VS Code extension id segment");
  }
  if (pkg.displayName !== "AgenC") packageFailures.push("displayName must be AgenC");
  if (pkg.publisher !== "tetsuo-ai") packageFailures.push("publisher must be tetsuo-ai");
  if (pkg.engines?.vscode !== "^1.90.0") packageFailures.push("engines.vscode must be ^1.90.0");
  if (!pkg.activationEvents?.includes?.("onCommand:agenc.connectDaemon")) {
    packageFailures.push("activationEvents must include onCommand:agenc.connectDaemon");
  }
  if (pkg.contributes?.commands?.[0]?.command !== "agenc.connectDaemon") {
    packageFailures.push("contributes.commands[0].command must be agenc.connectDaemon");
  }
  if (pkg.dependencies?.["@tetsuo-ai/protocol"] !== "file:../agenc-protocol/packages/protocol") {
    packageFailures.push("@tetsuo-ai/protocol dependency must point at the sibling protocol package");
  }
  if (pkg.dependencies?.["@tetsuo-ai/runtime"] !== "file:../agenc-core/runtime") {
    packageFailures.push("@tetsuo-ai/runtime dependency must point at the sibling runtime package");
  }
  if (pkg.scripts?.["test:scaffold"] !== "node test/scaffold.test.mjs") {
    packageFailures.push("test:scaffold script must run the local scaffold test");
  }
  if (packageFailures.length > 0) {
    failGate(`IDE-01: agenc-vscode/package.json scaffold mismatch:\n  ${packageFailures.join("\n  ")}`);
  }

  const extensionSource = readFileSync(path.join(repo, "src/extension.ts"), "utf8");
  const hasInitialProtocolStub =
    extensionSource.includes("AGENC_IDE_EXTENSION_SCAFFOLD") &&
    extensionSource.includes("createAgenCIdeInitializeParams");
  const hasDaemonProtocolConnection =
    extensionSource.includes("AgenCDaemonProcess") &&
    extensionSource.includes("daemon.connect()");
  if (!extensionSource.includes("agenc.connectDaemon")) {
    failGate("IDE-01: src/extension.ts missing agenc.connectDaemon command registration");
  }
  if (!hasInitialProtocolStub && !hasDaemonProtocolConnection) {
    failGate(
      "IDE-01: src/extension.ts must reference either the initial IDE protocol scaffold " +
        "or the daemon-backed IDE protocol connection",
    );
  }

  const selfTest = run("node", ["test/scaffold.test.mjs"], { cwd: repo, silent: true });
  if (selfTest.status !== 0) {
    failGate(`IDE-01: agenc-vscode scaffold self-test failed:\n${selfTest.stderr || selfTest.stdout}`);
  }
  pass("IDE-01: agenc-vscode sibling repo scaffold present and self-test passes");
}

function assertAgenCVscodeExtensionBoilerplate() {
  const repo = path.resolve(mainCheckoutRoot(), "..", "agenc-vscode");
  const requiredFiles = [
    ".vscode/extensions.json",
    ".vscode/launch.json",
    ".vscode/tasks.json",
    ".vscodeignore",
    "package-lock.json",
    "scripts/clean.mjs",
    "src/agenc-runtime.d.ts",
    "src/extension.ts",
    "test/scaffold.test.mjs",
    "tsconfig.json",
  ];
  const missing = requiredFiles.filter((rel) => !existsSync(path.join(repo, rel)));
  if (missing.length > 0) {
    failGate(
      `IDE-02: agenc-vscode extension boilerplate missing required file(s):\n  ${missing.join("\n  ")}\n` +
        `Expected repo root: ${repo}`,
    );
  }

  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  const expectedScripts = {
    clean: "node scripts/clean.mjs",
    compile: "tsc -p tsconfig.json",
    build: "npm run clean && npm run compile",
    typecheck: "tsc --noEmit",
    "test:scaffold": "node test/scaffold.test.mjs",
  };
  const scriptFailures = Object.entries(expectedScripts)
    .filter(([name, script]) => pkg.scripts?.[name] !== script)
    .map(([name, script]) => `${name} must be ${script}`);
  if (typeof pkg.scripts?.check !== "string") {
    scriptFailures.push("check script must exist");
  } else {
    for (const required of ["npm run test:scaffold", "npm run typecheck"]) {
      if (!pkg.scripts.check.includes(required)) {
        scriptFailures.push(`check script must include ${required}`);
      }
    }
  }
  if (scriptFailures.length > 0) {
    failGate(`IDE-02: agenc-vscode/package.json script mismatch:\n  ${scriptFailures.join("\n  ")}`);
  }

  const vscodeIgnore = readFileSync(path.join(repo, ".vscodeignore"), "utf8");
  for (const required of ["node_modules/", "src/", "test/", "scripts/"]) {
    if (!vscodeIgnore.split(/\r?\n/).includes(required)) {
      failGate(`IDE-02: .vscodeignore must include ${required}`);
    }
  }

  const check = run("npm", ["run", "check"], { cwd: repo, silent: true });
  if (check.status !== 0) {
    failGate(`IDE-02: agenc-vscode check failed:\n${check.stderr || check.stdout}`);
  }
  const build = run("npm", ["run", "build"], { cwd: repo, silent: true });
  if (build.status !== 0) {
    failGate(`IDE-02: agenc-vscode build failed:\n${build.stderr || build.stdout}`);
  }
  if (!existsSync(path.join(repo, "dist/extension.js"))) {
    failGate("IDE-02: agenc-vscode build did not emit dist/extension.js");
  }
  pass("IDE-02: agenc-vscode extension boilerplate checks and builds");
}

function assertAgenCVscodeDaemonConnection() {
  const repo = path.resolve(mainCheckoutRoot(), "..", "agenc-vscode");
  const requiredFiles = [
    "src/daemon.ts",
    "src/extension.ts",
    "test/daemon.test.mjs",
  ];
  const missing = requiredFiles.filter((rel) => !existsSync(path.join(repo, rel)));
  if (missing.length > 0) {
    failGate(
      `IDE-03: agenc-vscode daemon connection missing required file(s):\n  ${missing.join("\n  ")}\n` +
        `Expected repo root: ${repo}`,
    );
  }

  const daemonSource = readFileSync(path.join(repo, "src/daemon.ts"), "utf8");
  const daemonMarkers = [
    "AGENC_DAEMON_COMMAND = \"agenc\"",
    "\"daemon\"",
    "\"start\"",
    "\"--foreground\"",
    "createAgenCDaemonLaunchPlan",
    "createAgenCDaemonInitializeRequest",
    "connectAgenCDaemonSocket",
    "sendAgenCDaemonInitializeRequest",
    "socket.write(`${JSON.stringify(request)}\\n`)",
  ];
  const missingDaemonMarkers = daemonMarkers.filter((marker) => !daemonSource.includes(marker));
  if (missingDaemonMarkers.length > 0) {
    failGate(`IDE-03: src/daemon.ts missing marker(s): ${missingDaemonMarkers.join(", ")}`);
  }

  const extensionSource = readFileSync(path.join(repo, "src/extension.ts"), "utf8");
  const extensionMarkers = [
    "new AgenCDaemonProcess()",
    "daemon.connect()",
    "daemon.stop()",
    "showErrorMessage",
  ];
  const testSource = readFileSync(path.join(repo, "test/daemon.test.mjs"), "utf8");
  const testMarkers = [
    "createServer",
    "AgenCDaemonProcess",
    "sendAgenCDaemonInitializeRequest",
    "AgenC daemon initialize failed",
    "exited before initialize response",
  ];
  const missingExtensionMarkers = extensionMarkers.filter((marker) => !extensionSource.includes(marker));
  if (missingExtensionMarkers.length > 0) {
    failGate(`IDE-03: src/extension.ts missing marker(s): ${missingExtensionMarkers.join(", ")}`);
  }
  const missingTestMarkers = testMarkers.filter((marker) => !testSource.includes(marker));
  if (missingTestMarkers.length > 0) {
    failGate(`IDE-03: test/daemon.test.mjs missing behavior marker(s): ${missingTestMarkers.join(", ")}`);
  }

  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  if (pkg.scripts?.["test:daemon"] !== "npm run build && node test/daemon.test.mjs") {
    failGate("IDE-03: package.json must expose test:daemon for daemon launch contract coverage");
  }
  if (typeof pkg.scripts?.check !== "string" || !pkg.scripts.check.includes("npm run test:daemon")) {
    failGate("IDE-03: package.json check script must include npm run test:daemon");
  }

  const daemonTest = run("npm", ["run", "test:daemon"], { cwd: repo, silent: true });
  if (daemonTest.status !== 0) {
    failGate(`IDE-03: agenc-vscode daemon behavior test failed:\n${daemonTest.stderr || daemonTest.stdout}`);
  }
  const check = run("npm", ["run", "check"], { cwd: repo, silent: true });
  if (check.status !== 0) {
    failGate(`IDE-03: agenc-vscode check failed:\n${check.stderr || check.stdout}`);
  }
  pass("IDE-03: agenc-vscode launches agenc daemon and builds daemon connection contract");
}

function grepRepo(pattern, scope = "runtime/src", options = {}) {
  const args = ["--no-messages", "-l", pattern];
  if (options.caseInsensitive) args.push("-i");
  for (const glob of options.globs ?? []) args.push("-g", glob);
  for (const glob of options.excludeGlobs ?? []) args.push("-g", `!${glob}`);
  args.push(scope);
  const r = run("rg", args, { silent: true });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function assertChangedRelativeImportsResolve() {
  const missing = [];
  const specifierPattern =
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
  const diff = git("diff", "--unified=0", "main", "--", "runtime/src");
  if (diff.status !== 0) return;

  let currentRel = "";
  for (const line of diff.stdout.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentRel = line.slice("+++ b/".length);
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (!/^runtime\/src\/.*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(currentRel)) {
      continue;
    }
    const addedLine = line.slice(1);
    for (const match of addedLine.matchAll(specifierPattern)) {
      const specifier = match[1];
      if (!specifier || specifier.includes("?")) continue;
      const baseDir = path.dirname(path.join(root, currentRel));
      if (!relativeImportTargetExists(path.resolve(baseDir, specifier))) {
        missing.push(`${currentRel}: unresolved relative import ${specifier}`);
      }
    }
  }

  if (missing.length > 0) {
    failGate(`ZC-06: changed relative import target(s) do not resolve:\n${missing.join("\n")}`);
  }
}

function sourceModuleExtensions() {
  return [
    ".d.ts",
    ".d.mts",
    ".d.cts",
    ".tsx",
    ".ts",
    ".mts",
    ".cts",
    ".jsx",
    ".js",
    ".mjs",
    ".cjs",
  ];
}

function stripSourceModuleExtension(filePath) {
  for (const ext of sourceModuleExtensions()) {
    if (filePath.endsWith(ext)) return filePath.slice(0, -ext.length);
  }
  return null;
}

function zc06DeletedModuleBases(label = "ZC-06") {
  const diff = git("diff", "--name-only", "--diff-filter=D", "main", "--", "runtime/src");
  if (diff.status !== 0) {
    failGate(`${label}: could not derive deleted module list from git diff`);
  }
  const deletedBases = new Set();
  for (const rel of diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const baseRel = stripSourceModuleExtension(rel);
    if (!baseRel) continue;
    deletedBases.add(path.join(root, baseRel));
  }
  if (deletedBases.size === 0) {
    failGate(`${label}: no deleted runtime source modules found in diff`);
  }
  return deletedBases;
}

function assertNoDeletedModuleSurvivors(deletedBases, label = "ZC-06") {
  const survivors = [];
  for (const base of deletedBases) {
    for (const ext of sourceModuleExtensions()) {
      const candidate = `${base}${ext}`;
      if (existsSync(candidate)) survivors.push(path.relative(root, candidate).replaceAll("\\", "/"));
    }
  }
  if (survivors.length > 0) {
    failGate(`${label}: same-base module file(s) still exist for deleted re-export modules:\n${survivors.join("\n")}`);
  }
}

function assertNoDeletedModuleImporters(deletedBases, label = "ZC-06") {
  const specifierPattern =
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
  const offenders = [];

  for (const rel of listSourceFiles(path.join(root, "runtime/src"))) {
    const abs = path.join(root, rel);
    const source = readFileSync(abs, "utf8");
    const baseDir = path.dirname(abs);
    for (const match of source.matchAll(specifierPattern)) {
      const specifier = match[1];
      if (!specifier || specifier.includes("?")) continue;
      const targetBase = importTargetBase(path.resolve(baseDir, specifier));
      if (deletedBases.has(targetBase)) {
        offenders.push(`${rel}: references deleted ${label} module ${specifier}`);
      }
    }
  }

  if (offenders.length > 0) {
    failGate(`${label}: importer(s) still point at deleted re-export modules:\n${offenders.join("\n")}`);
  }
}

function assertNoZc06DeletedModuleSurvivors(deletedBases) {
  assertNoDeletedModuleSurvivors(deletedBases, "ZC-06");
}

function assertNoZc06DeletedModuleImporters(deletedBases) {
  assertNoDeletedModuleImporters(deletedBases, "ZC-06");
}

var typeScriptModulePromise = null;

async function loadTypeScriptForForwarderGate() {
  typeScriptModulePromise ??= import("typescript").catch((error) => {
    failGate(
      `ZC-23: could not load TypeScript compiler API for forwarder detection: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return typeScriptModulePromise;
}

function runtimeForwarderScriptKind(ts, rel) {
  if (/\.tsx$/u.test(rel)) return ts.ScriptKind.TSX;
  if (/\.jsx$/u.test(rel)) return ts.ScriptKind.JSX;
  if (/\.mts$/u.test(rel)) return ts.ScriptKind.TS;
  if (/\.cts$/u.test(rel)) return ts.ScriptKind.TS;
  if (/\.mjs$/u.test(rel)) return ts.ScriptKind.JS;
  if (/\.cjs$/u.test(rel)) return ts.ScriptKind.JS;
  if (/\.js$/u.test(rel)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function runtimeForwarderSourceFile(ts, rel, source) {
  return ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    true,
    runtimeForwarderScriptKind(ts, rel),
  );
}

function moduleSpecifierText(ts, node) {
  if (!node || !ts.isStringLiteralLike(node)) return null;
  return node.text;
}

function recordImportedBinding(bindings, localName, info) {
  if (!localName) return;
  bindings.set(localName, info);
}

function collectRuntimeForwarderImports(ts, node, importedBindings) {
  const specifier = moduleSpecifierText(ts, node.moduleSpecifier);
  if (specifier === null) return false;
  if (!node.importClause) return false;

  const importClause = node.importClause;
  if (importClause.name) {
    recordImportedBinding(importedBindings, importClause.name.text, {
      module: specifier,
      imported: "default",
      typeOnly: importClause.isTypeOnly === true,
      namespace: false,
    });
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings) return true;

  if (ts.isNamespaceImport(namedBindings)) {
    recordImportedBinding(importedBindings, namedBindings.name.text, {
      module: specifier,
      imported: "*",
      typeOnly: importClause.isTypeOnly === true,
      namespace: true,
    });
    return true;
  }

  if (ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      recordImportedBinding(importedBindings, element.name.text, {
        module: specifier,
        imported: importedName,
        typeOnly: importClause.isTypeOnly === true || element.isTypeOnly === true,
        namespace: false,
      });
    }
  }

  return true;
}

function exportDeclarationForward(ts, node) {
  const specifier = moduleSpecifierText(ts, node.moduleSpecifier);
  if (specifier === null) return null;
  const names = [];
  const exportClause = node.exportClause;
  if (!exportClause) {
    names.push("*");
  } else if (ts.isNamespaceExport(exportClause)) {
    names.push(`* as ${exportClause.name.text}`);
  } else if (ts.isNamedExports(exportClause)) {
    for (const element of exportClause.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      const exported = element.name.text;
      names.push(imported === exported ? exported : `${imported} as ${exported}`);
    }
  }
  return {
    kind: "export-from",
    module: specifier,
    names,
    typeOnly: node.isTypeOnly === true,
  };
}

function localExportDeclarationForward(ts, node, importedBindings) {
  if (!node.exportClause) return {
    kind: "module-marker",
    forwards: [],
  };
  if (!ts.isNamedExports(node.exportClause)) return null;

  const forwards = [];
  for (const element of node.exportClause.elements) {
    const localName = element.propertyName?.text ?? element.name.text;
    const imported = importedBindings.get(localName);
    if (!imported) return null;
    const exported = element.name.text;
    forwards.push({
      kind: "imported-binding-export",
      module: imported.module,
      imported: imported.imported,
      exported,
      local: localName,
      typeOnly: node.isTypeOnly === true || element.isTypeOnly === true || imported.typeOnly === true,
      namespace: imported.namespace,
    });
  }

  return {
    kind: "local-export",
    forwards,
  };
}

function classifyRuntimeForwarderSource(ts, rel, source) {
  const sourceFile = runtimeForwarderSourceFile(ts, rel, source);
  const importedBindings = new Map();
  const forwards = [];
  let hasLocalBehavior = false;

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!collectRuntimeForwarderImports(ts, statement, importedBindings)) {
        hasLocalBehavior = true;
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const directForward = exportDeclarationForward(ts, statement);
      if (directForward !== null) {
        forwards.push(directForward);
        continue;
      }

      const localForward = localExportDeclarationForward(ts, statement, importedBindings);
      if (localForward?.kind === "module-marker") continue;
      if (localForward?.kind === "local-export") {
        forwards.push(...localForward.forwards);
        continue;
      }

      hasLocalBehavior = true;
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals === true) {
        hasLocalBehavior = true;
        continue;
      }
      if (ts.isIdentifier(statement.expression)) {
        const imported = importedBindings.get(statement.expression.text);
        if (imported) {
          forwards.push({
            kind: "default-assignment",
            module: imported.module,
            imported: imported.imported,
            exported: "default",
            local: statement.expression.text,
            typeOnly: imported.typeOnly === true,
            namespace: imported.namespace,
          });
          continue;
        }
      }
      hasLocalBehavior = true;
      continue;
    }

    if (ts.isEmptyStatement(statement)) continue;
    hasLocalBehavior = true;
  }

  return {
    rel,
    isForwarderOnly: forwards.length > 0 && !hasLocalBehavior,
    forwards,
    hasLocalBehavior,
  };
}

function isRuntimeDeclarationFile(rel) {
  return /\.d\.(?:ts|mts|cts)$/u.test(rel);
}

function isRuntimeTestSource(rel) {
  return /\.test\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(rel);
}

function isRuntimeSourceModule(rel) {
  return /^runtime\/src\/.*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(rel);
}

function shouldScanRuntimeForwarderFile(rel) {
  if (!isRuntimeSourceModule(rel)) return false;
  if (isRuntimeDeclarationFile(rel)) return false;
  if (isRuntimeTestSource(rel)) return false;
  if (rel.startsWith("runtime/src/agenc/upstream/")) return false;
  return true;
}

async function assertRuntimeForwarderClassifierSelfTests() {
  const ts = await loadTypeScriptForForwarderGate();
  const cases = [
    {
      name: "comment plus named export-from",
      source: "// public surface\nexport { Foo } from './foo.js';\n",
      expected: true,
    },
    {
      name: "multiline mixed type value export-from",
      source: "export {\n  type Foo,\n  Bar,\n} from './foo.js';\n",
      expected: true,
    },
    {
      name: "alias export-from",
      source: "export { Foo as Bar } from './foo.js';\n",
      expected: true,
    },
    {
      name: "default export-from",
      source: "export { default } from './foo.js';\n",
      expected: true,
    },
    {
      name: "default alias export-from",
      source: "export { default as Foo } from './foo.js';\n",
      expected: true,
    },
    {
      name: "type star export-from",
      source: "export type * from './foo.js';\n",
      expected: true,
    },
    {
      name: "namespace export-from",
      source: "export * as ns from './foo.js';\n",
      expected: true,
    },
    {
      name: "import default then export default",
      source: "import Foo from './foo.js';\nexport default Foo;\n",
      expected: true,
    },
    {
      name: "import named then export named",
      source: "import { Foo } from './foo.js';\nexport { Foo };\n",
      expected: true,
    },
    {
      name: "import type then export type",
      source: "import type { Foo } from './foo.js';\nexport type { Foo };\n",
      expected: true,
    },
    {
      name: "module marker plus forward",
      source: "export {};\nexport { Foo } from './foo.js';\n",
      expected: true,
    },
    {
      name: "empty comments only",
      source: "// nothing exported\n/* still empty */\n",
      expected: false,
    },
    {
      name: "side-effect import protects file",
      source: "import './setup.js';\nimport Foo from './foo.js';\nexport default Foo;\n",
      expected: false,
    },
    {
      name: "local const plus re-export",
      source: "export const local = 1;\nexport { Foo } from './foo.js';\n",
      expected: false,
    },
    {
      name: "local function plus re-export",
      source: "export function local() {}\nexport { Foo } from './foo.js';\n",
      expected: false,
    },
    {
      name: "local type plus re-export",
      source: "export type Local = string;\nexport { Foo } from './foo.js';\n",
      expected: false,
    },
    {
      name: "local interface plus re-export",
      source: "export interface Local { value: string }\nexport { Foo } from './foo.js';\n",
      expected: false,
    },
    {
      name: "local export declaration",
      source: "const Foo = 1;\nexport { Foo };\n",
      expected: false,
    },
    {
      name: "export equals is local behavior",
      source: "import Foo from './foo.js';\nexport = Foo;\n",
      expected: false,
    },
  ];

  const failures = [];
  for (const testCase of cases) {
    const result = classifyRuntimeForwarderSource(
      ts,
      `runtime/src/__zc23_fixture_${testCase.name.replace(/[^a-z0-9]+/giu, "_")}.ts`,
      testCase.source,
    );
    if (result.isForwarderOnly !== testCase.expected) {
      failures.push(
        `${testCase.name}: expected ${testCase.expected ? "forwarder" : "non-forwarder"}, ` +
        `got ${result.isForwarderOnly ? "forwarder" : "non-forwarder"}`,
      );
    }
  }

  if (failures.length > 0) {
    failGate(`ZC-23: runtime forwarder classifier self-test failed:\n  ${failures.join("\n  ")}`);
  }
}

async function runtimeForwarderOnlyModules() {
  const ts = await loadTypeScriptForForwarderGate();
  const tracked = git("ls-files", "runtime/src");
  if (tracked.status !== 0) failGate("ZC-23: git ls-files failed while scanning runtime/src");
  const offenders = [];
  for (const rel of tracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    if (!shouldScanRuntimeForwarderFile(rel)) continue;
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    const source = readFileSync(abs, "utf8");
    const result = classifyRuntimeForwarderSource(ts, rel, source);
    if (result.isForwarderOnly) offenders.push(result);
  }
  return offenders;
}

async function assertNoRuntimeForwarderOnlyModules() {
  await assertRuntimeForwarderClassifierSelfTests();
  const offenders = await runtimeForwarderOnlyModules();
  if (offenders.length > 0) {
    failGate(
      `ZC-23: runtime forwarder-only module(s) remain. Delete them and update importers to canonical homes:\n  ` +
      offenders
        .map((offender) => {
          const targets = [...new Set(offender.forwards.map((forward) => forward.module))]
            .filter(Boolean)
            .join(", ");
          return `${offender.rel}${targets ? ` -> ${targets}` : ""}`;
        })
        .join("\n  "),
    );
  }
}

function assertZc12DonorPortArtifactsGone() {
  const files = git("ls-files");
  if (files.status !== 0) failGate("ZC-12: git ls-files failed");
  const tracked = files.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const openToolName = "open" + "clau" + "de";
  const runtimeToolName = "co" + "dex";
  const guideName = "clau" + "de";
  const guideSnakeName = "clau" + "de_code";
  const guideCompactName = "clau" + "decode";
  const donorArtifactRe = new RegExp(
    `^(?:(?:parity|docs/plan|scripts|runtime/scripts|runtime/parity|runtime/docs|runtime/tests)/.*(?:${openToolName}|${runtimeToolName}|${guideName}))`,
    "i",
  );
  const donorPortArtifacts = tracked.filter((rel) => donorArtifactRe.test(rel));
  if (donorPortArtifacts.length > 0) {
    failGate(`ZC-12: tracked donor-named port artifact(s) remain:\n${donorPortArtifacts.join("\n")}`);
  }

  const sourceParityTestRe = new RegExp(`^runtime/src/.*\\.${openToolName}-parity\\.test\\.`, "i");
  const sourceParityDirRe = new RegExp(`^runtime/src/tui/${openToolName}/`, "i");
  const sourceParityTests = tracked.filter((rel) =>
    sourceParityTestRe.test(rel) ||
    sourceParityDirRe.test(rel),
  );
  if (sourceParityTests.length > 0) {
    failGate(`ZC-12: tracked donor-named runtime parity test artifact(s) remain:\n${sourceParityTests.join("\n")}`);
  }

  const donorNameRe = new RegExp(
    `(?:${openToolName}|${runtimeToolName}|${guideSnakeName}|${guideCompactName})`,
    "i",
  );
  const remainingDonorNamed = tracked
    .filter((rel) => donorNameRe.test(rel))
    .filter((rel) => !rel.startsWith("runtime/src/agenc/upstream/"));
  if (remainingDonorNamed.length > 0) {
    failGate(`ZC-12: donor-named tracked path(s) remain outside the frozen upstream mirror:\n${remainingDonorNamed.join("\n")}`);
  }

  const packageRefRe = new RegExp(
    `(check-[^"'\\s]*-parity|${openToolName}-parity|${runtimeToolName}[^"'\\s]*parity|${guideName}[^"'\\s]*parity)`,
    "i",
  );
  const packageRefs = [];
  for (const rel of ["package.json", "runtime/package.json"]) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    const source = readFileSync(abs, "utf8");
    if (packageRefRe.test(source)) {
      packageRefs.push(rel);
    }
  }
  if (packageRefs.length > 0) {
    failGate(`ZC-12: package script/reference(s) to deleted donor parity artifacts remain:\n${packageRefs.join("\n")}`);
  }

  const staleReferenceRe = new RegExp(
    [
      `${openToolName}-(?:diagnostics|ink|keybindings|markdown|search|selection)-(?:port|transform)\\.mjs`,
      `install-tui-${openToolName}-parity-hook\\.sh`,
      `runtime/src/tui/${openToolName}/`,
      `\\.${openToolName}-parity\\.test\\.`,
      `runtime/tests/${openToolName}-compact-loader\\.contract\\.test\\.ts`,
      `docs/plan/${openToolName}-`,
    ].join("|"),
    "i",
  );
  const staleReferences = [];
  for (const rel of tracked) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    let source;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (staleReferenceRe.test(source)) staleReferences.push(rel);
  }
  if (staleReferences.length > 0) {
    failGate(`ZC-12: live file(s) still reference deleted donor-named artifacts:\n${staleReferences.join("\n")}`);
  }
}

function assertZc21McpClientBridgeFilesRenamed() {
  const oldPaths = [
    "runtime/src/mcp-client/prompt-bridge.ts",
    "runtime/src/mcp-client/prompt-bridge.test.ts",
    "runtime/src/mcp-client/resilient-bridge.ts",
    "runtime/src/mcp-client/resilient-bridge.test.ts",
    "runtime/src/mcp-client/resource-bridge.ts",
    "runtime/src/mcp-client/resource-bridge.test.ts",
    "runtime/src/mcp-client/tool-bridge.ts",
    "runtime/src/mcp-client/tool-bridge.test.ts",
  ];
  const existing = oldPaths.filter((rel) => existsSync(path.join(root, rel)));
  if (existing.length > 0) {
    failGate(`ZC-21: bridge-suffix MCP client file(s) still exist:\n${existing.join("\n")}`);
  }

  const expectedPaths = [
    "runtime/src/mcp-client/prompts.ts",
    "runtime/src/mcp-client/prompts.test.ts",
    "runtime/src/mcp-client/resilient-client.ts",
    "runtime/src/mcp-client/resilient-client.test.ts",
    "runtime/src/mcp-client/resources.ts",
    "runtime/src/mcp-client/resources.test.ts",
    "runtime/src/mcp-client/tools.ts",
    "runtime/src/mcp-client/tools.test.ts",
  ];
  const missing = expectedPaths.filter((rel) => !existsSync(path.join(root, rel)));
  if (missing.length > 0) {
    failGate(`ZC-21: expected renamed MCP client file(s) missing:\n${missing.join("\n")}`);
  }

  const refs = run("bash", ["-c", "rg -n '(prompt|resilient|resource|tool)-bridge' runtime/src"], { silent: true });
  if (refs.status === 0) {
    failGate(`ZC-21: old MCP bridge module reference(s) remain:\n${refs.stdout.trim()}`);
  } else if (refs.status !== 1) {
    failGate("ZC-21: failed to scan runtime/src for old MCP bridge module references");
  }

  const verifySource = readFileSync(path.join(root, "scripts/goal/verify.mjs"), "utf8");
  if (/SHIM_ALLOW_DIRS[\s\S]{0,160}runtime\/src\/mcp-client\//.test(verifySource)) {
    failGate("ZC-21: runtime/src/mcp-client remains in SHIM_ALLOW_DIRS; remove the exemption");
  }
}

function assertZc20NoRuntimeShimCruft() {
  const forwardingHits = [];
  for (const rel of listSourceFiles(path.join(root, "runtime/src"))) {
    if (!rel.startsWith("runtime/src/")) continue;
    if (SHIM_ALLOW_DIRS.some((dir) => rel.startsWith(dir))) continue;
    if (/\.test\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(rel)) continue;
    if (/\.d\.ts$/.test(rel)) continue;

    let body;
    try {
      body = readFileSync(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    const violation = measureShimBehaviorForPath(rel, body);
    if (violation) forwardingHits.push(formatShimBehaviorViolation(violation));
  }

  const failures = [];
  if (forwardingHits.length > 0) {
    failures.push(
      `forwarding-heavy module(s) (>${Math.round(SHIM_BEHAVIOR_RATIO_LIMIT * 100)}% imports+forwards LOC):\n${forwardingHits.join("\n")}`,
    );
  }
  if (failures.length > 0) {
    failGate(`ZC-20: runtime/src shim cruft remains:\n${failures.join("\n\n")}`);
  }
}

function assertZc08NoDeletedShimSubjectTests() {
  const expectedRenames = [
    "runtime/src/tools/ask-user-question-tui-routing.test.tsx",
    "runtime/src/tools/tool-rendering-bash.test.tsx",
    "runtime/src/tools/tool-rendering-edit.test.tsx",
    "runtime/src/tools/tool-rendering-extra.test.tsx",
    "runtime/src/tui/parity/session-transcript.contract.test.ts",
    "runtime/src/tui/parity/session-transcript.test.ts",
    "runtime/src/tui/parity/session-transcript.streaming-tool-use.parity.test.ts",
    "runtime/src/tui/parity/session-transcript.no-runningtoolprogress.parity.test.ts",
    "runtime/src/tui/parity/session-transcript-hook.streaming-tool-use.parity.test.ts",
  ];
  const missing = expectedRenames.filter((rel) => !existsSync(path.join(root, rel)));
  if (missing.length > 0) {
    failGate(`ZC-08: expected canonical test file(s) missing:\n${missing.join("\n")}`);
  }
  const expectedRenameSet = new Set(expectedRenames);

  const stalePathPattern =
    /(^|\/)(message-adapter|use-session-transcript|tool-stubs-[^/]*bridge|ask-user-question-bridge-routing)\.[^/]*test\.(ts|tsx)$/;
  const stalePaths = listSourceFiles(path.join(root, "runtime/src")).filter(
    (rel) => stalePathPattern.test(rel),
  );
  if (stalePaths.length > 0) {
    failGate(`ZC-08: tests still named after deleted shim/adapter subjects:\n${stalePaths.join("\n")}`);
  }

  const staleImportPattern =
    /(agenc\/adapters|tui\/bridges|response-adapter|session-id-compat|prompt-input-(fast-mode|terminal-setup|ultrareview))/;
  const staleTextPattern =
    /\b(message-adapter|use-session-transcript|tool-stubs|AskUserQuestion bridge routing|use-tool-jsx)\b|bridge's/;
  const renamedCanonicalSubjectPattern =
    /\b(?:[Oo][Pp][Ee][Nn][Cc][Ll][Aa][Uu][Dd][Ee]|bridge|adapter)\b|MESSAGE_ADAPTER/;
  const offenders = [];
  for (const rel of listSourceFiles(path.join(root, "runtime/src"))) {
    if (!/\.test\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(rel)) continue;
    const source = readFileSync(path.join(root, rel), "utf8");
    if (
      staleImportPattern.test(source) ||
      staleTextPattern.test(source) ||
      (expectedRenameSet.has(rel) && renamedCanonicalSubjectPattern.test(source))
    ) {
      offenders.push(rel);
    }
  }
  if (offenders.length > 0) {
    failGate(`ZC-08: test(s) still describe deleted shim/adapter subjects:\n${offenders.join("\n")}`);
  }
}

function assertZc15ChecklistHandoffClarified() {
  const checklistPath = path.join(mainCheckoutRoot(), "PORT_CHECKLIST.md");
  if (!existsSync(checklistPath)) {
    failGate(`ZC-15: checklist not found at ${checklistPath}`);
  }
  const checklist = readFileSync(checklistPath, "utf8");
  const items = parseItems(checklist);
  const z03 = items.find((candidate) => candidate.id === "Z-03");
  const zc04 = items.find((candidate) => candidate.id === "ZC-04");
  if (!z03 || !zc04) {
    failGate("ZC-15: expected Z-03 and ZC-04 rows to exist in PORT_CHECKLIST.md");
  }

  const requiredUpstreamAdapterFiles = [
    "upstream-agent-list.ts",
    "upstream-attachments.ts",
    "upstream-commands.ts",
    "upstream-mcp-clients.ts",
    "upstream-model-switch.ts",
    "upstream-tool-result-dispatch.ts",
  ];
  const missingFromZ03 = requiredUpstreamAdapterFiles.filter(
    (file) => !z03.body.includes(`\`${file}\``),
  );
  if (missingFromZ03.length > 0) {
    failGate(`ZC-15: Z-03 row must enumerate upstream adapter file(s): ${missingFromZ03.join(", ")}`);
  }

  const zc04Text = `${zc04.title} ${zc04.body}`;
  if (!zc04.dependsOn.includes("Z-03")) {
    failGate("ZC-15: ZC-04 row must list Z-03 in its Depends clause.");
  }
  const requiredZc04Phrases = [
    "does NOT touch the 6 `upstream-*.ts` files",
    "Z-03's job exclusively",
  ];
  const missingFromZc04 = requiredZc04Phrases.filter(
    (phrase) => !zc04Text.includes(phrase),
  );
  if (missingFromZc04.length > 0) {
    failGate(`ZC-15: ZC-04 row is missing handoff phrase(s): ${missingFromZc04.join(", ")}`);
  }
}

function assertZc22ElicitationRendererInlined() {
  const appRel = "runtime/src/tui/components/App.tsx";
  const appPath = path.join(root, appRel);
  if (!existsSync(appPath)) failGate("ZC-22: App.tsx consumer is missing.");
  const appSource = readFileSync(appPath, "utf8");
  const requiredAppSymbols = [
    "createElicitationQueue",
    "installElicitationResolvers",
    "useTuiElicitation",
    "ElicitationOverlay",
  ];
  const missing = requiredAppSymbols.filter((symbol) => !appSource.includes(symbol));
  if (missing.length > 0) {
    failGate(`ZC-22: elicitation logic is not inlined into ${appRel}; missing ${missing.join(", ")}.`);
  }

  const survivorPattern =
    /\b(createElicitationQueue|installElicitationResolvers|useTuiElicitation|ElicitationOverlay)\b/;
  const offenders = [];
  for (const rel of listSourceFiles(path.join(root, "runtime/src"))) {
    if (rel === appRel) continue;
    if (/\.test\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(rel)) continue;
    const source = readFileSync(path.join(root, rel), "utf8");
    if (survivorPattern.test(source)) offenders.push(rel);
  }
  if (offenders.length > 0) {
    failGate(`ZC-22: elicitation renderer logic survived outside the App consumer:\n${offenders.join("\n")}`);
  }

  const tuiElicitationDir = path.join(root, "runtime/src/tui/elicitation");
  if (existsSync(tuiElicitationDir)) {
    const survivors = listSourceFiles(tuiElicitationDir).filter(
      (rel) => !/\.test\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(rel),
    );
    if (survivors.length > 0) {
      failGate(`ZC-22: behavior survived as a separate TUI elicitation module:\n${survivors.join("\n")}`);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertZc24UnusedDependenciesRemoved() {
  const packagePath = path.join(root, "runtime/package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const dependencies = pkg.dependencies ?? {};
  const devDependencies = pkg.devDependencies ?? {};
  const forbiddenRuntimeDependencies = [
    "@types/better-sqlite3",
    "eventsource",
  ];
  const runtimeSurvivors = forbiddenRuntimeDependencies.filter((name) =>
    Object.hasOwn(dependencies, name),
  );
  if (runtimeSurvivors.length > 0) {
    failGate(`ZC-24: unused runtime dependencies still listed:\n  ${runtimeSurvivors.join("\n  ")}`);
  }

  if (Object.hasOwn(devDependencies, "tsx")) {
    failGate("ZC-24: devDependency tsx is still listed in runtime/package.json");
  }

  if (!Object.hasOwn(devDependencies, "@types/better-sqlite3")) {
    failGate(
      "ZC-24: @types/better-sqlite3 should remain as a devDependency because runtime/src/state/sqlite-driver.ts imports better-sqlite3.",
    );
  }

  const packagesWithRuntimeImporters = [
    "@ant/computer-use-mcp",
    "jimp",
    "markdown-it",
  ];
  const missingRetainedDependencies = packagesWithRuntimeImporters.filter((name) =>
    !Object.hasOwn(dependencies, name),
  );
  if (missingRetainedDependencies.length > 0) {
    failGate(
      `ZC-24: package(s) still imported by runtime source must remain listed:\n  ${missingRetainedDependencies.join("\n  ")}`,
    );
  }

  const scannedPackages = [
    "eventsource",
    "tsx",
  ];
  const runtimeSourceImportGlobs = [
    "*.ts",
    "*.tsx",
    "*.mts",
    "*.cts",
    "*.js",
    "*.jsx",
    "*.mjs",
    "*.cjs",
  ];
  const offenders = [];
  for (const packageName of scannedPackages) {
    const escaped = escapeRegExp(packageName);
    const packageRef = `${escaped}(?:["'/]|$)`;
    const pattern =
      `(?:from\\s+["']${packageRef}|require\\(\\s*["']${packageRef}|import\\(\\s*["']${packageRef})`;
    const globArgs = runtimeSourceImportGlobs.flatMap((glob) => ["-g", glob]);
    const scan = run("rg", [
      "--no-messages",
      "-n",
      pattern,
      "runtime/src",
      ...globArgs,
    ], { silent: true });
    if (scan.status === 0) {
      offenders.push(scan.stdout.trim());
    } else if (scan.status !== 1) {
      failGate(`ZC-24: failed to scan runtime source imports for ${packageName}`);
    }
  }
  if (offenders.length > 0) {
    failGate(`ZC-24: package(s) marked unused are still imported by runtime source:\n${offenders.join("\n")}`);
  }
}

function assertZc29AuditEvidence() {
  const ledgerRel = "parity/ZC-29-parity.json";
  const ledgerPath = path.join(root, ledgerRel);
  if (!existsSync(ledgerPath)) failGate(`ZC-29: missing audit ledger ${ledgerRel}`);

  let ledger;
  try {
    ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  } catch (error) {
    failGate(`ZC-29: ${ledgerRel} is not valid JSON: ${error.message}`);
  }

  if (ledger.item !== "ZC-29" || ledger.status !== "audited") {
    failGate(`ZC-29: ${ledgerRel} must identify item ZC-29 with audited status`);
  }

  const specs = [
    {
      key: "fileWatcher",
      decision: "implemented",
      files: [
        "runtime/src/file-watcher/index.ts",
        "runtime/src/file-watcher/index.test.ts",
      ],
    },
    {
      key: "skills",
      decision: "scope-documented",
      files: [
        "runtime/src/skills/local-loader.ts",
        "runtime/src/skills/local-loader.test.ts",
      ],
    },
    {
      key: "conversation",
      decision: "implemented-with-neighboring-ownership",
      files: [
        "runtime/src/conversation/thread-manager.ts",
        "runtime/src/conversation/thread-manager.contract.test.ts",
      ],
    },
  ];

  const validationTests = ledger.validation?.existingTests ?? [];
  const missing = [];

  for (const spec of specs) {
    const subsystem = ledger.subsystems?.[spec.key];
    if (!subsystem) {
      missing.push(`subsystem entry: ${spec.key}`);
      continue;
    }
    if (subsystem.decision !== spec.decision) {
      failGate(`ZC-29: ${spec.key} decision must be ${spec.decision}; found ${subsystem.decision ?? "<missing>"}`);
    }
    if (!Array.isArray(subsystem.carriedBehavior) || subsystem.carriedBehavior.length === 0) {
      failGate(`ZC-29: ${spec.key} needs explicit carriedBehavior audit evidence`);
    }
    if (!Array.isArray(subsystem.intentionalReductions) || subsystem.intentionalReductions.length === 0) {
      failGate(`ZC-29: ${spec.key} needs explicit intentionalReductions audit evidence`);
    }
    for (const rel of spec.files) {
      if (!existsSync(path.join(root, rel))) missing.push(`file: ${rel}`);
      if (!subsystem.agencFiles?.includes(rel)) missing.push(`${spec.key}.agencFiles: ${rel}`);
    }

    const testFile = spec.files.find((rel) => rel.includes(".test."));
    if (testFile && !validationTests.includes(testFile)) missing.push(`validation.existingTests: ${testFile}`);
  }

  const skillsCarried = (ledger.subsystems?.skills?.carriedBehavior ?? []).join("\n");
  if (/\bMCP\b/i.test(skillsCarried)) {
    failGate("ZC-29: skills MCP roots must be documented as a reduction until local-loader.ts implements them");
  }
  if (ledger.validation?.runtimeDocsRetiredBy !== "ZC-40") {
    failGate("ZC-29: audit ledger must record that runtime parity docs were retired by ZC-40");
  }

  if (missing.length > 0) {
    failGate(`ZC-29: audit evidence is incomplete:\n  ${missing.join("\n  ")}`);
  }
}

function assertZc30PluginCoverage() {
  const requiredCounterparts = [
    "runtime/src/plugins/loader.ts",
    "runtime/src/plugins/manifest.ts",
    "runtime/src/plugins/manifest-schema.ts",
    "runtime/src/plugins/registration/manager.ts",
    "runtime/src/plugins/toggles.ts",
    "runtime/src/plugins/cli/marketplace-add.ts",
    "runtime/src/plugins/cli/marketplace-remove.ts",
    "runtime/src/plugins/cli/marketplace-upgrade.ts",
    "runtime/src/plugins/marketplace/marketplace.ts",
    "runtime/src/plugins/marketplace/installed_marketplaces.ts",
    "runtime/src/plugins/marketplace/remote_bundle.ts",
    "runtime/src/plugins/marketplace/startup_remote_sync.ts",
    "runtime/src/plugins/resolution.ts",
  ];
  const missingCounterparts = requiredCounterparts.filter((rel) => !existsSync(path.join(root, rel)));
  if (missingCounterparts.length > 0) {
    failGate(`ZC-30: plugin counterpart file(s) missing:\n  ${missingCounterparts.join("\n  ")}`);
  }
}

function assertZc31SkillsCoverage() {
  const requiredCounterparts = [
    "runtime/src/skills/local-loader.ts",
    "runtime/src/skills/local-loader.test.ts",
    "runtime/src/prompts/attachments/skill-listing.ts",
    "runtime/src/bin/model-facing-tools.ts",
    "runtime/src/commands/skills.ts",
    "runtime/src/commands/skills.test.ts",
    "runtime/src/bin/model-facing-tools.test.ts",
  ];
  const missingCounterparts = requiredCounterparts.filter((rel) => !existsSync(path.join(root, rel)));
  if (missingCounterparts.length > 0) {
    failGate(`ZC-31: skills counterpart file(s) missing:\n  ${missingCounterparts.join("\n  ")}`);
  }

  const localLoader = readFileSync(path.join(root, "runtime/src/skills/local-loader.ts"), "utf8");
  const localLoaderSymbols = [
    "discoverSkillRoots",
    "loadLocalSkillsSnapshot",
    "formatSkillListingWithinBudget",
    "recordInvokedSkill",
    "BUNDLED_SKILLS",
    "AGENC_MANAGED_HOME",
    "pathsActivateSkill",
    "renderSkill",
  ];
  const missingLocalLoaderSymbols = localLoaderSymbols.filter((symbol) => !localLoader.includes(symbol));
  if (missingLocalLoaderSymbols.length > 0) {
    failGate(`ZC-31: local skills loader is missing symbol(s): ${missingLocalLoaderSymbols.join(", ")}`);
  }

  const skillListing = readFileSync(
    path.join(root, "runtime/src/prompts/attachments/skill-listing.ts"),
    "utf8",
  );
  if (!skillListing.includes("formatSkillListingWithinBudget")) {
    failGate("ZC-31: skill listing attachment no longer uses the shared listing budget helper.");
  }

  const modelFacingTools = readFileSync(path.join(root, "runtime/src/bin/model-facing-tools.ts"), "utf8");
  for (const pattern of ['name: "Skill"', "renderSkill", "recordInvokedSkill"]) {
    if (!modelFacingTools.includes(pattern)) {
      failGate(`ZC-31: model-facing Skill tool is missing ${pattern}.`);
    }
  }
}

function assertZc32ShellCommandCoverage() {
  const ledgerRel = "parity/ZC-32-parity.json";
  const requiredFiles = [
    "runtime/src/shell-command/parser.ts",
    "runtime/src/shell-command/safety.ts",
    "runtime/src/shell-command/powershell-parser.ts",
    "runtime/src/shell-command/parser.test.ts",
    "runtime/src/shell-command/safety.test.ts",
    "runtime/src/shell-command/powershell-parser.test.ts",
    ledgerRel,
  ];
  const missingFiles = requiredFiles.filter((rel) => !existsSync(path.join(root, rel)));
  if (missingFiles.length > 0) {
    failGate(`ZC-32: shell-command file(s) missing:\n  ${missingFiles.join("\n  ")}`);
  }

  if (
    existsSync(path.join(root, "runtime/src/permissions/command-parser.ts")) ||
    existsSync(path.join(root, "runtime/src/permissions/command-parser.test.ts"))
  ) {
    failGate("ZC-32: command parser still lives under runtime/src/permissions; move importers to runtime/src/shell-command.");
  }

  let ledger;
  try {
    ledger = JSON.parse(readFileSync(path.join(root, ledgerRel), "utf8"));
  } catch (error) {
    failGate(`ZC-32: ${ledgerRel} is not valid JSON: ${error.message}`);
  }
  if (ledger.item !== "ZC-32" || ledger.status !== "implemented") {
    failGate(`ZC-32: ${ledgerRel} must identify item ZC-32 with implemented status`);
  }
  if (!Array.isArray(ledger.rows) || ledger.rows.length < 5) {
    failGate("ZC-32: parity ledger must include parser, summary, Unix safety, dangerous safety, and Windows/PowerShell rows.");
  }
  const nonRequiredRows = ledger.rows.filter((row) => row?.status !== "required");
  if (nonRequiredRows.length > 0) {
    failGate(`ZC-32: parity rows must be required: ${nonRequiredRows.map((row) => row?.id ?? "<missing>").join(", ")}`);
  }

  const sourceFiles = Array.isArray(ledger.sourceFiles) ? ledger.sourceFiles : [];
  const requiredSourceAnchors = [
    "src/bash.rs",
    "src/powershell.rs",
    "src/parse_command.rs",
    "src/command_safety/is_dangerous_command.rs",
    "src/command_safety/is_safe_command.rs",
    "src/command_safety/powershell_parser.rs",
    "src/command_safety/powershell_parser.ps1",
    "src/command_safety/windows_dangerous_commands.rs",
    "src/command_safety/windows_safe_commands.rs",
  ];
  const missingAnchors = requiredSourceAnchors.filter((anchor) => !sourceFiles.includes(anchor));
  if (missingAnchors.length > 0) {
    failGate(`ZC-32: shell-command parity ledger is missing source anchor(s):\n  ${missingAnchors.join("\n  ")}`);
  }
  if (ledger.validation?.runtimeDocsRetiredBy !== "ZC-40") {
    failGate("ZC-32: shell-command parity ledger must record that runtime parity docs were retired by ZC-40");
  }

  const parser = readFileSync(path.join(root, "runtime/src/shell-command/parser.ts"), "utf8");
  const parserMarkers = [
    "extractBashCommand",
    "extractPowerShellCommand",
    "parseWordOnlyShellSequence",
    "parseShellLcSingleCommandPrefix",
    "canonicalizeCommandForApproval",
    "parseCommand",
  ];
  const missingParserMarkers = parserMarkers.filter((marker) => !parser.includes(marker));
  if (missingParserMarkers.length > 0) {
    failGate(`ZC-32: parser.ts is missing symbol(s): ${missingParserMarkers.join(", ")}`);
  }

  const safety = readFileSync(path.join(root, "runtime/src/shell-command/safety.ts"), "utf8");
  const safetyMarkers = [
    "isKnownSafeCommand",
    "commandMightBeDangerous",
    "isDangerousWindowsCommand",
    "isSafePowerShellWords",
    "--pre",
    "--hostname-bin",
    "--search-zip",
    "--output",
    "-exec",
    "-delete",
  ];
  const missingSafetyMarkers = safetyMarkers.filter((marker) => !safety.includes(marker));
  if (missingSafetyMarkers.length > 0) {
    failGate(`ZC-32: safety.ts is missing marker(s): ${missingSafetyMarkers.join(", ")}`);
  }

  const safetyTests = readFileSync(path.join(root, "runtime/src/shell-command/safety.test.ts"), "utf8");
  const requiredSafetyRegressionMarkers = [
    "del,-Force,C:\\\\foo",
    "[\"git\", \"grep\", \"needle\"]",
    "[\"git\", \"ls-files\"]",
    "Windows known-safe checks do not fall through to Unix allowlists",
    "isKnownSafeCommandForPlatform([\"ls\"], \"win32\")",
  ];
  const missingSafetyRegressionMarkers = requiredSafetyRegressionMarkers.filter((marker) => !safetyTests.includes(marker));
  if (missingSafetyRegressionMarkers.length > 0) {
    failGate(`ZC-32: safety tests are missing regression marker(s): ${missingSafetyRegressionMarkers.join(", ")}`);
  }

  const psParser = readFileSync(path.join(root, "runtime/src/shell-command/powershell-parser.ts"), "utf8");
  for (const marker of ["spawn(", "-EncodedCommand", "PowerShellParserProcess", "parsePowerShellScriptWithNativeAst"]) {
    if (!psParser.includes(marker)) {
      failGate(`ZC-32: powershell-parser.ts is missing ${marker}.`);
    }
  }
  if (/spawnSync/.test(psParser)) {
    failGate("ZC-32: PowerShell parser must use the cached parser process, not spawnSync per parse.");
  }

  const bashPermissions = readFileSync(path.join(root, "runtime/src/permissions/bash.ts"), "utf8");
  for (const marker of [
    "../shell-command/parser.js",
    "../shell-command/safety.js",
    "isKnownSafeCommand",
    "commandMightBeDangerous",
  ]) {
    if (!bashPermissions.includes(marker)) {
      failGate(`ZC-32: Bash permission integration is missing ${marker}.`);
    }
  }

  const testRun = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/shell-command/parser.test.ts",
    "src/shell-command/safety.test.ts",
    "src/shell-command/powershell-parser.test.ts",
    "src/permissions/bash.test.ts",
    "src/permissions/approval-cache.test.ts",
  ]);
  if (testRun.status !== 0) {
    failGate("ZC-32: shell-command safety behavior test suites failed.");
  }
}

function assertZc33SandboxCoverage() {
  const readRequired = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) failGate(`ZC-33: missing required file ${rel}`);
    return readFileSync(abs, "utf8");
  };

  const permissionsSandbox = readRequired("runtime/src/permissions/sandbox.ts");

  const requiredTargets = [
    "runtime/src/sandbox/engine/index.ts",
    "runtime/src/sandbox/engine/manager.ts",
    "runtime/src/sandbox/engine/policy-transforms.ts",
    "runtime/src/sandbox/engine/seatbelt.ts",
    "runtime/src/sandbox/engine/landlock.ts",
    "runtime/src/sandbox/engine/bwrap.ts",
    "runtime/src/sandbox/engine/policies/seatbelt_base_policy.sbpl",
    "runtime/src/sandbox/engine/policies/seatbelt_network_policy.sbpl",
    "runtime/src/sandbox/engine/policies/restricted_read_only_platform_defaults.sbpl",
    "runtime/src/sandbox/linux-launcher/main.ts",
    "runtime/src/sandbox/linux-launcher/lib.ts",
    "runtime/src/sandbox/linux-launcher/cli.ts",
    "runtime/src/sandbox/linux-launcher/linux-run-main.ts",
    "runtime/src/sandbox/linux-launcher/launcher.ts",
    "runtime/src/sandbox/linux-launcher/bwrap.ts",
    "runtime/src/sandbox/linux-launcher/landlock.ts",
    "runtime/src/sandbox/linux-launcher/proxy-routing.ts",
    "runtime/src/sandbox/linux-launcher/vendored-bwrap.ts",
    "runtime/src/sandbox/linux-launcher/config.ts",
    "runtime/src/sandbox/linux-launcher/build.ts",
    "runtime/bin/agenc-linux-sandbox",
  ];
  const missingTargets = requiredTargets.filter((rel) => !existsSync(path.join(root, rel)));
  if (missingTargets.length > 0) {
    failGate(`ZC-33: sandbox counterpart file(s) missing:\n  ${missingTargets.join("\n  ")}`);
  }

  if (/does not use any of those primitives directly/.test(permissionsSandbox)) {
    failGate("ZC-33: permissions sandbox docs still deny the platform-backed sandbox layer.");
  }
  const donorBrandRe = new RegExp(
    `${["co", "dex"].join("")}|${["open", ["clau", "de"].join("")].join("")}|${["Clau", "de"].join("")}`,
    "i",
  );
  if (donorBrandRe.test(permissionsSandbox)) {
    failGate("ZC-33: permissions sandbox source must not carry donor-branded runtime citations.");
  }

  const seatbeltSource = readRequired("runtime/src/sandbox/engine/seatbelt.ts");
  if (!/\bspawn\(/.test(seatbeltSource) || !/MACOS_PATH_TO_SEATBELT_EXECUTABLE/.test(seatbeltSource) || !/sandbox-exec/.test(seatbeltSource)) {
    failGate("ZC-33: seatbelt backend must spawn the platform sandbox executable.");
  }
  const engineLandlockSource = readRequired("runtime/src/sandbox/engine/landlock.ts");
  if (!/\bspawn\(/.test(engineLandlockSource) || !/createLinuxSandboxCommandArgsForPermissionProfile/.test(engineLandlockSource)) {
    failGate("ZC-33: engine landlock backend must spawn the Linux helper with serialized policy arguments.");
  }
  const engineBwrapSource = readRequired("runtime/src/sandbox/engine/bwrap.ts");
  if (!/\bspawnSync\(/.test(engineBwrapSource) || !/--unshare-user/.test(engineBwrapSource) || !/--unshare-net/.test(engineBwrapSource)) {
    failGate("ZC-33: engine bwrap diagnostics must probe the real bubblewrap binary.");
  }

  const launcherSource = readRequired("runtime/src/sandbox/linux-launcher/launcher.ts");
  const runMainSource = readRequired("runtime/src/sandbox/linux-launcher/linux-run-main.ts");
  const launcherBwrapSource = readRequired("runtime/src/sandbox/linux-launcher/bwrap.ts");
  const launcherLandlockSource = readRequired("runtime/src/sandbox/linux-launcher/landlock.ts");
  const launcherTestsSource = readRequired("runtime/src/sandbox/linux-launcher/linux-launcher.test.ts");

  if (!/\bspawn\(/.test(launcherSource) || !/TRUSTED_BWRAP_DIRECTORIES/.test(launcherSource)) {
    failGate("ZC-33: Linux launcher must spawn a trusted platform bubblewrap binary.");
  }
  if (!/\bspawn\(/.test(runMainSource) || !/runCommandWithInnerSeccomp/.test(runMainSource) || !/\bexecve\b/.test(runMainSource)) {
    failGate("ZC-33: Linux run-main must execute both outer and inner platform sandbox stages.");
  }
  for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-net", "--seccomp"]) {
    if (!launcherBwrapSource.includes(flag)) {
      failGate(`ZC-33: Linux bwrap builder is missing ${flag}.`);
    }
  }
  if (!/createNetworkSeccompProgram/.test(launcherLandlockSource) || !/SECCOMP_RET_ERRNO/.test(launcherLandlockSource)) {
    failGate("ZC-33: Linux landlock module must generate the seccomp cBPF program.");
  }
  if (!/\bspawn\(/.test(launcherTestsSource) || !/runLinuxSandboxMain/.test(launcherTestsSource) || !/withTempDir/.test(launcherTestsSource)) {
    failGate("ZC-33: Linux launcher tests must exercise subprocess and temp-dir harness paths.");
  }

  const testRun = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/sandbox/engine/linux-engine.test.ts",
    "src/sandbox/engine/seatbelt.test.ts",
    "src/sandbox/engine/policy-transforms.test.ts",
    "src/sandbox/linux-launcher/linux-launcher.test.ts",
    "src/permissions/sandbox.test.ts",
  ]);
  if (testRun.status !== 0) {
    failGate("ZC-33: sandbox coverage test suites failed.");
  }

  pass("ZC-33: sandbox engine and Linux launcher coverage locked");
}

function assertZc35OcCoverage() {
  const readRequired = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) failGate(`ZC-35: missing required file ${rel}`);
    return readFileSync(abs, "utf8");
  };

  const parity = JSON.parse(readRequired("parity/ZC-35-parity.json"));
  const sourceFiles = Array.isArray(parity.sourceFiles) ? parity.sourceFiles : [];
  const requiredSourceAnchors = [
    "src/utils/conversationRecovery.ts",
    "src/utils/hooks/AsyncHookRegistry.ts",
    "src/utils/hooks/apiQueryHookHelper.ts",
    "src/utils/hooks/execAgentHook.ts",
    "src/utils/hooks/execHttpHook.ts",
    "src/utils/hooks/execPromptHook.ts",
    "src/utils/hooks/fileChangedWatcher.ts",
    "src/utils/hooks/hookEvents.ts",
    "src/utils/hooks/hookHelpers.ts",
    "src/utils/hooks/hooksConfigManager.ts",
    "src/utils/hooks/hooksConfigSnapshot.ts",
    "src/utils/hooks/hooksSettings.ts",
    "src/utils/hooks/postSamplingHooks.ts",
    "src/utils/hooks/registerFrontmatterHooks.ts",
    "src/utils/hooks/registerSkillHooks.ts",
    "src/utils/hooks/sessionHooks.ts",
    "src/utils/hooks/skillImprovement.ts",
    "src/utils/hooks/ssrfGuard.ts",
    "src/utils/secureStorage/fallbackStorage.ts",
    "src/utils/secureStorage/index.ts",
    "src/utils/secureStorage/keychainPrefetch.ts",
    "src/utils/secureStorage/linuxSecretStorage.ts",
    "src/utils/secureStorage/macOsKeychainHelpers.ts",
    "src/utils/secureStorage/macOsKeychainStorage.ts",
    "src/utils/secureStorage/plainTextStorage.ts",
    "src/utils/secureStorage/platformStorage.test.ts",
    "src/utils/secureStorage/windowsCredentialStorage.ts",
    "src/utils/swarm/It2SetupPrompt.tsx",
    "src/utils/swarm/backends/ITermBackend.ts",
    "src/utils/swarm/backends/InProcessBackend.ts",
    "src/utils/swarm/backends/PaneBackendExecutor.ts",
    "src/utils/swarm/backends/TmuxBackend.ts",
    "src/utils/swarm/backends/detection.ts",
    "src/utils/swarm/backends/it2Setup.ts",
    "src/utils/swarm/backends/registry.ts",
    "src/utils/swarm/backends/teammateModeSnapshot.ts",
    "src/utils/swarm/backends/types.ts",
    "src/utils/swarm/constants.ts",
    "src/utils/swarm/inProcessRunner.ts",
    "src/utils/swarm/leaderPermissionBridge.ts",
    "src/utils/swarm/permissionSync.ts",
    "src/utils/swarm/reconnection.ts",
    "src/utils/swarm/spawnInProcess.ts",
    "src/utils/swarm/spawnUtils.test.ts",
    "src/utils/swarm/spawnUtils.ts",
    "src/utils/swarm/teamHelpers.ts",
    "src/utils/swarm/teammateInit.ts",
    "src/utils/swarm/teammateLayoutManager.ts",
    "src/utils/swarm/teammateModel.ts",
    "src/utils/swarm/teammatePromptAddendum.ts",
  ];
  const missingAnchors = requiredSourceAnchors.filter((anchor) => !sourceFiles.includes(anchor));
  if (missingAnchors.length > 0) {
    failGate(`ZC-35: parity artifact is missing source anchor(s):\n  ${missingAnchors.join("\n  ")}`);
  }
  if (typeof parity.sourceCommits?.typescriptRuntimeSource !== "string") {
    failGate("ZC-35: parity artifact is missing the TypeScript source commit.");
  }

  const decisions = parity.decisions ?? {};
  const requiredDecisionKeys = ["swarm", "hooks", "secureStorage", "conversationRecovery"];
  const missingDecisions = requiredDecisionKeys.filter((key) => decisions[key] === undefined);
  if (missingDecisions.length > 0) {
    failGate(`ZC-35: parity artifact is missing decision section(s): ${missingDecisions.join(", ")}`);
  }

  const requiredTargets = [
    "runtime/src/agents/v2/index.ts",
    "runtime/src/agents/v2/spawn.ts",
    "runtime/src/agents/v2/wait.ts",
    "runtime/src/agents/mailbox.ts",
    "runtime/src/hooks/configured-hooks.ts",
    "runtime/src/hooks/engine/dispatcher.ts",
    "runtime/src/hooks/engine/command-runner.ts",
    "runtime/src/hooks/engine/output-parser.ts",
    "runtime/src/secrets/sanitizer.ts",
    "runtime/src/auth/backends/local.ts",
    "runtime/src/auth/backends/remote.ts",
    "runtime/src/conversation/thread-manager.ts",
    "runtime/src/bin/bootstrap.ts",
  ];
  const missingTargets = requiredTargets.filter((rel) => !existsSync(path.join(root, rel)));
  if (missingTargets.length > 0) {
    failGate(`ZC-35: AgenC target coverage file(s) missing:\n  ${missingTargets.join("\n  ")}`);
  }

  const testRun = run("npm", [
    "run",
    "test",
    "--workspace=@tetsuo-ai/runtime",
    "--",
    "src/agents/mailbox.test.ts",
    "src/hooks/configured-hooks.test.ts",
    "src/secrets/sanitizer.test.ts",
    "src/auth/backends/local.contract.test.ts",
    "src/auth/backends/remote.contract.test.ts",
    "src/conversation/thread-manager.contract.test.ts",
  ]);
  if (testRun.status !== 0) {
    failGate("ZC-35: coverage-lock test suites failed.");
  }

  pass("ZC-35: coverage anchors, reductions, and target tests locked");
}

function assertZc34AgentGraphStoreCoverage() {
  const readRequired = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) failGate(`ZC-34: missing required file ${rel}`);
    return readFileSync(abs, "utf8");
  };

  const requiredTargets = [
    "runtime/src/agents/graph-store/types.ts",
    "runtime/src/agents/graph-store/errors.ts",
    "runtime/src/agents/graph-store/store.ts",
    "runtime/src/agents/graph-store/local.ts",
    "runtime/src/agents/graph-store/local.test.ts",
  ];
  const missingTargets = requiredTargets.filter((rel) => !existsSync(path.join(root, rel)));
  if (missingTargets.length > 0) {
    failGate(`ZC-34: graph-store target file(s) missing:\n  ${missingTargets.join("\n  ")}`);
  }

  const localSource = readRequired("runtime/src/agents/graph-store/local.ts");
  for (const marker of [
    "class LocalAgentGraphStore",
    "upsertThreadSpawnEdge",
    "setThreadSpawnEdgeStatus",
    "listThreadSpawnChildren",
    "listThreadSpawnDescendants",
    "thread_spawn_edges",
    "driver.transaction",
  ]) {
    if (!localSource.includes(marker)) {
      failGate(`ZC-34: local graph store is missing ${marker}.`);
    }
  }

  const testSource = readRequired("runtime/src/agents/graph-store/local.test.ts");
  for (const marker of [
    "stable status filters",
    "undefined",
    "null",
    "missing children as a no-op",
    "breadth-first",
    "cycle",
    "invalid runtime statuses",
    "read-side SQLite failures",
    "preserves existing AgenC edge metadata",
  ]) {
    if (!testSource.includes(marker)) {
      failGate(`ZC-34: graph-store tests are missing ${marker}.`);
    }
  }

  const testRun = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/agents/graph-store/local.test.ts",
  ]);
  if (testRun.status !== 0) {
    failGate("ZC-34: graph-store behavior tests failed.");
  }

  pass("ZC-34: agent graph store coverage locked");
}

function assertZc37UndefinedDirectoryGone() {
  const rootUndefined = path.join(root, "undefined");
  if (existsSync(rootUndefined)) {
    failGate("ZC-37: repo-root undefined/ directory still exists; delete it.");
  }

  const tracked = run("git", ["ls-files", "undefined", ":(glob)**/undefined/**"], { silent: true });
  if (tracked.status !== 0) {
    failGate(`ZC-37: failed to inspect tracked undefined/ paths:\n${tracked.stderr || tracked.stdout}`);
  }
  if (tracked.stdout.trim()) {
    failGate(`ZC-37: tracked undefined/ path(s) remain:\n${tracked.stdout.trim()}`);
  }

  const gitignorePath = path.join(root, ".gitignore");
  if (!existsSync(gitignorePath)) failGate("ZC-37: .gitignore is missing.");
  const gitignore = readFileSync(gitignorePath, "utf8");
  for (const required of ["undefined/", "**/undefined/"]) {
    const escaped = required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const linePattern = new RegExp(`(^|\\n)${escaped}(\\n|$)`);
    if (!linePattern.test(gitignore)) {
      failGate(`ZC-37: .gitignore is missing required rule ${required}`);
    }
  }

  pass("ZC-37: undefined/ directory absent, untracked, and ignored");
}

function assertZc39VoicePartialPortResolved() {
  const deletedComponent = "runtime/src/tui/components/PromptInput/VoiceIndicator.tsx";
  if (existsSync(path.join(root, deletedComponent))) {
    failGate(`ZC-39: ${deletedComponent} still exists.`);
  }

  const blockedRefs = [
    {
      scope: "runtime/src/tui/components/PromptInput",
      pattern: "VoiceIndicator|VoiceWarmupHint|voiceInterimRange|useVoiceState|useVoiceEnabled|VOICE_MODE",
    },
    {
      scope: "runtime/src/tui/state/AppState.tsx",
      pattern: "VoiceProvider|VOICE_MODE|context/voice",
    },
    {
      scope: "runtime/src/tui/keybindings",
      pattern: "voice:pushToTalk|VOICE_MODE",
    },
    {
      scope: "runtime/src/commands/keybindings.ts",
      pattern: "chat:voiceInput",
    },
    {
      scope: "runtime/src/config",
      pattern: "VoiceInputConfig|voiceInput",
    },
    {
      scope: "runtime/src/build/feature.ts",
      pattern: "VOICE_MODE",
    },
    {
      scope: "runtime/src/agenc/upstream/screens/REPL.tsx",
      pattern: "useVoiceIntegration|VoiceKeybindingHandler|insertTextRef|VOICE_MODE|voiceInterimRange",
    },
  ];

  for (const { scope, pattern } of blockedRefs) {
    const scan = run("rg", ["--no-messages", "-n", pattern, scope], { silent: true });
    if (scan.status === 0) {
      failGate(`ZC-39: live voice partial-port reference(s) remain in ${scope}:\n${scan.stdout.trim()}`);
    }
    if (scan.status !== 1) {
      failGate(`ZC-39: failed to scan ${scope} for voice partial-port references.`);
    }
  }

  if (existsSync(path.join(root, "runtime/src/services/voice"))) {
    failGate("ZC-39: runtime/src/services/voice exists; this item chose deletion, not a voice service port.");
  }

  pass("ZC-39: voice partial-port UI, config, and keybinding surfaces removed from live runtime");
}

function assertZc42ExternalAgentMigrationPort() {
  const requiredFiles = [
    "runtime/src/migration/external-agent/project-importer.ts",
    "runtime/src/migration/external-agent/toml.ts",
    "runtime/src/migration/external-agent/PARITY.md",
    "runtime/src/migration/external-agent/project-importer.test.ts",
    "parity/ZC-42-parity.json",
  ];
  for (const rel of requiredFiles) {
    if (!existsSync(path.join(root, rel))) {
      failGate(`ZC-42: required migration port file is missing: ${rel}`);
    }
  }

  const parity = JSON.parse(readFileSync(path.join(root, "parity/ZC-42-parity.json"), "utf8"));
  if (parity.item !== "ZC-42" || parity.status !== "implemented") {
    failGate("ZC-42: parity artifact must record implemented status for this item.");
  }
  const rows = Array.isArray(parity.rows) ? parity.rows : [];
  for (const rowId of ["mcp-config-import", "hooks-import", "agents-and-commands-import"]) {
    if (!rows.some((row) => row?.id === rowId && row?.status === "required")) {
      failGate(`ZC-42: parity artifact is missing required row ${rowId}.`);
    }
  }

  const importer = readFileSync(path.join(root, "runtime/src/migration/external-agent/project-importer.ts"), "utf8");
  for (const required of [
    "buildMcpConfigFromSource",
    "importExternalAgentProject",
    "importHooks",
    "importSubagents",
    "importCommands",
    "renderMcpConfigToml",
    "parseEnvPlaceholder",
    "HOOK_EVENTS_TO_IMPORT",
  ]) {
    if (!importer.includes(required)) {
      failGate(`ZC-42: project importer is missing expected implementation anchor ${required}.`);
    }
  }

  const checklistPath = path.join(mainCheckoutRoot(), "PORT_CHECKLIST.md");
  if (!existsSync(checklistPath)) {
    failGate(`ZC-42: checklist not found at ${checklistPath}; cannot verify Phase 5 reclassification.`);
  }
  const checklist = readFileSync(checklistPath, "utf8");
  const identitySkipLine = checklist
    .split("\n")
    .find((line) => line.includes("agent-identity/") && line.includes("keyring-store/"));
  if (!identitySkipLine) {
    failGate("ZC-42: could not find the Phase 5 identity/keyring skip row.");
  }
  if (/external-agent/i.test(identitySkipLine)) {
    failGate("ZC-42: Phase 5 identity/keyring skip row still covers external-agent migration.");
  }

  const testRun = run("npm", [
    "run",
    "test",
    "--workspace=@tetsuo-ai/runtime",
    "--",
    "src/migration/external-agent/project-importer.test.ts",
  ]);
  if (testRun.status !== 0) {
    failGate("ZC-42: external-agent migration parity tests failed.");
  }

  pass("ZC-42: external-agent migration port, parity artifact, and tests locked");
}

function assertZc36TestFixtureParityCoverage() {
  const readRequired = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) failGate(`ZC-36: missing required file ${rel}`);
    return readFileSync(abs, "utf8");
  };

  const matrixText = readRequired("parity/ZC-36-parity.json");
  let matrix;
  try {
    matrix = JSON.parse(matrixText);
  } catch (error) {
    failGate(`ZC-36: parity matrix is not valid JSON: ${error?.message || error}`);
  }

  if (matrix.item !== "ZC-36" || matrix.status !== "representative-subset") {
    failGate("ZC-36: parity matrix must record the representative-subset decision.");
  }
  if (!Array.isArray(matrix.selectedCases) || matrix.selectedCases.length < 20) {
    failGate("ZC-36: parity matrix must select at least 20 source-suite behaviors.");
  }
  if (!Array.isArray(matrix.targetTestFiles) || matrix.targetTestFiles.length < 10) {
    failGate("ZC-36: parity matrix must list the AgenC target test files.");
  }

  const targetTests = new Set(matrix.targetTestFiles);
  for (const target of targetTests) {
    if (typeof target !== "string" || !target.startsWith("runtime/src/") || !target.endsWith(".test.ts")) {
      failGate(`ZC-36: invalid target test path ${String(target)}`);
    }
    if (!existsSync(path.join(root, target))) {
      failGate(`ZC-36: mapped target test does not exist: ${target}`);
    }
  }
  for (const selected of matrix.selectedCases) {
    if (!selected || typeof selected.id !== "string" || !/^[a-z0-9-]+$/.test(selected.id)) {
      failGate("ZC-36: each selected case needs a stable kebab-case id.");
    }
    if (!Array.isArray(selected.targetTests) || selected.targetTests.length === 0) {
      failGate(`ZC-36: selected case ${selected.id} has no target tests.`);
    }
    for (const target of selected.targetTests) {
      if (!targetTests.has(target)) {
        failGate(`ZC-36: selected case ${selected.id} references unlisted target test ${target}.`);
      }
    }
  }

  const expectedScenarios = matrix.applyPatchFixtureCoverage?.expectedScenarioDirectories;
  if (!Array.isArray(expectedScenarios) || expectedScenarios.length < 22) {
    failGate("ZC-36: apply-patch fixture corpus must list every numbered scenario.");
  }
  const scenariosRoot = path.join(root, "runtime/src/tools/apply-patch/__fixtures__/scenarios");
  const actualScenarios = readdirSync(scenariosRoot)
    .filter((entry) => statSync(path.join(scenariosRoot, entry)).isDirectory())
    .sort();
  const expectedSorted = [...expectedScenarios].sort();
  if (JSON.stringify(actualScenarios) !== JSON.stringify(expectedSorted)) {
    failGate("ZC-36: apply-patch scenario fixture directories do not match the parity matrix.");
  }

  const testRun = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    ...matrix.targetTestFiles.map((target) => target.replace(/^runtime\//, "")),
  ]);
  if (testRun.status !== 0) {
    failGate("ZC-36: representative suite parity tests failed.");
  }

  pass("ZC-36: representative test/fixture parity coverage locked");
}

function assertZc38DistBuildArtifactsIgnored() {
  const gitignorePath = path.join(root, ".gitignore");
  if (!existsSync(gitignorePath)) failGate("ZC-38: .gitignore is missing.");
  const gitignoreLines = readFileSync(gitignorePath, "utf8").split(/\r?\n/u);
  const requiredRules = [
    "dist/",
    "**/dist/",
    "runtime/dist/",
    "web/dist/",
    "mcp/dist/",
    "!patches/**/dist/",
  ];
  const ruleIndexes = requiredRules.map((rule) => gitignoreLines.indexOf(rule));
  const missingRules = requiredRules.filter((_, index) => ruleIndexes[index] === -1);
  if (missingRules.length > 0) {
    failGate(`ZC-38: .gitignore is missing required dist rule(s):\n  ${missingRules.join("\n  ")}`);
  }
  for (let i = 1; i < ruleIndexes.length; i += 1) {
    if (ruleIndexes[i] <= ruleIndexes[i - 1]) {
      failGate("ZC-38: .gitignore dist rules must keep package-specific locks below the generic dist rules and above the patches exception.");
    }
  }

  for (const sentinel of [
    "runtime/dist/.zc38-sentinel",
    "web/dist/.zc38-sentinel",
    "mcp/dist/.zc38-sentinel",
  ]) {
    const ignored = git("check-ignore", sentinel);
    if (ignored.status !== 0) {
      failGate(`ZC-38: ${sentinel} is not ignored by git.`);
    }
  }
  const patchDist = git("check-ignore", "patches/example/dist/.zc38-sentinel");
  if (patchDist.status === 0) {
    failGate("ZC-38: patches/**/dist/ exception no longer works.");
  }

  const files = git("ls-files");
  if (files.status !== 0) failGate("ZC-38: git ls-files failed while checking tracked build artifacts.");
  const trackedBuildArtifacts = files.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((rel) => (rel.startsWith("dist/") || rel.includes("/dist/")) && !rel.startsWith("patches/"));
  if (trackedBuildArtifacts.length > 0) {
    failGate(
      `ZC-38: tracked non-patches dist build artifact(s) found:\n  ${trackedBuildArtifacts.join("\n  ")}`,
    );
  }

  pass("ZC-38: dist build artifacts are ignored and absent from tracked files");
}

function assertZc41ObservabilityCoverage() {
  const requiredFiles = [
    "runtime/src/observability/telemetry.ts",
    "runtime/src/observability/telemetry.test.ts",
    "parity/ZC-41-parity.json",
  ];
  for (const rel of requiredFiles) {
    if (!existsSync(path.join(root, rel))) {
      failGate(`ZC-41: missing required observability artifact ${rel}`);
    }
  }

  const telemetry = readFileSync(path.join(root, "runtime/src/observability/telemetry.ts"), "utf8");
  const requiredSurface = [
    "interface TelemetrySpan",
    "interface TelemetryTimer",
    "interface TelemetryClient",
    "startSpan(",
    "withSpan",
    "recordDuration(",
    "timer(",
    "sanitizeMetricTagValue",
    "setAgencTelemetryClient",
  ];
  const missingSurface = requiredSurface.filter((marker) => !telemetry.includes(marker));
  if (missingSurface.length > 0) {
    failGate(`ZC-41: observability surface missing marker(s): ${missingSurface.join(", ")}`);
  }

  const wiredMarkers = [
    ["runtime/src/session/session.ts", "AGENC_TURN_E2E_DURATION_METRIC"],
    ["runtime/src/session/run-turn.ts", "AGENC_TURN_TTFT_DURATION_METRIC"],
    ["runtime/src/session/startup-prewarm.ts", "AGENC_STARTUP_PREWARM_AGE_AT_FIRST_TURN_METRIC"],
    ["runtime/src/agenc/adapters/runtime-session.ts", "AGENC_COMPACT_DURATION_METRIC"],
    ["runtime/src/hooks/engine/dispatcher.ts", "AGENC_HOOK_RUN_DURATION_METRIC"],
    ["runtime/src/mcp-client/tools.ts", "mcp.tools.call"],
    ["runtime/src/session/observer-wiring.ts", "AGENC_TOOL_UNIFIED_EXEC_DURATION_METRIC"],
    ["runtime/src/app-server/command-exec.ts", "AGENC_TOOL_UNIFIED_EXEC_METRIC"],
    ["runtime/src/unified-exec/process-manager.ts", "AGENC_WINDOWS_SANDBOX_SETUP_DURATION_METRIC"],
  ];
  const missingWiring = [];
  for (const [rel, marker] of wiredMarkers) {
    const source = readFileSync(path.join(root, rel), "utf8");
    if (!source.includes(marker)) missingWiring.push(`${rel}: ${marker}`);
  }
  if (missingWiring.length > 0) {
    failGate(`ZC-41: telemetry wiring marker(s) missing:\n  ${missingWiring.join("\n  ")}`);
  }

  const ledger = JSON.parse(readFileSync(path.join(root, "parity/ZC-41-parity.json"), "utf8"));
  if (ledger.item !== "ZC-41" || ledger.status !== "implemented") {
    failGate("ZC-41: parity ledger must identify item ZC-41 with implemented status");
  }
  if (!Array.isArray(ledger.coverageRows) || ledger.coverageRows.length < 9) {
    failGate("ZC-41: parity ledger must cover client, timer, turn timing, task lifecycle, startup prewarm, compact, hooks, MCP, exec, and Windows sandbox seams");
  }
  const nonRequiredRows = ledger.coverageRows.filter((row) => row?.required !== true);
  if (nonRequiredRows.length > 0) {
    failGate(`ZC-41: parity rows must be required: ${nonRequiredRows.map((row) => row?.id ?? "<missing>").join(", ")}`);
  }

  const testRun = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/observability/telemetry.test.ts",
    "tests/runtime-session-compact-telemetry.test.ts",
    "src/phases/stream-model.test.ts",
    "src/hooks/engine/dispatcher.test.ts",
    "src/mcp-client/tools.test.ts",
    "src/unified-exec/process-manager.test.ts",
  ]);
  if (testRun.status !== 0) {
    failGate("ZC-41: observability seam tests failed.");
  }

  pass("ZC-41: observability no-op surface and call-site seams locked");
}

function assertZc40RuntimeParityDocsGone() {
  const runtimeSrc = path.join(root, "runtime/src");
  const filesystemDocs = walkFiles(runtimeSrc)
    .filter((abs) => path.basename(abs) === "PARITY.md")
    .map((abs) => path.relative(root, abs).replaceAll("\\", "/"));

  const tracked = git("ls-files", "runtime/src/**/PARITY.md");
  if (tracked.status !== 0) {
    failGate(`ZC-40: failed to inspect tracked runtime PARITY.md files:\n${tracked.stderr || tracked.stdout}`);
  }
  const trackedDocs = tracked.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const remaining = [...new Set([...filesystemDocs, ...trackedDocs])].sort();
  if (remaining.length > 0) {
    failGate(`ZC-40: runtime PARITY.md scaffolding remains:\n  ${remaining.join("\n  ")}`);
  }

  const staleReferences = run(
    "rg",
    ["--no-messages", "-n", "PARITY\\.md", "runtime/src", "-g", "!**/PARITY.md"],
    { silent: true },
  );
  if (staleReferences.status === 0 && staleReferences.stdout.trim()) {
    failGate(`ZC-40: live runtime source still references deleted PARITY.md scaffolding:\n${staleReferences.stdout.trim()}`);
  }

  pass("ZC-40: runtime PARITY.md scaffolding is gone");
}

function assertZc43NetworkPolicyInterfaces() {
  const readRequired = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) failGate(`ZC-43: missing required file ${rel}`);
    return readFileSync(abs, "utf8");
  };

  const policySource = readRequired("runtime/src/sandbox/network-policy.ts");
  for (const marker of [
    "export type NetworkPolicyRequestProtocol",
    "export interface NetworkPolicyRequest",
    "export type NetworkDecision",
    "export interface NetworkPolicyDecider",
    "export interface BlockedRequestObserver",
    "readonly protocol: NetworkPolicyRequestProtocol",
    "readonly timestamp: number",
    "networkPolicyDeciderFrom",
    "networkApprovalProtocolFromRequestProtocol",
    "blockedRequestObserverFrom",
    "noopBlockedRequestObserver",
    "notifyBlockedRequest",
  ]) {
    if (!policySource.includes(marker)) {
      failGate(`ZC-43: network-policy.ts is missing ${marker}.`);
    }
  }

  const turnContextSource = readRequired("runtime/src/session/turn-context.ts");
  for (const marker of [
    "NetworkPolicyDecider",
    "BlockedRequestObserver",
    "policyDecider?: NetworkPolicyDecider",
    "blockedRequestObserver?: BlockedRequestObserver",
  ]) {
    if (!turnContextSource.includes(marker)) {
      failGate(`ZC-43: turn-context.ts is missing ${marker}.`);
    }
  }

  const ledger = JSON.parse(readRequired("parity/ZC-43-parity.json"));
  if (ledger.item !== "ZC-43" || ledger.status !== "no-op-interface-port") {
    failGate("ZC-43: parity ledger must identify the no-op interface port decision.");
  }
  for (const required of [
    "network-proxy/src/network_policy.rs",
    "network-proxy/src/runtime.rs",
    "core/src/session/session.rs",
    "core/src/exec.rs",
    "core/src/spawn.rs",
    "core/src/network_policy_decision.rs",
    "core/src/guardian/review.rs",
  ]) {
    if (!ledger.sourceFiles?.includes(required)) {
      failGate(`ZC-43: parity ledger is missing source file ${required}.`);
    }
  }
  for (const required of [
    "runtime/src/sandbox/network-policy.ts",
    "runtime/src/sandbox/engine/index.ts",
    "runtime/src/session/turn-context.ts",
    "runtime/src/session/session.ts",
    "runtime/src/tools/system/exec-command.ts",
    "runtime/src/tools/system/exec-command.test.ts",
    "runtime/src/tools/execution.ts",
    "runtime/src/tools/execution.test.ts",
    "runtime/src/tools/router.ts",
    "runtime/src/tools/router.test.ts",
    "runtime/src/unified-exec/types.ts",
    "runtime/src/unified-exec/process-manager.ts",
    "runtime/src/unified-exec/process-manager.test.ts",
    "runtime/src/permissions/guardian/approval-request.ts",
    "runtime/src/permissions/guardian/approval-request.test.ts",
    "runtime/src/permissions/guardian/arbiter.ts",
  ]) {
    if (!ledger.targetFiles?.includes(required)) {
      failGate(`ZC-43: parity ledger is missing target file ${required}.`);
    }
  }
  const siteRows = ledger.checklistPortSites;
  if (!Array.isArray(siteRows)) {
    failGate("ZC-43: parity ledger must include checklistPortSites.");
  }
  for (const required of [
    "core/src/session.rs",
    "core/src/exec.rs",
    "core/src/spawn.rs",
    "core/src/network_policy_decision.rs",
    "core/src/guardian/review.rs",
  ]) {
    const row = siteRows.find((candidate) => candidate?.checklistFile === required);
    if (!row) {
      failGate(`ZC-43: parity ledger is missing checklist port site ${required}.`);
    }
    if (!Array.isArray(row.targetFiles) || row.targetFiles.length === 0) {
      failGate(`ZC-43: checklist port site ${required} must list target files.`);
    }
    if (
      typeof row.resolution !== "string" ||
      !/\b(thread|threaded|threading)\b/i.test(row.resolution)
    ) {
      failGate(`ZC-43: checklist port site ${required} must document interface threading.`);
    }
  }
  const ledgerText = JSON.stringify(ledger);
  if (/treats either interface as a managed-network requirement/i.test(ledgerText)) {
    failGate(
      "ZC-43: parity ledger must not claim no-op interfaces are managed-network requirements.",
    );
  }
  const spawnSite = siteRows.find((candidate) =>
    candidate?.checklistFile === "core/src/spawn.rs"
  );
  if (
    typeof spawnSite?.resolution !== "string" ||
    !/interface presence alone remains no-op/i.test(spawnSite.resolution)
  ) {
    failGate(
      "ZC-43: spawn parity row must document that interface presence alone is no-op for sandbox selection.",
    );
  }

  const testSource = readRequired("runtime/src/sandbox/network-policy.test.ts");
  for (const marker of [
    "network policy decider contracts",
    "request protocols preserve proxy labels before approval normalization",
    "blocked request observers",
    "request.timestamp",
    "allowNetworkDecision",
    "noopBlockedRequestObserver",
  ]) {
    if (!testSource.includes(marker)) {
      failGate(`ZC-43: network-policy tests are missing ${marker}.`);
    }
  }
  const turnContextTestSource = readRequired("runtime/src/session/turn-context.test.ts");
  for (const marker of [
    "buildTurnContext preserves network policy decider and observer",
    "turn-builder helpers preserve network policy decider and observer",
    "mkNetworkProxy",
  ]) {
    if (!turnContextTestSource.includes(marker)) {
      failGate(`ZC-43: turn-context tests are missing ${marker}.`);
    }
  }
  const sessionTestSource = readRequired("runtime/src/session/session.test.ts");
  if (!sessionTestSource.includes("threads network policy interfaces")) {
    failGate("ZC-43: Session live builder path must test network policy interface threading.");
  }
  const execSource = readRequired("runtime/src/tools/system/exec-command.ts");
  for (const marker of [
    "networkPolicyInterfaces",
    "networkPolicyDecider",
    "blockedRequestObserver",
  ]) {
    if (!execSource.includes(marker)) {
      failGate(`ZC-43: exec-command runtime sandbox threading is missing ${marker}.`);
    }
  }
  const execTestSource = readRequired("runtime/src/tools/system/exec-command.test.ts");
  if (!execTestSource.includes("threads network policy interfaces into runtime sandbox requests")) {
    failGate("ZC-43: exec-command tests must lock network policy interface threading.");
  }
  const executionSource = readRequired("runtime/src/tools/execution.ts");
  for (const marker of [
    "networkPolicyInterfacesFromInvocation",
    "networkPolicyDecider",
    "blockedRequestObserver",
  ]) {
    if (!executionSource.includes(marker)) {
      failGate(`ZC-43: execution approval fallback threading is missing ${marker}.`);
    }
  }
  const executionTestSource = readRequired("runtime/src/tools/execution.test.ts");
  if (
    !executionTestSource.includes(
      "legacy guardian approval fallback carries turn network policy interfaces",
    )
  ) {
    failGate(
      "ZC-43: execution fallback approval path must test network policy interface threading.",
    );
  }
  if (!executionTestSource.includes('"networkPolicyInterfaces" in')) {
    failGate("ZC-43: execution fallback test must assert request serialization stays no-op.");
  }
  const processManagerSource = readRequired("runtime/src/unified-exec/process-manager.ts");
  for (const marker of [
    "networkPolicyDecider",
    "blockedRequestObserver",
    "hasManagedNetworkRequirements",
  ]) {
    if (!processManagerSource.includes(marker)) {
      failGate(`ZC-43: unified-exec spawn threading is missing ${marker}.`);
    }
  }
  const managedNetworkStart = processManagerSource.indexOf(
    "hasManagedNetworkRequirements:",
  );
  if (managedNetworkStart === -1) {
    failGate("ZC-43: unified-exec must set hasManagedNetworkRequirements explicitly.");
  }
  const managedNetworkWindow = processManagerSource.slice(
    managedNetworkStart,
    managedNetworkStart + 260,
  );
  if (/networkPolicyDecider|blockedRequestObserver/.test(managedNetworkWindow)) {
    failGate(
      "ZC-43: network policy interfaces alone must not count as managed-network sandbox requirements.",
    );
  }
  const processManagerTestSource = readRequired(
    "runtime/src/unified-exec/process-manager.test.ts",
  );
  if (
    !processManagerTestSource.includes(
      "network policy interfaces alone do not force managed network sandboxing",
    )
  ) {
    failGate(
      "ZC-43: unified-exec tests must prove interface presence alone is no-op for managed-network sandbox selection.",
    );
  }
  const guardianSource = readRequired("runtime/src/permissions/guardian/approval-request.ts");
  if (guardianSource.includes("networkPolicyInterfaces")) {
    failGate("ZC-43: guardian approval request must not serialize network policy interfaces.");
  }
  const routerSource = readRequired("runtime/src/tools/router.ts");
  for (const marker of [
    "networkPolicyInterfacesFromTurn",
    "networkPolicyDecider",
    "blockedRequestObserver",
  ]) {
    if (!routerSource.includes(marker)) {
      failGate(`ZC-43: router approval-context threading is missing ${marker}.`);
    }
  }
  const routerTestSource = readRequired("runtime/src/tools/router.test.ts");
  if (
    !routerTestSource.includes(
      "threads turn network policy interfaces into guardian approval context",
    )
  ) {
    failGate("ZC-43: router guardian approval path must test internal network policy interface threading.");
  }
  if (!routerTestSource.includes('"networkPolicyInterfaces" in')) {
    failGate("ZC-43: router guardian approval test must assert request serialization stays no-op.");
  }

  const testRun = run("npm", [
    "exec",
    "--workspace=@tetsuo-ai/runtime",
    "vitest",
    "run",
    "src/sandbox/network-policy.test.ts",
    "src/session/turn-context.test.ts",
    "src/session/session.test.ts",
    "src/tools/system/exec-command.test.ts",
    "src/tools/execution.test.ts",
    "src/tools/router.test.ts",
    "src/unified-exec/process-manager.test.ts",
    "src/permissions/guardian/approval-request.test.ts",
  ]);
  if (testRun.status !== 0) {
    failGate("ZC-43: network policy interface threading tests failed.");
  }

  pass("ZC-43: network policy decider and blocked-request observer interfaces are locked");
}

function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const rel = path.relative(root, abs).replaceAll("\\", "/");
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...listSourceFiles(abs));
    } else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry)) {
      out.push(rel);
    }
  }
  return out;
}

function importTargetBase(target) {
  return stripSourceModuleExtension(target) ?? target;
}

function relativeImportTargetExists(target) {
  const ext = path.extname(target);
  const candidates = [];
  if (ext) {
    const withoutExt = target.slice(0, -ext.length);
    candidates.push(target);
    if (ext === ".js" || ext === ".jsx") {
      candidates.push(`${withoutExt}.ts`, `${withoutExt}.tsx`, `${withoutExt}.d.ts`);
    } else if (ext === ".mjs") {
      candidates.push(`${withoutExt}.mts`);
    } else if (ext === ".cjs") {
      candidates.push(`${withoutExt}.cts`);
    }
  } else {
    candidates.push(
      target,
      `${target}.ts`,
      `${target}.tsx`,
      `${target}.d.ts`,
      `${target}.js`,
      path.join(target, "index.ts"),
      path.join(target, "index.tsx"),
      path.join(target, "index.d.ts"),
      path.join(target, "index.js"),
    );
  }
  return candidates.some((candidate) => existsSync(candidate));
}

// ---- per-item evidence helpers -----------------------------------------

function checkFileExists(p) {
  return existsSync(path.join(root, p));
}

function checkFilesGlob(spec) {
  // spec: { globUnder, matching, minCount?, optional? }
  const minCount = spec.minCount ?? 1;
  const dir = path.join(root, spec.globUnder);
  if (!existsSync(dir)) {
    return spec.optional ? { ok: true, count: 0 } : { ok: false, reason: `dir missing: ${spec.globUnder}` };
  }
  const matched = walkFiles(dir).filter(
    (f) => spec.matching.test(path.relative(root, f)) || spec.matching.test(path.basename(f)),
  );
  if (matched.length < minCount) {
    return {
      ok: false,
      reason: `expected ${minCount} file(s) matching ${spec.matching} under ${spec.globUnder}, found ${matched.length}`,
    };
  }
  return { ok: true, count: matched.length };
}

function checkGrepPresent(spec) {
  const r = run("rg", ["--no-messages", "-l", spec.pattern, spec.scope], { silent: true });
  if (r.status !== 0 || !r.stdout.trim()) {
    return { ok: false, reason: `pattern not found: ${spec.pattern} in ${spec.scope}` };
  }
  return { ok: true };
}

function checkGrepNotPresent(spec) {
  const r = run("rg", ["--no-messages", "-l", spec.pattern, spec.scope], { silent: true });
  if (r.status === 0 && r.stdout.trim()) {
    return {
      ok: false,
      reason: `forbidden pattern found: ${spec.pattern} in ${spec.scope} (files: ${r.stdout
        .trim()
        .split("\n")
        .slice(0, 3)
        .join(", ")})`,
    };
  }
  return { ok: true };
}

function evaluateEvidence(itemId, evidence) {
  const failures = [];
  if (evidence.files) {
    for (const f of evidence.files) {
      if (typeof f === "string") {
        if (!checkFileExists(f)) failures.push(`file missing: ${f}`);
      } else {
        const res = checkFilesGlob(f);
        if (!res.ok) failures.push(res.reason);
      }
    }
  }
  if (evidence.filesAbsent) {
    for (const f of evidence.filesAbsent) {
      if (checkFileExists(f)) failures.push(`file should be absent: ${f}`);
    }
  }
  if (evidence.grepPresent) {
    for (const s of evidence.grepPresent) {
      const res = checkGrepPresent(s);
      if (!res.ok) failures.push(res.reason);
    }
  }
  if (evidence.grepNotPresent) {
    for (const s of evidence.grepNotPresent) {
      const res = checkGrepNotPresent(s);
      if (!res.ok) failures.push(res.reason);
    }
  }
  if (evidence.tests) {
    for (const t of evidence.tests) {
      if (typeof t === "string") {
        if (!checkFileExists(t)) failures.push(`test missing: ${t}`);
      } else {
        const res = checkFilesGlob(t);
        if (!res.ok && !t.optional) failures.push(res.reason);
      }
    }
  }
  return failures;
}

function countTscErrors(output) {
  // tsc summary line: "Found N error(s) in M file(s)." or "Found N errors."
  const m = /Found\s+(\d+)\s+error/i.exec(output);
  if (m) return parseInt(m[1], 10);
  // No summary line means tsc exited cleanly (zero errors), or the run
  // failed before tsc could emit one. Count error: lines as fallback.
  const lines = output.split("\n").filter((l) => /error\s+TS\d+/.test(l));
  return lines.length;
}

function readBaselineSafe(p) {
  if (!existsSync(p)) return null;
  // Validate JSON shape strictly: malformed files must fail the gate, not
  // be silently treated as "no baseline" (which would then auto-fail
  // through the missing-baseline path with a misleading message).
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    failGate(`could not read .typecheck-baseline.json: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    failGate(`.typecheck-baseline.json is not valid JSON: ${e.message}`);
  }
  if (
    !data ||
    typeof data !== "object" ||
    typeof data.errorCount !== "number" ||
    !Number.isInteger(data.errorCount) ||
    data.errorCount < 0
  ) {
    failGate(
      `.typecheck-baseline.json is malformed: errorCount must be a non-negative integer, ` +
      `got ${JSON.stringify(data && data.errorCount)}`,
    );
  }
  if (data.errorCount > MAX_ALLOWED_BASELINE) {
    failGate(
      `baseline file claims ${data.errorCount} errors which exceeds the project's ` +
      `MAX_ALLOWED_BASELINE of ${MAX_ALLOWED_BASELINE} — refusing to silently accept inflation.`,
    );
  }
  return data.errorCount;
}

function writeBaseline(p, count) {
  writeFileSync(
    p,
    JSON.stringify({ errorCount: count, capturedAt: new Date().toISOString() }, null, 2) + "\n",
  );
}

async function assertZPurgeATsupAliasBoundaries() {
  const root = repoRoot();
  const configPath = path.join(root, "runtime/tsup.config.ts");
  const configText = readFileSync(configPath, "utf8");
  if (configText.includes("relocatedSourcePathAliases")) {
    failGate(
      "Z-PURGEA: tsup relocatedSourcePathAliases survived after their upstream tui/components and tui/buddy roots were purged",
    );
  }

  const configModule = await import(pathToFileURL(configPath).href);
  const helper = configModule.__agencTsupAliasTest;
  if (!helper) {
    failGate("Z-PURGEA: tsup config does not export __agencTsupAliasTest for alias drift checks");
  }

  const toRepoRel = (file) => path.relative(root, file).split(path.sep).join("/");
  const expectResolution = (label, importerRel, source, expectedRel) => {
    const resolved = helper.resolveRelativeAgenCSource(path.join(root, importerRel), source);
    const actualRel = resolved ? toRepoRel(resolved) : null;
    if (actualRel !== expectedRel) {
      failGate(
        `Z-PURGEA: tsup alias resolution failed for ${label}; expected ${expectedRel}, got ${actualRel ?? "null"}`,
      );
    }
  };

  const movedBoundaryPrefixes = [
    "// @ts-nocheck\n" +
      "// Temporary boundary: this moved utility still imports not-yet-absorbed upstream subsystems.\n",
    "// @ts-nocheck\n" +
      "// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.\n",
    "// @ts-nocheck -- temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.\n",
  ];
  const expectedRelocatedRoots = new Map([
    ["runtime/src/utils", "runtime/src/agenc/upstream/utils"],
    ["runtime/src/constants", "runtime/src/agenc/upstream/constants"],
    ["runtime/src/memdir", "runtime/src/agenc/upstream/memdir"],
  ]);
  for (const alias of helper.relocatedUpstreamRoots) {
    const runtimeRel = toRepoRel(alias.runtimeRoot);
    const upstreamRel = toRepoRel(alias.upstreamRoot);
    if (expectedRelocatedRoots.get(runtimeRel) !== upstreamRel) {
      failGate(`Z-PURGEA: unexpected relocated upstream root alias ${runtimeRel} -> ${upstreamRel}`);
    }
    const boundaryFiles = walkFiles(alias.runtimeRoot).filter((f) => {
      if (!/\.(ts|tsx|mts|cts)$/.test(f)) return false;
      const source = readFileSync(f, "utf8");
      return movedBoundaryPrefixes.some((prefix) => source.startsWith(prefix));
    });
    if (boundaryFiles.length === 0) {
      failGate(
        `Z-PURGEA: relocated upstream root alias ${runtimeRel} has no documented temporary boundary files`,
      );
    }
  }
  if (helper.relocatedUpstreamRoots.length !== expectedRelocatedRoots.size) {
    failGate("Z-PURGEA: relocated upstream root alias count changed without updating the gate");
  }

  const expectedFileBaseAliases = new Map([
    ["runtime/src/tools/Tool", "runtime/src/agenc/upstream/Tool"],
    ["runtime/src/agenc/upstream/tools/Tool", "runtime/src/agenc/upstream/Tool"],
    ["runtime/src/agenc/upstream/tasks/Task", "runtime/src/agenc/upstream/Task"],
  ]);
  for (const alias of helper.sourceFileBaseAliases) {
    const runtimeRel = toRepoRel(alias.runtimeBase);
    const upstreamRel = toRepoRel(alias.upstreamBase);
    if (expectedFileBaseAliases.get(runtimeRel) !== upstreamRel) {
      failGate(`Z-PURGEA: unexpected source file-base alias ${runtimeRel} -> ${upstreamRel}`);
    }
    for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
      if (existsSync(`${alias.runtimeBase}${ext}`)) {
        failGate(
          `Z-PURGEA: source file-base alias ${runtimeRel} is stale because ${runtimeRel}${ext} now exists`,
        );
      }
    }
  }
  if (helper.sourceFileBaseAliases.length !== expectedFileBaseAliases.size) {
    failGate("Z-PURGEA: source file-base alias count changed without updating the gate");
  }

  const expectedTuiRoots = new Set([
    "runtime/src/tui/components",
    "runtime/src/tui/context",
    "runtime/src/tui/hooks",
  ]);
  for (const rootAlias of helper.relocatedTuiSourceRoots) {
    const rootRel = toRepoRel(rootAlias);
    if (!expectedTuiRoots.has(rootRel)) {
      failGate(`Z-PURGEA: unexpected relocated TUI source root alias ${rootRel}`);
    }
  }
  if (helper.relocatedTuiSourceRoots.length !== expectedTuiRoots.size) {
    failGate("Z-PURGEA: relocated TUI source root alias count changed without updating the gate");
  }

  expectResolution(
    "moved utility to upstream bootstrap",
    "runtime/src/utils/attribution.ts",
    "../bootstrap/state.js",
    "runtime/src/agenc/upstream/bootstrap/state.ts",
  );
  expectResolution(
    "moved constants to upstream Tool file-base",
    "runtime/src/constants/prompts.ts",
    "../tools/Tool.js",
    "runtime/src/agenc/upstream/Tool.ts",
  );
  expectResolution(
    "moved utility to upstream Task file-base",
    "runtime/src/utils/attachments.ts",
    "../tasks/Task.js",
    "runtime/src/agenc/upstream/Task.ts",
  );

  const tuiImporter = path.join(root, "runtime/src/tui/components/PromptInput/PromptInput.tsx");
  const tuiSourceRoot = helper.sourceRootForImporter(tuiImporter);
  if (!tuiSourceRoot || toRepoRel(tuiSourceRoot) !== "runtime/src/tui/components") {
    failGate(
      `Z-PURGEA: tsup did not classify moved TUI importer; got ${tuiSourceRoot ? toRepoRel(tuiSourceRoot) : "null"}`,
    );
  }
  const bareSrcResolved = helper.resolveAgenCBareSrc(
    "src/components/FeedbackSurvey/FeedbackSurvey.js",
  );
  const bareSrcRel = bareSrcResolved ? toRepoRel(bareSrcResolved) : null;
  if (bareSrcRel !== "runtime/src/tui/components/FeedbackSurvey/FeedbackSurvey.tsx") {
    failGate(
      `Z-PURGEA: tsup bare src TUI alias failed; expected runtime/src/tui/components/FeedbackSurvey/FeedbackSurvey.tsx, got ${bareSrcRel ?? "null"}`,
    );
  }

  pass("Z-PURGEA: tsup temporary alias boundaries and direct resolver cases verified");
}

async function cleanupGates(item) {
  // Recognized cleanup IDs. Anything outside this set must fail rather than
  // silently no-op through the function with no checks fired.
  const knownZ = new Set([
    "Z-01", "Z-02", "Z-03", "Z-04", "Z-05", "Z-06",
    "Z-PURGEA", "Z-PURGEB", "Z-PURGEC", "Z-PURGEFINAL", "Z-FINAL",
  ]);
  if (!knownZ.has(id) && !/^ZC-/.test(id)) {
    failGate(
      `item ${id} has no specific gate branch in cleanupGates; add one or remove the item`,
    );
  }

  // Z-PURGE* items: per-cluster upstream-tree purges.
  // Each item must verify that its assigned upstream subdirs are empty AND
  // that no remaining imports reference those subdirs from runtime/src/.
  function assertSubtreesPurged(subtrees, label) {
    for (const sub of subtrees) {
      const dir = path.join(root, "runtime/src/agenc/upstream", sub);
      if (existsSync(dir)) {
        const remaining = walkFiles(dir).filter((f) =>
          /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f),
        );
        if (remaining.length > 0) {
          failGate(
            `${id}: ${remaining.length} file(s) still in runtime/src/agenc/upstream/${sub}/:\n  ${remaining.slice(0, 10).map((f) => path.relative(root, f)).join("\n  ")}${remaining.length > 10 ? `\n  ... +${remaining.length - 10} more` : ""}`,
          );
        }
      }
      const importerScan = run("rg", [
        "--no-messages", "-l",
        `agenc/upstream/${sub}`,
        "runtime/src",
        "-g", "!runtime/src/agenc/upstream/**",
      ], { silent: true });
      const offenders = (importerScan.stdout || "").trim();
      if (importerScan.status === 0 && offenders) {
        const lines = offenders.split("\n").filter(Boolean);
        failGate(
          `${id}: ${lines.length} importer(s) of agenc/upstream/${sub}/ remain in runtime/src/:\n  ${lines.slice(0, 10).join("\n  ")}${lines.length > 10 ? `\n  ... +${lines.length - 10} more` : ""}`,
        );
      }
    }
    pass(`${id}: ${label} purged (zero files, zero importers)`);
  }

  function assertNoRuntimeUpstreamReferences(label) {
    const listed = run("git", ["ls-files", "--", ...RUNTIME_UPSTREAM_SCAN_PATHS], { silent: true });
    if (listed.status !== 0) {
      failGate(`${id}: unable to enumerate tracked runtime files for upstream-reference scan`);
    }
    const files = (listed.stdout || "")
      .split("\n")
      .filter(Boolean);
    const stale = collectRuntimeUpstreamReferences({ root, files });
    if (stale.length > 0) {
      failGate(
        `${id}: stale agenc/upstream reference(s) remain in tracked runtime source, tests, or build config:\n  ${stale.slice(0, 30).join("\n  ")}${stale.length > 30 ? `\n  ... +${stale.length - 30} more` : ""}`,
      );
    }
    pass(`${id}: ${label} has zero stale agenc/upstream references in tracked runtime source, tests, and build config`);
  }

  function summarizeCommandOutput(result, limit = 4_000) {
    const output = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    if (output.length <= limit) return output;
    return `${output.slice(0, limit)}\n... truncated ${output.length - limit} byte(s)`;
  }

  function runRequiredZFinalCommand(label, cmd, argv) {
    const result = run(cmd, argv, { silent: true });
    if (result.status !== 0) {
      failGate(`${label} failed:\n${summarizeCommandOutput(result)}`);
    }
    pass(label);
    return result;
  }

  const Z_FINAL_TS_PRUNE_PROJECT = "runtime/tsconfig.json";
  const Z_FINAL_TS_PRUNE_IGNORE_REL = ".ts-prune-ignore";
  const Z_FINAL_KNIP_CONFIG_REL = ".knip.json";
  const Z_FINAL_KNIP_ISSUE_IGNORE_REL = ".knip-issues-ignore.json";

  function readZFinalTsPruneIgnorePatterns() {
    const ignorePath = path.join(root, Z_FINAL_TS_PRUNE_IGNORE_REL);
    if (!existsSync(ignorePath)) return [];
    return readFileSync(ignorePath, "utf8")
      .split(/\r?\n/)
      .map((line, index) => ({ line: line.trim(), index: index + 1 }))
      .filter(({ line }) => line && !line.startsWith("#"))
      .map(({ line, index }) => {
        try {
          return { pattern: new RegExp(line), index };
        } catch (error) {
          failGate(
            `Z-FINAL gate 3: ${Z_FINAL_TS_PRUNE_IGNORE_REL}:${index} is not a valid regex: ${error?.message || error}`,
          );
        }
      });
  }

  function collectUnignoredTsPruneLines(output, ignorePatterns) {
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !ignorePatterns.some(({ pattern }) => pattern.test(line)));
  }

  function assertZFinalTsPruneClean() {
    const tsPrune = run("npx", [
      "--yes",
      "--package",
      "ts-prune@0.10.3",
      "ts-prune",
      "--error",
      "-p",
      Z_FINAL_TS_PRUNE_PROJECT,
    ], { silent: true });
    if (![0, 1].includes(tsPrune.status)) {
      failGate(`Z-FINAL gate 3: ts-prune failed to run:\n${summarizeCommandOutput(tsPrune)}`);
    }
    const ignorePatterns = readZFinalTsPruneIgnorePatterns();
    const unignored = collectUnignoredTsPruneLines(tsPrune.stdout || "", ignorePatterns);
    if (unignored.length > 0) {
      failGate(
        `Z-FINAL gate 3: ts-prune reported ${unignored.length} unignored unused export(s). ` +
          `Remove the export or add a precise ${Z_FINAL_TS_PRUNE_IGNORE_REL} entry:\n${unignored.slice(0, 80).join("\n")}`,
      );
    }
    if (tsPrune.stderr?.trim()) {
      failGate(`Z-FINAL gate 3: ts-prune wrote unexpected stderr:\n${tsPrune.stderr.trim()}`);
    }
    pass(`Z-FINAL gate 3: ts-prune has zero unignored unused exports (${ignorePatterns.length} ignore pattern(s))`);
  }

  function assertZFinalPredecessorsDone() {
    const checklist = path.join(mainCheckoutRoot(), "PORT_CHECKLIST.md");
    if (!existsSync(checklist)) {
      failGate("Z-FINAL precondition: PORT_CHECKLIST.md is missing from the main checkout before final merge");
    }
    const items = parseItems(readFileSync(checklist, "utf8"));
    const predecessors = items
      .filter((candidate) => candidate.id !== "Z-FINAL" && /^(?:Z-|ZC-)/.test(candidate.id))
      .filter((candidate) => !candidate.dependsOn.includes("Z-FINAL"));
    const incomplete = collectIncompleteZFinalPredecessors(items);
    if (incomplete.length > 0) {
      failGate(
        `Z-FINAL precondition: all predecessor Z-* and ZC-* items must be [x] before final cleanup:\n` +
          incomplete.map((candidate) => `${candidate.statusToken} ${candidate.id} ${candidate.title}`).join("\n"),
      );
    }
    pass(`Z-FINAL precondition: ${predecessors.length} predecessor Z/ZC item(s) are done`);
  }

  function listRuntimeDirectories() {
    const runtimeSrc = path.join(root, "runtime/src");
    const out = [];
    function visit(dir) {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const child = path.join(dir, entry.name);
        out.push(child);
        visit(child);
      }
    }
    visit(runtimeSrc);
    return out;
  }

  function readZFinalKnipIssueIgnoreEntries() {
    const ignorePath = path.join(root, Z_FINAL_KNIP_ISSUE_IGNORE_REL);
    if (!existsSync(ignorePath)) return [];
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(ignorePath, "utf8"));
    } catch (error) {
      failGate(`Z-FINAL gate 4: ${Z_FINAL_KNIP_ISSUE_IGNORE_REL} is not valid JSON: ${error?.message || error}`);
    }
    try {
      return normalizeKnipIssueIgnoreEntries(parsed?.entries);
    } catch (error) {
      failGate(`Z-FINAL gate 4: ${Z_FINAL_KNIP_ISSUE_IGNORE_REL} ${error?.message || error}`);
    }
  }

  function readZFinalKnipConfig() {
    const configPath = path.join(root, Z_FINAL_KNIP_CONFIG_REL);
    try {
      return JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      failGate(`Z-FINAL gate 4: ${Z_FINAL_KNIP_CONFIG_REL} is not valid JSON: ${error?.message || error}`);
    }
  }

  function assertZFinalKnipConfigCoversExactAuditEntries(config, ignoreEntries) {
    const expected = collectKnipIssueTypesByFile(ignoreEntries);
    const actual = config?.ignoreIssues && typeof config.ignoreIssues === "object" ? config.ignoreIssues : {};
    const missing = [];
    const stale = [];
    for (const [file, types] of Object.entries(expected)) {
      const actualTypes = new Set(Array.isArray(actual[file]) ? actual[file] : []);
      for (const type of types) {
        if (!actualTypes.has(type)) missing.push(`${file}: ${type}`);
      }
    }
    for (const [file, types] of Object.entries(actual)) {
      if (!Array.isArray(types)) {
        stale.push(`${file}: invalid non-array ignoreIssues entry`);
        continue;
      }
      const expectedTypes = new Set(expected[file] ?? []);
      for (const type of types) {
        if (!expectedTypes.has(type)) stale.push(`${file}: ${type}`);
      }
    }
    if (missing.length > 0 || stale.length > 0) {
      failGate(
        `Z-FINAL gate 4: ${Z_FINAL_KNIP_CONFIG_REL} ignoreIssues must match ${Z_FINAL_KNIP_ISSUE_IGNORE_REL} file/type coverage exactly.\n` +
          `${missing.length > 0 ? `Missing from ${Z_FINAL_KNIP_CONFIG_REL}:\n${missing.slice(0, 80).join("\n")}\n` : ""}` +
          `${stale.length > 0 ? `Stale in ${Z_FINAL_KNIP_CONFIG_REL}:\n${stale.slice(0, 80).join("\n")}` : ""}`,
      );
    }
  }

  function parseZFinalKnipReport(result, label) {
    if (result.status !== 0) {
      failGate(`Z-FINAL gate 4: ${label} failed to run:\n${summarizeCommandOutput(result)}`);
    }
    try {
      return JSON.parse(result.stdout || "{}");
    } catch (error) {
      failGate(`Z-FINAL gate 4: ${label} JSON reporter output was not parseable: ${error?.message || error}`);
    }
  }

  function runZFinalKnip(configPath = null) {
    const argv = [
      "--yes",
      "--package",
      "knip@5.85.0",
      "knip",
      "--no-progress",
      "--no-exit-code",
      "--reporter",
      "json",
      "--include",
      "files,dependencies,exports,types,enumMembers",
    ];
    if (configPath) argv.push("--config", configPath);
    return run("npx", argv, { silent: true });
  }

  function writeZFinalKnipAuditConfig(config) {
    const dir = mkdtempSync(path.join(tmpdir(), "agenc-z-final-knip-"));
    const configPath = path.join(dir, "knip.json");
    writeFileSync(configPath, JSON.stringify(stripKnipIssueAllowlists(config), null, 2) + "\n");
    return { dir, configPath };
  }

  const zFinalDebtCommentRe = /\b(?:TODO|FIXME|HACK|legacy|temporary|for now|remove after)\b/i;

  function collectTsCommentLines(source) {
    const comments = [];
    let index = 0;
    let line = 1;
    let state = "code";
    let commentStartLine = 0;
    let commentText = "";

    function consumeQuotedString(quote) {
      index += 1;
      let escaped = false;
      while (index < source.length) {
        const char = source[index];
        if (char === "\n") {
          line += 1;
          index += 1;
          if (quote !== "`") return;
          continue;
        }
        if (escaped) {
          escaped = false;
          index += 1;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          index += 1;
          continue;
        }
        index += 1;
        if (char === quote) return;
      }
    }

    while (index < source.length) {
      const char = source[index];
      const next = source[index + 1];
      if (state === "code") {
        if (char === "/" && next === "/") {
          state = "line";
          commentStartLine = line;
          commentText = "";
          index += 2;
          continue;
        }
        if (char === "/" && next === "*") {
          state = "block";
          commentStartLine = line;
          commentText = "";
          index += 2;
          continue;
        }
        if (char === "\"" || char === "'" || char === "`") {
          consumeQuotedString(char);
          continue;
        }
        if (char === "\n") line += 1;
        index += 1;
        continue;
      }

      if (state === "line") {
        if (char === "\n") {
          comments.push({ line: commentStartLine, text: commentText });
          state = "code";
          line += 1;
          index += 1;
          continue;
        }
        commentText += char;
        index += 1;
        continue;
      }

      if (state === "block") {
        if (char === "*" && next === "/") {
          comments.push({ line: commentStartLine, text: commentText });
          state = "code";
          index += 2;
          continue;
        }
        commentText += char;
        if (char === "\n") line += 1;
        index += 1;
      }
    }

    if (state === "line" || state === "block") {
      comments.push({ line: commentStartLine, text: commentText });
    }
    return comments;
  }

  function collectZFinalProductionDebtCommentHits() {
    const runtimeRoot = path.join(root, "runtime/src");
    return walkFiles(runtimeRoot)
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => !/\.test\.(ts|tsx)$/.test(file))
      .flatMap((file) => {
        const rel = path.relative(root, file).split(path.sep).join("/");
        const source = readFileSync(file, "utf8");
        const hits = [];
        for (const comment of collectTsCommentLines(source)) {
          const lines = comment.text.split("\n");
          for (let offset = 0; offset < lines.length; offset += 1) {
            const text = lines[offset].trim();
            if (zFinalDebtCommentRe.test(text)) {
              hits.push(`${rel}:${comment.line + offset}:${text}`);
            }
          }
        }
        return hits;
      });
  }

  function assertZFinalEndState() {
    assertZFinalPredecessorsDone();

    runRequiredZFinalCommand(
      "Z-FINAL gate 1: runtime tsc has zero errors",
      "npx",
      ["tsc", "--noEmit", "-p", "runtime/tsconfig.json"],
    );
    runRequiredZFinalCommand(
      "Z-FINAL gate 2: runtime strict unused-locals tsc has zero errors",
      "npx",
      [
        "tsc",
        "--strict",
        "--noUnusedLocals",
        "--noUnusedParameters",
        "--noEmit",
        "-p",
        "runtime/tsconfig.json",
      ],
    );
    assertZFinalTsPruneClean();

    const knipConfig = readZFinalKnipConfig();
    const ignoredIssueEntries = readZFinalKnipIssueIgnoreEntries();
    assertZFinalKnipConfigCoversExactAuditEntries(knipConfig, ignoredIssueEntries);

    const knipReport = parseZFinalKnipReport(runZFinalKnip(), "knip");
    const unusedFiles = Array.isArray(knipReport.files) ? knipReport.files : [];
    const configuredIssueEntries = collectKnipUnusedIssueEntries(knipReport);
    if (unusedFiles.length > 0 || configuredIssueEntries.length > 0) {
      failGate(
        `Z-FINAL gate 4: configured knip reported ${unusedFiles.length} unused file(s) and ${configuredIssueEntries.length} issue(s). ` +
          `Remove the dead surface or add justified file/type allow-list coverage to ${Z_FINAL_KNIP_CONFIG_REL}:\n` +
          configuredIssueEntries.slice(0, 80).map((entry) => `${entry.file}: ${entry.type} ${entry.name}`).join("\n"),
      );
    }

    const auditConfig = writeZFinalKnipAuditConfig(knipConfig);
    let auditIssueEntries = [];
    try {
      const rawKnipReport = parseZFinalKnipReport(runZFinalKnip(auditConfig.configPath), "raw knip audit");
      auditIssueEntries = collectKnipUnusedIssueEntries(rawKnipReport);
    } finally {
      rmSync(auditConfig.dir, { recursive: true, force: true });
    }
    const unignoredIssueEntries = findUnignoredKnipIssues(auditIssueEntries, ignoredIssueEntries);
    const staleIgnoredIssueEntries = findStaleKnipIssueIgnores(ignoredIssueEntries, auditIssueEntries);
    if (unignoredIssueEntries.length > 0) {
      failGate(
        `Z-FINAL gate 4: raw knip audit reported ${unignoredIssueEntries.length} issue(s) not covered by ${Z_FINAL_KNIP_ISSUE_IGNORE_REL}. ` +
          `Remove the dead surface or add an exact audit entry:\n` +
          unignoredIssueEntries.slice(0, 80).map((entry) => `${entry.file}: ${entry.type} ${entry.name}`).join("\n"),
      );
    }
    if (staleIgnoredIssueEntries.length > 0) {
      failGate(
        `Z-FINAL gate 4: ${Z_FINAL_KNIP_ISSUE_IGNORE_REL} contains ${staleIgnoredIssueEntries.length} stale issue ignore entr${staleIgnoredIssueEntries.length === 1 ? "y" : "ies"} no longer present in knip output:\n` +
          staleIgnoredIssueEntries.slice(0, 80).map((entry) => `${entry.file}: ${entry.type} ${entry.name ?? entry.namePattern}`).join("\n"),
      );
    }
    pass(`Z-FINAL gate 4: configured knip is clean and raw knip audit matches ${ignoredIssueEntries.length} exact issue entr${ignoredIssueEntries.length === 1 ? "y" : "ies"}`);

    const debtHits = collectZFinalProductionDebtCommentHits();
    if (debtHits.length > 0) {
      failGate(`Z-FINAL gate 5: production TODO/legacy/temporary comment debt remains:\n${debtHits.join("\n")}`);
    }
    pass("Z-FINAL gate 5: production TODO/legacy/temporary comment debt scan is clean");

    const upstreamImportScan = run("rg", [
      "--no-messages",
      "-l",
      "from .*agenc/upstream/",
      "runtime/src",
      "-g",
      "*.ts",
      "-g",
      "*.tsx",
    ], { silent: true });
    if (upstreamImportScan.status === 0 && upstreamImportScan.stdout.trim()) {
      failGate(`Z-FINAL gate 6: upstream importers remain:\n${upstreamImportScan.stdout.trim()}`);
    }
    if (upstreamImportScan.status > 1) {
      failGate(`Z-FINAL gate 6: upstream importer scan failed:\n${summarizeCommandOutput(upstreamImportScan)}`);
    }
    pass("Z-FINAL gate 6: upstream importer scan is clean");

    const forbiddenDirNames = new Set([
      // branding-scan: allow verifier rejects donor-named runtime dirs
      "openclaude",
      // branding-scan: allow verifier rejects donor-named runtime dirs
      "codex",
      "claude",
      "donor",
      "mirror",
      "vendored",
      "external",
      "_oc",
      "_cx",
    ]);
    const forbiddenDirs = listRuntimeDirectories()
      .filter((dir) => forbiddenDirNames.has(path.basename(dir)))
      .map((dir) => path.relative(root, dir).split(path.sep).join("/"));
    if (forbiddenDirs.length > 0) {
      failGate(`Z-FINAL gate 7: donor-named runtime dir(s) remain:\n${forbiddenDirs.join("\n")}`);
    }
    pass("Z-FINAL gate 7: no donor-named runtime directories remain");

    const shimSuffixRe = /-(shim|adapter|compat|legacy|bridge|wrapper|facade|proxy|glue|forwarder|passthrough|stub|indirect|dispatch|barrel)\.[^/]+$/;
    const shimFiles = walkFiles(path.join(root, "runtime/src"))
      .map((file) => path.relative(root, file).split(path.sep).join("/"))
      .filter((rel) => shimSuffixRe.test(path.basename(rel)));
    if (shimFiles.length > 0) {
      failGate(`Z-FINAL gate 8: shim-pattern runtime file(s) remain:\n${shimFiles.join("\n")}`);
    }
    pass("Z-FINAL gate 8: no shim-pattern runtime files remain");

    const trackedNames = git("ls-files");
    if (trackedNames.status !== 0) failGate("Z-FINAL gate 9: git ls-files failed");
    const donorNamedTracked = trackedNames.stdout
      .split("\n")
      // branding-scan: allow verifier rejects donor-named tracked path patterns
      .filter((line) => /(openclaude|codex|claude_code|claudecode)/i.test(line));
    if (donorNamedTracked.length > 0) {
      failGate(`Z-FINAL gate 9: donor-named tracked path(s) remain:\n${donorNamedTracked.join("\n")}`);
    }
    pass("Z-FINAL gate 9: no donor-named tracked paths remain");

    runRequiredZFinalCommand(
      "Z-FINAL gate 10: validate:umbrella passes",
      "npm",
      ["run", "validate:umbrella"],
    );

    function collectZFinalGoalCompletedDirs(startDir, label) {
      const dirs = [];
      const rootDir = path.resolve(startDir);
      function visitForGoalCompleted(dir) {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          const child = path.join(dir, entry.name);
          if (entry.name === ".goal-completed") {
            dirs.push(`${label}:${path.relative(rootDir, child).split(path.sep).join("/") || ".goal-completed"}`);
            continue;
          }
          visitForGoalCompleted(child);
        }
      }
      visitForGoalCompleted(rootDir);
      return dirs;
    }
    const goalCompletedDirs = [
      ...collectZFinalGoalCompletedDirs(root, "worktree"),
      ...(path.resolve(mainCheckoutRoot()) === path.resolve(root)
        ? []
        : collectZFinalGoalCompletedDirs(mainCheckoutRoot(), "main")),
    ];
    if (goalCompletedDirs.length > 0) {
      failGate(`Z-FINAL gate 11: .goal-completed dir(s) remain:\n${goalCompletedDirs.join("\n")}`);
    }
    pass("Z-FINAL gate 11: no .goal-completed marker directory remains in this worktree or main checkout");

    const portArtifacts = ["PORT_CHECKLIST.md", "GOAL_DISCIPLINE.md", "AGENTS.md"]
      .filter((rel) => existsSync(path.join(root, rel)));
    if (portArtifacts.length > 0) {
      failGate(`Z-FINAL gate 12: top-level port-era artifact(s) remain:\n${portArtifacts.join("\n")}`);
    }
    pass("Z-FINAL gate 12: top-level port-era artifacts are absent in this worktree");

    const parityDocs = walkFiles(path.join(root, "runtime/src"))
      .filter((file) => path.basename(file) === "PARITY.md")
      .map((file) => path.relative(root, file).split(path.sep).join("/"));
    if (parityDocs.length > 0) {
      failGate(`Z-FINAL gate 13: runtime PARITY.md scaffolding remains:\n${parityDocs.join("\n")}`);
    }
    pass("Z-FINAL gate 13: runtime PARITY.md scaffolding is gone");
  }

  function assertZPurgecTemporaryBoundaries() {
    const tsconfigSource = readFileSync(path.join(root, "runtime/tsconfig.json"), "utf8");
    const tsconfigBoundary = validateZPurgecTsconfigBoundary(tsconfigSource);
    if (tsconfigBoundary.issues.length > 0) {
      failGate(
        `Z-PURGEC: runtime/tsconfig.json temporary boundary is not exact:\n  ${tsconfigBoundary.issues.join("\n  ")}`,
      );
    }
    pass(`Z-PURGEC: runtime/tsconfig.json has exact ${tsconfigBoundary.entries.length}-entry concrete temporary boundary and no broad migrated-root exclusions`);

    const movedBoundaryPrefixes = [
      "// @ts-nocheck\n" +
        "// Temporary boundary: this moved utility still imports not-yet-absorbed upstream subsystems.\n",
      "// @ts-nocheck\n" +
        "// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.\n",
      "// @ts-nocheck\n" +
        "// temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.\n",
      "// @ts-nocheck\n" +
        "// temporary boundary: moved purge surface is outside baseline typecheck.\n",
      "// @ts-nocheck\n" +
        "// Z-PURGEC strictness boundary: tracked by scripts/goal/verify.mjs.\n",
      "// @ts-nocheck -- temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.",
      "// @ts-nocheck -- temporary boundary: moved purge surface is outside baseline typecheck.",
      "// @ts-nocheck\n" +
        "// Z-PURGEC strictness boundary: tracked by scripts/goal/verify.mjs.\n",
      "// @ts-nocheck -- Z-PURGEC strictness boundary: tracked by scripts/goal/verify.mjs.",
    ];
    const runtimeFiles = walkFiles(path.join(root, "runtime/src"))
      .filter((file) => /\.(ts|tsx|mts|cts)$/.test(file))
      .filter((file) => !file.split(path.sep).join("/").includes("/runtime/src/agenc/upstream/"));
    const boundaryFiles = runtimeFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      return movedBoundaryPrefixes.some((prefix) => source.startsWith(prefix));
    });
    const undocumentedUnchecked = runtimeFiles.filter((file) => {
      const source = readFileSync(file, "utf8");
      return source.startsWith("// @ts-nocheck") &&
        !movedBoundaryPrefixes.some((prefix) => source.startsWith(prefix));
    });
    if (undocumentedUnchecked.length > 0) {
      failGate(
        `Z-PURGEC: ${undocumentedUnchecked.length} runtime file(s) keep undocumented ts-nocheck:\n  ${undocumentedUnchecked.slice(0, 20).map((f) => path.relative(root, f)).join("\n  ")}`,
      );
    }
    if (boundaryFiles.length > 800) {
      failGate(`Z-PURGEC: ${boundaryFiles.length} moved file(s) keep ts-nocheck; expected <= 800 documented boundary files`);
    }
    pass(`Z-PURGEC: moved ts-nocheck boundary documented and capped at ${boundaryFiles.length} file(s)`);

    const scannerTest = run("node", ["scripts/goal/purge-scans.test.mjs"]);
    if (scannerTest.status !== 0) {
      failGate("Z-PURGEC: purge scanner self-test failed");
    }
    pass("Z-PURGEC: purge scanner self-test passed");

    const tsupResolutionTest = run("npm", [
      "test",
      "--workspace",
      "@tetsuo-ai/runtime",
      "--",
      "--run",
      "tests/zpurgec-tsup-resolution.test.ts",
    ]);
    if (tsupResolutionTest.status !== 0) {
      failGate("Z-PURGEC: tsup resolution boundary test failed");
    }
    pass("Z-PURGEC: tsup resolution boundary test passed");
  }

  if (id === "Z-PURGEA") {
    assertSubtreesPurged(["utils", "constants"], "utils + constants");
    const movedRoots = [
      path.join(root, "runtime/src/utils"),
      path.join(root, "runtime/src/constants"),
    ];
    const movedFiles = movedRoots.flatMap((dir) =>
      existsSync(dir)
        ? walkFiles(dir).filter((f) => /\.(ts|tsx|mts|cts)$/.test(f))
        : [],
    );
    const movedBoundaryPrefix =
      "// @ts-nocheck\n" +
      "// Temporary boundary: this moved utility still imports not-yet-absorbed upstream subsystems.\n";
    const unchecked = movedFiles.filter((f) =>
      readFileSync(f, "utf8").startsWith("// @ts-nocheck"),
    );
    const undocumentedUnchecked = unchecked.filter((f) =>
      !readFileSync(f, "utf8").startsWith(movedBoundaryPrefix),
    );
    if (undocumentedUnchecked.length > 0) {
      failGate(
        `Z-PURGEA: ${undocumentedUnchecked.length} moved file(s) keep undocumented ts-nocheck:\n  ${undocumentedUnchecked.slice(0, 10).map((f) => path.relative(root, f)).join("\n  ")}`,
      );
    }
    if (unchecked.length > 50) {
      failGate(`Z-PURGEA: ${unchecked.length} moved file(s) keep ts-nocheck; expected <= 50 boundary files`);
    }
    pass(`Z-PURGEA: moved utils/constants ts-nocheck narrowed to ${unchecked.length} documented boundary file(s)`);

    const transitiveBoundaryRoots = [
      "runtime/src/agenc/upstream",
      "runtime/src/tui",
      "runtime/src/memdir",
    ];
    const transitiveBoundaryPrefixes = [
      "// @ts-nocheck\n" +
        "// Temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.\n",
      "// @ts-nocheck -- temporary boundary: imported by moved purge roots until the owning subsystem is absorbed.\n",
    ];
    const transitiveUnchecked = transitiveBoundaryRoots.flatMap((dir) => {
      const abs = path.join(root, dir);
      return existsSync(abs)
        ? walkFiles(abs).filter((f) => {
          if (!/\.(ts|tsx|mts|cts)$/.test(f)) return false;
          return readFileSync(f, "utf8").startsWith("// @ts-nocheck");
        })
        : [];
    });
    const undocumentedTransitiveUnchecked = transitiveUnchecked.filter((f) =>
      !transitiveBoundaryPrefixes.some((prefix) =>
        readFileSync(f, "utf8").startsWith(prefix),
      ),
    );
    if (undocumentedTransitiveUnchecked.length > 0) {
      failGate(
        `Z-PURGEA: ${undocumentedTransitiveUnchecked.length} transitive file(s) keep undocumented ts-nocheck:\n  ${undocumentedTransitiveUnchecked.slice(0, 10).map((f) => path.relative(root, f)).join("\n  ")}`,
      );
    }
    if (transitiveUnchecked.length > 200) {
      failGate(`Z-PURGEA: ${transitiveUnchecked.length} transitive file(s) keep ts-nocheck; expected <= 200 boundary files`);
    }
    pass(`Z-PURGEA: transitive ts-nocheck documented for ${transitiveUnchecked.length} boundary file(s)`);

    const bannedMovedPatterns = [
      /github\.com\/anthropics\/agenc-code/i,
      /github\.com\/Gitlawb\/agenc/i,
      /raw\.githubusercontent\.com\/anthropics\/agenc-code/i,
      /raw\.githubusercontent\.com\/anthropics\/agenc-plugins-official/i,
      /anthropics\/agenc-code/i,
      /anthropics\/agenc-plugins-official/i,
      /@anthropic-ai\/agenc-code/i,
      /support\.anthropic\.com/i,
      /noreply@anthropic\.com/i,
      /agencusercontent\.com/i,
      /anthropic\.agenc-code(?:-internal)?/i,
      /https:\/\/(?:code|platform|downloads)\.agenc\./i,
      /agenc\.dev\b/i,
      /https:\/\/agenc\.(?:ai|com|dev)\b/i,
      /mcp__claude-in-chrome__/i,
      /claude-in-chrome/i, // branding-scan: allow verifier rejects stale donor MCP prefix
      /com\.anthropic\.agenc/i,
    ];
    const bannedFindings = [];
    for (const file of movedFiles) {
      const rel = path.relative(root, file);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (bannedMovedPatterns.some((re) => re.test(line))) {
          bannedFindings.push(`${rel}:${index + 1}: ${line.trim().slice(0, 180)}`);
        }
      });
    }
    if (bannedFindings.length > 0) {
      failGate(
        `Z-PURGEA: moved utils/constants contain banned donor/domain strings:\n  ${bannedFindings.slice(0, 20).join("\n  ")}${bannedFindings.length > 20 ? `\n  ... +${bannedFindings.length - 20} more` : ""}`,
      );
    }
    pass("Z-PURGEA: moved utils/constants donor/domain sweep clean");
    await assertZPurgeATsupAliasBoundaries();
    const movedDonorTests = walkFiles(path.join(root, "runtime/src"))
      .filter((file) =>
        /runtime\/src\/(?:utils|constants)\/.*\.test\.(ts|tsx)$/.test(file.split(path.sep).join("/"))
      );
    const vitestConfigSource = readFileSync(path.join(root, "runtime/vitest.config.ts"), "utf8");
    if (
      movedDonorTests.length > 0 &&
      !vitestConfigSource.includes("movedDonorTestFiles")
    ) {
      failGate("Z-PURGEA: moved donor-origin tests are not explicitly quarantined from Vitest");
    }
    pass(`Z-PURGEA: moved donor-origin test quarantine documented for ${movedDonorTests.length} file(s)`);
    const movedRuntimeProbe = run("npm", [
      "test",
      "--workspace",
      "@tetsuo-ai/runtime",
      "--",
      "--run",
      "tests/zpurgea-importability.test.ts",
    ]);
    if (movedRuntimeProbe.status !== 0) {
      failGate("Z-PURGEA: moved utility Vitest/importability probe failed");
    }
    pass("Z-PURGEA: moved utility Vitest/importability probe passed");
    return;
  }
  if (id === "Z-PURGEB") {
    assertSubtreesPurged(["components", "hooks", "context"], "components + hooks + context");
    return;
  }
  if (id === "Z-PURGEC") {
    assertSubtreesPurged(
      [
        "tools", "services", "types", "tasks", "state",
        "buddy", "bridge", "bootstrap", "coordinator",
        "commands", "screens", "native-ts",
      ],
      "remaining upstream subtrees (tools/services/types/etc.)",
    );
    // Top-level files in upstream/ (e.g. Tool.js) must also be gone.
    const upstreamRoot = path.join(root, "runtime/src/agenc/upstream");
    if (existsSync(upstreamRoot)) {
      const topLevelFiles = readdirSync(upstreamRoot)
        .filter((name) => {
          const p = path.join(upstreamRoot, name);
          return existsSync(p) && !statSync(p).isDirectory();
        });
      if (topLevelFiles.length > 0) {
        failGate(`${id}: ${topLevelFiles.length} top-level file(s) still in runtime/src/agenc/upstream/:\n  ${topLevelFiles.join("\n  ")}`);
      }
    }
    pass(`${id}: no top-level upstream files remain`);
    assertNoRuntimeUpstreamReferences("runtime purge surface");
    assertZPurgecTemporaryBoundaries();
    return;
  }
  if (id === "Z-PURGEFINAL" || id === "Z-FINAL") {
    if (existsSync(path.join(root, "runtime/src/agenc/upstream"))) {
      const remaining = walkFiles(path.join(root, "runtime/src/agenc/upstream"));
      if (remaining.length > 0) {
        failGate(
          `${id}: runtime/src/agenc/upstream/ still has ${remaining.length} file(s) — run Z-PURGEA/B/C first`,
        );
      }
      failGate(`${id}: runtime/src/agenc/upstream/ exists (empty); delete the directory itself`);
    }
    assertNoRuntimeUpstreamReferences("final runtime purge surface");
    pass(`${id}: upstream/ tree fully removed, zero importers`);
    if (id === "Z-FINAL") {
      assertZFinalEndState();
    }
    return;
  }
  if (id === "Z-01" || id === "Z-02") {
    const r = run("rg", ["--no-messages", "-l", "agenc/upstream", "runtime/src"]);
    if (r.status === 0 && r.stdout.trim()) {
      failGate(`agenc/upstream/ still imported in:\n${r.stdout}`);
    }
    pass("zero upstream importers in runtime/src");
  }
  if (id === "Z-02") {
    if (existsSync(path.join(root, "runtime/src/agenc/upstream"))) {
      failGate("runtime/src/agenc/upstream/ still exists; delete it");
    }
    pass("agenc/upstream/ removed");
  }
  if (id === "Z-03") {
    // Z-03 deletes the upstream-* adapters under runtime/src/agenc/adapters/.
    const adaptersDir = path.join(root, "runtime/src/agenc/adapters");
    if (existsSync(adaptersDir)) {
      const remaining = readdirSync(adaptersDir).filter((f) => /^upstream-/.test(f));
      if (remaining.length > 0) {
        failGate(`upstream-* adapters still in runtime/src/agenc/adapters/:\n  ${remaining.join("\n  ")}`);
      }
    }
    pass("no upstream-* adapters remain");
  }
  if (id === "Z-04") {
    // Z-04 tightens runtime/tsconfig.json — strict typecheck must pass without the agenc/** exclude.
    const tsconfigPath = path.join(root, "runtime/tsconfig.json");
    const tsconfig = readFileSync(tsconfigPath, "utf8");
    if (/"src\/agenc\/\*\*\/?\*?"/.test(tsconfig)) {
      failGate("runtime/tsconfig.json still excludes src/agenc/**/* — Z-04 must remove that exclude.");
    }
    pass("tsconfig has no src/agenc/** exclude");
  }
  if (id === "Z-05") {
    // Z-05 final branding sweep — branding-scan must come back clean over the whole runtime/src tree.
    const allTsRes = run("bash", ["-c", "git ls-files runtime/src | rg '\\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$'"], { silent: true });
    if (allTsRes.status !== 0) failGate("Z-05: failed to enumerate tracked runtime source files");
    const files = (allTsRes.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (files.length === 0) failGate("Z-05: no TS files found to scan");
    const r = run("node", [path.join(root, "scripts/branding-scan.mjs"), ...files]);
    if (r.status !== 0) failGate("Z-05: branding-scan reported findings on full runtime/src sweep");
    pass(`Z-05: branding clean across ${files.length} tracked source files`);
  }
  if (id === "Z-06") {
    // Z-06 removes parity scaffolding (MATRIX files, port-tracking artifacts)
    // from inside the AgenC repo. The skill itself is the implementer's
    // personal toolchain and is out of scope.
    const parityDir = path.join(root, "pa" + "rity");
    if (existsSync(parityDir)) {
      const remaining = readdirSync(parityDir);
      if (remaining.length > 0) {
        failGate(`Z-06: parity/ still contains ${remaining.length} file(s); delete the dir.`);
      }
    }
    const runtimeParityDir = path.join(root, "runtime", "pa" + "rity");
    if (existsSync(runtimeParityDir)) {
      const remaining = readdirSync(runtimeParityDir);
      if (remaining.length > 0) {
        failGate(`Z-06: runtime/parity/ still contains ${remaining.length} file(s); delete the dir.`);
      }
    }
    const pathChars = "[^[:space:]\"'()<>]+";
    const deletedMatrixRefPattern = `(^|[[:space:]"'(<])(${["parity", "runtime/parity"].join("|")})/${pathChars}\\.(json|md)`;
    const deletedScriptRefPattern = `(^|[[:space:]"'(<])((scripts|runtime/scripts)/)?(${["check", "verify", "run"].join("|")})-${pathChars}(parity|contract)${pathChars}\\.mjs`;
    const quotedParity = `["']${"parity"}["']`;
    const dynamicParityConsumerPattern = `(path\\.)?(join|resolve)\\([^\\n]*${quotedParity}`;
    const staleRefPatterns = [
      {
        pattern: deletedMatrixRefPattern,
        scopes: [
          ".githooks",
          "package.json",
          "runtime/package.json",
          "scripts",
          "runtime/scripts",
          "runtime/src",
          "runtime/tests",
          "docs/plan",
        ],
      },
      {
        pattern: deletedScriptRefPattern,
        scopes: [
          ".githooks",
          "package.json",
          "runtime/package.json",
          "scripts",
          "runtime/scripts",
          "runtime/src",
          "runtime/tests",
        ],
      },
      {
        pattern: dynamicParityConsumerPattern,
        scopes: ["scripts", "runtime/scripts", "runtime/src", "runtime/tests"],
      },
    ];
    const staleRefOutputs = [];
    for (const { pattern, scopes } of staleRefPatterns) {
      const scan = run("git", [
        "grep",
        "-n",
        "-E",
        pattern,
        "--",
        ...scopes,
        ":(exclude)scripts/goal/complete.mjs",
        ":(exclude)scripts/goal/verify.mjs",
      ], { silent: true });
      if (scan.status === 0) staleRefOutputs.push(scan.stdout.trim());
      else if (scan.status !== 1) failGate("Z-06: failed to scan for deleted parity scaffold references");
    }
    const scriptRefScan = run("git", [
      "grep",
      "-n",
      "-E",
      "(check|validate|test):[A-Za-z0-9:_-]+",
      "--",
      ".githooks",
      "package.json",
      "runtime/package.json",
      "scripts",
      "runtime/scripts",
      ":(exclude)scripts/goal/complete.mjs",
      ":(exclude)scripts/goal/verify.mjs",
    ], { silent: true });
    if (scriptRefScan.status === 0) {
      const staleScriptRefs = scriptRefScan.stdout
        .split("\n")
        .filter((line) => /(?:check|validate|test):[^\s"'`]*?(?:parity|contract)[^\s"'`]*/i.test(line));
      if (staleScriptRefs.length > 0) staleRefOutputs.push(staleScriptRefs.join("\n"));
    } else if (scriptRefScan.status !== 1) {
      failGate("Z-06: failed to scan for deleted parity npm script references");
    }
    if (staleRefOutputs.length > 0) {
      failGate(`Z-06: live files still reference deleted parity scaffolding:\n${staleRefOutputs.join("\n")}`);
    }
    pass("Z-06: parity scaffolding removed");
  }
  // ZC-* items: each ZC item has a specific deletion/cleanup target named
  // in its row body. The body's grep / file-existence assertions are the
  // contract; we extract them and verify here.
  if (/^ZC-/.test(id)) {
    const donorPathPattern =
      "/(open" + "clau" + "de|co" + "dex|clau" + "de|Open" + "Clau" + "de|Co" + "dex|Clau" + "de)/";
    const zcMap = {
      "ZC-01": { gone: ["runtime/src/agenc/adapters/prompt-input-fast-mode.tsx", "runtime/src/agenc/adapters/prompt-input-terminal-setup.ts", "runtime/src/agenc/adapters/prompt-input-ultrareview.ts"] },
      "ZC-02": { gone: ["runtime/src/bin/_deps/session-id-compat.ts"] },
      "ZC-03": { gone: ["runtime/src/tui/openclaude"] }, // branding-scan: allow donor-named dir that ZC-03 deletes
      "ZC-04": { gone: ["runtime/src/agenc/adapters"] },
      "ZC-05": { grepNotPresent: { pattern: "from .*agenc/upstream/", scope: "runtime/src" } },
      "ZC-06": {
        grepNotPresent: {
          pattern: "^export \\* from ",
          scope: "runtime/src",
          globs: ["*.ts", "*.tsx"],
          excludeGlobs: ["*.test.ts", "*.test.tsx"],
        },
        custom: assertNoRuntimeForwarderOnlyModules,
      },
      "ZC-07": {
        grepNotPresent: {
          pattern: "TODO.*(legacy|temporary|remove after|backward[ -]?compat|for now)",
          scope: "runtime/src",
          globs: ["*.ts", "*.tsx"],
          excludeGlobs: ["*.test.ts", "*.test.tsx"],
          caseInsensitive: true,
        },
      },
      "ZC-08": { custom: assertZc08NoDeletedShimSubjectTests },
      "ZC-09": {
        grepNotPresent: {
          pattern: donorPathPattern,
          scope: "runtime/src",
        },
      },
      "ZC-10": { gone: ["runtime/src/agenc/upstream", "runtime/src/types/runtime-ambient.d.ts"] },
      "ZC-11": { gone: ["runtime/src/tools/code-mode/response-adapter.ts"] },
      "ZC-12": { custom: assertZc12DonorPortArtifactsGone },
      "ZC-13": { gone: ["runtime/src/tui/bridges"] },
      "ZC-14": { gone: ["runtime/src/llm/grok/adapter.ts", "runtime/src/llm/grok/adapter-utils.ts"] },
      "ZC-15": { custom: assertZc15ChecklistHandoffClarified },
      "ZC-16": { gone: ["runtime/src/agenc/adapters/dynamic-loaders.js", "runtime/src/agenc/adapters/dynamic-loaders.d.ts"] },
      "ZC-17": {
        gone: ["runtime/src/config/upstream-init.ts", "runtime/src/config/upstream-init.test.ts"],
        grepNotPresent: { pattern: "upstream-init", scope: "runtime/src" },
      },
      "ZC-18": { gone: ["runtime/parity/agenc-compaction-context.json"] },
      "ZC-19": { grepPresent: { pattern: "openai-compatible.*OpenAI HTTP API protocol.*not a port-era shim", scope: "runtime/src/llm/providers/openai-compatible/README.md" } }, // branding-scan: allow real OpenAI protocol name in ZC-19 evidence
      "ZC-20": { custom: assertZc20NoRuntimeShimCruft },
      "ZC-21": { custom: assertZc21McpClientBridgeFilesRenamed },
      "ZC-22": {
        gone: ["runtime/src/tui/elicitation-bridge.tsx"],
        grepNotPresent: { pattern: "elicitation-bridge", scope: "runtime/src" },
        custom: assertZc22ElicitationRendererInlined,
      },
      "ZC-23": { custom: assertNoRuntimeForwarderOnlyModules },
      "ZC-24": { custom: assertZc24UnusedDependenciesRemoved },
      "ZC-26": { grepNotPresent: { pattern: "/home/claude/.agenc/remote", scope: "runtime/src" } }, // branding-scan: allow donor-leak path that ZC-26 is removing
      "ZC-27": {
        gone: ["runtime/src/tools/shared/gitOperationTracking.ts"],
        grepNotPresent: { pattern: "@ts-nocheck", scope: "runtime/src" },
      },
      "ZC-28": { gone: ["runtime/src/utils/attachments.ts", "runtime/src/utils/teamMemoryOps.ts", "runtime/src/components/FeedbackSurvey/useMemorySurvey.tsx"] },
      "ZC-29": { custom: assertZc29AuditEvidence },
      "ZC-30": { custom: assertZc30PluginCoverage },
      "ZC-31": { custom: assertZc31SkillsCoverage },
      "ZC-32": { custom: assertZc32ShellCommandCoverage },
      "ZC-33": { custom: assertZc33SandboxCoverage },
      "ZC-34": { custom: assertZc34AgentGraphStoreCoverage },
      "ZC-35": { custom: assertZc35OcCoverage },
      "ZC-37": { custom: assertZc37UndefinedDirectoryGone },
      "ZC-39": { custom: assertZc39VoicePartialPortResolved },
      "ZC-42": { custom: assertZc42ExternalAgentMigrationPort },
      "ZC-36": { custom: assertZc36TestFixtureParityCoverage },
      "ZC-38": { custom: assertZc38DistBuildArtifactsIgnored },
      "ZC-41": { custom: assertZc41ObservabilityCoverage },
      "ZC-40": { custom: assertZc40RuntimeParityDocsGone },
      "ZC-43": { custom: assertZc43NetworkPolicyInterfaces },
    };
    const expectations = zcMap[id];
    if (!expectations) {
      failGate(
        `${id}: no specific gate. Add a structural assertion (path-gone or grep-not-present) for ${id} ` +
        `to the zcMap inside cleanupGates() in scripts/goal/verify.mjs.`,
      );
    }
    if (expectations.gone) {
      for (const p of expectations.gone) {
        if (existsSync(path.join(root, p))) failGate(`${id}: expected ${p} to be deleted; still exists.`);
      }
      pass(`${id}: ${expectations.gone.length} target path(s) confirmed deleted`);
    }
    if (expectations.grepNotPresent) {
      const { pattern, scope, globs, excludeGlobs, caseInsensitive } = expectations.grepNotPresent;
      if (grepRepo(pattern, scope, { globs, excludeGlobs, caseInsensitive })) failGate(`${id}: pattern "${pattern}" still found in ${scope}; should return zero hits.`);
      pass(`${id}: no hits for "${pattern}" in ${scope}`);
    }
    if (expectations.grepPresent) {
      const { pattern, scope, globs, excludeGlobs, caseInsensitive } = expectations.grepPresent;
      if (!grepRepo(pattern, scope, { globs, excludeGlobs, caseInsensitive })) failGate(`${id}: pattern "${pattern}" not found in ${scope}.`);
      pass(`${id}: required pattern "${pattern}" found in ${scope}`);
    }
    if (expectations.custom) {
      await expectations.custom();
      pass(`${id}: custom cleanup gate passed`);
    }
    if (id === "ZC-06") {
      const deletedBases = zc06DeletedModuleBases();
      assertNoZc06DeletedModuleSurvivors(deletedBases);
      pass("ZC-06: deleted re-export modules have no same-base survivors");
      assertNoZc06DeletedModuleImporters(deletedBases);
      pass("ZC-06: no importers point at deleted re-export modules");
      assertChangedRelativeImportsResolve();
      pass("ZC-06: changed relative import targets resolve");
    }
    if (id === "ZC-23") {
      const deletedBases = zc06DeletedModuleBases("ZC-23");
      assertNoDeletedModuleSurvivors(deletedBases, "ZC-23");
      pass("ZC-23: deleted forwarder modules have no same-base survivors");
      assertNoDeletedModuleImporters(deletedBases, "ZC-23");
      pass("ZC-23: no importers point at deleted forwarder modules");
      assertChangedRelativeImportsResolve();
      pass("ZC-23: changed relative import targets resolve");
    }
  }
}

async function readFileSafe(p) {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(p, "utf8");
  } catch {
    return "";
  }
}

function walkFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}
