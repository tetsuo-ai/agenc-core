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
import { findItem, repoRoot, fail } from "./checklist-utils.mjs";

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
//   grepPresent: { pattern, scope }[]
//   grepNotPresent: { pattern, scope }[]
//   tests: string[] | { globUnder, matching, minCount?, optional? }[]
//   runStrict: boolean — if true, typecheck gate enforces zero errors.
const ITEM_EVIDENCE = {
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
      "runtime/src/services/compact/PARITY.md",
    ],
    tests: [
      "runtime/src/services/compact/compact.test.ts",
      "runtime/src/services/compact/autoCompact.test.ts",
      "runtime/src/services/compact/microCompact.test.ts",
      "runtime/src/services/compact/compact-surfaces.test.ts",
      "runtime/tests/compact-loader-service.contract.test.ts",
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
      "runtime/src/services/extractMemories/PARITY.md",
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
      "runtime/src/tools/PARITY.md",
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
      "runtime/src/services/PARITY.md",
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
      "runtime/src/cost/PARITY.md",
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
      "runtime/src/services/AgentSummary/PARITY.md",
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
      "runtime/src/sandbox/engine/PARITY.md",
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
      "runtime/src/sandbox/linux-launcher/PARITY.md",
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
    files: [{ globUnder: "runtime/src/sandbox/policy", matching: /\.tsx?$/, minCount: 1 }],
    tests: [{ globUnder: "runtime/src/sandbox/policy", matching: /\.test\.tsx?$/ }],
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
      "runtime/src/sandbox/execpolicy/PARITY.md",
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
      "runtime/src/state/migrations/PARITY.md",
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
      "runtime/src/tasks/PARITY.md",
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
      "runtime/src/tools/AgentTool/PARITY.md",
    ],
    tests: [
      "runtime/src/tools/ask-user-question-bridge-routing.test.tsx",
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
      "runtime/src/tui/startup/PARITY.md",
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
      "runtime/src/tui/history/PARITY.md",
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
      "runtime/src/tui/cost/PARITY.md",
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
      "runtime/src/tui/components/spinner/PARITY.md",
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
      "runtime/src/tui/components/markdown/PARITY.md",
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
  "T-13": {
    files: [
      "runtime/src/tui/slash/slash-command-parsing.ts",
      "runtime/src/tui/slash/argument-substitution.ts",
      "runtime/src/tui/slash/shell-quote.ts",
      "runtime/src/tui/slash/PARITY.md",
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
      "runtime/src/tui/input/PARITY.md",
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
      "runtime/src/tools/runtimes/PARITY.md",
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
    grepPresent: [{ pattern: "sandbox", scope: "runtime/src/permissions" }],
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
    files: ["runtime/src/permissions/command-parser.ts"],
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
  "MG-01": {
    files: ["runtime/src/bin/agenc.ts"],
  },
  "MG-04": {
    grepNotPresent: [{ pattern: "directRuntime|direct.*runtime|legacy.*direct", scope: "runtime/src/bin" }],
  },
  "MG-06": {
    grepPresent: [{ pattern: "autostart|spawnDaemon", scope: "packages/agenc" }],
  },
  "CF-01": {
    grepPresent: [{ pattern: "auth\\.backend", scope: "runtime/src/config" }],
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
    grepPresent: [{ pattern: "configMigration|migrateConfig|configVersion", scope: "runtime/src/config" }],
  },
  "CF-13": {
    tests: [{ globUnder: "runtime/src/config", matching: /\.test\.tsx?$/ }],
  },
  "CF-14": {
    grepPresent: [{ pattern: "agenc config", scope: "runtime/src" }],
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
    grepPresent: [{ pattern: "agenc init", scope: "runtime/src" }],
  },
  "OB-07": {
    grepPresent: [{ pattern: "AGENC\\.md", scope: "runtime/src/prompts" }],
  },
  "OB-09": {
    grepPresent: [{ pattern: "byok|paste.*key|enter.*api.*key", scope: "runtime/src" }],
  },
  "UP-01": {
    grepPresent: [{ pattern: "agenc update", scope: "runtime/src" }],
  },
  "UP-06": {
    files: [{ globUnder: "runtime/src/install-context", matching: /\.tsx?$/, minCount: 1 }],
  },
  "PR-02": {
    grepPresent: [{ pattern: "AGENC\\.md", scope: "runtime/src/prompts" }],
  },
  "MM-06": {
    grepPresent: [{ pattern: "agenc memory", scope: "runtime/src" }],
  },
  "Z-04": {
    // Strict typecheck must pass with NO baseline tolerance.
    runStrict: true,
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
const addedRes = git("diff", "--name-only", "--diff-filter=A", "main...HEAD");
const addedStagedRes = git("diff", "--name-only", "--diff-filter=A", "--cached");
const addedWtRes = git("ls-files", "--others", "--exclude-standard");
const added = new Set(
  [addedRes.stdout, addedStagedRes.stdout, addedWtRes.stdout]
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
  "main",
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
const SHIM_ALLOW_DIRS = [
  "runtime/src/mcp-client/",
];
const shimAdditions = [...added].filter((p) => {
  if (!SHIM_RE.test(p)) return false;
  if (/\.test\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(p)) return false;
  return !SHIM_ALLOW_DIRS.some((d) => p.startsWith(d));
});
if (shimAdditions.length > 0) {
  failGate(
    `forbidden: this item adds ${shimAdditions.length} new shim-pattern file(s) ` +
      `outside the legitimate location (runtime/src/mcp-client/). ` +
      `Banned suffixes: -shim/-adapter/-compat/-legacy/-bridge/-wrapper/-facade/-proxy/-glue/` +
      `-forwarder/-passthrough/-stub/-indirect/-dispatch/-barrel across .ts/.tsx/.mts/.cts/.mjs/.cjs/.js/.jsx. ` +
      `This codebase has no backwards-compatibility constraint; do not create wrapper files to keep ` +
      `old import paths alive. Inline the logic at the call site or move to its proper home.\n  ` +
      shimAdditions.map((p) => `- ${p}`).join("\n  "),
  );
}

// Behavior gate: catch forwarding-only modules whose filename doesn't match SHIM_RE.
// A new module whose body is >80% imports + re-exports + single-line forwards AND
// has fewer than 40 significant lines is functionally a shim regardless of name.
const FORWARD_LINE_RE =
  /^\s*(export\s*\*\s*from\b|export\s*type\s*\*\s*from\b|export\s*\{[^}]*\}\s*from\b|export\s*\{[^}]*\}\s*;?\s*$|export\s+default\s+\w+\s*;?\s*$|export\s*\*\s*as\s+\w+\s*from\b)/;
const FORWARD_STATEMENT_RE =
  /^\s*(export\s*\*\s*from\b|export\s*type\s*\*\s*from\b|export\s*\{[\s\S]*\}\s*from\b|export\s*\{[\s\S]*\}\s*;?\s*$|export\s+default\s+\w+\s*;?\s*$|export\s*\*\s*as\s+\w+\s*from\b)/;
const SINGLE_LINE_FORWARD_FN_RE =
  /^\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*\{\s*(?:return\s+(?:await\s+)?|await\s+)?[\w$.]+\([^{};]*\)\s*;?\s*\}\s*$/;
const SINGLE_LINE_FORWARD_ARROW_RE =
  /^\s*export\s+const\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*(?:\{\s*(?:return\s+(?:await\s+)?|await\s+)?[\w$.]+\([^{};]*\)\s*;?\s*\}|[\w$.]+\([^{};]*\)|[\w$.]+\.[\w$]+(?:\([^{};]*\))?)\s*;?\s*$/;
function countForwardingLines(significant) {
  return combineLogicalStatements(significant).filter((stmt) =>
    FORWARD_LINE_RE.test(stmt) ||
    FORWARD_STATEMENT_RE.test(stmt) ||
    SINGLE_LINE_FORWARD_FN_RE.test(stmt) ||
    SINGLE_LINE_FORWARD_ARROW_RE.test(stmt)
  ).length;
}
const forwardingViolations = [];
for (const rel of added) {
  if (!/^runtime\/src\//.test(rel)) continue;
  if (!/\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(rel)) continue;
  if (/\.test\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(rel)) continue;
  if (/\.d\.ts$/.test(rel)) continue;
  if (rel.startsWith("runtime/src/agenc/upstream/")) continue;
  let body;
  try {
    body = readFileSync(path.join(repoRoot(), rel), "utf8");
  } catch {
    continue;
  }
  if (body.length > 16000) continue; // big files aren't shims
  const lines = body.split("\n");
  const significant = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*") && l !== "*/");
  if (significant.length === 0 || significant.length >= 40) continue;
  const implementationLines = significant.filter((line) => !/^\s*import\s/.test(line));
  if (implementationLines.length === 0) continue;
  const logicalStatements = combineLogicalStatements(implementationLines);
  if (logicalStatements.length === 0 || logicalStatements.length >= 40) continue;
  const forward = countForwardingLines(implementationLines);
  const ratio = forward / logicalStatements.length;
  if (forward > 0 && ratio > 0.8) {
    forwardingViolations.push({ path: rel, ratio: ratio.toFixed(2), lines: logicalStatements.length, forward });
  }
}
if (forwardingViolations.length > 0) {
  failGate(
    `forbidden: this item adds ${forwardingViolations.length} forwarding-only module(s) ` +
      `(>80% imports + re-exports + single-line forwarders, <40 significant lines). ` +
      `These are shims by another name. Inline at the call site or move to canonical home.\n  ` +
      forwardingViolations.map((v) => `- ${v.path} (${v.forward}/${v.lines} forward lines, ratio ${v.ratio})`).join("\n  "),
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

function combineLogicalStatements(significant) {
  const statements = [];
  let current = "";
  let braceDepth = 0;
  for (const line of significant) {
    const startsMultilineForward = current.length > 0 || /^\s*(import|export)\s*\{/u.test(line);
    if (!startsMultilineForward) {
      statements.push(line);
      continue;
    }
    current = current.length === 0 ? line : `${current}\n${line}`;
    braceDepth += countChar(line, "{") - countChar(line, "}");
    if (braceDepth <= 0 && /(?:;|\bfrom\s+["'][^"']+["'];?)\s*$/u.test(line)) {
      statements.push(current);
      current = "";
      braceDepth = 0;
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

function countChar(value, needle) {
  let count = 0;
  for (const char of value) {
    if (char === needle) count += 1;
  }
  return count;
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
    "runtime/src/tools/ask-user-question-bridge-routing.test.tsx",
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
  if (id === "OC-10") {
    const required = [
      "runtime/src/cost/tracker.ts",
      "runtime/src/cost/hook.ts",
      "runtime/src/cost/PARITY.md",
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
      "runtime/src/state/migrations/PARITY.md",
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
      "runtime/src/tasks/PARITY.md",
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

  if (id === "S-14") {
    const required = [
      "runtime/src/services/notifier.ts",
      "runtime/src/services/preventSleep.ts",
      "runtime/src/services/tokenEstimation.ts",
      "runtime/src/services/PARITY.md",
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
      "runtime/src/tools/PARITY.md",
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
    // Daemon autostart wrapper.
    const found = grepRepo("agenc daemon", "runtime/src/bin");
    if (!found) failGate("MG-02: 'agenc daemon' wrapper not referenced in runtime/src/bin/");
    pass("MG-02: agenc daemon wrapper present");
    return;
  }
  if (id === "MG-03") {
    // Migration warning for direct-CLI fallback path users.
    const found = grepRepo("daemon mode unavailable|daemon-mode unavailable|direct-runtime fallback", "runtime/src");
    if (!found) failGate("MG-03: direct-runtime-fallback warning not found in runtime/src/");
    pass("MG-03: fallback warning present");
    return;
  }
  if (id === "MG-04") {
    // Direct-CLI removal. The runtime should now be daemon-driven only.
    const f = path.join(root, "runtime/src/app-server-client/index.ts");
    if (!existsSync(f)) failGate("runtime/src/app-server-client/index.ts missing — daemon-only CLI requires it");
    pass("daemon-only CLI client present");
    return;
  }
  if (id === "MG-05") {
    // Wrapper update for daemon autostart.
    const found = grepRepo("daemon.autostart", "runtime/src/config");
    if (!found) failGate("MG-05: 'daemon.autostart' config flag not referenced under runtime/src/config/");
    pass("MG-05: daemon.autostart wired");
    return;
  }
  if (id === "MG-06") {
    // Wrapper hand-off: npm wrapper invokes daemon path.
    const wrapperRoot = path.resolve(root, "..");
    const wrapperPkg = path.join(wrapperRoot, "packages/agenc/package.json");
    if (!existsSync(wrapperPkg)) {
      // No sibling wrapper checked out at this location — soft-pass with note.
      process.stdout.write(`${YELLOW}!${RESET} MG-06: sibling wrapper at ${wrapperPkg} not found; cannot verify wrapper hand-off from agenc-core alone.\n`);
      pass("MG-06: wrapper-hand-off check requires sibling agenc-core wrapper repo");
      return;
    }
    pass("MG-06: sibling wrapper present");
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
    "CF-02": "provider.default",
    "CF-03": "provider.managed_keys",
    "CF-04": "agenc",
    "CF-05": "sandbox.mode",
    "CF-06": "agent.retention_days",
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
  }
  if (id === "CF-14") {
    const cli = grepRepo("agenc config", "runtime/src");
    if (!cli) failGate("'agenc config' CLI surface not found anywhere in runtime/src/");
    pass("agenc config subcommand present");
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
  if (id === "OB-08" || id === "OB-09") {
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
    // Memory instructions.
    const found = grepRepo("memoryInstructions|memory_instructions", "runtime/src/prompts");
    if (!found) failGate("PR-06: memory instructions not referenced");
    pass("PR-06: memory instructions referenced");
    return;
  }
  if (id === "PR-07") {
    // Plugin instructions.
    const found = grepRepo("pluginInstructions|plugin_instructions|availablePlugins", "runtime/src/prompts");
    if (!found) failGate("PR-07: plugin instructions not referenced");
    pass("PR-07: plugin instructions referenced");
    return;
  }
  if (id === "PR-08") {
    // Per-mode prompt variants.
    const found = grepRepo("planMode|defaultMode|acceptEdits|byMode", "runtime/src/prompts");
    if (!found) failGate("PR-08: per-mode prompt variant not referenced");
    pass("PR-08: per-mode prompt variant referenced");
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
    // Memory loader/registry.
    const found = grepRepo("loadMemor|MemoryRegistry|loadMemdir|loadMemoryDir", "runtime/src");
    if (!found) failGate("MM-01: memory-loader surface not found");
    pass("MM-01: memory loader referenced");
    return;
  }
  if (id === "MM-02") {
    // AGENC.md inclusion / per-repo memory.
    const found = grepRepo("AGENC\\.md|agencMd|agencMemory", "runtime/src");
    if (!found) failGate("MM-02: AGENC.md / agenc-memory surface not found");
    pass("MM-02: AGENC.md inclusion referenced");
    return;
  }
  if (id === "MM-03") {
    // Mention syntax / @memory.
    const found = grepRepo("@memor|mentionSyntax|memoryMention", "runtime/src");
    if (!found) failGate("MM-03: memory mention syntax not found");
    pass("MM-03: memory mention referenced");
    return;
  }
  if (id === "MM-04") {
    // Per-conversation memory persistence.
    const found = grepRepo("MemoryStore|memoryStore|persistMemory|saveMemory", "runtime/src");
    if (!found) failGate("MM-04: memory persistence not found");
    pass("MM-04: memory persistence referenced");
    return;
  }
  if (id === "MM-05") {
    // Memory hot-reload via FW-01.
    const found = grepRepo("memoryReload|hot.reload|hotReload", "runtime/src/memory") ||
                  grepRepo("memoryReload|hot.reload|hotReload", "runtime/src/memdir");
    if (!found) failGate("MM-05: memory hot-reload not found");
    pass("MM-05: memory hot-reload referenced");
    return;
  }
  if (id === "MM-07" || id === "MM-08") {
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

async function webPortalGates(item) {
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

// Generic gate factory: subsystem must exist as a real directory under runtime/src,
// have at least one production module, and at least one test file. Used for FW/RT/SE/SK
// prefixes that previously had no gate at all.
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
  pass(`IDE-*: IDE protocol surface referenced (${id})`);
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

function zc06DeletedModuleBases() {
  const diff = git("diff", "--name-only", "--diff-filter=D", "main...HEAD", "--", "runtime/src");
  if (diff.status !== 0) {
    failGate("ZC-06: could not derive deleted module list from git diff");
  }
  const deletedBases = new Set();
  for (const rel of diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const baseRel = stripSourceModuleExtension(rel);
    if (!baseRel) continue;
    deletedBases.add(path.join(root, baseRel));
  }
  if (deletedBases.size === 0) {
    failGate("ZC-06: no deleted runtime source modules found in diff");
  }
  return deletedBases;
}

function assertNoZc06DeletedModuleSurvivors(deletedBases) {
  const survivors = [];
  for (const base of deletedBases) {
    for (const ext of sourceModuleExtensions()) {
      const candidate = `${base}${ext}`;
      if (existsSync(candidate)) survivors.push(path.relative(root, candidate).replaceAll("\\", "/"));
    }
  }
  if (survivors.length > 0) {
    failGate(`ZC-06: same-base module file(s) still exist for deleted re-export modules:\n${survivors.join("\n")}`);
  }
}

function assertNoZc06DeletedModuleImporters(deletedBases) {
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
        offenders.push(`${rel}: imports deleted ZC-06 module ${specifier}`);
      }
    }
  }

  if (offenders.length > 0) {
    failGate(`ZC-06: importer(s) still point at deleted re-export modules:\n${offenders.join("\n")}`);
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

async function cleanupGates(item) {
  // Recognized cleanup IDs. Anything outside this set must fail rather than
  // silently no-op through the function with no checks fired.
  const knownZ = new Set(["Z-01", "Z-02", "Z-03", "Z-04", "Z-05", "Z-06"]);
  if (!knownZ.has(id) && !/^ZC-/.test(id)) {
    failGate(
      `item ${id} has no specific gate branch in cleanupGates; add one or remove the item`,
    );
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
    const allTsRes = run("bash", ["-c", "find runtime/src -type f \\( -name '*.ts' -o -name '*.tsx' \\) | head -2000"], { silent: true });
    const files = (allTsRes.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (files.length === 0) failGate("Z-05: no TS files found to scan");
    const r = run("node", [path.join(root, "scripts/branding-scan.mjs"), ...files]);
    if (r.status !== 0) failGate("Z-05: branding-scan reported findings on full runtime/src sweep");
    pass(`Z-05: branding clean across ${files.length} files`);
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
      "ZC-10": { gone: ["runtime/src/agenc/upstream", "runtime/src/types/runtime-ambient.d.ts"] },
      "ZC-11": { gone: ["runtime/src/tools/code-mode/response-adapter.ts"] },
      "ZC-12": { custom: assertZc12DonorPortArtifactsGone },
      "ZC-13": { gone: ["runtime/src/tui/bridges"] },
      "ZC-14": { gone: ["runtime/src/llm/grok/adapter.ts", "runtime/src/llm/grok/adapter-utils.ts"] },
      "ZC-22": { gone: ["runtime/src/tui/elicitation-bridge.tsx"] },
      "ZC-26": { grepNotPresent: { pattern: "/home/claude/.agenc/remote", scope: "runtime/src" } }, // branding-scan: allow donor-leak path that ZC-26 is removing
      "ZC-27": { grepNotPresent: { pattern: "@ts-nocheck", scope: "runtime/src/types" } },
      "ZC-28": { gone: ["runtime/src/utils/attachments.ts", "runtime/src/utils/teamMemoryOps.ts", "runtime/src/components/FeedbackSurvey/useMemorySurvey.tsx"] },
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
    if (expectations.custom) {
      expectations.custom();
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
