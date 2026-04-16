/**
 * Slash command registry creation for the daemon.
 *
 * Extracted from daemon.ts to reduce file size.
 * Contains the createDaemonCommandRegistry() function that registers all
 * built-in slash commands (/help, /new, /init, /status, /model, /eval, etc.).
 *
 * @module
 */

import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { Logger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import type { GatewayConfig, GatewayMCPServerConfig } from "./types.js";
import type {
  LLMProvider,
  LLMProviderTraceEvent,
  LLMStoredResponse,
  ToolHandler,
} from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import { SlashCommandRegistry, createDefaultCommands } from "./commands.js";
import {
  buildSessionRuntimeContractStatusSnapshot,
  clearStatefulContinuationMetadata,
  coerceSessionShellProfile,
  DEFAULT_SESSION_SHELL_PROFILE,
  ensureSessionShellProfile,
  resolveSessionShellProfile,
  SessionManager,
  SESSION_REVIEW_SURFACE_STATE_METADATA_KEY,
  SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  SESSION_VERIFICATION_SURFACE_STATE_METADATA_KEY,
  type Session,
  type SessionShellProfile,
} from "./session.js";
import {
  formatModelRouteModelLabel,
  normalizeModelRouteSnapshot,
} from "./model-route.js";
import {
  formatSessionWorkflowStage,
  formatSessionWorktreeMode,
  resolveSessionWorkflowState,
  updateSessionWorkflowState,
  type SessionWorkflowStage,
} from "./workflow-state.js";
import type { DiscoveredSkill } from "../skills/markdown/discovery.js";
import type { DiscoveryPaths } from "../skills/markdown/discovery.js";
import { ToolRegistry } from "../tools/registry.js";
import { HookDispatcher } from "./hooks.js";
import { ApprovalEngine } from "./approvals.js";
import {
  coerceReviewSurfaceState,
  coerceVerificationSurfaceState,
  type ReviewSurfaceState,
  type VerificationSurfaceState,
  type WorkflowOwnershipEntry,
} from "./watch-cockpit.js";
import {
  collectSessionWorkflowOwnership,
  formatWorkflowOwnershipReply,
} from "./workflow-ownership.js";
import { ProgressTracker } from "./progress.js";
import {
  PipelineExecutor,
  type Pipeline,
  type PipelineStep,
} from "../workflow/pipeline.js";
import { ChatExecutor } from "../llm/chat-executor.js";
import type { GatewayMessage } from "./message.js";
import { createGatewayMessage } from "./message.js";
import {
  resolveTraceLoggingConfig,
  logProviderPayloadTraceEvent,
  truncateToolLogText,
  EVAL_REPLY_MAX_CHARS,
} from "./daemon-trace.js";
// ResolvedTraceLoggingConfig used indirectly via resolveTraceLoggingConfig
import {
  resolveSessionTokenBudget,
  DEFAULT_GROK_MODEL,
} from "./llm-provider-manager.js";
import {
  buildSessionStatefulOptions,
  clearWebSessionRuntimeState,
  persistWebSessionRuntimeState,
} from "./daemon-session-state.js";
import { hasRuntimeLimit } from "../llm/runtime-limit-policy.js";
import {
  buildCurrentApiView,
  buildCurrentContextUsageSnapshot,
} from "../llm/compact/context-window.js";
import {
  listKnownGrokModels,
  normalizeGrokModel,
} from "./context-window.js";
import { getDefaultWorkspacePath } from "./workspace-files.js";
import {
  computeMCPToolCatalogSha256,
  validateMCPServerBinaryIntegrity,
  validateMCPServerStaticPolicy,
} from "../policy/mcp-governance.js";
import type {
  DelegationAggressivenessProfile,
  ResolvedSubAgentRuntimeConfig,
} from "./subagent-infrastructure.js";
import type { VoiceBridge } from "./voice-bridge.js";
import type { WebChatChannel } from "../channels/webchat/plugin.js";
import type { SessionContinuityDetail } from "../channels/webchat/types.js";
import { PluginCatalog } from "../skills/catalog.js";
import { TASK_LIST_ARG } from "../tools/system/task-tracker.js";
import type {
  ShellAgentRoleDescriptor,
  ShellAgentRoleSource,
  ShellAgentToolBundleName,
} from "./shell-agent-roles.js";
import {
  evaluateShellFeatureRollout,
  formatShellRolloutHoldback,
  resolveConfiguredShellProfile,
} from "./shell-rollout.js";

// ============================================================================
// Eval script helpers (moved from daemon.ts top-level)
// ============================================================================

export interface EvalScriptResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export function didEvalScriptPass(result: EvalScriptResult): boolean {
  if (result.timedOut || result.exitCode !== 0) return false;
  return extractEvalOverall(result.stdout) === "pass";
}

function extractEvalOverall(stdout: string): "pass" | "fail" | undefined {
  const marker = stdout.match(/\bOverall:\s*(pass|fail)\b/i);
  if (marker) {
    return marker[1].toLowerCase() as "pass" | "fail";
  }

  const objectMatches = stdout.match(/\{[\s\S]*?\}/g);
  if (!objectMatches) return undefined;
  for (let i = objectMatches.length - 1; i >= 0; i--) {
    const candidate = objectMatches[i];
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed.overall === "pass" || parsed.overall === "fail") {
        return parsed.overall;
      }
    } catch {
      // continue scanning
    }
  }

  return undefined;
}

export function formatEvalScriptReply(result: EvalScriptResult): string {
  const stdout = formatEvalTextForReply(result.stdout);
  const stderr = formatEvalTextForReply(result.stderr);
  if (result.timedOut) {
    return (
      `Eval test timed out after ${result.durationMs}ms.` +
      (stdout ? `\nstdout:\n${stdout}` : "") +
      (stderr ? `\nstderr:\n${stderr}` : "")
    );
  }
  if (result.exitCode === 0) {
    return (
      `Eval test passed in ${result.durationMs}ms.` +
      (stdout ? `\nstdout:\n${stdout}` : "") +
      (stderr ? `\nstderr:\n${stderr}` : "")
    );
  }
  return (
    `Eval test failed (exit ${result.exitCode ?? "unknown"}) in ${result.durationMs}ms.` +
    (stderr ? `\nstderr:\n${stderr}` : "") +
    (stdout ? `\nstdout:\n${stdout}` : "")
  );
}

function formatEvalTextForReply(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return truncateToolLogText(trimmed, EVAL_REPLY_MAX_CHARS);
}

// ============================================================================
// Eval script runner (moved from daemon.ts top-level)
// ============================================================================

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { access as accessFs, constants as fsConstants } from "node:fs";

const EVAL_SCRIPT_NAME = "agenc-eval-test.cjs";
const EVAL_SCRIPT_TIMEOUT_MS = 10 * 60_000;

interface ResolveEvalScriptPathOptions {
  readonly cwd?: string;
  readonly workspacePath?: string;
  readonly canRead?: (candidate: string) => Promise<boolean>;
}

function getEvalScriptPathCandidates(options: ResolveEvalScriptPathOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const workspacePath = options.workspacePath ?? getDefaultWorkspacePath();
  return [
    resolvePath(cwd, "tools", "eval", EVAL_SCRIPT_NAME),
    resolvePath(workspacePath, "tools", "eval", EVAL_SCRIPT_NAME),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
}

async function canReadEvalScript(candidate: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      accessFs(candidate, fsConstants.R_OK, (err) => (err ? reject(err) : resolve()));
    });
    return true;
  } catch {
    return false;
  }
}

export async function resolveEvalScriptPathCandidates(
  options: ResolveEvalScriptPathOptions = {},
): Promise<string | undefined> {
  const candidates = getEvalScriptPathCandidates(options);
  const canRead = options.canRead ?? canReadEvalScript;
  for (const candidate of candidates) {
    if (await canRead(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function formatEvalScriptCandidateList(options: ResolveEvalScriptPathOptions = {}): string {
  const candidates = getEvalScriptPathCandidates(options);
  return candidates.map((candidate) => `- ${candidate}`).join("\n");
}

async function resolveEvalScriptForReply(
  options: ResolveEvalScriptPathOptions = {},
): Promise<{ scriptPath: string | undefined; candidateList: string }> {
  const scriptPath = await resolveEvalScriptPathCandidates(options);
  return {
    scriptPath,
    candidateList: formatEvalScriptCandidateList(options),
  };
}

export async function runEvalScript(
  scriptPath: string,
  args: readonly string[],
  onProgress?: (progress: {
    stream: "stdout" | "stderr";
    line: string;
  }) => void,
): Promise<EvalScriptResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutCarry = "";
    let stderrCarry = "";
    let settled = false;
    let timedOut = false;

    const emitProgressLines = (
      stream: "stdout" | "stderr",
      chunk: string,
      carry: string,
    ): { nextCarry: string } => {
      const combined = carry + chunk;
      const parts = combined.split(/\r?\n/);
      const nextCarry = parts.pop() ?? "";
      for (const rawLine of parts) {
        const line = rawLine.trim();
        if (!line) continue;
        onProgress?.({ stream, line });
      }
      return { nextCarry };
    };

    const finalize = (exitCode: number | null, errorMessage?: string): void => {
      if (settled) return;
      settled = true;

      if (stdoutCarry.trim().length > 0) {
        onProgress?.({ stream: "stdout", line: stdoutCarry.trim() });
      }
      if (stderrCarry.trim().length > 0) {
        onProgress?.({ stream: "stderr", line: stderrCarry.trim() });
      }

      if (errorMessage && stderr.trim().length === 0) {
        stderr = errorMessage;
      }

      resolve({
        exitCode: timedOut ? null : exitCode,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start,
      });
    };

    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: dirname(scriptPath),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort kill
      }
    }, EVAL_SCRIPT_TIMEOUT_MS);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      const { nextCarry } = emitProgressLines("stdout", text, stdoutCarry);
      stdoutCarry = nextCarry;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      const { nextCarry } = emitProgressLines("stderr", text, stderrCarry);
      stderrCarry = nextCarry;
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      finalize(1, toErrorMessage(err));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      finalize(code ?? 1);
    });
  });
}

// ============================================================================
// WebChatSkillSummary type
// ============================================================================

export interface WebChatSkillSummary {
  name: string;
  description: string;
  enabled: boolean;
  available?: boolean;
  tier?: string;
  sourcePath?: string;
  tags?: string[];
  primaryEnv?: string;
  unavailableReason?: string;
  missingRequirements?: string[];
}

function getSessionResumeAnchorResponseId(session: Session | undefined): string | undefined {
  const candidate = session?.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY];
  if (!candidate || typeof candidate !== "object") return undefined;
  const responseId = (candidate as { previousResponseId?: unknown }).previousResponseId;
  return typeof responseId === "string" && responseId.trim().length > 0
    ? responseId.trim()
    : undefined;
}

function getSessionHistoryCompacted(session: Session | undefined): boolean {
  return session?.metadata[SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY] === true;
}

const SESSION_SHELL_PROFILES: readonly SessionShellProfile[] = [
  "general",
  "coding",
  "research",
  "validation",
  "documentation",
  "operator",
];
const SHELL_AGENT_TOOL_BUNDLES: readonly ShellAgentToolBundleName[] = [
  "inherit",
  "coding-core",
  "docs-core",
  "research-evidence",
  "verification-probes",
  "operator-core",
  "marketplace-core",
  "browser-test",
  "remote-debug",
];

function formatShellProfileList(current: SessionShellProfile): string {
  return SESSION_SHELL_PROFILES.map((profile) =>
    `  ${profile}${profile === current ? " (current)" : ""}`,
  ).join("\n");
}

function evaluateSessionShellRollout(params: {
  readonly ctx: CommandRegistryDaemonContext;
  readonly sessionId: string;
  readonly feature:
    | "shellProfiles"
    | "codingCommands"
    | "shellExtensions"
    | "watchCockpit"
    | "multiAgent";
  readonly domain: "shell" | "extensions" | "watch";
}) {
  const scope = params.ctx.resolvePolicyScopeForSession({
    sessionId: params.sessionId,
    channel: "webchat",
  });
  return evaluateShellFeatureRollout({
    autonomy: params.ctx.gateway?.config.autonomy,
    tenantId: scope.tenantId,
    feature: params.feature,
    domain: params.domain,
    stableKey: params.sessionId,
  });
}

function resolveEffectiveShellProfileForSession(params: {
  readonly ctx: CommandRegistryDaemonContext;
  readonly sessionId: string;
  readonly preferred?: unknown;
}): SessionShellProfile {
  const scope = params.ctx.resolvePolicyScopeForSession({
    sessionId: params.sessionId,
    channel: "webchat",
  });
  return resolveConfiguredShellProfile({
    autonomy: params.ctx.gateway?.config.autonomy,
    tenantId: scope.tenantId,
    requested: params.preferred,
    stableKey: params.sessionId,
  }).profile;
}

function coerceShellAgentToolBundleName(
  value: unknown,
): ShellAgentToolBundleName | undefined {
  return typeof value === "string" &&
    SHELL_AGENT_TOOL_BUNDLES.includes(value as ShellAgentToolBundleName)
    ? (value as ShellAgentToolBundleName)
    : undefined;
}

const REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

function parseCommandJsonArgs(
  args: string,
): Record<string, unknown> | undefined {
  const trimmed = args.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("command JSON input must be an object");
  }
  return parsed as Record<string, unknown>;
}

function parseCommandJsonArgv(
  argv: readonly string[],
  startIndex = 1,
): Record<string, unknown> | undefined {
  const candidate = argv.slice(startIndex).join(" ").trim();
  if (!candidate.startsWith("{")) {
    return undefined;
  }
  return parseCommandJsonArgs(candidate);
}

function parseInlineFlag(
  argv: readonly string[],
  flag: string,
): string | undefined {
  const exact = `--${flag}`;
  const prefix = `--${flag}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === exact) {
      const next = argv[index + 1];
      return typeof next === "string" && !next.startsWith("--")
        ? next
        : undefined;
    }
    if (token.startsWith(prefix)) {
      return token.slice(prefix.length);
    }
  }
  return undefined;
}

function hasInlineFlag(argv: readonly string[], flag: string): boolean {
  const exact = `--${flag}`;
  const prefix = `--${flag}=`;
  return argv.some((token) => token === exact || token.startsWith(prefix));
}

function parseCsvFlag(argv: readonly string[], flag: string): string[] | undefined {
  const raw = parseInlineFlag(argv, flag);
  if (!raw) return undefined;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return values.length > 0 ? values : undefined;
}

function parseIntegerFlag(
  argv: readonly string[],
  flag: string,
): number | undefined {
  const raw = parseInlineFlag(argv, flag);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatToolError(result: Record<string, unknown>, fallback: string): string {
  const message =
    typeof result.error === "string" && result.error.trim().length > 0
      ? result.error.trim()
      : fallback;
  return `Command failed: ${message}`;
}

async function executeStructuredTool(
  baseToolHandler: ToolHandler,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const raw = await baseToolHandler(toolName, args);
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Tool ${toolName} returned non-object output`);
  }
  return parsed as Record<string, unknown>;
}

function groupCatalogBySource(
  catalog: readonly ReturnType<ToolRegistry["listCatalog"]>[number][],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of catalog) {
    const source = entry.metadata.source ?? "builtin";
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

function formatMcpTrustLine(server: GatewayMCPServerConfig): string {
  const trustTier = server.trustTier ?? "trusted";
  const approvalRequired =
    server.riskControls?.requireApproval === true || trustTier === "untrusted";
  return `${trustTier}${approvalRequired ? " (approval required)" : ""}`;
}

function stripMcpToolPrefix(toolName: string, serverName: string): string {
  return toolName.startsWith(`mcp.${serverName}.`)
    ? toolName.slice(`mcp.${serverName}.`.length)
    : toolName;
}

function getMcpCatalogEntries(
  catalog: readonly ReturnType<ToolRegistry["listCatalog"]>[number][],
  serverName?: string,
): readonly ReturnType<ToolRegistry["listCatalog"]>[number][] {
  return catalog.filter((entry) => {
    if (entry.metadata.source !== "mcp") return false;
    if (!serverName) return true;
    return entry.name.startsWith(`mcp.${serverName}.`);
  });
}

function getSkillDisabledMarker(sourcePath: string | undefined): boolean {
  return typeof sourcePath === "string" && existsSync(`${sourcePath}.disabled`);
}

function formatSkillState(params: {
  available: boolean;
  disabled: boolean;
}): string {
  if (params.disabled) return "disabled";
  return params.available ? "enabled" : "unavailable";
}

function renderPluginMutationNote(): string {
  return (
    "Catalog updated. Live plugin effects depend on the owning integration " +
    "surface and may require reconnect, restart, or a host-specific reload."
  );
}

function formatRepoInventoryReply(result: Record<string, unknown>): string {
  if (typeof result.error === "string") {
    return formatToolError(result, "repo inventory failed");
  }
  const repoRoot = typeof result.repoRoot === "string" ? result.repoRoot : "unknown";
  const branch = typeof result.branch === "string" ? result.branch : null;
  const fileCount =
    typeof result.fileCount === "number" ? result.fileCount.toLocaleString("en-US") : "unknown";
  const manifests = Array.isArray(result.manifests)
    ? result.manifests.filter((value): value is string => typeof value === "string")
    : [];
  const directories = Array.isArray(result.topLevelDirectories)
    ? result.topLevelDirectories.filter((value): value is string => typeof value === "string")
    : [];
  const languages = Array.isArray(result.languages)
    ? result.languages
        .filter(
          (value): value is { language: string; count: number } =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as { language?: unknown }).language === "string" &&
            typeof (value as { count?: unknown }).count === "number",
        )
        .slice(0, 8)
        .map((entry) => `${entry.language}:${entry.count}`)
    : [];
  return [
    "Repo inventory:",
    `  Root: ${repoRoot}`,
    `  Branch: ${branch ?? "detached/unknown"}`,
    `  Files: ${fileCount}`,
    `  Manifests: ${manifests.length > 0 ? manifests.join(", ") : "none"}`,
    `  Top-level dirs: ${directories.length > 0 ? directories.join(", ") : "none"}`,
    `  Languages: ${languages.length > 0 ? languages.join(", ") : "unknown"}`,
  ].join("\n");
}

function formatSearchFilesReply(result: Record<string, unknown>): string {
  if (typeof result.error === "string") {
    return formatToolError(result, "file search failed");
  }
  const matches = Array.isArray(result.matches)
    ? result.matches.filter((value): value is string => typeof value === "string")
    : [];
  if (matches.length === 0) {
    return "No matching files found.";
  }
  return [
    `Files (${matches.length}):`,
    ...matches.slice(0, 50).map((match) => `  ${match}`),
  ].join("\n");
}

function formatGrepReply(result: Record<string, unknown>): string {
  if (typeof result.error === "string") {
    return formatToolError(result, "grep failed");
  }
  const matches = Array.isArray(result.matches)
    ? result.matches.filter(
        (value): value is {
          filePath: string;
          line: number;
          column: number;
          matchText: string;
        } =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { filePath?: unknown }).filePath === "string" &&
          typeof (value as { line?: unknown }).line === "number" &&
          typeof (value as { column?: unknown }).column === "number" &&
          typeof (value as { matchText?: unknown }).matchText === "string",
      )
    : [];
  if (matches.length === 0) {
    return "No grep matches found.";
  }
  const lines = matches.slice(0, 25).map(
    (match) =>
      `  ${match.filePath}:${match.line}:${match.column}  ${match.matchText}`,
  );
  return [
    `Matches (${matches.length}${result.truncated === true ? ", truncated" : ""}):`,
    ...lines,
  ].join("\n");
}

function formatGitStatusReply(result: Record<string, unknown>): string {
  if (typeof result.error === "string") {
    return formatToolError(result, "git status failed");
  }
  const summary =
    typeof result.summary === "object" && result.summary !== null
      ? (result.summary as Record<string, unknown>)
      : {};
  const changed = Array.isArray(result.changed)
    ? result.changed.length
    : undefined;
  return [
    "Git status:",
    `  Repo: ${typeof result.repoRoot === "string" ? result.repoRoot : "unknown"}`,
    `  Branch: ${typeof result.branch === "string" ? result.branch : result.detached === true ? "detached" : "unknown"}`,
    `  Upstream: ${typeof result.upstream === "string" ? result.upstream : "none"}`,
    `  Ahead/behind: ${typeof result.ahead === "number" ? result.ahead : 0}/${typeof result.behind === "number" ? result.behind : 0}`,
    `  Changed files: ${changed ?? "unknown"}`,
    `  Staged: ${typeof summary.staged === "number" ? summary.staged : 0}`,
    `  Unstaged: ${typeof summary.unstaged === "number" ? summary.unstaged : 0}`,
    `  Untracked: ${typeof summary.untracked === "number" ? summary.untracked : 0}`,
    `  Conflicted: ${typeof summary.conflicted === "number" ? summary.conflicted : 0}`,
  ].join("\n");
}

function formatGitBranchReply(result: Record<string, unknown>): string {
  if (typeof result.error === "string") {
    return formatToolError(result, "git branch info failed");
  }
  return [
    "Git branch:",
    `  Repo: ${typeof result.repoRoot === "string" ? result.repoRoot : "unknown"}`,
    `  Branch: ${typeof result.branch === "string" ? result.branch : result.detached === true ? "detached" : "unknown"}`,
    `  HEAD: ${typeof result.head === "string" ? result.head : "unknown"}`,
    `  Upstream: ${typeof result.upstream === "string" ? result.upstream : "none"}`,
    `  Ahead/behind: ${typeof result.ahead === "number" ? result.ahead : 0}/${typeof result.behind === "number" ? result.behind : 0}`,
  ].join("\n");
}

function formatGitSummaryReply(result: Record<string, unknown>): string {
  if (typeof result.error === "string") {
    return formatToolError(result, "git summary failed");
  }
  const summary =
    typeof result.summary === "object" && result.summary !== null
      ? (result.summary as Record<string, unknown>)
      : {};
  return [
    "Git change summary:",
    `  Staged: ${typeof summary.staged === "number" ? summary.staged : 0}`,
    `  Unstaged: ${typeof summary.unstaged === "number" ? summary.unstaged : 0}`,
    `  Untracked: ${typeof summary.untracked === "number" ? summary.untracked : 0}`,
    `  Renamed: ${typeof summary.renamed === "number" ? summary.renamed : 0}`,
    `  Deleted: ${typeof summary.deleted === "number" ? summary.deleted : 0}`,
    `  Conflicted: ${typeof summary.conflicted === "number" ? summary.conflicted : 0}`,
  ].join("\n");
}

function formatGitDiffReply(result: Record<string, unknown>): string {
  if (typeof result.error === "string") {
    return formatToolError(result, "git diff failed");
  }
  const diff = typeof result.diff === "string" ? result.diff.trimEnd() : "";
  if (diff.length === 0) {
    return "No git diff output.";
  }
  return (
    `Git diff${result.truncated === true ? " (truncated)" : ""}:\n` +
    diff
  );
}

function formatGitShowReply(result: Record<string, unknown>): string {
  if (typeof result.error === "string") {
    return formatToolError(result, "git show failed");
  }
  const output = typeof result.output === "string" ? result.output.trimEnd() : "";
  return output.length > 0 ? output : "No git show output.";
}

function formatGitWorktreeListReply(result: Record<string, unknown>): string {
  if (typeof result.error === "string") {
    return formatToolError(result, "git worktree list failed");
  }
  const worktrees = Array.isArray(result.worktrees)
    ? result.worktrees.filter(
        (value): value is {
          path: string;
          branch: string | null;
          head: string | null;
          detached: boolean;
        } =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { path?: unknown }).path === "string",
      )
    : [];
  if (worktrees.length === 0) {
    return "No git worktrees found.";
  }
  return [
    `Worktrees (${worktrees.length}):`,
    ...worktrees.map(
      (worktree) =>
        `  ${worktree.path} — ${worktree.branch ?? (worktree.detached ? "detached" : "unknown")} (${worktree.head ?? "no head"})`,
    ),
  ].join("\n");
}

function formatGitWorktreeMutationReply(
  action: "create" | "remove",
  result: Record<string, unknown>,
): string {
  if (typeof result.error === "string") {
    return formatToolError(
      result,
      action === "create" ? "git worktree create failed" : "git worktree remove failed",
    );
  }
  if (action === "create") {
    return [
      "Worktree created:",
      `  Path: ${typeof result.worktreePath === "string" ? result.worktreePath : "unknown"}`,
      `  Branch: ${typeof result.branch === "string" ? result.branch : "none"}`,
      `  Ref: ${typeof result.ref === "string" ? result.ref : "none"}`,
    ].join("\n");
  }
  return [
    "Worktree removed:",
    `  Path: ${typeof result.worktreePath === "string" ? result.worktreePath : "unknown"}`,
    `  Dirty before removal: ${result.dirty === true ? "yes" : "no"}`,
  ].join("\n");
}

function formatGitWorktreeStatusReply(result: Record<string, unknown>): string {
  if (typeof result.error === "string") {
    return formatToolError(result, "git worktree status failed");
  }
  const statusLines = Array.isArray(result.statusLines)
    ? result.statusLines.filter((value): value is string => typeof value === "string")
    : [];
  return [
    "Worktree status:",
    `  Path: ${typeof result.worktreePath === "string" ? result.worktreePath : "unknown"}`,
    `  Branch: ${typeof result.branch === "string" ? result.branch : "unknown"}`,
    `  HEAD: ${typeof result.head === "string" ? result.head : "unknown"}`,
    `  Dirty: ${result.dirty === true ? "yes" : "no"}`,
    ...(statusLines.length > 0 ? ["  Status lines:", ...statusLines.map((line) => `    ${line}`)] : []),
  ].join("\n");
}

function formatTaskListReply(result: Record<string, unknown>): string {
  if (typeof result.error === "string") {
    return formatToolError(result, "task list failed");
  }
  const tasks = Array.isArray(result.tasks)
    ? result.tasks.filter(
        (value): value is { id: string; subject: string; status: string } =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { id?: unknown }).id === "string" &&
          typeof (value as { subject?: unknown }).subject === "string" &&
          typeof (value as { status?: unknown }).status === "string",
      )
    : [];
  if (tasks.length === 0) {
    return "No tasks for this session.";
  }
  return [
    `Tasks (${tasks.length}):`,
    ...tasks.map((task) => `  ${task.id} [${task.status}] ${task.subject}`),
  ].join("\n");
}

function formatTaskDetailReply(result: Record<string, unknown>): string {
  if (typeof result.error === "string") {
    return formatToolError(result, "task lookup failed");
  }
  const task =
    typeof result.task === "object" && result.task !== null
      ? (result.task as Record<string, unknown>)
      : undefined;
  if (!task) {
    return "Task detail unavailable.";
  }
  return [
    `Task ${typeof task.id === "string" ? task.id : "unknown"}:`,
    `  Status: ${typeof task.status === "string" ? task.status : "unknown"}`,
    `  Subject: ${typeof task.subject === "string" ? task.subject : "unknown"}`,
    `  Description: ${typeof task.description === "string" ? task.description : "none"}`,
  ].join("\n");
}

function formatAgentRoleCatalog(
  roles: readonly ShellAgentRoleDescriptor[],
): string {
  if (roles.length === 0) {
    return "No child-agent roles are available.";
  }
  return [
    `Child-agent roles (${roles.length}):`,
    ...roles.map((role) =>
      [
        `  ${role.id}`,
        `source=${role.source}`,
        `trust=${role.trustLabel}`,
        `profile=${role.defaultShellProfile}`,
        `bundle=${role.defaultToolBundle}`,
        role.worktreeEligible ? "worktree=eligible" : "worktree=off",
        role.mutating ? "mutating=yes" : "mutating=no",
        `:: ${role.description}`,
      ].join(" "),
    ),
  ].join("\n");
}

function formatAgentListReply(entries: readonly {
  sessionId: string;
  status: string;
  task: string;
  role?: string;
  roleSource?: string;
  toolBundle?: string;
  taskId?: string;
  shellProfile?: SessionShellProfile;
  executionLocation?: string;
  worktreePath?: string;
}[]): string {
  if (entries.length === 0) {
    return "No child agents matched the current filter.";
  }
  return [
    `Child agents (${entries.length}):`,
    ...entries.map((entry) =>
      [
        `  ${entry.sessionId}`,
        `[${entry.status}]`,
        entry.role ? `role=${entry.role}` : null,
        entry.roleSource ? `source=${entry.roleSource}` : null,
        entry.taskId ? `task=${entry.taskId}` : null,
        entry.shellProfile ? `profile=${entry.shellProfile}` : null,
        entry.toolBundle ? `bundle=${entry.toolBundle}` : null,
        entry.executionLocation ? `exec=${entry.executionLocation}` : null,
        entry.worktreePath ? `worktree=${entry.worktreePath}` : null,
        `:: ${entry.task}`,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" "),
    ),
  ].join("\n");
}

function formatAgentInspectReply(entry: {
  sessionId?: string;
  taskId?: string;
  status: string;
  task: string;
  role?: string;
  roleSource?: string;
  toolBundle?: string;
  shellProfile?: SessionShellProfile;
  executionLocation?: string;
  workspaceRoot?: string;
  workingDirectory?: string;
  worktreePath?: string;
  outputPreview?: string;
}): string {
  return [
    "Child agent:",
    `  Session: ${entry.sessionId ?? "none"}`,
    `  Task id: ${entry.taskId ?? "none"}`,
    `  Status: ${entry.status}`,
    `  Role: ${entry.role ?? "unknown"}`,
    `  Role source: ${entry.roleSource ?? "unknown"}`,
    `  Shell profile: ${entry.shellProfile ?? "unknown"}`,
    `  Tool bundle: ${entry.toolBundle ?? "inherit"}`,
    `  Objective: ${entry.task}`,
    `  Execution: ${entry.executionLocation ?? "unknown"}`,
    `  Workspace: ${entry.workspaceRoot ?? "unknown"}`,
    `  Working directory: ${entry.workingDirectory ?? "unknown"}`,
    `  Worktree: ${entry.worktreePath ?? "none"}`,
    `  Preview: ${entry.outputPreview ?? "none"}`,
  ].join("\n");
}

function formatContinuitySessionList(
  sessions: readonly Record<string, unknown>[],
): string {
  if (sessions.length === 0) {
    return "No resumable sessions found.";
  }
  return [
    `Resumable sessions (${sessions.length}):`,
    ...sessions.map((session) => {
      const sessionId =
        typeof session.sessionId === "string" ? session.sessionId : "unknown";
      const profile =
        typeof session.shellProfile === "string"
          ? ` profile=${session.shellProfile}`
          : "";
      const stage =
        typeof session.workflowStage === "string"
          ? ` stage=${session.workflowStage}`
          : "";
      const state =
        typeof session.resumabilityState === "string"
          ? ` state=${session.resumabilityState}`
          : "";
      const branch =
        typeof session.branch === "string" ? ` branch=${session.branch}` : "";
      const messages =
        typeof session.messageCount === "number"
          ? ` messages=${session.messageCount}`
          : "";
      const preview =
        typeof session.preview === "string" ? session.preview : "New conversation";
      return `  ${sessionId}${profile}${stage}${state}${branch}${messages} :: ${preview}`;
    }),
  ].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compactSurfacePreview(value: string, maxChars = 220): string | undefined {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length === 0) {
    return undefined;
  }
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars - 3)}...`;
}

function updateReviewSurfaceState(
  session: Session,
  state: Partial<ReviewSurfaceState> & Pick<ReviewSurfaceState, "status" | "source">,
): ReviewSurfaceState {
  const prior = coerceReviewSurfaceState(
    session.metadata[SESSION_REVIEW_SURFACE_STATE_METADATA_KEY],
  );
  const now = Date.now();
  const next: ReviewSurfaceState = {
    status: state.status,
    source: state.source,
    startedAt:
      state.startedAt ??
      (state.status === "running" ? now : prior?.startedAt ?? now),
    updatedAt: state.updatedAt ?? now,
    ...(state.completedAt !== undefined
      ? { completedAt: state.completedAt }
      : state.status === "completed" || state.status === "failed" || state.status === "stale"
        ? { completedAt: now }
        : {}),
    ...(state.delegatedSessionId ? { delegatedSessionId: state.delegatedSessionId } : {}),
    ...(state.backgroundRunId ? { backgroundRunId: state.backgroundRunId } : {}),
    ...(state.summaryPreview
      ? { summaryPreview: compactSurfacePreview(state.summaryPreview) }
      : {}),
  };
  session.metadata[SESSION_REVIEW_SURFACE_STATE_METADATA_KEY] = next;
  return next;
}

function updateVerificationSurfaceState(
  session: Session,
  state: Partial<VerificationSurfaceState> &
    Pick<VerificationSurfaceState, "status" | "source">,
): VerificationSurfaceState {
  const prior = coerceVerificationSurfaceState(
    session.metadata[SESSION_VERIFICATION_SURFACE_STATE_METADATA_KEY],
  );
  const now = Date.now();
  const next: VerificationSurfaceState = {
    status: state.status,
    source: state.source,
    startedAt:
      state.startedAt ??
      (state.status === "running" ? now : prior?.startedAt ?? now),
    updatedAt: state.updatedAt ?? now,
    ...(state.completedAt !== undefined
      ? { completedAt: state.completedAt }
      : state.status === "completed" || state.status === "failed" || state.status === "stale"
        ? { completedAt: now }
        : {}),
    ...(state.delegatedSessionId ? { delegatedSessionId: state.delegatedSessionId } : {}),
    ...(state.backgroundRunId ? { backgroundRunId: state.backgroundRunId } : {}),
    ...(state.summaryPreview
      ? { summaryPreview: compactSurfacePreview(state.summaryPreview) }
      : {}),
    ...(state.verdict ?? prior?.verdict ? { verdict: state.verdict ?? prior?.verdict } : {}),
  };
  session.metadata[SESSION_VERIFICATION_SURFACE_STATE_METADATA_KEY] = next;
  return next;
}

async function persistSurfaceStateForSession(
  memoryBackend: MemoryBackend,
  webSessionId: string,
  session: Session | undefined,
): Promise<void> {
  if (!session) {
    return;
  }
  await persistWebSessionRuntimeState(memoryBackend, webSessionId, session);
}

function formatContinuitySessionInspect(detail: SessionContinuityDetail): string {
  const lines = [
    "Session detail:",
    `  Session id: ${detail.sessionId}`,
    `  Profile: ${detail.shellProfile}`,
    `  Workflow stage: ${detail.workflowStage}`,
    `  Resumability: ${detail.resumabilityState}`,
    ...(typeof detail.workspaceRoot === "string"
      ? [`  Workspace root: ${detail.workspaceRoot}`]
      : []),
    ...(typeof detail.repoRoot === "string"
      ? [`  Repo root: ${detail.repoRoot}`]
      : []),
    ...(typeof detail.branch === "string" ? [`  Branch: ${detail.branch}`] : []),
    ...(typeof detail.head === "string" ? [`  Head: ${detail.head}`] : []),
    ...(typeof detail.workflowState.objective === "string"
      ? [`  Objective: ${detail.workflowState.objective}`]
      : []),
    `  Messages: ${detail.messageCount}`,
    `  Pending approvals: ${detail.pendingApprovalCount}`,
    `  Child sessions: ${detail.childSessionCount}`,
    `  Worktrees: ${detail.worktreeCount}`,
    ...(typeof detail.activeTaskSummary === "string"
      ? [`  Active task: ${detail.activeTaskSummary}`]
      : []),
    ...(typeof detail.lastAssistantOutputPreview === "string"
      ? [`  Last assistant output: ${detail.lastAssistantOutputPreview}`]
      : []),
  ];
  if (detail.forkLineage) {
    lines.push(
      `  Forked from: ${detail.forkLineage.parentSessionId} (${detail.forkLineage.source})`,
    );
  }
  if (detail.backgroundRun) {
    lines.push("");
    lines.push("Background run:");
    lines.push(
      `  ${detail.backgroundRun.runId} [${detail.backgroundRun.state}] ${detail.backgroundRun.currentPhase ?? ""}`.trim(),
    );
    if (typeof detail.backgroundRun.objective === "string") {
      lines.push(`  Objective: ${detail.backgroundRun.objective}`);
    }
    if (detail.backgroundRun.checkpointAvailable === true) {
      lines.push("  Checkpoint available: yes");
    }
  }
  if ((detail.recentHistory?.length ?? 0) > 0) {
    lines.push("");
    lines.push("Recent history:");
    for (const entry of detail.recentHistory ?? []) {
      lines.push(`  ${entry.sender}: ${entry.content.trim() || "(empty)"}`);
    }
  }
  return lines.join("\n");
}

function formatSessionHistoryReply(
  history: readonly {
    readonly content: string;
    readonly sender: string;
    readonly toolName?: string;
  }[],
): string {
  if (history.length === 0) {
    return "No session history found.";
  }
  return [
    `Session history (${history.length}):`,
    ...history.map((entry) => {
      const toolName = entry.toolName ? ` ${entry.toolName}` : "";
      const content = entry.content.trim().length > 0 ? entry.content.trim() : "(empty)";
      return `  ${entry.sender}${toolName}: ${content}`;
    }),
  ].join("\n");
}

function suggestNextWorkflowStage(params: {
  readonly currentStage: SessionWorkflowStage;
  readonly plannerStatus: string;
  readonly ownership: readonly WorkflowOwnershipEntry[];
  readonly hasChanges: boolean;
}): SessionWorkflowStage | undefined {
  if (params.currentStage === "plan") {
    return "implement";
  }
  if (params.currentStage === "implement") {
    if (params.plannerStatus === "needs_verification") {
      return "verify";
    }
    if (params.hasChanges) {
      return "review";
    }
  }
  if (params.currentStage === "review") {
    return "verify";
  }
  if (params.currentStage === "verify") {
    return params.plannerStatus === "completed" ? "idle" : undefined;
  }
  if (params.currentStage === "idle" && params.ownership.length > 0) {
    return "review";
  }
  return undefined;
}

function buildReviewDelegatePrompt(params: {
  readonly branchReply: string;
  readonly summaryReply: string;
  readonly diffReply: string;
}): string {
  return [
    "Review the current changes and return findings-first output.",
    "",
    params.branchReply,
    "",
    params.summaryReply,
    "",
    params.diffReply,
  ].join("\n");
}

function buildVerifyDelegatePrompt(params: {
  readonly branchReply: string;
  readonly summaryReply: string;
  readonly taskReply: string;
  readonly runtimeStatusSnapshot?: Record<string, unknown>;
}): string {
  const verifierStages =
    typeof params.runtimeStatusSnapshot?.verifierStages === "object" &&
    params.runtimeStatusSnapshot.verifierStages !== null
      ? JSON.stringify(params.runtimeStatusSnapshot.verifierStages, null, 2)
      : undefined;
  return [
    "Verify the current implementation state for this session.",
    "",
    params.branchReply,
    "",
    params.summaryReply,
    "",
    params.taskReply,
    ...(verifierStages ? ["", "Runtime verifier snapshot:", verifierStages] : []),
  ].join("\n");
}

type ShellAgentLaunchResult = Awaited<
  ReturnType<CommandRegistryDaemonContext["launchShellAgentTask"]>
>;

async function launchDelegatedSurfaceTask<
  TSurfaceState extends ReviewSurfaceState | VerificationSurfaceState,
>(params: {
  readonly ctx: CommandRegistryDaemonContext;
  readonly session: Session | undefined;
  readonly webSessionId: string;
  readonly resolvedSessionId: string;
  readonly memoryBackend: MemoryBackend;
  readonly shellProfile: SessionShellProfile;
  readonly roleId: "review" | "verify";
  readonly objective: string;
  readonly prompt: string;
  readonly startSurfaceState: Partial<TSurfaceState> &
    Pick<TSurfaceState, "status" | "source">;
  readonly finishSurfaceState: (
    delegated: ShellAgentLaunchResult,
  ) => Partial<TSurfaceState> & Pick<TSurfaceState, "status" | "source">;
  readonly updateSurfaceState: (
    session: Session,
    state: Partial<TSurfaceState> & Pick<TSurfaceState, "status" | "source">,
  ) => TSurfaceState;
}): Promise<ShellAgentLaunchResult> {
  if (params.session) {
    params.updateSurfaceState(params.session, params.startSurfaceState);
    await persistSurfaceStateForSession(
      params.memoryBackend,
      params.webSessionId,
      params.session,
    );
  }
  const delegated = await params.ctx.launchShellAgentTask({
    parentSessionId: params.resolvedSessionId,
    roleId: params.roleId,
    objective: params.objective,
    prompt: params.prompt,
    shellProfile: params.shellProfile,
    wait: true,
  });
  if (params.session) {
    params.updateSurfaceState(
      params.session,
      params.finishSurfaceState(delegated),
    );
    await persistSurfaceStateForSession(
      params.memoryBackend,
      params.webSessionId,
      params.session,
    );
  }
  return delegated;
}

async function launchDelegatedReviewTask(params: {
  readonly ctx: CommandRegistryDaemonContext;
  readonly session: Session | undefined;
  readonly webSessionId: string;
  readonly resolvedSessionId: string;
  readonly memoryBackend: MemoryBackend;
  readonly shellProfile: SessionShellProfile;
  readonly branchInfo: Record<string, unknown>;
  readonly summary: Record<string, unknown>;
  readonly diff: Record<string, unknown>;
  readonly mode: "default" | "security" | "pr-comments";
}): Promise<ShellAgentLaunchResult> {
  return launchDelegatedSurfaceTask({
    ctx: params.ctx,
    session: params.session,
    webSessionId: params.webSessionId,
    resolvedSessionId: params.resolvedSessionId,
    memoryBackend: params.memoryBackend,
    shellProfile: params.shellProfile,
    roleId: "review",
    objective:
      params.mode === "security"
        ? "Review the current changes for security issues and return findings-first output."
        : params.mode === "pr-comments"
          ? "Review the current changes and draft concise PR comments."
          : "Review the current changes and return findings-first output.",
    prompt: buildReviewDelegatePrompt({
      branchReply: formatGitBranchReply(params.branchInfo),
      summaryReply: formatGitSummaryReply(params.summary),
      diffReply:
        typeof params.diff.diff === "string" && params.diff.diff.trim().length > 0
          ? formatGitDiffReply(params.diff)
          : "No diff content to review.",
    }),
    startSurfaceState: {
      status: "running",
      source: "delegated",
    },
    finishSurfaceState: (delegated) => ({
      status: delegated.success === true ? "completed" : "failed",
      source: "delegated",
      delegatedSessionId: delegated.sessionId,
      summaryPreview: delegated.output,
    }),
    updateSurfaceState: updateReviewSurfaceState,
  });
}

async function launchDelegatedVerifyTask(params: {
  readonly ctx: CommandRegistryDaemonContext;
  readonly session: Session | undefined;
  readonly webSessionId: string;
  readonly resolvedSessionId: string;
  readonly memoryBackend: MemoryBackend;
  readonly shellProfile: SessionShellProfile;
  readonly branchInfo: Record<string, unknown>;
  readonly summary: Record<string, unknown>;
  readonly tasks: Record<string, unknown>;
  readonly runtimeStatusSnapshot?: Record<string, unknown>;
}): Promise<ShellAgentLaunchResult> {
  return launchDelegatedSurfaceTask({
    ctx: params.ctx,
    session: params.session,
    webSessionId: params.webSessionId,
    resolvedSessionId: params.resolvedSessionId,
    memoryBackend: params.memoryBackend,
    shellProfile: params.shellProfile,
    roleId: "verify",
    objective: "Verify the current implementation state and return a verdict.",
    prompt: buildVerifyDelegatePrompt({
      branchReply: formatGitBranchReply(params.branchInfo),
      summaryReply: formatGitSummaryReply(params.summary),
      taskReply: formatTaskListReply(params.tasks),
      runtimeStatusSnapshot: params.runtimeStatusSnapshot,
    }),
    startSurfaceState: {
      status: "running",
      source: "delegated",
      verdict: "unknown",
    },
    finishSurfaceState: (delegated) => ({
      status: delegated.success === true ? "completed" : "failed",
      source: "delegated",
      delegatedSessionId: delegated.sessionId,
      summaryPreview: delegated.output,
      verdict:
        (delegated.success === true ? "pass" : "fail") as VerificationSurfaceState["verdict"],
    }),
    updateSurfaceState: updateVerificationSurfaceState,
  });
}

function summarizeStoredResponse(response: LLMStoredResponse): string {
  const usage = response.usage
    ? `prompt=${response.usage.promptTokens}, completion=${response.usage.completionTokens}, total=${response.usage.totalTokens}`
    : "unavailable";
  const citations = response.providerEvidence?.citations ?? [];
  const serverSideToolCalls = response.providerEvidence?.serverSideToolCalls ?? [];
  const serverSideToolUsage = response.providerEvidence?.serverSideToolUsage ?? [];
  const content = response.content.trim();
  const contentPreview =
    content.length > 0
      ? truncateToolLogText(content, 1_000)
      : "(no assistant text content)";
  const lines = [
    `Stored response: ${response.id}`,
    `Provider: ${response.provider}`,
    `Model: ${response.model ?? "unknown"}`,
    `Status: ${response.status ?? "unknown"}`,
    `Usage: ${usage}`,
    `Client-side tool calls: ${response.toolCalls.length}`,
    `Server-side tool calls: ${serverSideToolCalls.length}`,
    `Server-side tool usage entries: ${serverSideToolUsage.length}`,
    `Citations: ${citations.length}`,
    `Encrypted reasoning: ${
      response.encryptedReasoning
        ? `${response.encryptedReasoning.available ? "available" : "not returned"}`
        : "not requested/not available"
    }`,
    "Content:",
    contentPreview,
  ];
  if (serverSideToolUsage.length > 0) {
    lines.push(
      "Server-side usage:",
      ...serverSideToolUsage.map((entry) =>
        `  ${entry.category}: ${entry.count}${entry.toolType ? ` (${entry.toolType})` : ""}`
      ),
    );
  }
  return lines.join("\n");
}

function orderProvidersForStoredResponses(
  providers: readonly LLMProvider[],
  preferredProviderName: string | undefined,
  operation: "retrieve" | "delete",
): LLMProvider[] {
  const supported = providers.filter((provider) =>
    operation === "retrieve"
      ? typeof provider.retrieveStoredResponse === "function"
      : typeof provider.deleteStoredResponse === "function"
  );
  if (!preferredProviderName) {
    return supported;
  }
  return [
    ...supported.filter((provider) => provider.name === preferredProviderName),
    ...supported.filter((provider) => provider.name !== preferredProviderName),
  ];
}

async function retrieveStoredResponseWithFallback(
  providers: readonly LLMProvider[],
  responseId: string,
  preferredProviderName?: string,
): Promise<LLMStoredResponse> {
  const candidates = orderProvidersForStoredResponses(
    providers,
    preferredProviderName,
    "retrieve",
  );
  if (candidates.length === 0) {
    throw new Error("No configured provider supports stored response retrieval.");
  }
  let lastError: unknown;
  for (const provider of candidates) {
    try {
      return await provider.retrieveStoredResponse!(responseId);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Stored response retrieval failed.");
}

async function deleteStoredResponseWithFallback(
  providers: readonly LLMProvider[],
  responseId: string,
  preferredProviderName?: string,
): Promise<{ readonly providerName: string; readonly deleted: boolean; readonly id: string }> {
  const candidates = orderProvidersForStoredResponses(
    providers,
    preferredProviderName,
    "delete",
  );
  if (candidates.length === 0) {
    throw new Error("No configured provider supports stored response deletion.");
  }
  let lastError: unknown;
  for (const provider of candidates) {
    try {
      const result = await provider.deleteStoredResponse!(responseId);
      return {
        providerName: provider.name,
        deleted: result.deleted,
        id: result.id,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Stored response deletion failed.");
}

// ============================================================================
// Daemon context type for command registry
// ============================================================================

export interface CommandRegistryDaemonContext {
  readonly logger: Logger;
  readonly configPath: string;
  readonly gateway: { readonly config: GatewayConfig } | null;
  readonly yolo: boolean;
  resetWebSessionContext(params: {
    webSessionId: string;
    sessionMgr: SessionManager;
    resolveSessionId: (sessionKey: string) => string;
    memoryBackend: MemoryBackend;
    progressTracker?: ProgressTracker;
  }): Promise<void>;
  getWebChatChannel(): WebChatChannel | null;
  getHostWorkspacePath(): string | null;
  getChatExecutor(): ChatExecutor | null;
  getResolvedContextWindowTokens(): number | undefined;
  getSystemPrompt(): string;
  getMemoryBackendName(): string | undefined;
  getPolicyEngineState(): { mode: string; recentViolations: number } | undefined;
  isPolicyEngineEnabled(): boolean;
  isGovernanceAuditLogEnabled(): boolean;
  listSessionCredentialLeases(sessionId: string): Array<{
    credentialId: string;
    expiresAt: number;
    domains: string[];
  }>;
  revokeSessionCredentials(params: {
    sessionId: string;
    credentialId?: string;
    reason: "manual" | "shutdown" | "session_reset";
  }): Promise<number>;
  resolvePolicyScopeForSession(params: {
    sessionId: string;
    runId?: string;
    channel?: string;
  }): {
    tenantId?: string;
    projectId?: string;
    runId?: string;
    sessionId: string;
    channel: string;
  };
  buildPolicySimulationPreview(params: {
    sessionId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }): Promise<{
    toolName: string;
    sessionId: string;
    policy: {
      allowed: boolean;
      mode: string;
      violations: Array<{ code: string; message: string }>;
    };
    approval: {
      required: boolean;
      elevated: boolean;
      denied: boolean;
      requestPreview?: {
        message: string;
        deadlineAt: number;
        allowDelegatedResolution: boolean;
        approverGroup?: string;
        requiredApproverRoles?: readonly string[];
      };
    };
  }>;
  getSessionPolicyState(sessionId: string): {
    elevatedPatterns: readonly string[];
    deniedPatterns: readonly string[];
  };
  updateSessionPolicyState(params: {
    sessionId: string;
    operation: "allow" | "deny" | "clear" | "reset";
    pattern?: string;
  }): {
    elevatedPatterns: readonly string[];
    deniedPatterns: readonly string[];
  };
  getSubAgentRuntimeConfig(): ResolvedSubAgentRuntimeConfig | null;
  getActiveDelegationAggressiveness(
    config: ResolvedSubAgentRuntimeConfig,
  ): DelegationAggressivenessProfile;
  resolveDelegationScoreThreshold(
    config?: ResolvedSubAgentRuntimeConfig,
  ): number;
  getDelegationAggressivenessOverride(): DelegationAggressivenessProfile | null;
  setDelegationAggressivenessOverride(
    value: DelegationAggressivenessProfile | null,
  ): void;
  configureDelegationRuntimeServices(
    config: ResolvedSubAgentRuntimeConfig,
  ): void;
  getWebChatInboundHandler(): ((msg: GatewayMessage) => Promise<void>) | null;
  getDesktopHandleBySession(
    sessionId: string,
  ): { containerId: string; maxMemory: string; maxCpu: string } | undefined;
  getSessionModelInfo(sessionId: string): {
    provider: string;
    model: string;
    configuredModel?: string;
    resolvedModel?: string;
    usedFallback: boolean;
  } | undefined;
  handleConfigReload(): Promise<void>;
  getMcpManager(): import("../mcp-client/manager.js").MCPManager | null;
  getPluginCatalog(): PluginCatalog;
  discoverShellSkills(params: {
    sessionId: string;
  }): Promise<DiscoveredSkill[]>;
  resolveShellSkillDiscoveryPaths(params: {
    sessionId: string;
  }): Promise<DiscoveryPaths>;
  getVoiceBridge(): VoiceBridge | null;
  getDesktopManager(): {
    getOrCreate(sessionId: string, opts?: { maxMemory?: string; maxCpu?: string }): Promise<{
      containerId: string;
      vncHostPort: number;
      resolution: { width: number; height: number };
      maxMemory: string;
      maxCpu: string;
    }>;
    destroy(containerId: string): Promise<void>;
    getHandleBySession(sessionId: string): {
      containerId: string;
      vncHostPort: number;
      resolution: { width: number; height: number };
      maxMemory: string;
      maxCpu: string;
      status: string;
      createdAt: number;
      sessionId: string;
    } | undefined;
    getHandle(containerId: string): {
      containerId: string;
      sessionId: string;
    } | undefined;
    assignSession(containerId: string, sessionId: string): {
      containerId: string;
      vncHostPort: number;
    };
    listAll(): Array<{
      containerId: string;
      sessionId: string;
      status: string;
      maxMemory: string;
      maxCpu: string;
      vncUrl: string;
      createdAt: number;
    }>;
  } | null;
  getDesktopBridges(): Map<string, unknown>;
  getPlaywrightBridges(): Map<string, unknown>;
  getContainerMCPBridges(): Map<string, unknown[]>;
  getGoalManager(): {
    addGoal(params: {
      title: string;
      description: string;
      priority: string;
      source: string;
      maxAttempts: number;
    }): Promise<{ id: string; title: string }>;
    getActiveGoals(): Promise<
      Array<{ priority: string; status: string; title: string }>
    >;
  } | null;
  startSlashInit(params: {
    workspaceRoot: string;
    force?: boolean;
    sessionId: string;
    senderId: string;
    channel: string;
    reply: (content: string) => Promise<void>;
  }): Promise<{ filePath: string; started: boolean }>;
  listAgentRoles(): readonly ShellAgentRoleDescriptor[];
  launchShellAgentTask(params: {
    parentSessionId: string;
    roleId: string;
    objective: string;
    prompt?: string;
    taskId?: string;
    shellProfile?: SessionShellProfile;
    toolBundle?: ShellAgentToolBundleName;
    tools?: readonly string[];
    requiredCapabilities?: readonly string[];
    workspaceRoot?: string;
    workingDirectory?: string;
    continuationSessionId?: string;
    requireToolCall?: boolean;
    delegationSpec?: Record<string, unknown>;
    worktree?: "auto" | string;
    wait?: boolean;
    timeoutMs?: number;
    name?: string;
    createTaskIfMissing?: boolean;
    unsafeBenchmarkMode?: boolean;
  }): Promise<{
    role: ShellAgentRoleDescriptor;
    sessionId: string;
    taskId?: string;
    output: string;
    success: boolean;
    status: string;
    waited: boolean;
    outputPath?: string;
    name?: string;
  }>;
  inspectShellAgentTask(parentSessionId: string, target: string): Promise<{
    sessionId?: string;
    taskId?: string;
    status: string;
    task: string;
    role?: string;
    roleSource?: ShellAgentRoleSource;
    toolBundle?: string;
    shellProfile?: SessionShellProfile;
    executionLocation?: string;
    workspaceRoot?: string;
    workingDirectory?: string;
    worktreePath?: string;
    outputPreview?: string;
  } | undefined>;
  stopShellAgentTask(parentSessionId: string, target: string): Promise<{
    stopped: boolean;
    sessionId?: string;
    taskId?: string;
  }>;
  listSubAgentInfo(parentSessionId: string): Array<{
    sessionId: string;
    status: string;
    task: string;
    role?: string;
    roleSource?: string;
    toolBundle?: string;
    taskId?: string;
    shellProfile?: SessionShellProfile;
    workspaceRoot?: string;
    workingDirectory?: string;
    executionLocation?: string;
    worktreePath?: string;
  }>;
}

// ============================================================================
// Main factory function
// ============================================================================

export function createDaemonCommandRegistry(
  ctx: CommandRegistryDaemonContext,
  sessionMgr: SessionManager,
  resolveSessionId: (sessionKey: string) => string,
  providers: LLMProvider[],
  memoryBackend: MemoryBackend,
  registry: ToolRegistry,
  availableSkills: DiscoveredSkill[],
  skillList: WebChatSkillSummary[],
  hooks: HookDispatcher,
  baseToolHandler: ToolHandler,
  approvalEngine: ApprovalEngine | null,
  progressTracker?: ProgressTracker,
  pipelineExecutor?: PipelineExecutor,
): SlashCommandRegistry {
  void hooks; void baseToolHandler; void approvalEngine; void skillList;
  const commandRegistry = new SlashCommandRegistry({ logger: ctx.logger });
  const requireShellFeature = async (params: {
    readonly cmdCtx: {
      sessionId: string;
      reply: (content: string) => Promise<void>;
    };
    readonly feature:
      | "shellProfiles"
      | "codingCommands"
      | "shellExtensions"
      | "watchCockpit"
      | "multiAgent";
    readonly domain: "shell" | "extensions" | "watch";
    readonly label: string;
  }): Promise<boolean> => {
    const decision = evaluateSessionShellRollout({
      ctx,
      sessionId: resolveSessionId(params.cmdCtx.sessionId),
      feature: params.feature,
      domain: params.domain,
    });
    if (decision.allowed) {
      return true;
    }
    await params.cmdCtx.reply(
      formatShellRolloutHoldback({
        label: params.label,
        decision,
      }),
    );
    return false;
  };
  for (const command of createDefaultCommands()) {
    commandRegistry.register(command);
  }

  commandRegistry.register({
    name: "help",
    description: "Show available commands",
    global: true,
    handler: async (cmdCtx) => {
      const commands = commandRegistry.getCommands();
      const lines = commands.map(
        (command) => `  /${command.name} — ${command.description}`,
      );
      await cmdCtx.reply("Available commands:\n" + lines.join("\n"));
    },
  });
  commandRegistry.register({
    name: "new",
    description: "Start a new session (reset conversation)",
    global: true,
    handler: async (cmdCtx) => {
      await ctx.resetWebSessionContext({
        webSessionId: cmdCtx.sessionId,
        sessionMgr,
        resolveSessionId,
        memoryBackend,
        progressTracker,
      });
      await cmdCtx.reply("Session reset. Starting fresh conversation.");
    },
  });
  commandRegistry.register({
    name: "init",
    description: "Generate an AGENC.md contributor guide",
    args: "[--force]",
    global: true,
    handler: async (cmdCtx) => {
      const force = cmdCtx.argv.includes("--force");
      const workspaceRoot =
        (typeof ctx.getWebChatChannel()?.loadSessionWorkspaceRoot === "function"
          ? await ctx.getWebChatChannel()!.loadSessionWorkspaceRoot(cmdCtx.sessionId)
          : undefined) ??
        ctx.getHostWorkspacePath() ??
        process.cwd();
      const filePath = `${workspaceRoot}/AGENC.md`;

      // Check if file exists and --force not set
      const { existsSync } = await import("node:fs");
      if (existsSync(filePath) && !force) {
        await cmdCtx.reply(`AGENC.md already exists at ${filePath}. Use /init --force to overwrite.`);
        return;
      }

      const started = await ctx.startSlashInit({
        workspaceRoot,
        force,
        sessionId: cmdCtx.sessionId,
        senderId: cmdCtx.senderId,
        channel: cmdCtx.channel,
        reply: cmdCtx.reply,
      });
      if (!started.started) {
        await cmdCtx.reply(`Init already running for ${started.filePath}.`);
        return;
      }
      await cmdCtx.reply(`Starting /init for ${started.filePath}. I'll reply when it finishes.`);
    },
  });
  commandRegistry.register({
    name: "reset",
    description: "Reset session and clear context",
    global: true,
    handler: async (cmdCtx) => {
      await ctx.resetWebSessionContext({
        webSessionId: cmdCtx.sessionId,
        sessionMgr,
        resolveSessionId,
        memoryBackend,
        progressTracker,
      });
      await cmdCtx.reply("Session and context cleared.");
    },
  });
  commandRegistry.register({
    name: "restart",
    description: "Restart current chat context (alias for /reset)",
    global: true,
    handler: async (cmdCtx) => {
      await ctx.resetWebSessionContext({
        webSessionId: cmdCtx.sessionId,
        sessionMgr,
        resolveSessionId,
        memoryBackend,
        progressTracker,
      });
      await cmdCtx.reply("Session restarted. Context cleared.");
    },
  });
  commandRegistry.register({
    name: "compact",
    description: "Force conversation compaction",
    global: true,
    handler: async (cmdCtx) => {
      const sessionId = resolveSessionId(cmdCtx.sessionId);
      const result = await sessionMgr.compact(sessionId);
      if (result) {
        await cmdCtx.reply(
          `Compacted: removed ${result.messagesRemoved}, retained ${result.messagesRetained}.`,
        );
      } else {
        await cmdCtx.reply("No session to compact.");
      }
    },
  });
  const replyRuntimeResult = async (
    cmdCtx: import("./commands.js").SlashCommandContext,
    surface: import("../channels/webchat/protocol.js").RuntimeCommandData["surface"],
    text: string,
    extras: Omit<import("../channels/webchat/protocol.js").RuntimeCommandData, "kind" | "surface"> = {},
  ): Promise<void> => {
    await cmdCtx.replyResult({
      text,
      viewKind: "runtime",
      data: {
        kind: "runtime",
        surface,
        ...extras,
      },
    });
  };
  commandRegistry.register({
    name: "context",
    description: "Show current context window usage",
    global: true,
    metadata: {
      category: "runtime",
      clients: ["shell", "console", "web"],
      viewKind: "runtime",
    },
    handler: async (cmdCtx) => {
      const executor = ctx.getChatExecutor();
      if (!executor) {
        await replyRuntimeResult(
          cmdCtx,
          "context",
          `Session: ${cmdCtx.sessionId}\nContext usage unavailable (LLM not initialized).`,
          {
            status: "unavailable",
            metrics: [{ label: "Session", value: cmdCtx.sessionId }],
          },
        );
        return;
      }

      const contextWindowTokens = ctx.getResolvedContextWindowTokens();
      const sessionTokenBudget = resolveSessionTokenBudget(
        ctx.gateway?.config.llm,
        contextWindowTokens,
      );

      // Build breakdown
      const sessionId = resolveSessionId(cmdCtx.sessionId);
      const session = sessionMgr.get(sessionId);
      const systemPrompt = ctx.getSystemPrompt();
      const stateful = session ? buildSessionStatefulOptions(session) : undefined;
      const usageSnapshot = buildCurrentContextUsageSnapshot({
        messages: buildCurrentApiView({
          baseSystemPrompt: systemPrompt,
          artifactContext: stateful?.artifactContext,
          history: session?.history ?? [],
        }),
        contextWindowTokens,
        maxOutputTokens: ctx.gateway?.config.llm?.maxTokens,
      });
      const toolCount = registry.size;
      const model = normalizeGrokModel(ctx.gateway?.config.llm?.model) ?? "unknown";
      const provider = ctx.gateway?.config.llm?.provider ?? "unknown";

      const lines = [
        `Context Window: ${(contextWindowTokens ?? 0).toLocaleString()} tokens (${model} via ${provider})`,
        `Effective Window: ${
          usageSnapshot.effectiveContextWindowTokens?.toLocaleString() ?? "unknown"
        } tokens`,
        `Session Budget: ${
          hasRuntimeLimit(sessionTokenBudget)
            ? `${sessionTokenBudget.toLocaleString()} tokens`
            : "unlimited"
        }`,
        `Current View: ${usageSnapshot.currentTokens.toLocaleString()} tokens (${(
          usageSnapshot.percentUsed ?? 0
        ).toFixed((usageSnapshot.percentUsed ?? 0) >= 10 ? 0 : 1)}%)` +
          (usageSnapshot.isAboveAutocompactThreshold
            ? " — COMPACTION PENDING"
            : ""),
        `Free: ${
          typeof usageSnapshot.freeTokens === "number"
            ? `${usageSnapshot.freeTokens.toLocaleString()} tokens`
            : "unknown"
        }`,
        `Autocompact Threshold: ${usageSnapshot.autocompactThresholdTokens.toLocaleString()} tokens`,
        `Blocking Limit: ${
          usageSnapshot.blockingThresholdTokens?.toLocaleString() ?? "unknown"
        } tokens`,
        "Compaction: local current-view autocompact; provider disabled",
        "",
        "Breakdown:",
        ...usageSnapshot.sections.map(
          (section) => `  ${section.label}: ~${section.tokens.toLocaleString()} tokens`,
        ),
        `  Tools: ${toolCount} registered`,
        `  History: ${(session?.history.length ?? 0).toLocaleString()} messages`,
        `  Memory: ${ctx.getMemoryBackendName() ?? "none"}`,
        "",
        "Workspace files loaded:",
      ];

      // Show which workspace files are loaded
      const wsFiles: [string, boolean][] = [
        ["AGENT.md", !!systemPrompt?.includes("# Agent")],
        ["AGENC.md", !!systemPrompt?.includes("# Repository Guidelines")],
        ["SOUL.md", !!systemPrompt?.includes("# Soul")],
        ["TOOLS.md", !!systemPrompt?.includes("# Tool")],
        ["MEMORY.md", !!systemPrompt?.includes("# Memory")],
        ["USER.md", !!systemPrompt?.includes("# User")],
      ];
      for (const [name, loaded] of wsFiles) {
        lines.push(`  ${loaded ? "●" : "○"} ${name}`);
      }

      // Phase 9 / Task 7.2: memory health metrics in /context output
      try {
        const { collectMemoryHealthReport } = await import("../memory/diagnostics.js");
        const report = await collectMemoryHealthReport({ memoryBackend });
        lines.push("");
        lines.push("Memory health:");
        lines.push(`  Backend: ${report.backendType} (${report.durability})`);
        lines.push(`  Status: ${report.healthy ? "healthy" : "unhealthy"}`);
        lines.push(`  Entries: ~${report.entryCount.toLocaleString()} across ${report.sessionCount} sessions`);
        if (report.vectorStore) {
          lines.push(`  Vectors: dim=${report.vectorStore.dimension || "?"}${report.vectorStore.persistent ? " (persistent)" : " (ephemeral)"}`);
        }
        if (report.embeddingProvider) {
          lines.push(`  Embeddings: ${report.embeddingProvider.name} (${report.embeddingProvider.available ? "available" : "unavailable"})`);
        }
        if (report.knowledgeGraph) {
          lines.push(`  Graph: ${report.knowledgeGraph.nodeCount} nodes, ${report.knowledgeGraph.edgeCount} edges`);
        }
      } catch {
        // Non-blocking — diagnostics may not be available
      }

      const memoryHealthItems = lines.includes("Memory health:")
        ? lines.slice(lines.indexOf("Memory health:") + 1)
        : [];
      await replyRuntimeResult(cmdCtx, "context", lines.join("\n"), {
        status: usageSnapshot.isAboveAutocompactThreshold ? "warning" : "healthy",
        metrics: [
          {
            label: "Context Window",
            value: `${(contextWindowTokens ?? 0).toLocaleString()} tokens`,
          },
          {
            label: "Current View",
            value: `${usageSnapshot.currentTokens.toLocaleString()} tokens (${(
              usageSnapshot.percentUsed ?? 0
            ).toFixed((usageSnapshot.percentUsed ?? 0) >= 10 ? 0 : 1)}%)`,
            tone: usageSnapshot.isAboveAutocompactThreshold ? "warning" : "neutral",
          },
          {
            label: "Free",
            value:
              typeof usageSnapshot.freeTokens === "number"
                ? `${usageSnapshot.freeTokens.toLocaleString()} tokens`
                : "unknown",
          },
          { label: "History", value: `${session?.history.length ?? 0} messages` },
          { label: "Tools", value: `${toolCount}` },
          { label: "Memory", value: ctx.getMemoryBackendName() ?? "none" },
        ],
        sections: [
          {
            title: "Workspace Files",
            items: wsFiles.map(([name, loaded]) => `${loaded ? "loaded" : "missing"}: ${name}`),
          },
          ...(memoryHealthItems.length > 0
            ? [{ title: "Memory Health", items: memoryHealthItems }]
            : []),
        ],
        detail: {
          sessionId: cmdCtx.sessionId,
          contextWindowTokens: contextWindowTokens ?? 0,
          sessionTokenBudget,
          autocompactThresholdTokens: usageSnapshot.autocompactThresholdTokens,
          effectiveContextWindowTokens: usageSnapshot.effectiveContextWindowTokens,
          currentTokens: usageSnapshot.currentTokens,
          blockingThresholdTokens: usageSnapshot.blockingThresholdTokens,
          compactionPending: usageSnapshot.isAboveAutocompactThreshold,
          toolCount,
          historyLen: session?.history.length ?? 0,
          provider,
          model,
        },
      });
    },
  });
  commandRegistry.register({
    name: "status",
    description: "Show agent status",
    global: true,
    metadata: {
      category: "runtime",
      clients: ["shell", "console", "web"],
      viewKind: "runtime",
    },
    handler: async (cmdCtx) => {
      const sessionId = resolveSessionId(cmdCtx.sessionId);
      const session = sessionMgr.get(sessionId);
      const historyLen = session?.history.length ?? 0;
      const providerNames =
        providers.map((provider) => provider.name).join(" → ") || "none";
      const statefulConfig = ctx.gateway?.config.llm?.statefulResponses;
      const encryptedReasoningEnabled =
        ctx.gateway?.config.llm?.includeEncryptedReasoning === true;
      const responseAnchor = getSessionResumeAnchorResponseId(session);
      const shellProfile = resolveEffectiveShellProfileForSession({
        ctx,
        sessionId,
        preferred: resolveSessionShellProfile(session?.metadata ?? {}),
      });
      const workflowState = resolveSessionWorkflowState(session?.metadata ?? {});
      const text =
        `Agent is running.\n` +
          `Session: ${cmdCtx.sessionId}\n` +
          `History: ${historyLen} messages\n` +
          `Shell Profile: ${shellProfile}\n` +
          `Workflow Stage: ${formatSessionWorkflowStage(workflowState.stage)}\n` +
          `Worktree Mode: ${formatSessionWorktreeMode(workflowState.worktreeMode)}\n` +
          `LLM: ${providerNames}\n` +
          `Stateful: ${
            statefulConfig?.enabled === true
              ? `enabled (store=${statefulConfig.store === true ? "yes" : "no"}, encrypted_reasoning=${encryptedReasoningEnabled ? "yes" : "no"}, anchor=${responseAnchor ?? "none"})`
              : "disabled"
          }\n` +
          `Memory: ${memoryBackend.name}\n` +
          `Tools: ${registry.size}\n` +
          `Skills: ${availableSkills.length}`;
      await replyRuntimeResult(cmdCtx, "status", text, {
        status: "running",
        metrics: [
          { label: "Session", value: cmdCtx.sessionId },
          { label: "History", value: `${historyLen} messages` },
          { label: "Profile", value: shellProfile },
          { label: "Stage", value: workflowState.stage },
          { label: "Worktree", value: workflowState.worktreeMode },
          { label: "Tools", value: `${registry.size}` },
          { label: "Skills", value: `${availableSkills.length}` },
        ],
        sections: [
          { title: "LLM", items: [providerNames] },
          {
            title: "Stateful Responses",
            items: [
              statefulConfig?.enabled === true
                ? `enabled (store=${statefulConfig.store === true ? "yes" : "no"}, encrypted_reasoning=${encryptedReasoningEnabled ? "yes" : "no"}, anchor=${responseAnchor ?? "none"})`
                : "disabled",
            ],
          },
        ],
        detail: {
          sessionId: cmdCtx.sessionId,
          historyLen,
          shellProfile,
          workflowState,
          providerNames,
          statefulEnabled: statefulConfig?.enabled === true,
          encryptedReasoningEnabled,
          responseAnchor,
          memoryBackend: memoryBackend.name,
          tools: registry.size,
          skills: availableSkills.length,
        },
      });
    },
  });
  commandRegistry.register({
    name: "profile",
    description: "Show or set the active shell profile",
    args: "[list|general|coding|research|validation|documentation|operator]",
    global: true,
    metadata: {
      category: "runtime",
      clients: ["shell", "console", "web"],
      rolloutFeature: "shellProfiles",
      viewKind: "runtime",
    },
    handler: async (cmdCtx) => {
      const sessionId = resolveSessionId(cmdCtx.sessionId);
      const session = sessionMgr.get(sessionId);
      if (!session) {
        await cmdCtx.reply("No active session.");
        return;
      }

      const current = resolveEffectiveShellProfileForSession({
        ctx,
        sessionId,
        preferred: resolveSessionShellProfile(session.metadata),
      });
      const arg = cmdCtx.argv[0]?.toLowerCase();

      if (!arg || arg === "status") {
        await replyRuntimeResult(
          cmdCtx,
          "profile",
          `Shell profile: ${current}\nAvailable: ${SESSION_SHELL_PROFILES.join(", ")}`,
          {
            status: "active",
            metrics: [
              { label: "Current", value: current },
              { label: "Default", value: DEFAULT_SESSION_SHELL_PROFILE },
            ],
            sections: [
              { title: "Profiles", items: [...SESSION_SHELL_PROFILES] },
            ],
            detail: { current, available: SESSION_SHELL_PROFILES },
          },
        );
        return;
      }

      if (arg === "list") {
        await replyRuntimeResult(
          cmdCtx,
          "profile",
          `Shell profile: ${current}\nDefault: ${DEFAULT_SESSION_SHELL_PROFILE}\nProfiles:\n${formatShellProfileList(current)}`,
          {
            status: "active",
            metrics: [
              { label: "Current", value: current },
              { label: "Default", value: DEFAULT_SESSION_SHELL_PROFILE },
            ],
            sections: [
              {
                title: "Profiles",
                items: SESSION_SHELL_PROFILES.map((profile) =>
                  profile === current ? `${profile} (active)` : profile,
                ),
              },
            ],
            detail: { current, available: SESSION_SHELL_PROFILES },
          },
        );
        return;
      }

      const nextProfile = coerceSessionShellProfile(arg);
      if (!nextProfile) {
        await cmdCtx.reply(
          "Usage: /profile [list|general|coding|research|validation|documentation|operator]",
        );
        return;
      }

      const resolvedProfile = resolveConfiguredShellProfile({
        autonomy: ctx.gateway?.config.autonomy,
        tenantId: ctx.resolvePolicyScopeForSession({
          sessionId,
          channel: "webchat",
        }).tenantId,
        requested: nextProfile,
        stableKey: sessionId,
      });
      ensureSessionShellProfile(session.metadata, resolvedProfile.profile);
      if (cmdCtx.channel === "webchat") {
        await persistWebSessionRuntimeState(
          memoryBackend,
          cmdCtx.sessionId,
          session,
        );
      }

      const profileText =
        resolvedProfile.coerced
          ? [
              `Shell profile set to ${resolvedProfile.profile}.`,
              formatShellRolloutHoldback({
                label: `Profile "${resolvedProfile.requestedProfile}"`,
                decision: resolvedProfile.decision,
              }),
            ].join("\n")
          : `Shell profile set to ${resolvedProfile.profile}.\nThis currently updates session metadata; profile-aware routing and tool curation build on top of it.`;
      await replyRuntimeResult(cmdCtx, "profile", profileText, {
        status: resolvedProfile.coerced ? "warning" : "active",
        metrics: [
          { label: "Current", value: resolvedProfile.profile },
          { label: "Requested", value: resolvedProfile.requestedProfile },
        ],
        detail: {
          current: resolvedProfile.profile,
          requested: resolvedProfile.requestedProfile,
          coerced: resolvedProfile.coerced,
          heldBackReason: resolvedProfile.decision?.reason ?? null,
        },
      });
    },
  });
  commandRegistry.register({
    name: "files",
    description: "Show repo inventory or search files in the active workspace",
    args: "[query|json]",
    global: true,
    metadata: {
      category: "coding",
      clients: ["shell", "console", "web"],
      rolloutFeature: "codingCommands",
      viewKind: "files",
    },
    handler: async (cmdCtx) => {
      if (
        !(await requireShellFeature({
          cmdCtx,
          feature: "codingCommands",
          domain: "shell",
          label: "Files command",
        }))
      ) {
        return;
      }
      let jsonArgs: Record<string, unknown> | undefined;
      try {
        jsonArgs = parseCommandJsonArgs(cmdCtx.args);
      } catch (error) {
        await cmdCtx.reply(
          `Usage: /files [query] [--regex] [--path <dir>] [--glob <pattern1,pattern2>] [--max <n>]\n${toErrorMessage(error)}`,
        );
        return;
      }
      if (jsonArgs) {
        const query =
          typeof jsonArgs.query === "string" ? jsonArgs.query.trim() : "";
        const result = await executeStructuredTool(
          baseToolHandler,
          query.length > 0 ? "system.searchFiles" : "system.repoInventory",
          jsonArgs,
        );
        const text =
          query.length > 0
            ? formatSearchFilesReply(result)
            : formatRepoInventoryReply(result);
        await cmdCtx.replyResult({
          text,
          viewKind: "files",
          data: {
            kind: "files",
            mode: query.length > 0 ? "search" : "inventory",
            ...(query.length > 0 ? { query } : {}),
            result,
          },
        });
        return;
      }
      const query = cmdCtx.argv
        .filter((token) => !token.startsWith("--"))
        .join(" ")
        .trim();
      if (!query) {
        const result = await executeStructuredTool(
          baseToolHandler,
          "system.repoInventory",
          {},
        );
        await cmdCtx.replyResult({
          text: formatRepoInventoryReply(result),
          viewKind: "files",
          data: {
            kind: "files",
            mode: "inventory",
            result,
          },
        });
        return;
      }
      const result = await executeStructuredTool(
        baseToolHandler,
        "system.searchFiles",
        {
          query,
          ...(parseInlineFlag(cmdCtx.argv, "path")
            ? { path: parseInlineFlag(cmdCtx.argv, "path") }
            : {}),
          ...(hasInlineFlag(cmdCtx.argv, "regex") ? { regex: true } : {}),
          ...(parseCsvFlag(cmdCtx.argv, "glob")
            ? { filePatterns: parseCsvFlag(cmdCtx.argv, "glob") }
            : {}),
          ...(parseIntegerFlag(cmdCtx.argv, "max")
            ? { maxResults: parseIntegerFlag(cmdCtx.argv, "max") }
            : {}),
        },
      );
      await cmdCtx.replyResult({
        text: formatSearchFilesReply(result),
        viewKind: "files",
        data: {
          kind: "files",
          mode: "search",
          query,
          result,
        },
      });
    },
  });
  commandRegistry.register({
    name: "grep",
    description: "Search repo-local files with the native coding grep tool",
    args: "<pattern|json>",
    global: true,
    metadata: {
      category: "coding",
      clients: ["shell", "console", "web"],
      rolloutFeature: "codingCommands",
      viewKind: "grep",
    },
    handler: async (cmdCtx) => {
      if (
        !(await requireShellFeature({
          cmdCtx,
          feature: "codingCommands",
          domain: "shell",
          label: "Grep command",
        }))
      ) {
        return;
      }
      let jsonArgs: Record<string, unknown> | undefined;
      try {
        jsonArgs = parseCommandJsonArgs(cmdCtx.args);
      } catch (error) {
        await cmdCtx.reply(
          `Usage: /grep <pattern> [--regex] [--path <dir>] [--glob <pattern1,pattern2>] [--context <n>] [--max <n>]\n${toErrorMessage(error)}`,
        );
        return;
      }
      const args =
        jsonArgs ??
        {
          pattern: cmdCtx.argv
            .filter((token) => !token.startsWith("--"))
            .join(" ")
            .trim(),
          ...(parseInlineFlag(cmdCtx.argv, "path")
            ? { path: parseInlineFlag(cmdCtx.argv, "path") }
            : {}),
          ...(hasInlineFlag(cmdCtx.argv, "regex") ? { regex: true } : {}),
          ...(parseCsvFlag(cmdCtx.argv, "glob")
            ? { filePatterns: parseCsvFlag(cmdCtx.argv, "glob") }
            : {}),
          ...(parseIntegerFlag(cmdCtx.argv, "context")
            ? { contextLines: parseIntegerFlag(cmdCtx.argv, "context") }
            : {}),
          ...(parseIntegerFlag(cmdCtx.argv, "max")
            ? { maxResults: parseIntegerFlag(cmdCtx.argv, "max") }
            : {}),
        };
      if (typeof args.pattern !== "string" || args.pattern.trim().length === 0) {
        await cmdCtx.reply(
          "Usage: /grep <pattern> [--regex] [--path <dir>] [--glob <pattern1,pattern2>] [--context <n>] [--max <n>]",
        );
        return;
      }
      const result = await executeStructuredTool(
        baseToolHandler,
        "system.grep",
        args,
      );
      await cmdCtx.replyResult({
        text: formatGrepReply(result),
        viewKind: "grep",
        data: {
          kind: "grep",
          pattern: typeof args.pattern === "string" ? args.pattern : "",
          result,
        },
      });
    },
  });
  commandRegistry.register({
    name: "git",
    description: "Run structured git status, diff, branch, show, summary, or worktree commands",
    args: "<status|diff|show|branch|summary|worktree>",
    global: true,
    metadata: {
      category: "coding",
      clients: ["shell", "console", "web"],
      rolloutFeature: "codingCommands",
      viewKind: "git",
    },
    handler: async (cmdCtx) => {
      if (
        !(await requireShellFeature({
          cmdCtx,
          feature: "codingCommands",
          domain: "shell",
          label: "Git command",
        }))
      ) {
        return;
      }
      let jsonArgs: Record<string, unknown> | undefined;
      try {
        jsonArgs = parseCommandJsonArgs(cmdCtx.args);
      } catch (error) {
        await cmdCtx.reply(`Usage: /git <status|diff|show|branch|summary|worktree>\n${toErrorMessage(error)}`);
        return;
      }

      const subcommand =
        typeof jsonArgs?.subcommand === "string"
          ? jsonArgs.subcommand.trim().toLowerCase()
          : cmdCtx.argv[0]?.toLowerCase();
      if (!subcommand) {
        await cmdCtx.reply(
          "Usage: /git <status|diff|show|branch|summary|worktree>",
        );
        return;
      }

      if (subcommand === "status") {
        const result = await executeStructuredTool(
          baseToolHandler,
          "system.gitStatus",
          jsonArgs ?? {},
        );
        await cmdCtx.replyResult({
          text: formatGitStatusReply(result),
          viewKind: "git",
          data: {
            kind: "git",
            subcommand: "status",
            branchInfo: asRecord(result),
          },
        });
        return;
      }

      if (subcommand === "branch") {
        const result = await executeStructuredTool(
          baseToolHandler,
          "system.gitBranchInfo",
          jsonArgs ?? {},
        );
        await cmdCtx.replyResult({
          text: formatGitBranchReply(result),
          viewKind: "git",
          data: {
            kind: "git",
            subcommand: "branch",
            branchInfo: asRecord(result),
          },
        });
        return;
      }

      if (subcommand === "summary") {
        const result = await executeStructuredTool(
          baseToolHandler,
          "system.gitChangeSummary",
          jsonArgs ?? {},
        );
        await cmdCtx.replyResult({
          text: formatGitSummaryReply(result),
          viewKind: "git",
          data: {
            kind: "git",
            subcommand: "summary",
            changeSummary: asRecord(result),
          },
        });
        return;
      }

      if (subcommand === "show") {
        const ref =
          typeof jsonArgs?.ref === "string"
            ? jsonArgs.ref.trim()
            : cmdCtx.argv[1]?.trim();
        if (!ref) {
          await cmdCtx.reply("Usage: /git show <ref> [--stat]");
          return;
        }
        const result = await executeStructuredTool(
          baseToolHandler,
          "system.gitShow",
          jsonArgs ?? {
            ref,
            ...(hasInlineFlag(cmdCtx.argv, "stat") ? { noPatch: true } : {}),
          },
        );
        await cmdCtx.replyResult({
          text: formatGitShowReply(result),
          viewKind: "git",
          data: {
            kind: "git",
            subcommand: "show",
            diff: asRecord(result),
          },
        });
        return;
      }

      if (subcommand === "diff") {
        const result = await executeStructuredTool(
          baseToolHandler,
          "system.gitDiff",
          jsonArgs ?? {
            ...(hasInlineFlag(cmdCtx.argv, "staged") ? { staged: true } : {}),
            ...(parseInlineFlag(cmdCtx.argv, "from")
              ? { fromRef: parseInlineFlag(cmdCtx.argv, "from") }
              : {}),
            ...(parseInlineFlag(cmdCtx.argv, "to")
              ? { toRef: parseInlineFlag(cmdCtx.argv, "to") }
              : {}),
            ...(parseCsvFlag(cmdCtx.argv, "files")
              ? { filePaths: parseCsvFlag(cmdCtx.argv, "files") }
              : {}),
          },
        );
        await cmdCtx.replyResult({
          text: formatGitDiffReply(result),
          viewKind: "git",
          data: {
            kind: "git",
            subcommand: "diff",
            diff: asRecord(result),
          },
        });
        return;
      }

      if (subcommand === "worktree") {
        const worktreeCommand =
          typeof jsonArgs?.action === "string"
            ? jsonArgs.action.trim().toLowerCase()
            : cmdCtx.argv[1]?.toLowerCase();
        if (!worktreeCommand) {
          await cmdCtx.reply(
            "Usage: /git worktree <list|create|remove|status> [...]",
          );
          return;
        }
        if (worktreeCommand === "list") {
          const result = await executeStructuredTool(
            baseToolHandler,
            "system.gitWorktreeList",
            jsonArgs ?? {},
          );
          await cmdCtx.replyResult({
            text: formatGitWorktreeListReply(result),
            viewKind: "git",
            data: {
              kind: "git",
              subcommand: "worktree-list",
              diff: asRecord(result),
            },
          });
          return;
        }
        if (worktreeCommand === "create") {
          const worktreePath =
            typeof jsonArgs?.worktreePath === "string"
              ? jsonArgs.worktreePath.trim()
              : cmdCtx.argv[2]?.trim();
          if (!worktreePath) {
            await cmdCtx.reply(
              "Usage: /git worktree create <path> [--branch <name>] [--ref <ref>] [--detached]",
            );
            return;
          }
          const result = await executeStructuredTool(
            baseToolHandler,
            "system.gitWorktreeCreate",
            jsonArgs ?? {
              worktreePath,
              ...(parseInlineFlag(cmdCtx.argv, "branch")
                ? { branch: parseInlineFlag(cmdCtx.argv, "branch") }
                : {}),
              ...(parseInlineFlag(cmdCtx.argv, "ref")
                ? { ref: parseInlineFlag(cmdCtx.argv, "ref") }
                : {}),
              ...(hasInlineFlag(cmdCtx.argv, "detached") ? { detached: true } : {}),
            },
          );
          await cmdCtx.replyResult({
            text: formatGitWorktreeMutationReply("create", result),
            viewKind: "git",
            data: {
              kind: "git",
              subcommand: "worktree-create",
              diff: asRecord(result),
            },
          });
          return;
        }
        if (worktreeCommand === "remove") {
          const worktreePath =
            typeof jsonArgs?.worktreePath === "string"
              ? jsonArgs.worktreePath.trim()
              : cmdCtx.argv[2]?.trim();
          if (!worktreePath) {
            await cmdCtx.reply(
              "Usage: /git worktree remove <path> [--force]",
            );
            return;
          }
          const result = await executeStructuredTool(
            baseToolHandler,
            "system.gitWorktreeRemove",
            jsonArgs ?? {
              worktreePath,
              ...(hasInlineFlag(cmdCtx.argv, "force") ? { force: true } : {}),
            },
          );
          await cmdCtx.replyResult({
            text: formatGitWorktreeMutationReply("remove", result),
            viewKind: "git",
            data: {
              kind: "git",
              subcommand: "worktree-remove",
              diff: asRecord(result),
            },
          });
          return;
        }
        if (worktreeCommand === "status") {
          const worktreePath =
            typeof jsonArgs?.worktreePath === "string"
              ? jsonArgs.worktreePath.trim()
              : cmdCtx.argv[2]?.trim();
          if (!worktreePath) {
            await cmdCtx.reply(
              "Usage: /git worktree status <path>",
            );
            return;
          }
          const result = await executeStructuredTool(
            baseToolHandler,
            "system.gitWorktreeStatus",
            jsonArgs ?? { worktreePath },
          );
          await cmdCtx.replyResult({
            text: formatGitWorktreeStatusReply(result),
            viewKind: "git",
            data: {
              kind: "git",
              subcommand: "worktree-status",
              diff: asRecord(result),
            },
          });
          return;
        }
        await cmdCtx.reply(
          "Usage: /git worktree <list|create|remove|status> [...]",
        );
        return;
      }

      await cmdCtx.reply(
        "Usage: /git <status|diff|show|branch|summary|worktree>",
      );
    },
  });
  commandRegistry.register({
    name: "branch",
    description: "Alias for /git branch",
    global: true,
    metadata: {
      category: "coding",
      clients: ["shell", "console", "web"],
      rolloutFeature: "codingCommands",
      viewKind: "git",
    },
    handler: async (cmdCtx) => {
      await commandRegistry
        .get("git")
        ?.handler({
          ...cmdCtx,
          args: "branch",
          argv: ["branch"],
        });
    },
  });
  commandRegistry.register({
    name: "worktree",
    description: "Alias for /git worktree",
    args: "<list|create|remove|status>",
    global: true,
    metadata: {
      category: "coding",
      clients: ["shell", "console", "web"],
      rolloutFeature: "codingCommands",
      viewKind: "git",
    },
    handler: async (cmdCtx) => {
      const args = cmdCtx.args.trim();
      const forwardedArgs =
        args.startsWith("{")
          ? JSON.stringify({
              subcommand: "worktree",
              ...(JSON.parse(args) as Record<string, unknown>),
            })
          : `worktree${args.length > 0 ? ` ${args}` : ""}`;
      await commandRegistry
        .get("git")
        ?.handler({
          ...cmdCtx,
          args: forwardedArgs,
          argv: args.startsWith("{") ? ["worktree"] : ["worktree", ...cmdCtx.argv],
        });
    },
  });
  commandRegistry.register({
    name: "diff",
    description: "Show repo change summary plus a structured git diff",
    args: "[--staged|json]",
    global: true,
    metadata: {
      category: "coding",
      clients: ["shell", "console", "web"],
      rolloutFeature: "codingCommands",
      viewKind: "diff",
    },
    handler: async (cmdCtx) => {
      if (
        !(await requireShellFeature({
          cmdCtx,
          feature: "codingCommands",
          domain: "shell",
          label: "Diff command",
        }))
      ) {
        return;
      }
      let jsonArgs: Record<string, unknown> | undefined;
      try {
        jsonArgs = parseCommandJsonArgs(cmdCtx.args);
      } catch (error) {
        await cmdCtx.reply(`Usage: /diff [--staged] [--from <ref>] [--to <ref>] [--files <a,b>]\n${toErrorMessage(error)}`);
        return;
      }
      const summary = await executeStructuredTool(
        baseToolHandler,
        "system.gitChangeSummary",
        jsonArgs ?? {},
      );
      const diff = await executeStructuredTool(
        baseToolHandler,
        "system.gitDiff",
        jsonArgs ?? {
          ...(hasInlineFlag(cmdCtx.argv, "staged") ? { staged: true } : {}),
          ...(parseInlineFlag(cmdCtx.argv, "from")
            ? { fromRef: parseInlineFlag(cmdCtx.argv, "from") }
            : {}),
          ...(parseInlineFlag(cmdCtx.argv, "to")
            ? { toRef: parseInlineFlag(cmdCtx.argv, "to") }
            : {}),
          ...(parseCsvFlag(cmdCtx.argv, "files")
            ? { filePaths: parseCsvFlag(cmdCtx.argv, "files") }
            : {}),
          },
      );
      await cmdCtx.replyResult({
        text: `${formatGitSummaryReply(summary)}\n\n${formatGitDiffReply(diff)}`,
        viewKind: "diff",
        data: {
          kind: "diff",
          subcommand: "diff",
          changeSummary: asRecord(summary),
          diff: asRecord(diff),
        },
      });
    },
  });
  commandRegistry.register({
    name: "review",
    description: "Summarize the current repo state for human or agent review",
    args: "[--staged|--delegate|--mode security|--mode pr-comments]",
    global: true,
    metadata: {
      category: "coding",
      clients: ["shell", "console", "web"],
      rolloutFeature: "codingCommands",
      viewKind: "review",
    },
    handler: async (cmdCtx) => {
      if (
        !(await requireShellFeature({
          cmdCtx,
          feature: "codingCommands",
          domain: "shell",
          label: "Review command",
        }))
      ) {
        return;
      }
      let jsonArgs: Record<string, unknown> | undefined;
      try {
        jsonArgs = parseCommandJsonArgs(cmdCtx.args);
      } catch (error) {
        await cmdCtx.reply(
          `Usage: /review [--staged] [--delegate|--mode security|--mode pr-comments]\n${toErrorMessage(error)}`,
        );
        return;
      }
      const wantsDelegate =
        jsonArgs?.delegate === true || hasInlineFlag(cmdCtx.argv, "delegate");
      const requestedMode =
        typeof jsonArgs?.mode === "string"
          ? jsonArgs.mode.trim().toLowerCase()
          : parseInlineFlag(cmdCtx.argv, "mode")?.trim().toLowerCase();
      const reviewMode =
        requestedMode === "security" || requestedMode === "pr-comments"
          ? requestedMode
          : "default";
      const branchInfo = await executeStructuredTool(
        baseToolHandler,
        "system.gitBranchInfo",
        {},
      );
      const summary = await executeStructuredTool(
        baseToolHandler,
        "system.gitChangeSummary",
        {},
      );
      const diff = await executeStructuredTool(
        baseToolHandler,
        "system.gitDiff",
        jsonArgs ??
          (hasInlineFlag(cmdCtx.argv, "staged") ? { staged: true } : {}),
      );
      const reviewSurface = [
        reviewMode === "security"
          ? "Security review surface:"
          : reviewMode === "pr-comments"
            ? "PR comment drafting surface:"
            : "Review surface:",
        formatGitBranchReply(branchInfo),
        "",
        formatGitSummaryReply(summary),
        "",
        typeof diff.diff === "string" && diff.diff.trim().length > 0
          ? formatGitDiffReply(diff)
          : "No diff content to review.",
      ].join("\n");
      const resolvedSessionId = resolveSessionId(cmdCtx.sessionId);
      const session = sessionMgr.get(resolvedSessionId);
      const effectiveShellProfile = resolveEffectiveShellProfileForSession({
        ctx,
        sessionId: resolvedSessionId,
        preferred: resolveSessionShellProfile(session?.metadata ?? {}),
      });
      if (!wantsDelegate) {
        let reviewState: ReviewSurfaceState | undefined;
        if (session) {
          reviewState = updateReviewSurfaceState(session, {
            status: "completed",
            source: "local",
            summaryPreview: reviewSurface,
          });
          await persistWebSessionRuntimeState(memoryBackend, cmdCtx.sessionId, session);
        }
        await cmdCtx.replyResult({
          text: reviewSurface,
          viewKind: "review",
          data: {
            kind: "review",
            mode: reviewMode,
            delegated: false,
            branchInfo: asRecord(branchInfo),
            changeSummary: asRecord(summary),
            diff: asRecord(diff),
            ...(reviewState
              ? {
                  reviewSurface: {
                    status: reviewState.status,
                    source: reviewState.source,
                    ...(reviewState.delegatedSessionId
                      ? { delegatedSessionId: reviewState.delegatedSessionId }
                      : {}),
                    ...(reviewState.summaryPreview
                      ? { summaryPreview: reviewState.summaryPreview }
                      : {}),
                  },
                }
              : {}),
          },
        });
        return;
      }
      const delegated = await launchDelegatedReviewTask({
        ctx,
        session,
        webSessionId: cmdCtx.sessionId,
        resolvedSessionId,
        memoryBackend,
        shellProfile: effectiveShellProfile,
        branchInfo,
        summary,
        diff,
        mode: reviewMode,
      });
      const delegatedText = [
        reviewSurface,
        "",
        `Delegated reviewer session: ${delegated.sessionId} [${delegated.status}]`,
        delegated.output.trim().length > 0
          ? delegated.output.trim()
          : "Delegated reviewer returned no output.",
      ].join("\n");
      await cmdCtx.replyResult({
        text: delegatedText,
        viewKind: "review",
        data: {
          kind: "review",
          mode: reviewMode,
          delegated: true,
          branchInfo: asRecord(branchInfo),
          changeSummary: asRecord(summary),
          diff: asRecord(diff),
          reviewSurface: {
            status: delegated.success === true ? "completed" : "failed",
            source: "delegated",
            delegatedSessionId: delegated.sessionId,
            ...(delegated.output.trim().length > 0
              ? { summaryPreview: compactSurfacePreview(delegated.output) }
              : {}),
          },
          delegatedResult: {
            sessionId: delegated.sessionId,
            status: delegated.status,
            ...(delegated.output.trim().length > 0
              ? { output: delegated.output.trim() }
              : {}),
          },
        },
      });
    },
  });
  commandRegistry.register({
    name: "agents",
    description: "List, spawn, inspect, assign, or stop child agents",
    args: "[roles|list|spawn|assign|inspect|stop]",
    global: true,
    metadata: {
      category: "agents",
      clients: ["shell", "console", "web"],
      rolloutFeature: "multiAgent",
      viewKind: "agents",
    },
    handler: async (cmdCtx) => {
      const sessionId = resolveSessionId(cmdCtx.sessionId);
      const session = sessionMgr.get(sessionId);
      if (!session) {
        await cmdCtx.reply("No active session.");
        return;
      }
      if (
        !(await requireShellFeature({
          cmdCtx,
          feature: "multiAgent",
          domain: "shell",
          label: "Agents command",
        }))
      ) {
        return;
      }
      let jsonArgs: Record<string, unknown> | undefined;
      try {
        jsonArgs = parseCommandJsonArgs(cmdCtx.args);
      } catch (error) {
        await cmdCtx.reply(
          `Usage: /agents [roles|list|spawn|assign|inspect|stop]\n${toErrorMessage(error)}`,
        );
        return;
      }
      const subcommand =
        typeof jsonArgs?.subcommand === "string"
          ? jsonArgs.subcommand.trim().toLowerCase()
          : cmdCtx.argv[0]?.toLowerCase() ?? "list";
      if (subcommand === "roles") {
        const roles = ctx.listAgentRoles();
        await cmdCtx.replyResult({
          text: formatAgentRoleCatalog(roles),
          viewKind: "agents",
          data: {
            kind: "agents",
            subcommand: "roles",
            roles: roles.map((role) => ({ ...role })),
          },
        });
        return;
      }
      if (subcommand === "list") {
        const includeAll =
          jsonArgs?.all === true || hasInlineFlag(cmdCtx.argv, "all");
        const entries = ctx.listSubAgentInfo(sessionId).filter((entry) =>
          includeAll ? true : entry.status === "running"
        );
        await cmdCtx.replyResult({
          text: formatAgentListReply(entries),
          viewKind: "agents",
          data: {
            kind: "agents",
            subcommand: "list",
            entries: entries.map((entry) => ({ ...entry })),
          },
        });
        return;
      }
      if (subcommand === "inspect") {
        const target =
          typeof jsonArgs?.target === "string"
            ? jsonArgs.target.trim()
            : cmdCtx.argv[1]?.trim();
        if (!target) {
          await cmdCtx.reply("Usage: /agents inspect <childSessionId|taskId>");
          return;
        }
        const detail = await ctx.inspectShellAgentTask(sessionId, target);
        await cmdCtx.replyResult({
          text: detail
            ? formatAgentInspectReply(detail)
            : `Child agent "${target}" is unavailable.`,
          viewKind: "agents",
          data: {
            kind: "agents",
            subcommand: "inspect",
            ...(detail ? { detail: { ...detail } } : {}),
          },
        });
        return;
      }
      if (subcommand === "stop") {
        const target =
          typeof jsonArgs?.target === "string"
            ? jsonArgs.target.trim()
            : cmdCtx.argv[1]?.trim();
        if (!target) {
          await cmdCtx.reply("Usage: /agents stop <childSessionId|taskId>");
          return;
        }
        const stopped = await ctx.stopShellAgentTask(sessionId, target);
        await cmdCtx.replyResult({
          text: stopped.stopped
            ? `Stopped child agent ${stopped.sessionId ?? target}.${stopped.taskId ? ` Task ${stopped.taskId}.` : ""}`
            : `Child agent "${target}" could not be stopped.`,
          viewKind: "agents",
          data: {
            kind: "agents",
            subcommand: "stop",
            stopped: { ...stopped, target },
          },
        });
        return;
      }
      if (subcommand !== "spawn" && subcommand !== "assign") {
        await cmdCtx.reply(
          "Usage: /agents [roles|list|spawn|assign|inspect|stop]",
        );
        return;
      }

      const taskId =
        subcommand === "assign"
          ? typeof jsonArgs?.taskId === "string"
            ? jsonArgs.taskId.trim()
            : cmdCtx.argv[1]?.trim()
          : undefined;
      const roleId =
        typeof jsonArgs?.roleId === "string"
          ? jsonArgs.roleId.trim()
          : subcommand === "assign"
            ? cmdCtx.argv[2]?.trim()
            : cmdCtx.argv[1]?.trim();
      if (!roleId) {
        await cmdCtx.reply(
          subcommand === "assign"
            ? "Usage: /agents assign <taskId> <role> [--objective <text>] [--profile <name>] [--bundle <name>] [--workspace <path>] [--worktree auto|<path>] [--cwd <path>] [--wait]"
            : "Usage: /agents spawn <role> --objective <text> [--profile <name>] [--bundle <name>] [--workspace <path>] [--worktree auto|<path>] [--cwd <path>] [--wait]",
        );
        return;
      }
      const shellProfile = coerceSessionShellProfile(
        typeof jsonArgs?.profile === "string"
          ? jsonArgs.profile
          : parseInlineFlag(cmdCtx.argv, "profile"),
      );
      const toolBundle = coerceShellAgentToolBundleName(
        typeof jsonArgs?.toolBundle === "string"
          ? jsonArgs.toolBundle
          : parseInlineFlag(cmdCtx.argv, "bundle"),
      );
      const worktreeValue =
        typeof jsonArgs?.worktree === "string"
          ? jsonArgs.worktree.trim()
          : parseInlineFlag(cmdCtx.argv, "worktree");
      const workspaceRoot =
        typeof jsonArgs?.workspaceRoot === "string"
          ? jsonArgs.workspaceRoot.trim()
          : parseInlineFlag(cmdCtx.argv, "workspace");
      const workingDirectory =
        typeof jsonArgs?.workingDirectory === "string"
          ? jsonArgs.workingDirectory.trim()
          : parseInlineFlag(cmdCtx.argv, "cwd");
      const wantsWait =
        jsonArgs?.wait === true || hasInlineFlag(cmdCtx.argv, "wait");

      let objective =
        typeof jsonArgs?.objective === "string"
          ? jsonArgs.objective.trim()
          : parseInlineFlag(cmdCtx.argv, "objective");
      let prompt =
        typeof jsonArgs?.prompt === "string" ? jsonArgs.prompt.trim() : undefined;
      if (subcommand === "assign") {
        if (!taskId) {
          await cmdCtx.reply(
            "Usage: /agents assign <taskId> <role> [--objective <text>] [--profile <name>] [--bundle <name>] [--workspace <path>] [--worktree auto|<path>] [--cwd <path>] [--wait]",
          );
          return;
        }
        const taskDetail = await executeStructuredTool(
          baseToolHandler,
          "task.get",
          { [TASK_LIST_ARG]: cmdCtx.sessionId, taskId },
        );
        const taskRecord =
          typeof taskDetail.task === "object" && taskDetail.task !== null
            ? (taskDetail.task as Record<string, unknown>)
            : undefined;
        if (!taskRecord) {
          await cmdCtx.reply(`Task "${taskId}" is unavailable.`);
          return;
        }
        objective =
          objective ??
          (typeof taskRecord.subject === "string" ? taskRecord.subject : undefined);
        prompt =
          prompt ??
          [
            "Execute the assigned task for the parent session.",
            `Task id: ${taskId}`,
            `Subject: ${typeof taskRecord.subject === "string" ? taskRecord.subject : "unknown"}`,
            `Description: ${typeof taskRecord.description === "string" ? taskRecord.description : "none"}`,
            objective ? `Objective: ${objective}` : null,
          ]
            .filter((value): value is string => Boolean(value))
            .join("\n");
      }
      if (!objective) {
        await cmdCtx.reply(
          subcommand === "assign"
            ? "Assigned child agents need a task subject or explicit --objective."
            : "Child agent spawn requires --objective <text>.",
        );
        return;
      }

      const launched = await ctx.launchShellAgentTask({
        parentSessionId: sessionId,
        roleId,
        objective,
        ...(prompt ? { prompt } : {}),
        ...(taskId ? { taskId } : {}),
        ...(shellProfile ? { shellProfile } : {}),
        ...(toolBundle ? { toolBundle } : {}),
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(worktreeValue
          ? { worktree: worktreeValue === "auto" ? "auto" : worktreeValue }
          : {}),
        ...(wantsWait ? { wait: true } : {}),
      });
      await cmdCtx.replyResult({
        text: launched.waited
          ? [
              `${launched.role.displayName} agent ${launched.sessionId} [${launched.status}]`,
              ...(launched.taskId ? [`Task: ${launched.taskId}`] : []),
              launched.output.trim().length > 0
                ? launched.output.trim()
                : `${launched.role.displayName} agent returned no output.`,
            ].join("\n")
          : [
              `${launched.role.displayName} agent started.`,
              `Session: ${launched.sessionId}`,
              ...(launched.taskId ? [`Task: ${launched.taskId}`] : []),
              `Role: ${launched.role.id}`,
              `Profile: ${shellProfile ?? launched.role.defaultShellProfile}`,
              `Bundle: ${toolBundle ?? launched.role.defaultToolBundle}`,
            ].join("\n"),
        viewKind: "agents",
        data: {
          kind: "agents",
          subcommand,
          launched: {
            ...launched,
            requestedRoleId: roleId,
            ...(shellProfile ? { requestedProfile: shellProfile } : {}),
            ...(toolBundle ? { requestedToolBundle: toolBundle } : {}),
            ...(workspaceRoot ? { workspaceRoot } : {}),
            ...(workingDirectory ? { workingDirectory } : {}),
            ...(worktreeValue ? { worktree: worktreeValue } : {}),
          },
        },
      });
    },
  });
  commandRegistry.register({
    name: "tasks",
    description: "List or inspect session task-tracker tasks",
    args: "[list|get <taskId>]",
    global: true,
    metadata: {
      category: "tasks",
      clients: ["shell", "console", "web"],
      viewKind: "tasks",
    },
    handler: async (cmdCtx) => {
      let jsonArgs: Record<string, unknown> | undefined;
      try {
        jsonArgs = parseCommandJsonArgs(cmdCtx.args);
      } catch (error) {
        await cmdCtx.reply(
          `Usage: /tasks [list|get <taskId>]\n${toErrorMessage(error)}`,
        );
        return;
      }
      const subcommand =
        typeof jsonArgs?.subcommand === "string"
          ? jsonArgs.subcommand.trim().toLowerCase()
          : cmdCtx.argv[0]?.toLowerCase() ?? "list";
      if (subcommand === "list") {
        const result = await executeStructuredTool(
          baseToolHandler,
          "task.list",
          {
            [TASK_LIST_ARG]: cmdCtx.sessionId,
            ...(jsonArgs?.status ? { status: jsonArgs.status } : {}),
            ...(parseInlineFlag(cmdCtx.argv, "status")
              ? { status: parseInlineFlag(cmdCtx.argv, "status") }
              : {}),
          },
        );
        await cmdCtx.replyResult({
          text: formatTaskListReply(result),
          viewKind: "tasks",
          data: {
            kind: "tasks",
            subcommand,
            result: asRecord(result),
          },
        });
        return;
      }

      const taskId =
        typeof jsonArgs?.taskId === "string"
          ? jsonArgs.taskId.trim()
          : cmdCtx.argv[1]?.trim();
      if (!taskId) {
        await cmdCtx.reply("Usage: /tasks [list|get <taskId>]");
        return;
      }

      if (subcommand === "get") {
        const result = await executeStructuredTool(
          baseToolHandler,
          "task.get",
          { [TASK_LIST_ARG]: cmdCtx.sessionId, taskId },
        );
        await cmdCtx.replyResult({
          text: formatTaskDetailReply(result),
          viewKind: "tasks",
          data: {
            kind: "tasks",
            subcommand,
            taskId,
            result: asRecord(result),
          },
        });
        return;
      }

      await cmdCtx.reply("Usage: /tasks [list|get <taskId>]");
    },
  });
  commandRegistry.register({
    name: "plan",
    description: "Show or change the current coding workflow stage for this session",
    args: "[status|enter|exit|implement|review|verify]",
    global: true,
    metadata: {
      category: "workflow",
      clients: ["shell", "console", "web"],
      rolloutFeature: "codingCommands",
      viewKind: "workflow",
    },
    handler: async (cmdCtx) => {
      const sessionId = resolveSessionId(cmdCtx.sessionId);
      const session = sessionMgr.get(sessionId);
      if (!session) {
        await cmdCtx.reply("No active session.");
        return;
      }
      if (
        !(await requireShellFeature({
          cmdCtx,
          feature: "codingCommands",
          domain: "shell",
          label: "Plan command",
        }))
      ) {
        return;
      }
      let jsonArgs: Record<string, unknown> | undefined;
      try {
        jsonArgs = parseCommandJsonArgs(cmdCtx.args);
      } catch (error) {
        await cmdCtx.reply(
          `Usage: /plan [status|enter|exit|implement|review|verify]\n${toErrorMessage(error)}`,
        );
        return;
      }
      const subcommand =
        typeof jsonArgs?.subcommand === "string"
          ? jsonArgs.subcommand.trim().toLowerCase()
          : cmdCtx.argv[0]?.toLowerCase() ?? "status";
      const shellProfile = resolveEffectiveShellProfileForSession({
        ctx,
        sessionId,
        preferred: resolveSessionShellProfile(session?.metadata ?? {}),
      });
      const currentWorkflowState = resolveSessionWorkflowState(session.metadata);
      const wantsDelegate =
        jsonArgs?.delegate === true || hasInlineFlag(cmdCtx.argv, "delegate");
      if (
        wantsDelegate &&
        !(await requireShellFeature({
          cmdCtx,
          feature: "multiAgent",
          domain: "shell",
          label: `Plan ${subcommand} delegation`,
        }))
      ) {
        return;
      }
      const wantsStaged =
        jsonArgs?.staged === true || hasInlineFlag(cmdCtx.argv, "staged");
      const branchInfo = await executeStructuredTool(
        baseToolHandler,
        "system.gitBranchInfo",
        {},
      );
      const summary = await executeStructuredTool(
        baseToolHandler,
        "system.gitChangeSummary",
        {},
      );
      const hasChanges =
        typeof summary.summary === "object" &&
        summary.summary !== null &&
        Object.values(summary.summary as Record<string, unknown>).some(
          (value) => typeof value === "number" && value > 0,
        );
      const tasks = await executeStructuredTool(
        baseToolHandler,
        "task.list",
        { [TASK_LIST_ARG]: cmdCtx.sessionId },
      );
      const activePipelines = pipelineExecutor
        ? await pipelineExecutor.listActive()
        : [];
      const runtimeStatusSnapshot = buildSessionRuntimeContractStatusSnapshot(
        session.metadata,
      ) as Record<string, unknown> | undefined;
      const ownership = collectSessionWorkflowOwnership({
        runtimeStatusSnapshot,
        taskResult: tasks,
        childInfos: ctx.listSubAgentInfo(sessionId),
      });
      const formatPlanSurface = (
        workflowState = resolveSessionWorkflowState(session.metadata),
      ): string => {
        const suggestedStage = suggestNextWorkflowStage({
          currentStage: workflowState.stage,
          plannerStatus:
            typeof runtimeStatusSnapshot?.completionState === "string"
              ? runtimeStatusSnapshot.completionState
              : "idle",
          ownership,
          hasChanges,
        });
        return [
          "Plan surface:",
          `  Session: ${cmdCtx.sessionId}`,
          `  Shell profile: ${shellProfile}`,
          `  Workflow stage: ${formatSessionWorkflowStage(workflowState.stage)}`,
          `  Worktree mode: ${formatSessionWorktreeMode(workflowState.worktreeMode)}`,
          ...(workflowState.objective ? [`  Objective: ${workflowState.objective}`] : []),
          `  History messages: ${session.history.length}`,
          `  Active pipelines: ${activePipelines.length}`,
          `  Planner DAG: ${typeof runtimeStatusSnapshot?.completionState === "string" ? runtimeStatusSnapshot.completionState : "idle"}`,
          `  Suggested next stage: ${suggestedStage ? formatSessionWorkflowStage(suggestedStage) : "none"}`,
          "",
          formatGitBranchReply(branchInfo),
          "",
          formatGitSummaryReply(summary),
          "",
          formatTaskListReply(tasks),
          "",
          formatWorkflowOwnershipReply(ownership),
        ].join("\n");
      };
      const buildPlanData = (
        workflowState = resolveSessionWorkflowState(session.metadata),
        delegated?: {
          sessionId: string;
          status: string;
          output?: string;
        },
      ) => ({
        kind: "workflow" as const,
        subcommand,
        shellProfile,
        workflowState,
        plannerStatus:
          typeof runtimeStatusSnapshot?.completionState === "string"
            ? runtimeStatusSnapshot.completionState
            : "idle",
        suggestedNextStage: suggestNextWorkflowStage({
          currentStage: workflowState.stage,
          plannerStatus:
            typeof runtimeStatusSnapshot?.completionState === "string"
              ? runtimeStatusSnapshot.completionState
              : "idle",
          ownership,
          hasChanges,
        }),
        branchInfo: asRecord(branchInfo),
        changeSummary: asRecord(summary),
        tasks: asRecord(tasks),
        ownership: ownership.map((entry) => ({ ...entry })) as readonly Record<
          string,
          unknown
        >[],
        ...(delegated ? { delegated } : {}),
      });
      if (subcommand === "status") {
        await cmdCtx.replyResult({
          text: formatPlanSurface(currentWorkflowState),
          viewKind: "workflow",
          data: buildPlanData(currentWorkflowState),
        });
        return;
      }
      if (subcommand === "enter") {
        const objective =
          typeof jsonArgs?.objective === "string"
            ? jsonArgs.objective
            : parseInlineFlag(cmdCtx.argv, "objective");
        const explicitWorktreeMode =
          typeof jsonArgs?.worktreeMode === "string"
            ? jsonArgs.worktreeMode
            : parseInlineFlag(cmdCtx.argv, "worktrees");
        const workflowState = updateSessionWorkflowState(
          session.metadata,
          {
            stage: "plan",
            worktreeMode:
              explicitWorktreeMode === "child"
                ? "child_optional"
                : explicitWorktreeMode === "off"
                  ? "off"
                  : shellProfile === "coding"
                    ? "child_optional"
                    : "off",
            ...(objective !== undefined ? { objective } : {}),
          },
        );
        await persistWebSessionRuntimeState(memoryBackend, cmdCtx.sessionId, session);
        await cmdCtx.replyResult({
          text: `Workflow stage set to ${formatSessionWorkflowStage(workflowState.stage)}.\n\n${formatPlanSurface(workflowState)}`,
          viewKind: "workflow",
          data: buildPlanData(workflowState),
        });
        return;
      }
      if (subcommand === "exit") {
        if (currentWorkflowState.stage !== "plan") {
          await cmdCtx.reply("Workflow exit is only available while the session is in plan mode.");
          return;
        }
        const workflowState = updateSessionWorkflowState(session.metadata, {
          stage: "implement",
        });
        await persistWebSessionRuntimeState(memoryBackend, cmdCtx.sessionId, session);
        await cmdCtx.replyResult({
          text: `Workflow stage set to ${formatSessionWorkflowStage(workflowState.stage)}.\n\n${formatPlanSurface(workflowState)}`,
          viewKind: "workflow",
          data: buildPlanData(workflowState),
        });
        return;
      }
      if (subcommand === "implement") {
        const workflowState = updateSessionWorkflowState(session.metadata, {
          stage: "implement",
        });
        await persistWebSessionRuntimeState(memoryBackend, cmdCtx.sessionId, session);
        await cmdCtx.replyResult({
          text: `Workflow stage set to ${formatSessionWorkflowStage(workflowState.stage)}.\n\n${formatPlanSurface(workflowState)}`,
          viewKind: "workflow",
          data: buildPlanData(workflowState),
        });
        return;
      }
      if (subcommand === "review") {
        const workflowState = updateSessionWorkflowState(session.metadata, {
          stage: "review",
        });
        if (!wantsDelegate) {
          updateReviewSurfaceState(session, {
            status: "idle",
            source: "local",
            summaryPreview: "Review stage entered.",
          });
          await persistWebSessionRuntimeState(memoryBackend, cmdCtx.sessionId, session);
          await cmdCtx.replyResult({
            text: `Workflow stage set to ${formatSessionWorkflowStage(workflowState.stage)}.\n\n${formatPlanSurface(workflowState)}`,
            viewKind: "workflow",
            data: buildPlanData(workflowState),
          });
          return;
        }
        const diff = await executeStructuredTool(
          baseToolHandler,
          "system.gitDiff",
          wantsStaged ? { staged: true } : {},
        );
        const delegated = await launchDelegatedReviewTask({
          ctx,
          session,
          webSessionId: cmdCtx.sessionId,
          resolvedSessionId: sessionId,
          memoryBackend,
          shellProfile,
          branchInfo,
          summary,
          diff,
          mode: "default",
        });
        await cmdCtx.replyResult({
          text: [
            `Workflow stage set to ${formatSessionWorkflowStage(workflowState.stage)}.`,
            "",
            formatPlanSurface(workflowState),
            "",
            `Delegated reviewer session: ${delegated.sessionId} [${delegated.status}]`,
            delegated.output.trim().length > 0
              ? delegated.output.trim()
              : "Delegated reviewer returned no output.",
          ].join("\n"),
          viewKind: "workflow",
          data: buildPlanData(workflowState, {
            sessionId: delegated.sessionId,
            status: delegated.status,
            ...(delegated.output.trim().length > 0
              ? { output: delegated.output.trim() }
              : {}),
          }),
        });
        return;
      }
      if (subcommand === "verify") {
        const workflowState = updateSessionWorkflowState(session.metadata, {
          stage: "verify",
        });
        if (!wantsDelegate) {
          updateVerificationSurfaceState(session, {
            status: "idle",
            source: "local",
            verdict: "unknown",
            summaryPreview: "Verification stage entered.",
          });
          await persistWebSessionRuntimeState(memoryBackend, cmdCtx.sessionId, session);
          await cmdCtx.replyResult({
            text: `Workflow stage set to ${formatSessionWorkflowStage(workflowState.stage)}.\n\n${formatPlanSurface(workflowState)}`,
            viewKind: "workflow",
            data: buildPlanData(workflowState),
          });
          return;
        }
        const delegated = await launchDelegatedVerifyTask({
          ctx,
          session,
          webSessionId: cmdCtx.sessionId,
          resolvedSessionId: sessionId,
          memoryBackend,
          shellProfile,
          branchInfo,
          summary,
          tasks,
          runtimeStatusSnapshot,
        });
        await cmdCtx.replyResult({
          text: [
            `Workflow stage set to ${formatSessionWorkflowStage(workflowState.stage)}.`,
            "",
            formatPlanSurface(workflowState),
            "",
            `Delegated verifier session: ${delegated.sessionId} [${delegated.status}]`,
            delegated.output.trim().length > 0
              ? delegated.output.trim()
              : "Delegated verifier returned no output.",
          ].join("\n"),
          viewKind: "workflow",
          data: buildPlanData(workflowState, {
            sessionId: delegated.sessionId,
            status: delegated.status,
            ...(delegated.output.trim().length > 0
              ? { output: delegated.output.trim() }
              : {}),
          }),
        });
        return;
      }
      await cmdCtx.reply(
        "Usage: /plan [status|enter|exit|implement|review|verify]",
      );
    },
  });
  commandRegistry.register({
    name: "verify",
    description: "Show verifier state or run the restricted verifier child",
    args: "[--delegate]",
    global: true,
    metadata: {
      category: "coding",
      clients: ["shell", "console", "web"],
      rolloutFeature: "codingCommands",
      viewKind: "verify",
    },
    handler: async (cmdCtx) => {
      const resolvedSessionId = resolveSessionId(cmdCtx.sessionId);
      const session = sessionMgr.get(resolvedSessionId);
      if (!session) {
        await cmdCtx.reply("No active session.");
        return;
      }
      if (
        !(await requireShellFeature({
          cmdCtx,
          feature: "codingCommands",
          domain: "shell",
          label: "Verify command",
        }))
      ) {
        return;
      }
      let jsonArgs: Record<string, unknown> | undefined;
      try {
        jsonArgs = parseCommandJsonArgs(cmdCtx.args);
      } catch (error) {
        await cmdCtx.reply(`Usage: /verify [--delegate]\n${toErrorMessage(error)}`);
        return;
      }
      const wantsDelegate =
        jsonArgs?.delegate === true || hasInlineFlag(cmdCtx.argv, "delegate");
      if (
        wantsDelegate &&
        !(await requireShellFeature({
          cmdCtx,
          feature: "multiAgent",
          domain: "shell",
          label: "Verify delegation",
        }))
      ) {
        return;
      }
      const branchInfo = await executeStructuredTool(
        baseToolHandler,
        "system.gitBranchInfo",
        {},
      );
      const summary = await executeStructuredTool(
        baseToolHandler,
        "system.gitChangeSummary",
        {},
      );
      const hasChanges =
        typeof summary.summary === "object" &&
        summary.summary !== null &&
        Object.values(summary.summary as Record<string, unknown>).some(
          (value) => typeof value === "number" && value > 0,
        );
      const tasks = await executeStructuredTool(
        baseToolHandler,
        "task.list",
        { [TASK_LIST_ARG]: cmdCtx.sessionId },
      );
      const runtimeStatusSnapshot = buildSessionRuntimeContractStatusSnapshot(
        session.metadata,
      ) as Record<string, unknown> | undefined;
      const verifierSnapshot =
        typeof runtimeStatusSnapshot?.verifierStages === "object" &&
        runtimeStatusSnapshot.verifierStages !== null
          ? JSON.stringify(runtimeStatusSnapshot.verifierStages, null, 2)
          : "No runtime verifier snapshot available.";
      const verificationSurface = [
        "Verification surface:",
        formatGitBranchReply(branchInfo),
        "",
        formatGitSummaryReply(summary),
        "",
        formatTaskListReply(tasks),
        "",
        "Runtime verifier snapshot:",
        verifierSnapshot,
      ].join("\n");
      if (!wantsDelegate) {
        const verificationState = updateVerificationSurfaceState(session, {
          status: "completed",
          source: "local",
          summaryPreview: verificationSurface,
          verdict: hasChanges ? "mixed" : "pass",
        });
        await persistWebSessionRuntimeState(memoryBackend, cmdCtx.sessionId, session);
        await cmdCtx.replyResult({
          text: verificationSurface,
          viewKind: "verify",
          data: {
            kind: "verify",
            delegated: false,
            branchInfo: asRecord(branchInfo),
            changeSummary: asRecord(summary),
            tasks: asRecord(tasks),
            runtimeStatusSnapshot,
            verificationSurface: {
              status: verificationState.status,
              source: verificationState.source,
              ...(verificationState.summaryPreview
                ? { summaryPreview: verificationState.summaryPreview }
                : {}),
              ...(verificationState.verdict
                ? { verdict: verificationState.verdict }
                : {}),
            },
          },
        });
        return;
      }
      const delegated = await launchDelegatedVerifyTask({
        ctx,
        session,
        webSessionId: cmdCtx.sessionId,
        resolvedSessionId,
        memoryBackend,
        shellProfile: resolveEffectiveShellProfileForSession({
          ctx,
          sessionId: resolvedSessionId,
          preferred: resolveSessionShellProfile(session.metadata),
        }),
        branchInfo,
        summary,
        tasks,
        runtimeStatusSnapshot,
      });
      await cmdCtx.replyResult({
        text: [
          verificationSurface,
          "",
          `Delegated verifier session: ${delegated.sessionId} [${delegated.status}]`,
          delegated.output.trim().length > 0
            ? delegated.output.trim()
            : "Delegated verifier returned no output.",
        ].join("\n"),
        viewKind: "verify",
        data: {
          kind: "verify",
          delegated: true,
          branchInfo: asRecord(branchInfo),
          changeSummary: asRecord(summary),
          tasks: asRecord(tasks),
          runtimeStatusSnapshot,
          verificationSurface: {
            status: delegated.success === true ? "completed" : "failed",
            source: "delegated",
            delegatedSessionId: delegated.sessionId,
            ...(delegated.output.trim().length > 0
              ? { summaryPreview: compactSurfacePreview(delegated.output) }
              : {}),
            verdict: delegated.success === true ? "pass" : "fail",
          },
          delegatedResult: {
            sessionId: delegated.sessionId,
            status: delegated.status,
            ...(delegated.output.trim().length > 0
              ? { output: delegated.output.trim() }
              : {}),
          },
        },
      });
    },
  });
  commandRegistry.register({
    name: "session",
    description: "Inspect the current shell session or continuity catalog",
    global: true,
    metadata: {
      category: "session",
      clients: ["shell", "console", "web"],
      viewKind: "session",
    },
    handler: async (cmdCtx) => {
      const subcommand = cmdCtx.argv[0]?.toLowerCase() ?? "status";
      const webChat = ctx.getWebChatChannel();
      const replyCurrentSession = async (): Promise<void> => {
        const resolvedSessionId = resolveSessionId(cmdCtx.sessionId);
        const session = sessionMgr.get(resolvedSessionId);
        const workspaceRoot =
          (session?.metadata?.workspaceRoot as string | undefined) ??
          (typeof webChat?.loadSessionWorkspaceRoot === "function"
            ? await webChat.loadSessionWorkspaceRoot(cmdCtx.sessionId)
            : undefined) ??
          ctx.getHostWorkspacePath() ??
          process.cwd();
        const modelInfo = ctx.getSessionModelInfo(cmdCtx.sessionId);
        const shellProfile = resolveEffectiveShellProfileForSession({
          ctx,
          sessionId: resolvedSessionId,
          preferred: resolveSessionShellProfile(session?.metadata ?? {}),
        });
        const workflowState = resolveSessionWorkflowState(session?.metadata ?? {});
        const runtimeStatusSnapshot = buildSessionRuntimeContractStatusSnapshot(
          session?.metadata ?? {},
        ) as Record<string, unknown> | undefined;
        const tasks = await executeStructuredTool(baseToolHandler, "task.list", {
          [TASK_LIST_ARG]: cmdCtx.sessionId,
        });
        const ownership = collectSessionWorkflowOwnership({
          runtimeStatusSnapshot,
          taskResult: tasks,
          childInfos: ctx.listSubAgentInfo(resolvedSessionId),
        });
        const modelLabel = modelInfo
          ? `${modelInfo.provider}:${formatModelRouteModelLabel(modelInfo)}${modelInfo.usedFallback ? " (fallback)" : ""}`
          : "unknown";
        await cmdCtx.replyResult({
          text: [
            "Shell session:",
            `  Session id: ${cmdCtx.sessionId}`,
            `  Runtime session id: ${resolvedSessionId}`,
            `  Profile: ${shellProfile}`,
            `  Workflow stage: ${formatSessionWorkflowStage(workflowState.stage)}`,
            `  Worktree mode: ${formatSessionWorktreeMode(workflowState.worktreeMode)}`,
            ...(workflowState.objective
              ? [`  Objective: ${workflowState.objective}`]
              : []),
            `  Workspace root: ${workspaceRoot}`,
            `  History messages: ${session?.history.length ?? 0}`,
            `  Model: ${modelLabel}`,
            "",
            formatWorkflowOwnershipReply(ownership),
          ].join("\n"),
          viewKind: "session",
          data: {
            kind: "session",
            subcommand: "status",
            currentSession: {
              sessionId: cmdCtx.sessionId,
              runtimeSessionId: resolvedSessionId,
              shellProfile,
              workflowState,
              workspaceRoot,
              historyMessages: session?.history.length ?? 0,
              ...(modelInfo
                ? {
                    model: modelLabel,
                  }
                : {}),
              ownership: ownership.map((entry) => ({ ...entry })),
            },
          },
        });
      };

      if (!subcommand || subcommand === "status" || subcommand === "current") {
        await replyCurrentSession();
        return;
      }

      if (!webChat) {
        await cmdCtx.reply("Session continuity is unavailable.");
        return;
      }

      if (subcommand === "list") {
        const jsonArgs = parseCommandJsonArgv(cmdCtx.argv);
        const profile =
          coerceSessionShellProfile(
            jsonArgs?.profile ?? parseInlineFlag(cmdCtx.argv.slice(1), "profile"),
          ) ?? undefined;
        const sessions = await webChat.listContinuitySessionsForSession(
          cmdCtx.sessionId,
          {
            activeOnly:
              jsonArgs?.activeOnly === true ||
              hasInlineFlag(cmdCtx.argv.slice(1), "active-only"),
            limit:
              typeof jsonArgs?.limit === "number"
                ? jsonArgs.limit
                : parseIntegerFlag(cmdCtx.argv.slice(1), "limit"),
            ...(profile ? { shellProfile: profile } : {}),
          },
        );
        await cmdCtx.replyResult({
          text: formatContinuitySessionList(
            sessions as unknown as readonly Record<string, unknown>[],
          ),
          viewKind: "session",
          data: {
            kind: "session",
            subcommand: "list",
            sessions,
          },
        });
        return;
      }

      if (subcommand === "inspect") {
        const jsonArgs = parseCommandJsonArgv(cmdCtx.argv);
        const targetSessionId =
          (typeof jsonArgs?.sessionId === "string" ? jsonArgs.sessionId : undefined) ??
          cmdCtx.argv[1];
        const detail = await webChat.inspectOwnedSession(
          cmdCtx.sessionId,
          targetSessionId,
        );
        await cmdCtx.replyResult({
          text: detail
            ? formatContinuitySessionInspect(detail)
            : `Session "${targetSessionId ?? cmdCtx.sessionId}" not found.`,
          viewKind: "session",
          data: {
            kind: "session",
            subcommand: "inspect",
            ...(detail ? { detail } : {}),
          },
        });
        return;
      }

      if (subcommand === "history") {
        const jsonArgs = parseCommandJsonArgv(cmdCtx.argv);
        const argvTarget = cmdCtx.argv[1]?.startsWith("--") ? undefined : cmdCtx.argv[1];
        const history = await webChat.loadOwnedSessionHistory(cmdCtx.sessionId, {
          sessionId:
            (typeof jsonArgs?.sessionId === "string" ? jsonArgs.sessionId : undefined) ??
            argvTarget,
          limit:
            typeof jsonArgs?.limit === "number"
              ? jsonArgs.limit
              : parseIntegerFlag(cmdCtx.argv.slice(1), "limit"),
          includeTools:
            jsonArgs?.includeTools === true ||
            hasInlineFlag(cmdCtx.argv.slice(1), "include-tools"),
        });
        await cmdCtx.replyResult({
          text: formatSessionHistoryReply(history),
          viewKind: "session",
          data: {
            kind: "session",
            subcommand: "history",
            history,
          },
        });
        return;
      }

      if (subcommand === "resume") {
        const jsonArgs = parseCommandJsonArgv(cmdCtx.argv);
        const targetSessionId =
          (typeof jsonArgs?.sessionId === "string" ? jsonArgs.sessionId : undefined) ??
          cmdCtx.argv[1];
        if (!targetSessionId) {
          await cmdCtx.reply("Usage: /session resume <sessionId>");
          return;
        }
        const resumed = await webChat.resumeOwnedSession(
          cmdCtx.sessionId,
          targetSessionId,
        );
        await cmdCtx.replyResult({
          text: resumed
            ? [
                `Resumed session ${resumed.sessionId}.`,
                `  Messages: ${resumed.messageCount}`,
                ...(resumed.workspaceRoot
                  ? [`  Workspace root: ${resumed.workspaceRoot}`]
                  : []),
              ].join("\n")
            : `Session "${targetSessionId}" not found.`,
          viewKind: "session",
          data: {
            kind: "session",
            subcommand: "resume",
            ...(resumed ? { resumed } : {}),
          },
        });
        return;
      }

      if (subcommand === "fork") {
        const jsonArgs = parseCommandJsonArgv(cmdCtx.argv);
        const argvTarget = cmdCtx.argv[1]?.startsWith("--") ? undefined : cmdCtx.argv[1];
        const profile =
          coerceSessionShellProfile(
            jsonArgs?.profile ?? parseInlineFlag(cmdCtx.argv.slice(1), "profile"),
          ) ?? undefined;
        const objective =
          typeof jsonArgs?.objective === "string"
            ? jsonArgs.objective
            : parseInlineFlag(cmdCtx.argv.slice(1), "objective");
        const forked = await webChat.forkOwnedSessionForRequester(
          cmdCtx.sessionId,
          {
            ...(argvTarget ? { sessionId: argvTarget } : {}),
            ...(profile ? { shellProfile: profile } : {}),
            ...(objective ? { objective } : {}),
          },
        );
        if (!forked) {
          await cmdCtx.reply(
            `Session "${argvTarget ?? cmdCtx.sessionId}" could not be forked.`,
          );
          return;
        }
        const sessionDetail = asRecord(forked.session);
        await cmdCtx.replyResult({
          text: [
            `Forked session ${typeof forked.targetSessionId === "string" ? forked.targetSessionId : "unknown"} from ${
              typeof forked.sourceSessionId === "string" ? forked.sourceSessionId : cmdCtx.sessionId
            }.`,
            `  Source: ${typeof forked.forkSource === "string" ? forked.forkSource : "unknown"}`,
            ...(typeof sessionDetail?.preview === "string"
              ? [`  Preview: ${sessionDetail.preview}`]
              : []),
            "  Use /session resume <sessionId> to switch into the fork.",
          ].join("\n"),
          viewKind: "session",
          data: {
            kind: "session",
            subcommand: "fork",
            forked: {
              sourceSessionId:
                typeof forked.sourceSessionId === "string"
                  ? forked.sourceSessionId
                  : cmdCtx.sessionId,
              targetSessionId:
                typeof forked.targetSessionId === "string"
                  ? forked.targetSessionId
                  : "unknown",
              ...(typeof forked.forkSource === "string"
                ? { forkSource: forked.forkSource }
                : {}),
              ...(sessionDetail ? { session: sessionDetail } : {}),
            },
          },
        });
        return;
      }

      await cmdCtx.reply(
        "Usage: /session [status|list|inspect [sessionId]|history [sessionId] [--limit N] [--include-tools]|resume <sessionId>|fork [sessionId] [--objective TEXT] [--profile PROFILE]]",
      );
    },
  });
  commandRegistry.register({
    name: "response",
    description: "Inspect or delete stored xAI Responses API objects",
    args: "[status|get [response-id|latest] [--json]|delete [response-id|latest]]",
    global: true,
    handler: async (cmdCtx) => {
      if (
        !(await requireShellFeature({
          cmdCtx,
          feature: "shellExtensions",
          domain: "extensions",
          label: "MCP command",
        }))
      ) {
        return;
      }
      const subcommand = cmdCtx.argv[0]?.toLowerCase() ?? "status";
      const sessionId = resolveSessionId(cmdCtx.sessionId);
      const session = sessionMgr.get(sessionId);
      const responseAnchor = getSessionResumeAnchorResponseId(session);
      const preferredProviderName =
        ctx.getSessionModelInfo(cmdCtx.sessionId)?.provider ??
        ctx.gateway?.config.llm?.provider;
      const providersWithReplay = orderProvidersForStoredResponses(
        providers,
        preferredProviderName,
        "retrieve",
      );
      const capabilityProvider = providersWithReplay[0];
      const capabilityStateful = capabilityProvider?.getCapabilities?.().stateful;
      const encryptedReasoningEnabled =
        ctx.gateway?.config.llm?.includeEncryptedReasoning === true;
      const statefulConfig = ctx.gateway?.config.llm?.statefulResponses;

      if (subcommand === "status") {
        await cmdCtx.reply(
          [
            "Stored response state:",
            `  Replay provider available: ${capabilityProvider ? "yes" : "no"}`,
            `  Retrieval supported: ${capabilityStateful?.storedResponseRetrieval === true ? "yes" : "no"}`,
            `  Deletion supported: ${capabilityStateful?.storedResponseDeletion === true ? "yes" : "no"}`,
            `  Encrypted reasoning support: ${capabilityStateful?.encryptedReasoning === true ? "yes" : "no"}`,
            `  Stateful responses: ${statefulConfig?.enabled === true ? "enabled" : "disabled"}`,
            `  Provider storage: ${statefulConfig?.store === true ? "enabled" : "disabled"}`,
            `  Runtime includeEncryptedReasoning: ${encryptedReasoningEnabled ? "enabled" : "disabled"}`,
            `  Current response anchor: ${responseAnchor ?? "none"}`,
            `  History compacted: ${getSessionHistoryCompacted(session) ? "yes" : "no"}`,
          ].join("\n"),
        );
        return;
      }

      if (subcommand !== "get" && subcommand !== "delete") {
        await cmdCtx.reply(
          "Usage: /response [status|get [response-id|latest] [--json]|delete [response-id|latest]]",
        );
        return;
      }

      const wantsJson = cmdCtx.argv.some((arg) => arg === "--json");
      const requestedId = cmdCtx.argv
        .slice(1)
        .find((arg) => arg !== "--json");
      const responseId =
        !requestedId || requestedId.toLowerCase() === "latest"
          ? responseAnchor
          : requestedId.trim();
      if (!responseId) {
        await cmdCtx.reply(
          subcommand === "get"
            ? "No stored response anchor is available for this session. Pass an explicit response id or run another stateful turn first."
            : "No stored response anchor is available for this session to delete. Pass an explicit response id or run another stateful turn first.",
        );
        return;
      }

      if (subcommand === "get") {
        try {
          const stored = await retrieveStoredResponseWithFallback(
            providers,
            responseId,
            preferredProviderName,
          );
          if (wantsJson) {
            await cmdCtx.reply(JSON.stringify(stored.raw ?? stored, null, 2));
            return;
          }
          await cmdCtx.reply(summarizeStoredResponse(stored));
        } catch (error) {
          await cmdCtx.reply(
            `Stored response retrieval failed: ${toErrorMessage(error)}`,
          );
        }
        return;
      }

      try {
        const deleted = await deleteStoredResponseWithFallback(
          providers,
          responseId,
          preferredProviderName,
        );
        let clearedAnchor = false;
        if (responseAnchor && responseAnchor === responseId && session) {
          clearStatefulContinuationMetadata(session.metadata);
          await clearWebSessionRuntimeState(memoryBackend, cmdCtx.sessionId);
          clearedAnchor = true;
        }
        await cmdCtx.reply(
          [
            `Stored response delete: ${deleted.deleted ? "confirmed" : "not confirmed"}`,
            `  Provider: ${deleted.providerName}`,
            `  Response: ${deleted.id}`,
            `  Cleared active anchor: ${clearedAnchor ? "yes" : "no"}`,
          ].join("\n"),
        );
      } catch (error) {
        await cmdCtx.reply(
          `Stored response deletion failed: ${toErrorMessage(error)}`,
        );
      }
    },
  });
  commandRegistry.register({
    name: "policy",
    description: "Show policy state or simulate a tool policy decision",
    args: "[status|simulate <toolName> [jsonArgs]|credentials|revoke-credentials [credentialId]|update <allow|deny|clear|reset> [pattern]]",
    global: true,
    metadata: {
      category: "policy",
      clients: ["shell", "console", "web"],
      viewKind: "policy",
    },
    handler: async (cmdCtx) => {
      const replyPolicyResult = async (
        subcommandName: string,
        text: string,
        extras: Omit<import("../channels/webchat/protocol.js").PolicyCommandData, "kind" | "subcommand"> = {},
      ) => {
        await cmdCtx.replyResult({
          text,
          viewKind: "policy",
          data: {
            kind: "policy",
            subcommand: subcommandName,
            ...extras,
          },
        });
      };
      const subcommand = cmdCtx.argv[0]?.toLowerCase();
      if (!subcommand || subcommand === "status") {
        const state = ctx.getPolicyEngineState();
        const policy = ctx.gateway?.config.policy;
        const sessionPolicyState = ctx.getSessionPolicyState(cmdCtx.sessionId);
        await replyPolicyResult(
          "status",
          [
            `Policy engine: ${ctx.isPolicyEngineEnabled() ? "enabled" : "disabled"}`,
            `Simulation mode: ${policy?.simulationMode ?? "off"}`,
            `Audit log: ${ctx.isGovernanceAuditLogEnabled() ? "enabled" : "disabled"}`,
            state
              ? `Circuit mode: ${state.mode} (recent violations: ${state.recentViolations})`
              : "Circuit mode: unavailable",
            `Session allow patterns: ${
              sessionPolicyState.elevatedPatterns.length > 0
                ? sessionPolicyState.elevatedPatterns.join(", ")
                : "none"
            }`,
            `Session deny patterns: ${
              sessionPolicyState.deniedPatterns.length > 0
                ? sessionPolicyState.deniedPatterns.join(", ")
                : "none"
            }`,
          ].join("\n"),
          {
            sessionPolicyState: {
              elevatedPatterns: sessionPolicyState.elevatedPatterns,
              deniedPatterns: sessionPolicyState.deniedPatterns,
            },
            ...(state ? { preview: asRecord(state) } : {}),
          },
        );
        return;
      }
      if (subcommand === "credentials") {
        const leases =
          ctx.listSessionCredentialLeases(cmdCtx.sessionId) ?? [];
        if (leases.length === 0) {
          await replyPolicyResult("credentials", "No active session credential leases.");
          return;
        }
        const lines = leases.map(
          (lease) =>
            `- ${lease.credentialId}: expires ${new Date(lease.expiresAt).toISOString()} ` +
            `(domains=${lease.domains.join(", ") || "none"})`,
        );
        await replyPolicyResult(
          "credentials",
          `Active session credential leases:\n${lines.join("\n")}`,
          {
            leases: leases
              .map((lease) => asRecord(lease))
              .filter((lease): lease is Record<string, unknown> => Boolean(lease)),
          },
        );
        return;
      }
      if (subcommand === "revoke-credentials") {
        const credentialId = cmdCtx.argv[1]?.trim();
        const revoked = await ctx.revokeSessionCredentials({
          sessionId: cmdCtx.sessionId,
          credentialId:
            credentialId && credentialId.length > 0
              ? credentialId
              : undefined,
          reason: "manual",
        });
        await replyPolicyResult(
          "revoke-credentials",
          revoked > 0
            ? `Revoked ${revoked} session credential lease${revoked === 1 ? "" : "s"}.`
            : credentialId
              ? `No active lease found for credential ${credentialId}.`
              : "No active session credential leases to revoke.",
        );
        return;
      }
      if (subcommand === "update") {
        const operation = cmdCtx.argv[1]?.trim().toLowerCase();
        const pattern = cmdCtx.argv[2]?.trim();
        if (
          !operation ||
          !["allow", "deny", "clear", "reset"].includes(operation) ||
          (operation !== "reset" && (!pattern || pattern.length === 0))
        ) {
          await cmdCtx.reply(
            "Usage: /policy update <allow|deny|clear|reset> [pattern]",
          );
          return;
        }
        const nextState = ctx.updateSessionPolicyState({
          sessionId: cmdCtx.sessionId,
          operation: operation as "allow" | "deny" | "clear" | "reset",
          pattern,
        });
        await replyPolicyResult(
          "update",
          [
            `Policy update: ${operation}${pattern ? ` ${pattern}` : ""}`,
            `Session allow patterns: ${
              nextState.elevatedPatterns.length > 0
                ? nextState.elevatedPatterns.join(", ")
                : "none"
            }`,
            `Session deny patterns: ${
              nextState.deniedPatterns.length > 0
                ? nextState.deniedPatterns.join(", ")
                : "none"
            }`,
          ].join("\n"),
          {
            sessionPolicyState: {
              elevatedPatterns: nextState.elevatedPatterns,
              deniedPatterns: nextState.deniedPatterns,
            },
          },
        );
        return;
      }
      if (subcommand !== "simulate") {
        await cmdCtx.reply(
          "Usage: /policy [status|simulate <toolName> [jsonArgs]|credentials|revoke-credentials [credentialId]|update <allow|deny|clear|reset> [pattern]]",
        );
        return;
      }
      const toolName = cmdCtx.argv[1]?.trim();
      if (!toolName) {
        await cmdCtx.reply("Usage: /policy simulate <toolName> [jsonArgs]");
        return;
      }
      const argsText = cmdCtx.args.replace(/^simulate\s+\S+\s*/i, "").trim();
      let parsedArgs: Record<string, unknown> = {};
      if (argsText.length > 0) {
        try {
          const candidate = JSON.parse(argsText);
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate)
          ) {
            await cmdCtx.reply("Policy simulate JSON args must be an object.");
            return;
          }
          parsedArgs = candidate as Record<string, unknown>;
        } catch (error) {
          await cmdCtx.reply(
            `Policy simulate JSON parse failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
      }
      const preview = await ctx.buildPolicySimulationPreview({
        sessionId: cmdCtx.sessionId,
        toolName,
        args: parsedArgs,
      });
      const violationLines =
        preview.policy.violations.length > 0
          ? preview.policy.violations
              .map((violation) => `- ${violation.code}: ${violation.message}`)
              .join("\n")
          : "- none";
      const approvalPreview = preview.approval.requestPreview;
      await replyPolicyResult(
        "simulate",
        [
          `Policy simulation for ${preview.toolName}`,
          `Session: ${preview.sessionId}`,
          `Policy: ${preview.policy.allowed ? "allow" : "deny"} (${preview.policy.mode})`,
          `Violations:\n${violationLines}`,
          `Approval: required=${preview.approval.required} elevated=${preview.approval.elevated} denied=${preview.approval.denied}`,
          approvalPreview
            ? `Approval preview: ${approvalPreview.message}`
            : "Approval preview: none",
        ].join("\n"),
        {
          preview: asRecord(preview),
        },
      );
    },
  });
  commandRegistry.register({
    name: "permissions",
    description: "Alias for /policy with coding-shell wording",
    args: "[status|simulate <toolName> [jsonArgs]|credentials|revoke-credentials [credentialId]|update <allow|deny|clear|reset> [pattern]]",
    global: true,
    metadata: {
      category: "policy",
      clients: ["shell", "console", "web"],
      viewKind: "policy",
    },
    handler: async (cmdCtx) => {
      const policy = commandRegistry.get("policy");
      if (!policy) {
        await cmdCtx.reply("Policy command is unavailable.");
        return;
      }
      await policy.handler(cmdCtx);
    },
  });
  commandRegistry.register({
    name: "mcp",
    description: "Inspect and control already-configured MCP servers",
    args: "[status|list|inspect <server>|tools [server]|validate [server]|reconnect <server>|enable <server>|disable <server>]",
    global: true,
    metadata: {
      category: "extensions",
      clients: ["shell", "console", "web"],
      rolloutFeature: "shellExtensions",
      viewKind: "extensions",
    },
    handler: async (cmdCtx) => {
      if (
        !(await requireShellFeature({
          cmdCtx,
          feature: "shellExtensions",
          domain: "extensions",
          label: "MCP command",
        }))
      ) {
        return;
      }
      const subcommand = cmdCtx.argv[0]?.toLowerCase() ?? "status";
      const catalog = registry.listCatalog();
      const mcpCatalog = getMcpCatalogEntries(catalog);
      const sourceCounts = groupCatalogBySource(catalog);
      const configuredServers = Array.isArray(ctx.gateway?.config.mcp?.servers)
        ? ctx.gateway?.config.mcp?.servers
        : [];
      const mcpManager = ctx.getMcpManager();
      const connectedServers = new Set(mcpManager?.getConnectedServers() ?? []);
      const renderStatus = (): string => [
        "MCP surface:",
        `  Configured servers: ${configuredServers.length}`,
        `  Connected servers: ${connectedServers.size}`,
        `  Visible MCP tools: ${mcpCatalog.length}`,
        `  Builtin tools: ${sourceCounts.builtin ?? 0}`,
        `  Plugin tools: ${sourceCounts.plugin ?? 0}`,
        `  Skill tools: ${sourceCounts.skill ?? 0}`,
      ].join("\n");
      const replyExtensionResult = async (
        text: string,
        extras: Omit<import("../channels/webchat/protocol.js").ExtensionsCommandData, "kind" | "surface" | "subcommand"> = {},
      ) => {
        await cmdCtx.replyResult({
          text,
          viewKind: "extensions",
          data: {
            kind: "extensions",
            surface: "mcp",
            subcommand,
            ...extras,
          },
        });
      };
      const findServer = (name: string | undefined) =>
        configuredServers.find((server) => server.name === name);

      if (subcommand === "status") {
        await replyExtensionResult(renderStatus(), {
          status: {
            configuredServers: configuredServers.length,
            connectedServers: connectedServers.size,
            visibleTools: mcpCatalog.length,
            builtinTools: sourceCounts.builtin ?? 0,
            pluginTools: sourceCounts.plugin ?? 0,
            skillTools: sourceCounts.skill ?? 0,
          },
        });
        return;
      }
      if (subcommand === "list") {
        if (configuredServers.length === 0) {
          await replyExtensionResult(`${renderStatus()}\n\nNo MCP servers are configured.`);
          return;
        }
        const lines = configuredServers.map((server) => {
          const toolCount = getMcpCatalogEntries(mcpCatalog, server.name).length;
          const state =
            server.enabled === false
              ? "disabled"
              : server.container === "desktop"
                ? "container-routed"
                : connectedServers.has(server.name)
                  ? "connected"
                  : "disconnected";
          return (
            `  ${server.name} — ${state} — trust=${formatMcpTrustLine(server)} ` +
            `— tools=${toolCount}`
          );
        });
        await replyExtensionResult(`${renderStatus()}\n\nServers:\n${lines.join("\n")}`, {
          entries: configuredServers.map((server) => ({
            ...asRecord(server),
            visibleToolCount: getMcpCatalogEntries(mcpCatalog, server.name).length,
            connected: connectedServers.has(server.name),
          })),
        });
        return;
      }
      if (subcommand === "tools") {
        const serverName = cmdCtx.argv[1];
        const visibleCatalog =
          serverName && serverName.trim().length > 0
            ? getMcpCatalogEntries(mcpCatalog, serverName.trim())
            : mcpCatalog;
        if (visibleCatalog.length === 0) {
          await replyExtensionResult(`${renderStatus()}\n\nNo MCP tools are currently connected.`);
          return;
        }
        const lines = visibleCatalog
          .slice(0, 100)
          .map((entry) => `  ${entry.name} — ${entry.description}`);
        await replyExtensionResult(
          `${renderStatus()}\n\nTools${serverName ? ` (${serverName.trim()})` : ""}:\n${lines.join("\n")}`,
          {
            ...(serverName ? { target: serverName.trim() } : {}),
            entries: visibleCatalog
              .map((entry) => asRecord(entry))
              .filter((entry): entry is Record<string, unknown> => Boolean(entry)),
          },
        );
        return;
      }
      if (subcommand === "inspect") {
        const serverName = cmdCtx.argv[1]?.trim();
        const server = findServer(serverName);
        if (!serverName || !server) {
          await cmdCtx.reply("Usage: /mcp inspect <server>");
          return;
        }
        const serverCatalog = getMcpCatalogEntries(mcpCatalog, serverName);
        const allowList = server.riskControls?.toolAllowList?.join(", ") ?? "none";
        const denyList = server.riskControls?.toolDenyList?.join(", ") ?? "none";
        const lines = [
          `MCP server: ${server.name}`,
          `  Enabled: ${server.enabled === false ? "no" : "yes"}`,
          `  Runtime state: ${
            server.enabled === false
              ? "disabled"
              : server.container === "desktop"
                ? "container-routed"
                : connectedServers.has(server.name)
                  ? "connected"
                  : "disconnected"
          }`,
          `  Trust: ${formatMcpTrustLine(server)}`,
          `  Route: ${server.container === "desktop" ? "desktop container" : "host process"}`,
          `  Timeout: ${server.timeout ?? 30000}ms`,
          `  Tool allow-list: ${allowList}`,
          `  Tool deny-list: ${denyList}`,
          `  Supply chain: pinnedPackage=${
            server.supplyChain?.requirePinnedPackageVersion === true ? "yes" : "no"
          }, desktopDigest=${
            server.supplyChain?.requireDesktopImageDigest === true ? "yes" : "no"
          }, binarySha=${server.supplyChain?.binarySha256 ? "set" : "unset"}, catalogSha=${
            server.supplyChain?.catalogSha256 ? "set" : "unset"
          }`,
          `  Visible tools: ${serverCatalog.length}`,
        ];
        if (serverCatalog.length > 0) {
          lines.push(
            "",
            "Tools:",
            ...serverCatalog
              .slice(0, 25)
              .map((entry) => `  ${stripMcpToolPrefix(entry.name, server.name)} — ${entry.description}`),
          );
        }
        await replyExtensionResult(lines.join("\n"), {
          target: serverName,
          detail: {
            ...asRecord(server),
            visibleTools: serverCatalog
              .map((entry) => asRecord(entry))
              .filter((entry): entry is Record<string, unknown> => Boolean(entry)),
          },
        });
        return;
      }
      if (subcommand === "validate") {
        const serverName = cmdCtx.argv[1]?.trim();
        const targets =
          serverName && serverName.length > 0
            ? configuredServers.filter((server) => server.name === serverName)
            : configuredServers;
        if (targets.length === 0) {
          await cmdCtx.reply(
            serverName
              ? `MCP server "${serverName}" is not configured.`
              : "No MCP servers are configured.",
          );
          return;
        }
        const desktopImage = ctx.gateway?.config.desktop?.image ?? "agenc/desktop:latest";
        const sections: string[] = [];
        for (const server of targets) {
          const violations = [
            ...validateMCPServerStaticPolicy(server, { desktopImage }),
            ...(server.container
              ? []
              : await validateMCPServerBinaryIntegrity({ server })),
          ];
          const serverCatalog = getMcpCatalogEntries(mcpCatalog, server.name);
          const liveCatalogSha =
            serverCatalog.length > 0
              ? computeMCPToolCatalogSha256(
                  serverCatalog.map((entry) => ({
                    name: stripMcpToolPrefix(entry.name, server.name),
                    description: entry.description,
                    inputSchema: entry.inputSchema,
                  })),
                )
              : undefined;
          sections.push(
            [
              `MCP validate: ${server.name}`,
              `  Static policy: ${violations.length === 0 ? "ok" : "violations"}`,
              ...(violations.length > 0
                ? violations.map(
                    (violation) => `  - ${violation.code}: ${violation.message}`,
                  )
                : []),
              `  Trust: ${formatMcpTrustLine(server)}`,
              `  Runtime state: ${
                server.enabled === false
                  ? "disabled"
                  : server.container === "desktop"
                    ? "container-routed"
                    : connectedServers.has(server.name)
                      ? "connected"
                      : "disconnected"
              }`,
              `  Binary integrity: ${
                server.container
                  ? "n/a (container-routed)"
                  : server.supplyChain?.binarySha256
                    ? violations.some((item) => item.code === "binary_integrity_mismatch")
                      ? "mismatch"
                      : "ok"
                    : "not configured"
              }`,
              `  Catalog integrity: ${
                server.supplyChain?.catalogSha256
                  ? liveCatalogSha
                    ? liveCatalogSha === server.supplyChain.catalogSha256.trim().toLowerCase()
                      ? "ok"
                      : "mismatch"
                    : "not visible at runtime"
                  : "not configured"
              }`,
              ...(liveCatalogSha ? [`  Live catalog sha256: ${liveCatalogSha}`] : []),
            ].join("\n"),
          );
        }
        await replyExtensionResult(sections.join("\n\n"), {
          ...(serverName ? { target: serverName } : {}),
          entries: targets
            .map((server) => asRecord(server))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry)),
        });
        return;
      }
      if (subcommand === "reconnect") {
        const serverName = cmdCtx.argv[1]?.trim();
        const server = findServer(serverName);
        if (!serverName || !server) {
          await cmdCtx.reply("Usage: /mcp reconnect <server>");
          return;
        }
        if (server.container === "desktop") {
          await cmdCtx.reply(
            `MCP server "${server.name}" is desktop-container routed and cannot be reconnected from the daemon shell.`,
          );
          return;
        }
        if (!mcpManager) {
          await cmdCtx.reply("MCP manager is unavailable in this daemon.");
          return;
        }
        const result = await mcpManager.reconnectServer(server.name);
        await replyExtensionResult(
          result.success
            ? `MCP server "${server.name}" reconnected (${result.toolCount} tools).`
            : `MCP server "${server.name}" reconnect failed: ${result.error ?? "unknown error"}`,
          {
            target: server.name,
            detail: asRecord(result),
          },
        );
        return;
      }
      if (subcommand === "enable" || subcommand === "disable") {
        const serverName = cmdCtx.argv[1]?.trim();
        const server = findServer(serverName);
        if (!serverName || !server) {
          await cmdCtx.reply(`Usage: /mcp ${subcommand} <server>`);
          return;
        }
        const nextEnabled = subcommand === "enable";
        if ((server.enabled !== false) === nextEnabled) {
          await cmdCtx.reply(
            `MCP server "${server.name}" is already ${nextEnabled ? "enabled" : "disabled"}.`,
          );
          return;
        }
        try {
          const raw = await readFile(ctx.configPath, "utf-8");
          const parsed = JSON.parse(raw) as GatewayConfig;
          const servers = Array.isArray(parsed.mcp?.servers) ? parsed.mcp.servers : [];
          const index = servers.findIndex((entry) => entry.name === server.name);
          if (index < 0) {
            await cmdCtx.reply(`MCP server "${server.name}" is not present in ${ctx.configPath}.`);
            return;
          }
          servers[index] = {
            ...servers[index],
            enabled: nextEnabled,
          };
          parsed.mcp = { ...(parsed.mcp ?? {}), servers };
          await writeFile(ctx.configPath, JSON.stringify(parsed, null, 2) + "\n");
          await ctx.handleConfigReload();
          await replyExtensionResult(
            `MCP server "${server.name}" ${nextEnabled ? "enabled" : "disabled"} via config reload.`,
            {
              target: server.name,
              detail: {
                enabled: nextEnabled,
              },
            },
          );
        } catch (error) {
          await cmdCtx.reply(
            `Failed to ${subcommand} MCP server "${server.name}": ${toErrorMessage(error)}`,
          );
        }
        return;
      }
      await cmdCtx.reply(
        "Usage: /mcp [status|list|inspect <server>|tools [server]|validate [server]|reconnect <server>|enable <server>|disable <server>]",
      );
    },
  });
  commandRegistry.register({
    name: "delegation",
    description: "Show or set delegation aggressiveness",
    args: "[status|conservative|balanced|aggressive|adaptive|default]",
    global: true,
    handler: async (cmdCtx) => {
      const resolved = ctx.getSubAgentRuntimeConfig();
      if (!resolved?.enabled) {
        await cmdCtx.reply(
          "Delegation is disabled. Enable llm.subagents.enabled in config first.",
        );
        return;
      }

      const renderStatus = (): string => {
        const activeProfile =
          ctx.getActiveDelegationAggressiveness(resolved);
        const effectiveThreshold =
          ctx.resolveDelegationScoreThreshold(resolved);
        const override = ctx.getDelegationAggressivenessOverride();
        const hardBlocked =
          resolved.hardBlockedTaskClasses.length > 0
            ? resolved.hardBlockedTaskClasses.join(", ")
            : "none";
        return (
          `Delegation profile: ${activeProfile}` +
          `${override ? " (runtime override)" : " (config)"}\n` +
          `Threshold: effective=${effectiveThreshold.toFixed(3)} base=${resolved.baseSpawnDecisionThreshold.toFixed(3)}\n` +
          `Mode: ${resolved.mode} (handoff min confidence ${resolved.handoffMinPlannerConfidence.toFixed(2)})\n` +
          `Child provider strategy: ${resolved.childProviderStrategy}\n` +
          `Hard-blocked task classes: ${hardBlocked}`
        );
      };

      const arg = cmdCtx.argv[0]?.toLowerCase();
      if (!arg || arg === "status") {
        await cmdCtx.reply(renderStatus());
        return;
      }

      if (arg === "default" || arg === "clear" || arg === "reset") {
        ctx.setDelegationAggressivenessOverride(null);
        ctx.configureDelegationRuntimeServices(resolved);
        await cmdCtx.reply(
          `Delegation aggressiveness reset to config default.\n${renderStatus()}`,
        );
        return;
      }

      if (
        arg !== "conservative" &&
        arg !== "balanced" &&
        arg !== "aggressive" &&
        arg !== "adaptive"
      ) {
        await cmdCtx.reply(
          "Usage: /delegation [status|conservative|balanced|aggressive|adaptive|default]",
        );
        return;
      }

      ctx.setDelegationAggressivenessOverride(arg);
      ctx.configureDelegationRuntimeServices(resolved);
      await cmdCtx.reply(
        `Delegation aggressiveness set to ${arg}.\n${renderStatus()}`,
      );
    },
  });
  commandRegistry.register({
    name: "eval",
    description:
      "Evaluate model output or run tool harness in current session",
    args: "[prompt] | full [prompt] | script [args]",
    global: true,
    handler: async (cmdCtx) => {
      const mode = cmdCtx.argv[0]?.toLowerCase();
      const scriptHarness = mode === "script";
      const fullHarness =
        mode === "full" || mode === "tools" || scriptHarness;

      if (!fullHarness) {
        const provider = providers[0];
        if (!provider) {
          await cmdCtx.reply("No configured LLM provider available for /eval.");
          return;
        }

        const prompt =
          cmdCtx.args && cmdCtx.args.trim().length > 0
            ? cmdCtx.args.trim()
            : 'Respond with strict JSON only: {"ok":true,"test":"model-eval"}';

        const started = Date.now();
        const traceConfig = resolveTraceLoggingConfig(
          ctx.gateway?.config.logging,
        );
        const evalProviderTrace =
          traceConfig.enabled && traceConfig.includeProviderPayloads
            ? {
                trace: {
                  includeProviderPayloads: true as const,
                  onProviderTraceEvent: (event: LLMProviderTraceEvent) => {
                    logProviderPayloadTraceEvent({
                      logger: ctx.logger,
                      channelName: "webchat.eval",
                      traceConfig,
                      traceId: `eval:${cmdCtx.sessionId ?? "unknown"}:${started}`,
                      sessionId: cmdCtx.sessionId,
                      event,
                    });
                  },
                },
              }
            : undefined;
        try {
          const response = await provider.chat(
            [
              {
                role: "system",
                content:
                  "You are a model evaluation probe. Follow user formatting instructions exactly.",
              },
              { role: "user", content: prompt },
            ],
            evalProviderTrace,
          );
          const durationMs = Date.now() - started;
          if (response.finishReason === "error" || response.error) {
            await cmdCtx.reply(
              `Model eval failed (${provider.name}) in ${durationMs}ms: ` +
                `${response.error?.message ?? "unknown provider error"}`,
            );
            return;
          }

          await cmdCtx.reply(
            `Model eval (${provider.name}) completed in ${durationMs}ms.\n` +
              `Model: ${response.model}\n` +
              `Finish: ${response.finishReason}\n` +
              `Usage: prompt=${response.usage.promptTokens}, completion=${response.usage.completionTokens}, total=${response.usage.totalTokens}\n` +
              `Response:\n${truncateToolLogText(response.content, EVAL_REPLY_MAX_CHARS)}\n` +
              `Mode: model-only (no tools). Use /eval full to run tools in this chat session.`,
          );
        } catch (err) {
          await cmdCtx.reply(
            `Model eval error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      if (!scriptHarness) {
        const inboundHandler = ctx.getWebChatInboundHandler();
        if (!inboundHandler) {
          await cmdCtx.reply(
            "Full eval unavailable: webchat pipeline is not initialized.",
          );
          return;
        }

        const desktopHandle = ctx.getDesktopHandleBySession(
          cmdCtx.sessionId,
        );
        const customPrompt = cmdCtx.args.replace(/^(full|tools)\s*/i, "").trim();
        const defaultPrompt = desktopHandle
          ? [
              "You are running /eval full inside a desktop-assigned chat session.",
              "Use desktop tools only for execution.",
              "Do not use system.bash or other system.* tools.",
              "Steps:",
              "1) Use desktop.bash to create /tmp/agenc-eval/index.html containing exactly: <h1>agent-ok</h1>.",
              '2) Use desktop.bash to start a local HTTP server on 127.0.0.1 with a free port, and write /tmp/agenc-eval/state.txt with "port=<port> pid=<pid>".',
              "3) Use desktop.bash to curl the server and verify response includes agent-ok.",
              "4) Use desktop.bash to stop the exact pid and verify the port is closed.",
              'Return strict JSON: {"overall":"pass|fail","steps":[{"name":"...","status":"pass|fail","evidence":"..."}]}',
            ].join("\n")
          : [
              "You are running /eval full in a host-tools session (no desktop assigned).",
              "Use system.bash for all execution steps.",
              "Steps:",
              "1) Create /tmp/agenc-eval/index.html containing exactly: <h1>agent-ok</h1>.",
              '2) Start a local HTTP server on 127.0.0.1 with a free port, and write /tmp/agenc-eval/state.txt with "port=<port> pid=<pid>".',
              "3) curl the server and verify response includes agent-ok.",
              "4) Stop the exact pid and verify the port is closed.",
              'Return strict JSON: {"overall":"pass|fail","steps":[{"name":"...","status":"pass|fail","evidence":"..."}]}',
            ].join("\n");

        const evalPrompt =
          customPrompt.length > 0 ? customPrompt : defaultPrompt;
        const evalMessage = createGatewayMessage({
          channel: "webchat",
          senderId: cmdCtx.senderId,
          senderName: `WebClient(${cmdCtx.senderId})`,
          sessionId: cmdCtx.sessionId,
          content: evalPrompt,
          scope: "dm",
          metadata: {
            source: "slash-eval",
            mode: "full",
            target: desktopHandle ? "desktop" : "host",
            desktopContainerId: desktopHandle?.containerId,
          },
        });

        await cmdCtx.reply(
          desktopHandle
            ? `Starting full eval in this chat session on assigned desktop ${desktopHandle.containerId}. Live tool events will stream below.`
            : "Starting full eval in this chat session using host tools (no desktop assigned). Live tool events will stream below.",
        );
        void inboundHandler(evalMessage).catch((error) => {
          void cmdCtx.reply(
            `Full eval failed to start: ${toErrorMessage(error)}`,
          );
        });
        return;
      }

      const harnessArgs = cmdCtx.argv.slice(1);
      const { scriptPath, candidateList } = await resolveEvalScriptForReply();
      if (!scriptPath) {
        await cmdCtx.reply(
          `Could not find ${EVAL_SCRIPT_NAME}. ` +
            `Checked these locations:\n${candidateList}\n` +
            "Use `/eval` for model testing or `/eval full` for in-session tool evaluation.",
        );
        return;
      }

      await cmdCtx.reply(
        `Running ${EVAL_SCRIPT_NAME} (live tool trace enabled)...`,
      );
      let streamedLines = 0;
      let droppedLines = 0;
      const maxStreamedLines = 60;
      const shouldStreamEvalLine = (line: string): boolean =>
        line.startsWith("[TEST]") ||
        line.startsWith("[TOOL]") ||
        line.includes("AGENT RESPONSE") ||
        line.startsWith("Overall:");

      const result = await runEvalScript(
        scriptPath,
        harnessArgs,
        (progress) => {
          const line = progress.line.trim();
          if (!shouldStreamEvalLine(line)) return;

          if (streamedLines >= maxStreamedLines) {
            droppedLines += 1;
            return;
          }
          streamedLines += 1;
          const prefix =
            progress.stream === "stderr" ? "[eval stderr]" : "[eval]";
          void cmdCtx.reply(`${prefix} ${truncateToolLogText(line, 500)}`);
        },
      );
      if (droppedLines > 0) {
        await cmdCtx.reply(
          `[eval] Suppressed ${droppedLines} additional progress line(s).`,
        );
      }
      if (result.exitCode === 0 && !didEvalScriptPass(result)) {
        await cmdCtx.reply(
          formatEvalScriptReply({
            ...result,
            exitCode: 1,
            stderr: result.stderr
              ? `${result.stderr}\nEval output did not report Overall: pass.`
              : "Eval output did not report Overall: pass.",
          }),
        );
        return;
      }
      await cmdCtx.reply(formatEvalScriptReply(result));
    },
  });
  commandRegistry.register({
    name: "skills",
    description: "Inspect and toggle local discovered skills",
    args: "[list|inspect <name>|enable <name>|disable <name>|sources]",
    global: true,
    metadata: {
      category: "extensions",
      clients: ["shell", "console", "web"],
      rolloutFeature: "shellExtensions",
      viewKind: "extensions",
    },
    handler: async (cmdCtx) => {
      if (
        !(await requireShellFeature({
          cmdCtx,
          feature: "shellExtensions",
          domain: "extensions",
          label: "Skills command",
        }))
      ) {
        return;
      }
      const subcommand = cmdCtx.argv[0]?.toLowerCase() ?? "list";
      const discovered = await ctx.discoverShellSkills({
        sessionId: cmdCtx.sessionId,
      });
      const resolveState = (entry: DiscoveredSkill) => {
        const disabled = getSkillDisabledMarker(entry.skill.sourcePath);
        return {
          disabled,
          state: formatSkillState({
            available: entry.available,
            disabled,
          }),
        };
      };
      const resolveByName = (name: string | undefined) =>
        discovered.find((entry) => entry.skill.name === name);
      const replyExtensionResult = async (
        text: string,
        extras: Omit<import("../channels/webchat/protocol.js").ExtensionsCommandData, "kind" | "surface" | "subcommand"> = {},
      ) => {
        await cmdCtx.replyResult({
          text,
          viewKind: "extensions",
          data: {
            kind: "extensions",
            surface: "skills",
            subcommand,
            ...extras,
          },
        });
      };

      if (subcommand === "list") {
        if (discovered.length === 0) {
          await replyExtensionResult(
            "No local skills discovered.\nMarketplace listings remain under `agenc market skills ...`.",
          );
          return;
        }
        const lines = discovered.map((entry) => {
          const { state } = resolveState(entry);
          return (
            `  ${entry.skill.name} — ${entry.skill.description} ` +
            `(${entry.tier}, ${state})`
          );
        });
        await replyExtensionResult(
          "Local skills:\n" +
            lines.join("\n") +
            "\n\nMarketplace listings: use `agenc market skills ...`.",
          {
            entries: discovered
              .map((entry) =>
                asRecord({
                  ...entry,
                  ...resolveState(entry),
                }),
              )
              .filter((entry): entry is Record<string, unknown> => Boolean(entry)),
          },
        );
        return;
      }

      if (subcommand === "inspect") {
        const skillName = cmdCtx.argv[1]?.trim();
        const skill = resolveByName(skillName);
        if (!skillName || !skill) {
          await cmdCtx.reply("Usage: /skills inspect <name>");
          return;
        }
        const { disabled, state } = resolveState(skill);
        const lines = [
          `Skill: ${skill.skill.name}`,
          `  State: ${state}`,
          `  Tier: ${skill.tier}`,
          `  Description: ${skill.skill.description}`,
          `  Source: ${skill.skill.sourcePath ?? "inline/unknown"}`,
          `  Tags: ${
            skill.skill.metadata.tags.length > 0
              ? skill.skill.metadata.tags.join(", ")
              : "none"
          }`,
          `  Primary env: ${skill.skill.metadata.primaryEnv ?? "none"}`,
          `  Disabled marker: ${disabled ? "present" : "absent"}`,
          `  Availability: ${skill.available ? "usable" : "blocked"}`,
          ...(skill.missingRequirements && skill.missingRequirements.length > 0
            ? [
                "  Missing requirements:",
                ...skill.missingRequirements.map(
                  (item) => `    - ${item.message}`,
                ),
              ]
            : []),
        ];
        const preview =
          skill.skill.body.length > 240
            ? `${skill.skill.body.slice(0, 240)}...`
            : skill.skill.body;
        if (preview.trim().length > 0) {
          lines.push("", "Preview:", preview);
        }
        await replyExtensionResult(lines.join("\n"), {
          target: skillName,
          detail: asRecord({
            ...skill,
            ...resolveState(skill),
          }),
        });
        return;
      }

      if (subcommand === "sources") {
        const sources = await ctx.resolveShellSkillDiscoveryPaths({
          sessionId: cmdCtx.sessionId,
        });
        await replyExtensionResult(
          [
            "Skill discovery sources:",
            `  Agent: ${sources.agentSkills ?? "not configured"}`,
            `  Project: ${sources.projectSkills ?? "not configured"}`,
            `  User: ${sources.userSkills ?? "not configured"}`,
            `  Builtin: ${sources.builtinSkills ?? "not configured"}`,
            "",
            "Marketplace listings: use `agenc market skills ...`.",
          ].join("\n"),
          {
            detail: asRecord(sources),
          },
        );
        return;
      }

      if (subcommand === "enable" || subcommand === "disable") {
        const skillName = cmdCtx.argv[1]?.trim();
        const skill = resolveByName(skillName);
        if (!skillName || !skill) {
          await cmdCtx.reply(`Usage: /skills ${subcommand} <name>`);
          return;
        }
        const sourcePath = skill.skill.sourcePath;
        if (!sourcePath) {
          await cmdCtx.reply(
            `Skill "${skill.skill.name}" has no source path and cannot be toggled.`,
          );
          return;
        }
        const markerPath = `${sourcePath}.disabled`;
        try {
          if (subcommand === "enable") {
            if (existsSync(markerPath)) {
              await unlink(markerPath);
            }
          } else if (!existsSync(markerPath)) {
            await writeFile(markerPath, "", "utf8");
          }
          await replyExtensionResult(
            `Skill "${skill.skill.name}" ${subcommand}d.\n` +
              "Marketplace listings remain separate under `agenc market skills ...`.",
            {
              target: skill.skill.name,
              detail: {
                disabled: subcommand !== "enable",
              },
            },
          );
        } catch (error) {
          await cmdCtx.reply(
            `Failed to ${subcommand} skill "${skill.skill.name}": ${toErrorMessage(error)}`,
          );
        }
        return;
      }

      await cmdCtx.reply(
        "Usage: /skills [list|inspect <name>|enable <name>|disable <name>|sources]",
      );
    },
  });
  commandRegistry.register({
    name: "plugin",
    description: "Inspect and toggle the local plugin catalog",
    args: "[list|inspect <pluginId>|enable <pluginId>|disable <pluginId>|reload <pluginId>]",
    global: true,
    metadata: {
      category: "extensions",
      clients: ["shell", "console", "web"],
      rolloutFeature: "shellExtensions",
      viewKind: "extensions",
    },
    handler: async (cmdCtx) => {
      if (
        !(await requireShellFeature({
          cmdCtx,
          feature: "shellExtensions",
          domain: "extensions",
          label: "Plugin command",
        }))
      ) {
        return;
      }
      const subcommand = cmdCtx.argv[0]?.toLowerCase() ?? "list";
      const catalog = ctx.getPluginCatalog();
      const replyExtensionResult = async (
        text: string,
        extras: Omit<import("../channels/webchat/protocol.js").ExtensionsCommandData, "kind" | "surface" | "subcommand"> = {},
      ) => {
        await cmdCtx.replyResult({
          text,
          viewKind: "extensions",
          data: {
            kind: "extensions",
            surface: "plugin",
            subcommand,
            ...extras,
          },
        });
      };

      if (subcommand === "list") {
        const entries = catalog.list();
        if (entries.length === 0) {
          await replyExtensionResult("No plugins are registered in the local catalog.");
          return;
        }
        const lines = entries.map(
          (entry) =>
            `  ${entry.manifest.id} — ${entry.enabled ? "enabled" : "disabled"} ` +
            `(${entry.precedence}${entry.slot ? `, slot=${entry.slot}` : ""})`,
        );
        await replyExtensionResult("Plugin catalog:\n" + lines.join("\n"), {
          entries: entries
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry)),
        });
        return;
      }

      const pluginId = cmdCtx.argv[1]?.trim();
      const entry = catalog.list().find((item) => item.manifest.id === pluginId);

      if (subcommand === "inspect") {
        if (!pluginId || !entry) {
          await cmdCtx.reply("Usage: /plugin inspect <pluginId>");
          return;
        }
        const permissions =
          entry.manifest.permissions.length > 0
            ? entry.manifest.permissions.map(
                (permission) =>
                  `  - ${permission.type}:${permission.scope} (${permission.required ? "required" : "optional"})`,
              )
            : ["  - none"];
        const allowList =
          entry.manifest.allowDeny?.allow?.length
            ? entry.manifest.allowDeny.allow.join(", ")
            : "all";
        const denyList =
          entry.manifest.allowDeny?.deny?.length
            ? entry.manifest.allowDeny.deny.join(", ")
            : "none";
        await replyExtensionResult(
          [
            `Plugin: ${entry.manifest.id}`,
            `  Display name: ${entry.manifest.displayName}`,
            `  State: ${entry.enabled ? "enabled" : "disabled"}`,
            `  Version: ${entry.manifest.version}`,
            `  Schema version: ${entry.manifest.schemaVersion}`,
            `  Precedence: ${entry.precedence}`,
            `  Slot: ${entry.slot ?? "none"}`,
            `  Source path: ${entry.sourcePath ?? "unknown"}`,
            `  Labels: ${entry.manifest.labels.join(", ") || "none"}`,
            `  Description: ${entry.manifest.description ?? "none"}`,
            `  Allow: ${allowList}`,
            `  Deny: ${denyList}`,
            "Permissions:",
            ...permissions,
          ].join("\n"),
          {
            target: pluginId,
            detail: asRecord(entry),
          },
        );
        return;
      }

      if (subcommand === "enable" || subcommand === "disable" || subcommand === "reload") {
        if (!pluginId || !entry) {
          await cmdCtx.reply(`Usage: /plugin ${subcommand} <pluginId>`);
          return;
        }
        const result =
          subcommand === "enable"
            ? catalog.enable(pluginId)
            : subcommand === "disable"
              ? catalog.disable(pluginId)
              : catalog.reload(pluginId);
        await replyExtensionResult(
          [
            result.message,
            renderPluginMutationNote(),
          ].join("\n"),
          {
            target: pluginId,
            detail: asRecord(result),
          },
        );
        return;
      }

      await cmdCtx.reply(
        "Usage: /plugin [list|inspect <pluginId>|enable <pluginId>|disable <pluginId>|reload <pluginId>]",
      );
    },
  });
  commandRegistry.register({
    name: "model",
    description: "Show or switch the current LLM model",
    args: "[model-name | current | list]",
    global: true,
    metadata: {
      category: "runtime",
      clients: ["shell", "console", "web"],
      viewKind: "runtime",
    },
    handler: async (cmdCtx) => {
      const sessionId = cmdCtx.sessionId;
      const last = ctx.getSessionModelInfo(sessionId);
      const arg = cmdCtx.args.trim();
      const argLower = arg.toLowerCase();
      const configuredPrimaryProvider = ctx.gateway?.config.llm?.provider ?? "none";
      const configuredPrimaryRoute = normalizeModelRouteSnapshot({
        provider: configuredPrimaryProvider,
        configuredModel:
          ctx.gateway?.config.llm?.model ??
          (configuredPrimaryProvider === "grok"
            ? DEFAULT_GROK_MODEL
            : "unknown"),
        resolvedModel:
          configuredPrimaryProvider === "grok"
            ? normalizeGrokModel(ctx.gateway?.config.llm?.model) ??
              DEFAULT_GROK_MODEL
            : ctx.gateway?.config.llm?.model ?? "unknown",
      });
      const configuredPrimaryModel =
        formatModelRouteModelLabel(configuredPrimaryRoute);
      const configuredFallbacks =
        ctx.gateway?.config.llm?.fallback?.map((entry) => (
          `${entry.provider}:${
            entry.provider === "grok"
              ? normalizeGrokModel(entry.model) ?? DEFAULT_GROK_MODEL
              : entry.model ?? "unknown"
          }`
        )) ?? [];

      const knownGrokModels = listKnownGrokModels();
      const chatModels = knownGrokModels.filter((entry) => !entry.modality);

      // /model (no args) or /model current — show current routing
      if (!arg || argLower === "current") {
        const lines = [
          "Model routing:",
          last
            ? `  Last completion: ${formatModelRouteModelLabel(last)} (provider: ${last.provider}${last.usedFallback ? ", fallback used" : ""})`
            : "  Last completion: none recorded for this session",
          `  Primary: ${configuredPrimaryProvider}:${configuredPrimaryModel}`,
          `  Fallbacks: ${configuredFallbacks.length > 0 ? configuredFallbacks.join(", ") : "none"}`,
          "",
          `Available chat models: ${chatModels.map((m) => m.id).join(", ")}`,
          "",
          "Switch with: /model <model-name>",
        ];
        await replyRuntimeResult(cmdCtx, "model", lines.join("\n"), {
          status: "active",
          metrics: [
            {
              label: "Last Completion",
              value: last
                ? `${last.provider}:${formatModelRouteModelLabel(last)}${last.usedFallback ? " (fallback)" : ""}`
                : "none recorded",
            },
            {
              label: "Primary",
              value: `${configuredPrimaryProvider}:${configuredPrimaryModel}`,
            },
            {
              label: "Fallbacks",
              value: configuredFallbacks.length > 0 ? configuredFallbacks.join(", ") : "none",
            },
          ],
          sections: [
            { title: "Available Chat Models", items: chatModels.map((entry) => entry.id) },
          ],
          detail: {
            last,
            primary: { provider: configuredPrimaryProvider, model: configuredPrimaryModel },
            fallbacks: configuredFallbacks,
          },
        });
        return;
      }

      // /model list — show full catalog
      if (argLower === "list") {
        const lines = ["Known xAI models:"];
        for (const entry of knownGrokModels) {
          if (entry.modality) {
            lines.push(`  ${entry.id} [${entry.modality}]`);
          } else {
            const active = entry.id === configuredPrimaryModel ? " (active)" : "";
            lines.push(
              `  ${entry.id} (${entry.contextWindowTokens.toLocaleString("en-US")} ctx)${active}` +
                (entry.aliases.length > 0 ? ` aliases: ${entry.aliases.join(", ")}` : ""),
            );
          }
        }
        await replyRuntimeResult(cmdCtx, "model", lines.join("\n"), {
          status: "catalog",
          sections: [
            {
              title: "Known xAI Models",
              items: knownGrokModels.map((entry) =>
                entry.modality
                  ? `${entry.id} [${entry.modality}]`
                  : `${entry.id}${entry.id === configuredPrimaryModel ? " (active)" : ""}`,
              ),
            },
          ],
          detail: {
            configuredPrimaryModel,
            models: knownGrokModels,
          },
        });
        return;
      }

      // /model <name> — switch model
      if (configuredPrimaryProvider !== "grok") {
        await cmdCtx.reply(
          `Model switching is only supported for the grok provider (current: ${configuredPrimaryProvider}).`,
        );
        return;
      }

      const normalized = normalizeGrokModel(arg) ?? arg;
      const normalizedLower = normalized.toLowerCase();
      let match =
        chatModels.find((m) => m.id.toLowerCase() === argLower) ??
        chatModels.find((m) => m.id.toLowerCase() === normalizedLower);
      if (!match) {
        const argTokens = argLower.split(/[\s_]+/).filter(Boolean);
        const matchesModelQuery = (value: string): boolean =>
          value.includes(argLower) ||
          (argTokens.length > 1 && argTokens.every((token) => value.includes(token)));
        // Try fuzzy: check if any model contains the input
        const fuzzy = chatModels.filter((m) =>
          matchesModelQuery(m.id.toLowerCase()) ||
          m.aliases.some((a) => matchesModelQuery(a.toLowerCase())),
        );
        if (fuzzy.length === 1) {
          match = fuzzy[0];
        } else if (fuzzy.length > 1) {
          await cmdCtx.reply(
            `Multiple models match "${arg}":\n${fuzzy.map((m) => `  ${m.id}`).join("\n")}\n\nBe more specific.`,
          );
          return;
        } else {
          await cmdCtx.reply(
            `Unknown model "${arg}". Available chat models:\n${chatModels.map((m) => `  ${m.id}`).join("\n")}`,
          );
          return;
        }
      }

      if (match.id === configuredPrimaryModel) {
        await replyRuntimeResult(cmdCtx, "model", `Already using ${match.id}.`, {
          status: "active",
          metrics: [{ label: "Current", value: match.id }],
          detail: { model: match.id, unchanged: true },
        });
        return;
      }

      // Write updated model to config file and explicitly trigger reload
      try {
        const raw = await readFile(ctx.configPath, "utf-8");
        const config = JSON.parse(raw) as Record<string, unknown>;
        const llm = (config.llm ?? {}) as Record<string, unknown>;
        llm.model = match.id;
        config.llm = llm;
        await writeFile(ctx.configPath, JSON.stringify(config, null, 2) + "\n");
        ctx.logger.info(`Model switched to ${match.id} via /model command`);
        // Trigger config reload explicitly — filesystem watchers can be unreliable
        await ctx.handleConfigReload();
        await replyRuntimeResult(
          cmdCtx,
          "model",
          `Model switched: ${configuredPrimaryModel} → ${match.id} (${match.contextWindowTokens.toLocaleString("en-US")} ctx)`,
          {
            status: "updated",
            metrics: [
              { label: "Previous", value: configuredPrimaryModel },
              { label: "Current", value: match.id },
            ],
            detail: {
              previous: configuredPrimaryModel,
              current: match.id,
              contextWindowTokens: match.contextWindowTokens,
            },
          },
        );
      } catch (err) {
        ctx.logger.error("Failed to update model config", { error: toErrorMessage(err) });
        await cmdCtx.reply(`Failed to switch model: ${toErrorMessage(err)}`);
      }
    },
  });
  commandRegistry.register({
    name: "effort",
    description: "Show or switch the configured reasoning effort",
    args: "[current|list|low|medium|high|xhigh]",
    global: true,
    metadata: {
      category: "runtime",
      clients: ["shell", "console", "web"],
      viewKind: "runtime",
    },
    handler: async (cmdCtx) => {
      const arg = cmdCtx.args.trim().toLowerCase();
      const configuredEffort =
        ctx.gateway?.config.llm?.reasoningEffort ?? "medium";

      if (!arg || arg === "current" || arg === "status") {
        await replyRuntimeResult(
          cmdCtx,
          "effort",
          [
            "Reasoning effort:",
            `  Current: ${configuredEffort}`,
            `  Available: ${REASONING_EFFORTS.join(", ")}`,
            "",
            "Switch with: /effort <low|medium|high|xhigh>",
          ].join("\n"),
          {
            status: "active",
            metrics: [{ label: "Current", value: configuredEffort }],
            sections: [{ title: "Available", items: [...REASONING_EFFORTS] }],
            detail: { current: configuredEffort, available: REASONING_EFFORTS },
          },
        );
        return;
      }

      if (arg === "list") {
        await replyRuntimeResult(
          cmdCtx,
          "effort",
          `Reasoning efforts:\n${REASONING_EFFORTS.map((effort) => `  ${effort}${effort === configuredEffort ? " (active)" : ""}`).join("\n")}`,
          {
            status: "catalog",
            sections: [
              {
                title: "Reasoning Efforts",
                items: REASONING_EFFORTS.map((effort) =>
                  effort === configuredEffort ? `${effort} (active)` : effort,
                ),
              },
            ],
            detail: { current: configuredEffort, available: REASONING_EFFORTS },
          },
        );
        return;
      }

      if (!REASONING_EFFORTS.includes(arg as (typeof REASONING_EFFORTS)[number])) {
        await cmdCtx.reply(
          "Usage: /effort [current|list|low|medium|high|xhigh]",
        );
        return;
      }

      if (arg === configuredEffort) {
        await replyRuntimeResult(
          cmdCtx,
          "effort",
          `Already using reasoning effort "${arg}".`,
          {
            status: "active",
            metrics: [{ label: "Current", value: arg }],
            detail: { current: arg, unchanged: true },
          },
        );
        return;
      }

      try {
        const raw = await readFile(ctx.configPath, "utf-8");
        const config = JSON.parse(raw) as Record<string, unknown>;
        const llm = (config.llm ?? {}) as Record<string, unknown>;
        llm.reasoningEffort = arg;
        config.llm = llm;
        await writeFile(ctx.configPath, JSON.stringify(config, null, 2) + "\n");
        ctx.logger.info(`Reasoning effort switched to ${arg} via /effort command`);
        await ctx.handleConfigReload();
        await replyRuntimeResult(
          cmdCtx,
          "effort",
          `Reasoning effort switched: ${configuredEffort} → ${arg}`,
          {
            status: "updated",
            metrics: [
              { label: "Previous", value: configuredEffort },
              { label: "Current", value: arg },
            ],
            detail: { previous: configuredEffort, current: arg },
          },
        );
      } catch (error) {
        ctx.logger.error("Failed to update reasoning effort config", {
          error: toErrorMessage(error),
        });
        await cmdCtx.reply(
          `Failed to switch reasoning effort: ${toErrorMessage(error)}`,
        );
      }
    },
  });

  // Voice command
  const XAI_VOICES = ["Ara", "Rex", "Sal", "Eve", "Leo"] as const;
  commandRegistry.register({
    name: "voice",
    description: "Show voice config or change voice persona",
    args: "[Ara|Rex|Sal|Eve|Leo|status|enable|disable]",
    global: true,
    metadata: {
      category: "runtime",
      clients: ["shell", "console", "web"],
      viewKind: "runtime",
    },
    handler: async (cmdCtx) => {
      const arg = cmdCtx.args.trim();
      const voiceConfig = ctx.gateway?.config.voice;
      const bridge = ctx.getVoiceBridge();

      // /voice status — show active sessions
      if (arg.toLowerCase() === "status") {
        const count = bridge?.activeSessionCount ?? 0;
        const lines = [
          `Voice sessions: ${count} active`,
          `Enabled: ${voiceConfig?.enabled !== false && bridge ? "yes" : "no"}`,
          `Voice: ${voiceConfig?.voice ?? "Ara"} (default)`,
          `Mode: ${voiceConfig?.mode ?? "vad"}`,
          `Model: ${voiceConfig?.model ?? DEFAULT_GROK_MODEL}`,
          `VAD threshold: ${voiceConfig?.vadThreshold ?? 0.5}`,
          `VAD silence: ${voiceConfig?.vadSilenceDurationMs ?? 800}ms`,
        ];
        await replyRuntimeResult(cmdCtx, "voice", lines.join("\n"), {
          status: count > 0 ? "active" : "idle",
          metrics: [
            { label: "Sessions", value: `${count}` },
            { label: "Enabled", value: voiceConfig?.enabled !== false && bridge ? "yes" : "no" },
            { label: "Voice", value: voiceConfig?.voice ?? "Ara" },
          ],
          sections: [
            {
              title: "Voice Runtime",
              items: [
                `Mode: ${voiceConfig?.mode ?? "vad"}`,
                `Model: ${voiceConfig?.model ?? DEFAULT_GROK_MODEL}`,
                `VAD threshold: ${voiceConfig?.vadThreshold ?? 0.5}`,
                `VAD silence: ${voiceConfig?.vadSilenceDurationMs ?? 800}ms`,
              ],
            },
          ],
          detail: {
            activeSessionCount: count,
            enabled: voiceConfig?.enabled !== false && bridge ? "yes" : "no",
            voice: voiceConfig?.voice ?? "Ara",
            mode: voiceConfig?.mode ?? "vad",
            model: voiceConfig?.model ?? DEFAULT_GROK_MODEL,
          },
        });
        return;
      }

      // /voice enable / disable
      if (arg.toLowerCase() === "enable" || arg.toLowerCase() === "disable") {
        const enable = arg.toLowerCase() === "enable";
        if (ctx.gateway?.config.voice) {
          ctx.gateway.config.voice.enabled = enable;
        }
        await replyRuntimeResult(cmdCtx, "voice", `Voice ${enable ? "enabled" : "disabled"}.`, {
          status: enable ? "updated" : "idle",
          metrics: [{ label: "Enabled", value: enable ? "yes" : "no" }],
          detail: { enabled: enable },
        });
        return;
      }

      // /voice <VoiceName> — change voice persona
      const matchedVoice = XAI_VOICES.find(
        (v) => v.toLowerCase() === arg.toLowerCase(),
      );
      if (matchedVoice) {
        if (ctx.gateway?.config.voice) {
          ctx.gateway.config.voice.voice = matchedVoice;
        } else if (ctx.gateway?.config) {
          (ctx.gateway.config as any).voice = { voice: matchedVoice };
        }
        await replyRuntimeResult(
          cmdCtx,
          "voice",
          `Voice set to ${matchedVoice}. New voice sessions will use this persona.`,
          {
            status: "updated",
            metrics: [{ label: "Voice", value: matchedVoice }],
            detail: { voice: matchedVoice },
          },
        );
        return;
      }

      // /voice (no args) — show config + available voices
      const currentVoice = voiceConfig?.voice ?? "Ara";
      const lines = [
        `Voice: ${bridge ? "available" : "not configured"}`,
        `Current persona: ${currentVoice}`,
        `Mode: ${voiceConfig?.mode ?? "vad"}`,
        `Sessions: ${bridge?.activeSessionCount ?? 0} active`,
        "",
        "Available voices:",
      ];
      for (const v of XAI_VOICES) {
        lines.push(`  ${v === currentVoice ? "●" : "○"} ${v}`);
      }
      lines.push(
        "",
        "Usage: /voice <name> to switch, /voice status for details",
      );
      await cmdCtx.reply(lines.join("\n"));
    },
  });

  // Progress tracker command
  if (progressTracker) {
    commandRegistry.register({
      name: "progress",
      description: "Show recent task progress",
      global: true,
      handler: async (cmdCtx) => {
        const sessionId = cmdCtx.sessionId;
        const summary = await progressTracker.getSummary(sessionId);
        await cmdCtx.reply(summary || "No progress entries yet.");
      },
    });
  }

  // Pipeline commands
  if (pipelineExecutor) {
    commandRegistry.register({
      name: "pipeline",
      description: "Run a pipeline from JSON steps",
      args: "<json>",
      global: true,
      handler: async (cmdCtx) => {
        if (!cmdCtx.args) {
          await cmdCtx.reply(
            'Usage: /pipeline [{"name":"step1","tool":"system.bash","args":{"command":"ls"}}]',
          );
          return;
        }
        try {
          const steps: PipelineStep[] = JSON.parse(cmdCtx.args);
          if (!Array.isArray(steps) || steps.length === 0) {
            await cmdCtx.reply("Pipeline steps must be a non-empty JSON array.");
            return;
          }
          const pipeline: Pipeline = {
            id: `pipeline-${Date.now()}`,
            steps,
            context: { results: {} },
            createdAt: Date.now(),
          };
          await cmdCtx.reply(
            `Starting pipeline "${pipeline.id}" with ${steps.length} step(s)...`,
          );
          const result = await pipelineExecutor.execute(pipeline);
          if (result.status === "completed") {
            await cmdCtx.reply(
              `Pipeline completed (${result.completedSteps}/${result.totalSteps} steps).`,
            );
          } else if (result.status === "halted") {
            await cmdCtx.reply(
              `Pipeline halted at step ${result.resumeFrom}/${result.totalSteps}. ` +
                `Use /resume ${pipeline.id} to continue.`,
            );
          } else {
            await cmdCtx.reply(
              `Pipeline failed: ${result.error ?? "unknown error"}`,
            );
          }
        } catch (err) {
          await cmdCtx.reply(
            `Invalid pipeline JSON: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    });
    commandRegistry.register({
      name: "resume",
      description: "Resume a halted pipeline",
      args: "[pipeline-id]",
      global: true,
      handler: async (cmdCtx) => {
        if (!cmdCtx.args) {
          const active = await pipelineExecutor.listActive();
          if (active.length === 0) {
            await cmdCtx.reply("No active pipelines.");
            return;
          }
          const lines = active.map(
            (cp) =>
              `  ${cp.pipelineId} — step ${cp.stepIndex}/${cp.pipeline.steps.length} (${cp.status})`,
          );
          await cmdCtx.reply("Active pipelines:\n" + lines.join("\n"));
          return;
        }
        try {
          const result = await pipelineExecutor.resume(cmdCtx.args.trim());
          if (result.status === "completed") {
            await cmdCtx.reply(
              `Pipeline resumed and completed (${result.completedSteps}/${result.totalSteps} steps).`,
            );
          } else if (result.status === "halted") {
            await cmdCtx.reply(
              `Pipeline halted again at step ${result.resumeFrom}/${result.totalSteps}.`,
            );
          } else {
            await cmdCtx.reply(
              `Pipeline resume failed: ${result.error ?? "unknown error"}`,
            );
          }
        } catch (err) {
          await cmdCtx.reply(
            `Resume failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    });
  }

  // Desktop sandbox commands (only when desktop is enabled)
  const desktopMgr = ctx.getDesktopManager();
  if (desktopMgr) {
    commandRegistry.register({
      name: "desktop",
      description:
        "Manage desktop sandbox (start|stop|status|vnc|list|attach)",
      args: "<subcommand>",
      global: true,
      handler: async (cmdCtx) => {
        const sub = cmdCtx.argv[0]?.toLowerCase();
        const sessionId = cmdCtx.sessionId;
        const listOrderedSandboxes = () =>
          desktopMgr
            .listAll()
            .slice()
            .sort((a, b) => a.createdAt - b.createdAt);
        const listActiveSandboxes = () =>
          listOrderedSandboxes().filter(
            (entry) =>
              entry.status !== "stopped" && entry.status !== "failed",
          );
        const desktopLabel = (index: number) => `desktop-${index + 1}`;
        const findDesktopLabel = (
          containerId: string,
        ): string | undefined => {
          const index = listOrderedSandboxes().findIndex(
            (entry) => entry.containerId === containerId,
          );
          return index >= 0 ? desktopLabel(index) : undefined;
        };
        const resolveAttachTarget = (
          rawTarget: string | undefined,
        ): { containerId?: string; label?: string; error?: string } => {
          const running = listActiveSandboxes();
          if (running.length === 0) {
            return {
              error: "No active desktop sandboxes. Use /desktop start first.",
            };
          }

          const target = rawTarget?.trim();
          if (!target) {
            if (running.length === 1) {
              return {
                containerId: running[0].containerId,
                label: findDesktopLabel(running[0].containerId),
              };
            }
            return {
              error:
                "Usage: /desktop attach <number|name|containerId>\nTip: run /desktop list first.",
            };
          }

          if (/^\d+$/.test(target)) {
            const index = Number.parseInt(target, 10) - 1;
            if (index >= 0 && index < running.length) {
              return {
                containerId: running[index].containerId,
                label: findDesktopLabel(running[index].containerId),
              };
            }
            return {
              error: `Desktop index out of range: ${target}. Run /desktop list first.`,
            };
          }

          const labelMatch = target.toLowerCase().match(/^desktop-(\d+)$/);
          if (labelMatch) {
            const index = Number.parseInt(labelMatch[1], 10) - 1;
            if (index >= 0 && index < running.length) {
              return {
                containerId: running[index].containerId,
                label: desktopLabel(index),
              };
            }
            return {
              error: `Unknown desktop name: ${target}. Run /desktop list first.`,
            };
          }

          const exact = running.find((entry) => entry.containerId === target);
          if (exact) {
            return {
              containerId: exact.containerId,
              label: findDesktopLabel(exact.containerId),
            };
          }

          const prefixMatches = running.filter((entry) =>
            entry.containerId.startsWith(target),
          );
          if (prefixMatches.length === 1) {
            return {
              containerId: prefixMatches[0].containerId,
              label: findDesktopLabel(prefixMatches[0].containerId),
            };
          }
          if (prefixMatches.length > 1) {
            return {
              error:
                `Container id prefix "${target}" is ambiguous (${prefixMatches.length} matches). ` +
                "Use /desktop list and pick the desktop number.",
            };
          }

          return {
            error:
              `Desktop not found: ${target}\n` +
              "Use /desktop list and attach by number (for example, /desktop attach 1).",
          };
        };
        const resolveActiveSessionHandle = (): {
          handle?: ReturnType<typeof desktopMgr.getHandleBySession>;
          sourceSessionId?: string;
        } => {
          const direct = desktopMgr.getHandleBySession(sessionId);
          if (direct) {
            return { handle: direct, sourceSessionId: sessionId };
          }

          // Voice/session routing previously used senderId as the desktop
          // router key. Keep /desktop stop/status/vnc compatible with those
          // existing sandboxes while newer sessions converge on sessionId.
          const senderSessionId = cmdCtx.senderId?.trim();
          if (senderSessionId && senderSessionId !== sessionId) {
            const senderHandle =
              desktopMgr.getHandleBySession(senderSessionId);
            if (senderHandle) {
              return {
                handle: senderHandle,
                sourceSessionId: senderSessionId,
              };
            }
          }

          return {};
        };

        if (sub === "start") {
          const parseStartResourceOverrides = (): {
            maxMemory?: string;
            maxCpu?: string;
            error?: string;
          } => {
            let maxMemory: string | undefined;
            let maxCpu: string | undefined;
            for (let i = 1; i < cmdCtx.argv.length; i++) {
              const token = cmdCtx.argv[i];
              if (token === "--memory" || token === "--ram") {
                const value = cmdCtx.argv[i + 1];
                if (!value) return { error: "Missing value for --memory" };
                maxMemory = value;
                i += 1;
                continue;
              }
              if (
                token.startsWith("--memory=") ||
                token.startsWith("--ram=")
              ) {
                maxMemory = token.slice(token.indexOf("=") + 1);
                continue;
              }
              if (token === "--cpu" || token === "--cpus") {
                const value = cmdCtx.argv[i + 1];
                if (!value) return { error: "Missing value for --cpu" };
                maxCpu = value;
                i += 1;
                continue;
              }
              if (token.startsWith("--cpu=") || token.startsWith("--cpus=")) {
                maxCpu = token.slice(token.indexOf("=") + 1);
                continue;
              }
              return { error: `Unknown /desktop start option: ${token}` };
            }
            return { maxMemory, maxCpu };
          };

          const overrides = parseStartResourceOverrides();
          if (overrides.error) {
            await cmdCtx.reply(
              `${overrides.error}\nUsage: /desktop start [--memory 4g] [--cpu 2.0]`,
            );
            return;
          }

          const existing = desktopMgr.getHandleBySession(sessionId);
          if (existing && (overrides.maxMemory || overrides.maxCpu)) {
            await cmdCtx.reply(
              `Desktop already running for this session (RAM ${existing.maxMemory}, CPU ${existing.maxCpu}). ` +
                "Stop it first to change resources.",
            );
            return;
          }

          try {
            const handle = await desktopMgr.getOrCreate(sessionId, {
              maxMemory: overrides.maxMemory,
              maxCpu: overrides.maxCpu,
            });
            const label = findDesktopLabel(handle.containerId) ?? "desktop";
            await cmdCtx.reply(
              `Desktop sandbox started (${label}).\nVNC: http://localhost:${handle.vncHostPort}/vnc.html\n` +
                `Resolution: ${handle.resolution.width}x${handle.resolution.height}\n` +
                `Resources: RAM ${handle.maxMemory}, CPU ${handle.maxCpu}`,
            );
          } catch (err) {
            await cmdCtx.reply(
              `Failed to start desktop: ${err instanceof Error ? err.message : err}`,
            );
          }
        } else if (sub === "stop") {
          const stopTarget = cmdCtx.argv[1]?.trim();
          const { destroySessionBridge } =
            await import("../desktop/session-router.js");

          if (stopTarget && stopTarget.length > 0) {
            const resolved = resolveAttachTarget(stopTarget);
            if (!resolved.containerId) {
              await cmdCtx.reply(
                resolved.error ?? "Failed to resolve desktop target.",
              );
              return;
            }

            const targetHandle = desktopMgr.getHandle(resolved.containerId);
            await desktopMgr.destroy(resolved.containerId);

            const sessionsToReset = new Set<string>([sessionId]);
            if (targetHandle?.sessionId) {
              sessionsToReset.add(targetHandle.sessionId);
            }
            for (const targetSessionId of sessionsToReset) {
              destroySessionBridge(
                targetSessionId,
                ctx.getDesktopBridges() as any,
                ctx.getPlaywrightBridges() as any,
                ctx.getContainerMCPBridges() as any,
                ctx.logger,
              );
            }

            await cmdCtx.reply(
              `Desktop sandbox stopped (${resolved.label ?? resolved.containerId}).`,
            );
            return;
          }

          const activeResolution = resolveActiveSessionHandle();
          const active = activeResolution.handle;
          if (!active) {
            await cmdCtx.reply(
              "No active desktop sandbox for this session.\n" +
                "Use /desktop list and stop by number (for example, /desktop stop 1).",
            );
            return;
          }

          await desktopMgr.destroy(active.containerId);
          const sessionsToReset = new Set<string>([sessionId]);
          if (activeResolution.sourceSessionId) {
            sessionsToReset.add(activeResolution.sourceSessionId);
          }
          for (const targetSessionId of sessionsToReset) {
            destroySessionBridge(
              targetSessionId,
              ctx.getDesktopBridges() as any,
              ctx.getPlaywrightBridges() as any,
              ctx.getContainerMCPBridges() as any,
              ctx.logger,
            );
          }
          await cmdCtx.reply("Desktop sandbox stopped.");
        } else if (sub === "status") {
          const handle = resolveActiveSessionHandle().handle;
          if (!handle) {
            await cmdCtx.reply("No active desktop sandbox for this session.");
          } else {
            const uptimeS = Math.round(
              (Date.now() - handle.createdAt) / 1000,
            );
            const label = findDesktopLabel(handle.containerId) ?? "desktop";
            await cmdCtx.reply(
              `Desktop sandbox: ${label} [${handle.status}]\n` +
                `Container: ${handle.containerId}\n` +
                `Uptime: ${uptimeS}s\n` +
                `VNC: http://localhost:${handle.vncHostPort}/vnc.html\n` +
                `Resolution: ${handle.resolution.width}x${handle.resolution.height}\n` +
                `Resources: RAM ${handle.maxMemory}, CPU ${handle.maxCpu}`,
            );
          }
        } else if (sub === "vnc") {
          const handle = resolveActiveSessionHandle().handle;
          if (!handle) {
            await cmdCtx.reply(
              "No active desktop sandbox. Use /desktop start first.",
            );
          } else {
            await cmdCtx.reply(
              `http://localhost:${handle.vncHostPort}/vnc.html`,
            );
          }
        } else if (sub === "list") {
          const all = listOrderedSandboxes();
          if (all.length === 0) {
            await cmdCtx.reply("No desktop sandboxes running.");
          } else {
            const lines = all.map((entry, index) => {
              const label = desktopLabel(index);
              const session =
                entry.sessionId.length > 48
                  ? `${entry.sessionId.slice(0, 48)}...`
                  : entry.sessionId;
              return (
                `${index + 1}) ${label} [${entry.status}] id=${entry.containerId}\n` +
                `   session=${session} ram=${entry.maxMemory} cpu=${entry.maxCpu}\n` +
                `   vnc=${entry.vncUrl}`
              );
            });
            await cmdCtx.reply(
              `Desktop sandboxes (${all.length}):\n${lines.join("\n")}\n` +
                "Attach with: /desktop attach <number|name|containerId>",
            );
          }
        } else if (sub === "attach") {
          const targetArg = cmdCtx.argv[1];
          const resolved = resolveAttachTarget(
            typeof targetArg === "string" ? targetArg : undefined,
          );
          if (!resolved.containerId) {
            await cmdCtx.reply(
              resolved.error ?? "Failed to resolve desktop target.",
            );
            return;
          }

          try {
            const { destroySessionBridge } =
              await import("../desktop/session-router.js");
            // Reset any existing bridge for this session so follow-up desktop tool
            // calls reconnect against the newly attached container.
            destroySessionBridge(
              sessionId,
              ctx.getDesktopBridges() as any,
              ctx.getPlaywrightBridges() as any,
              ctx.getContainerMCPBridges() as any,
              ctx.logger,
            );
            const handle = desktopMgr.assignSession(
              resolved.containerId,
              sessionId,
            );
            const label =
              resolved.label ??
              findDesktopLabel(handle.containerId) ??
              "desktop";
            await cmdCtx.reply(
              `Attached ${label} (${handle.containerId}) to this chat session.\n` +
                `VNC: http://localhost:${handle.vncHostPort}/vnc.html`,
            );
          } catch (err) {
            await cmdCtx.reply(
              `Failed to attach desktop: ${err instanceof Error ? err.message : err}`,
            );
          }
        } else {
          await cmdCtx.reply(
            "Usage: /desktop <start|stop|status|vnc|list|attach>\n" +
              "/desktop start flags: [--memory 4g] [--cpu 2.0]\n" +
              "/desktop attach: <number|name|containerId>",
          );
        }
      },
    });
  }

  // /goal — create or list goals (lazy access to goalManager via getter)
  commandRegistry.register({
    name: "goal",
    description: "Create or list goals",
    args: "[description]",
    global: true,
    handler: async (cmdCtx) => {
      const gm = ctx.getGoalManager();
      if (!gm) {
        await cmdCtx.reply(
          "Goal manager not available. Autonomous features may be disabled.",
        );
        return;
      }
      if (cmdCtx.args) {
        const goal = await gm.addGoal({
          title: cmdCtx.args.slice(0, 60),
          description: cmdCtx.args,
          priority: "medium",
          source: "user",
          maxAttempts: 2,
        });
        await cmdCtx.reply(
          `Goal created [${goal.id.slice(0, 8)}]: ${goal.title}`,
        );
      } else {
        const active = await gm.getActiveGoals();
        if (active.length === 0) {
          await cmdCtx.reply(
            "No active goals. Use /goal <description> to create one.",
          );
          return;
        }
        const lines = active.map(
          (g) => `  [${g.priority}/${g.status}] ${g.title}`,
        );
        await cmdCtx.reply(
          `Active goals (${active.length}):\n${lines.join("\n")}`,
        );
      }
    },
  });

  // ---- /memory (Phase 9.1) ----
  commandRegistry.register({
    name: "memory",
    description: "Inspect and manage memory (search, list, forget, pin)",
    global: true,
    metadata: {
      category: "runtime",
      clients: ["shell", "console", "web"],
      viewKind: "runtime",
    },
    handler: async (cmdCtx) => {
      const args = (cmdCtx.args ?? "").trim();
      const subcommand = args.split(/\s+/)[0]?.toLowerCase() ?? "";
      const rest = args.slice(subcommand.length).trim();

      // /memory search <query>
      if (subcommand === "search" && rest) {
        try {
          const needle = rest.toLowerCase();
          const sessions = await memoryBackend.listSessions();
          const matches: Array<{ content: string; role: string; timestamp: number; metadata?: Record<string, unknown> }> = [];
          // Sample recent sessions for search (cap at 20 to avoid scanning everything)
          for (const sid of sessions.slice(-20)) {
            const thread = await memoryBackend.getThread(sid, 50);
            for (const entry of thread) {
              if (entry.content.toLowerCase().includes(needle)) {
                matches.push(entry);
                if (matches.length >= 10) break;
              }
            }
            if (matches.length >= 10) break;
          }
          if (matches.length === 0) {
            await replyRuntimeResult(
              cmdCtx,
              "memory",
              `No memory entries matching "${rest}".`,
              {
                status: "empty",
                metrics: [{ label: "Query", value: rest }],
                detail: { query: rest, matches: [] },
              },
            );
            return;
          }
          const lines = matches.map((e, i) => {
            const age = Math.round((Date.now() - e.timestamp) / 3_600_000);
            const preview = e.content.slice(0, 80).replace(/\n/g, " ");
            const meta = e.metadata as Record<string, unknown> | undefined;
            const conf = typeof meta?.confidence === "number"
              ? ` conf=${(meta.confidence as number).toFixed(2)}`
              : "";
            const access = typeof meta?.accessCount === "number"
              ? ` access=${meta.accessCount}`
              : "";
            return `  ${i + 1}. [${e.role}] ${preview}${preview.length >= 80 ? "…" : ""} (${age}h ago${conf}${access})`;
          });
          await replyRuntimeResult(
            cmdCtx,
            "memory",
            `Memory search results for "${rest}":\n${lines.join("\n")}`,
            {
              status: "results",
              metrics: [
                { label: "Query", value: rest },
                { label: "Matches", value: `${matches.length}` },
              ],
              sections: [{ title: "Matches", items: lines }],
              detail: { query: rest, matches },
            },
          );
        } catch (err) {
          await cmdCtx.reply(`Memory search error: ${toErrorMessage(err)}`);
        }
        return;
      }

      // /memory stats
      if (subcommand === "stats" || subcommand === "health" || !subcommand) {
        try {
          const { collectMemoryHealthReport, formatMemoryHealthReport } =
            await import("../memory/diagnostics.js");
          const report = await collectMemoryHealthReport({ memoryBackend });
          await replyRuntimeResult(
            cmdCtx,
            "memory",
            formatMemoryHealthReport(report),
            {
              status: report.healthy ? "healthy" : "warning",
              metrics: [
                { label: "Backend", value: report.backendType },
                { label: "Durability", value: report.durability },
                { label: "Entries", value: `${report.entryCount}` },
                { label: "Sessions", value: `${report.sessionCount}` },
              ],
              sections: [
                {
                  title: "Providers",
                  items: [
                    report.embeddingProvider
                      ? `Embeddings: ${report.embeddingProvider.name} (${report.embeddingProvider.available ? "available" : "unavailable"})`
                      : "Embeddings: unavailable",
                    report.vectorStore
                      ? `Vector store: dim=${report.vectorStore.dimension || "?"}${report.vectorStore.persistent ? " (persistent)" : " (ephemeral)"}`
                      : "Vector store: unavailable",
                    report.knowledgeGraph
                      ? `Graph: ${report.knowledgeGraph.nodeCount} nodes, ${report.knowledgeGraph.edgeCount} edges`
                      : "Graph: unavailable",
                  ],
                },
              ],
              detail: asRecord(report) ?? {},
            },
          );
        } catch (err) {
          await cmdCtx.reply(`Memory health error: ${toErrorMessage(err)}`);
        }
        return;
      }

      // /memory forget <sessionId>
      if (subcommand === "forget" && rest) {
        try {
          const deleted = await memoryBackend.deleteThread(rest);
          await cmdCtx.reply(`Deleted ${deleted} entries from session ${rest}.`);
        } catch (err) {
          await cmdCtx.reply(`Memory forget error: ${toErrorMessage(err)}`);
        }
        return;
      }

      // /memory pin <key> <value>
      if (subcommand === "pin" && rest) {
        try {
          const [key, ...valueParts] = rest.split(/\s+/);
          const value = valueParts.join(" ");
          if (!key || !value) {
            await cmdCtx.reply("Usage: /memory pin <key> <value>");
            return;
          }
          await memoryBackend.set(`pinned:${key}`, value);
          await cmdCtx.reply(`Pinned: ${key} = ${value}`);
        } catch (err) {
          await cmdCtx.reply(`Memory pin error: ${toErrorMessage(err)}`);
        }
        return;
      }

      // /memory recent [count]
      if (subcommand === "recent") {
        const count = Math.min(20, Math.max(1, parseInt(rest, 10) || 5));
        try {
          const results = await memoryBackend.query({
            order: "desc",
            limit: count,
          });
          if (results.length === 0) {
            await replyRuntimeResult(cmdCtx, "memory", "No memory entries found.", {
              status: "empty",
              detail: { recent: [] },
            });
            return;
          }
          const lines = results.map((e, i) => {
            const age = Math.round((Date.now() - e.timestamp) / 3_600_000);
            const preview = e.content.slice(0, 80).replace(/\n/g, " ");
            return `  ${i + 1}. [${e.role}] ${preview}${preview.length >= 80 ? "…" : ""} (${age}h ago) id=${e.id.slice(0, 8)}`;
          });
          await replyRuntimeResult(
            cmdCtx,
            "memory",
            `Recent memory entries:\n${lines.join("\n")}`,
            {
              status: "results",
              metrics: [{ label: "Entries", value: `${results.length}` }],
              sections: [{ title: "Recent Entries", items: lines }],
              detail: { recent: results },
            },
          );
        } catch (err) {
          await cmdCtx.reply(`Memory list error: ${toErrorMessage(err)}`);
        }
        return;
      }

      // /memory export
      if (subcommand === "export") {
        try {
          const { exportMemory } = await import("../memory/export-import.js");
          const data = await exportMemory({ memoryBackend });
          const json = JSON.stringify(data, null, 2);
          await cmdCtx.reply(`Memory export (${data.entries?.length ?? 0} entries):\n\`\`\`json\n${json.slice(0, 4000)}\n\`\`\``);
        } catch (err) {
          await cmdCtx.reply(`Memory export error: ${toErrorMessage(err)}`);
        }
        return;
      }

      await cmdCtx.reply(
        "Usage: /memory [search <query> | stats | recent [count] | forget <sessionId> | pin <key> <value> | export]",
      );
    },
  });

  return commandRegistry;
}
