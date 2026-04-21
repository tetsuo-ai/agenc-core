#!/usr/bin/env node
/**
 * `agenc` CLI entry point — phase-machine dispatcher.
 *
 * Reads a prompt from argv (or stdin), boots the Grok provider, builds
 * the coding-profile tool registry, constructs a Session + TurnContext,
 * drives `runTurn` through the 6-phase machine, and streams events to
 * stdout. The Ink/React cockpit lands in a later tranche; this lets us
 * verify the agent path end-to-end before adding UI.
 *
 * Usage:
 *   agenc "help me understand this repo"
 *   echo "..." | agenc
 *
 * Env:
 *   XAI_API_KEY        required — xAI API key (also accepts GROK_API_KEY)
 *   AGENC_MODEL        optional — model override (default: grok-4-fast)
 *   AGENC_WORKSPACE    optional — project root (default: process.cwd())
 *   AGENC_HOME         optional — state dir (default: $HOME/.agenc)
 *
 * Invariants wired here:
 *   I-45 (SIGTERM orderly shutdown, exit 0)
 *   I-46 (SIGHUP treated as stdin-lost terminal)
 *   I-47 (SIGUSR1 config reload request, SIGUSR2 state dump request)
 *   I-52 (AGENC_HOME / $HOME/.agenc writable precheck)
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cwd as processCwd } from "node:process";
import { createProvider, type ProviderName } from "../llm/provider.js";
import type { LLMProvider, LLMToolCall } from "../llm/types.js";
import type { PhaseEvent } from "../phases/events.js";
import { Session } from "../session/session.js";
import type {
  SessionServices,
  SessionState,
} from "../session/session.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import type { Event } from "../session/event-log.js";
import {
  buildTurnContext,
  type Config,
  type ModelInfo,
  type SessionConfiguration,
} from "../session/turn-context.js";
import { runTurn } from "../session/run-turn.js";
import type { Terminal } from "../session/turn-state.js";
import { buildToolRegistry } from "../tool-registry.js";
import { RolloutStore } from "../session/rollout-store.js";
import {
  SchemaMismatchError,
  SessionLockedError,
  getProjectDir,
  readIndexSnapshot,
} from "../session/session-store.js";
import { SidecarManager } from "../session/sidecar.js";
import { FileHistory, FileHistorySidecar } from "../session/file-history.js";
import { ErrorLogSidecar } from "../session/error-log.js";
import { CostSidecar } from "../session/cost.js";
import { reconstructFromRollout } from "../session/rollout-reconstruction.js";
import {
  createBashExecObserverForSlot,
  createMCPCallObserverForSlot,
  type SessionSlot,
} from "../session/observer-wiring.js";
import { buildDelegateTool } from "./delegate-tool.js";
import {
  handleSlashCommand,
  parseSlashCommand,
  runSlashCommand,
  type PendingWorktreeState,
} from "./slash.js";
import { parseSlashCommand as parseDispatcherInput } from "../commands/dispatcher.js";
import {
  ConfigStore,
  resolveAgencHome as resolveAgencHomeFromEnv,
  resolveApiKey as resolveApiKeyFromEnv,
  resolveWorkspace as resolveWorkspaceFromEnv,
  resolveModelDisambiguated,
  AmbiguousModelError,
  UnknownModelError,
  type AgenCConfig,
} from "../config/index.js";
import {
  loadTieredInstructions,
  assembleTieredInstructions,
} from "../prompts/claude-md.js";
import {
  loadMemoryPrompt,
  scanMemoryDir,
  registerAutoSaveSidecar,
  selectRelevantMemoriesForTurn,
  injectAttachmentsIntoPrompt,
  type ExtractMemoriesFn,
  type MemoryCandidate,
  type TurnState as MemoryTurnState,
} from "../prompts/memory/index.js";
import {
  assembleSystemPrompt,
  type McpServerInstructionsInput,
} from "../prompts/system-prompt.js";
import { clearSystemPromptSections } from "../prompts/sections.js";
import type { MemoryEntry } from "../prompts/memory/types.js";

const DEFAULT_MODEL = "grok-4-fast";

/**
 * Provider → known model slugs. I-60 disambiguation walks this catalog
 * when the user passes a bare model slug (no "provider:model" prefix).
 *
 * T13 replaces this with the real provider-factory catalog; today only
 * the Grok models are reachable through GrokProvider. Keep the shape
 * stable so swapping in the factory is a drop-in change.
 */
export const PROVIDER_MODEL_CATALOG: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    grok: Object.freeze([
      "grok-4-fast",
      "grok-4",
      "grok-3",
      "grok-2",
      "grok-2-mini",
      "grok-beta",
      "grok-code-fast-1",
    ]) as readonly string[],
  });

// ─────────────────────────────────────────────────────────────────────
// Argv / stdin / env resolution
// ─────────────────────────────────────────────────────────────────────

function resolveApiKey(): string {
  const key = resolveApiKeyFromEnv(process.env) ?? "";
  if (!key) {
    throw new Error(
      "missing xAI API key — set XAI_API_KEY (or GROK_API_KEY) in the environment",
    );
  }
  return key;
}

async function readStdin(signal: AbortSignal): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    if (signal.aborted) break;
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  if (signal.aborted) {
    throw new InitAbortedError("stdin read aborted");
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function resolveUserMessage(signal: AbortSignal): Promise<string> {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    return argv.join(" ").trim();
  }
  const piped = await readStdin(signal);
  if (piped) return piped;
  throw new Error(
    "no prompt provided — pass as argv (`agenc ...`) or pipe via stdin",
  );
}

// ─────────────────────────────────────────────────────────────────────
// I-51: Init step abort propagates cleanly.
// ─────────────────────────────────────────────────────────────────────

/**
 * Thrown when an init step observes its AbortSignal. The top-level
 * IIFE recognises this error type + exits with code 130 (SIGINT
 * conventional) after running reverse-cleanup. Mirrors I-51 rule
 * "emit error:'init_aborted'".
 */
class InitAbortedError extends Error {
  constructor(message: string) {
    super(`init_aborted: ${message}`);
    this.name = "InitAbortedError";
  }
}

/**
 * Reverse-cleanup stack for init. Each init step that opens a
 * resource pushes a finaliser onto this stack; on abort the stack is
 * drained in LIFO order. No-op entries are cheap; callers should
 * guard finalisers against double-close.
 */
class InitCleanupStack {
  private readonly finalisers: Array<{ name: string; run: () => Promise<void> | void }> = [];

  push(name: string, run: () => Promise<void> | void): void {
    this.finalisers.push({ name, run });
  }

  async unwind(onError: (name: string, err: unknown) => void): Promise<void> {
    while (this.finalisers.length > 0) {
      const { name, run } = this.finalisers.pop()!;
      try {
        await run();
      } catch (err) {
        onError(name, err);
      }
    }
  }
}

/**
 * Wire pre-session signal handlers to the init-stage AbortController.
 * Ctrl+C / SIGTERM / SIGHUP during init propagates to every async
 * init step, which in turn throws InitAbortedError; the top-level
 * catcher runs reverse-cleanup before exit.
 */
function installInitSignalHandlers(initAbort: AbortController): () => void {
  const onSigInt = () => initAbort.abort("SIGINT during init");
  const onSigTerm = () => initAbort.abort("SIGTERM during init");
  const onSigHup = () => initAbort.abort("SIGHUP during init");
  process.once("SIGINT", onSigInt);
  process.once("SIGTERM", onSigTerm);
  process.once("SIGHUP", onSigHup);
  return () => {
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
    process.removeListener("SIGHUP", onSigHup);
  };
}

// ─────────────────────────────────────────────────────────────────────
// I-52: validate AGENC_HOME / $HOME/.agenc writable before anything else.
// ─────────────────────────────────────────────────────────────────────

function validateAgencHome(): string {
  const explicit = process.env.AGENC_HOME;
  const home = explicit ?? (process.env.HOME ? `${process.env.HOME}/.agenc` : "");
  if (!home) {
    throw new Error(
      "HOME unset and AGENC_HOME unset — set AGENC_HOME to a writable dir",
    );
  }
  try {
    mkdirSync(home, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EROFS" || code === "EACCES") {
      throw new Error(
        `AGENC_HOME (${home}) is not writable (${code}) — set AGENC_HOME to a writable dir`,
      );
    }
    throw error;
  }
  return home;
}

// ─────────────────────────────────────────────────────────────────────
// Signal handlers (I-45 / I-46 / I-47)
// ─────────────────────────────────────────────────────────────────────

/**
 * Mutable latch SIGUSR1 flips when the operator requests a config
 * reload. I-47: the handler never reloads mid-turn; the between-turn
 * check in `maybeReloadConfigBetweenTurns` drains the latch before
 * the next `runTurn`.
 */
export interface ConfigReloadLatch {
  requested: boolean;
}

function installSignalHandlers(
  getSession: () => Session | null,
  configReloadLatch: ConfigReloadLatch,
): void {
  // I-45: SIGTERM — orderly shutdown, exit 0.
  process.once("SIGTERM", () => {
    getSession()?.abortTerminal("signal_received");
  });
  // I-46: SIGHUP — same path as stdin loss (T12 wires the stdin handler).
  process.once("SIGHUP", () => {
    getSession()?.abortTerminal("stdin_lost");
  });
  // I-47: SIGUSR1 — config reload requested (takes effect next turn per I-30).
  //       SIGUSR2 — state dump to ~/.agenc/diag-<pid>-<ts>.json (T-future).
  process.on("SIGUSR1", () => {
    // T10 Group I: latch only. The between-turn drain runs the real
    // ConfigStore.reload() + clearSystemPromptSections() + emits a
    // warning event once the current turn (if any) completes.
    configReloadLatch.requested = true;
    getSession()?.emit({
      id: "startup",
      msg: {
        type: "warning",
        payload: {
          cause: "config_reload_requested",
          message: "config reload will take effect at next turn (I-30)",
        },
      },
    });
  });
  process.on("SIGUSR2", () => {
    // T-future: dump session state. Logged as a warning so we can audit.
    getSession()?.emit({
      id: "startup",
      msg: {
        type: "warning",
        payload: {
          cause: "state_dump_requested",
          message: "state dump requested (T-future)",
        },
      },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// T10 Group I — I-47 between-turn config reload
// ─────────────────────────────────────────────────────────────────────

/**
 * Drain the SIGUSR1 latch if set. Reloads the ConfigStore, wipes the
 * system-prompt section cache so a stale static head can't leak into
 * the next turn, and emits a session warning documenting the change.
 *
 * MUST be called between turns, never mid-turn. I-47 + I-30.
 *
 * Returns `{ reloaded, previous, next }` so callers/tests can inspect
 * the transition.
 */
export async function maybeReloadConfigBetweenTurns(params: {
  readonly latch: ConfigReloadLatch;
  readonly store: ConfigStore;
  readonly session: Session | null;
  readonly clearCache?: () => void;
}): Promise<
  | { readonly reloaded: false }
  | {
      readonly reloaded: true;
      readonly previous: AgenCConfig;
      readonly next: AgenCConfig;
    }
> {
  if (!params.latch.requested) return { reloaded: false };
  const previous = params.store.current();
  const next = await params.store.reload();
  params.latch.requested = false;
  // Wipe the prompt-section cache so the refresh picks up any new
  // static-head inputs (env info, model, MCP, etc.) on the next turn.
  (params.clearCache ?? clearSystemPromptSections)();
  params.session?.emit({
    id: params.session.nextInternalSubId(),
    msg: {
      type: "warning",
      payload: {
        cause: "config_reloaded",
        message:
          `config reloaded (model: ${previous.model ?? "default"} → ${next.model ?? "default"})`,
      },
    },
  });
  return { reloaded: true, previous, next };
}

// ─────────────────────────────────────────────────────────────────────
// System prompt + rendering
// ─────────────────────────────────────────────────────────────────────

function describeToolCall(toolCall: LLMToolCall): string {
  const tail =
    toolCall.arguments && toolCall.arguments.length > 80
      ? `${toolCall.arguments.slice(0, 80)}…`
      : (toolCall.arguments ?? "");
  return `${toolCall.name}(${tail})`;
}

function renderEvent(event: PhaseEvent): void {
  switch (event.type) {
    case "turn_start":
      if (event.turnIndex > 0) {
        process.stderr.write(`\n── turn ${event.turnIndex + 1} ──\n`);
      }
      return;
    case "assistant_text":
      process.stdout.write(event.content);
      process.stdout.write("\n");
      return;
    case "tool_call":
      process.stderr.write(`→ ${describeToolCall(event.toolCall)}\n`);
      return;
    case "tool_result": {
      const tag = event.result.isError ? "✗" : "✓";
      const preview =
        event.result.content.length > 200
          ? `${event.result.content.slice(0, 200)}…`
          : event.result.content;
      process.stderr.write(`${tag} ${preview}\n`);
      return;
    }
    case "turn_complete": {
      const { usage, stopReason, error } = event;
      const line = `\n[${stopReason}] in:${usage.promptTokens} out:${usage.completionTokens} total:${usage.totalTokens}\n`;
      process.stderr.write(line);
      if (error) {
        process.stderr.write(`error: ${error.message}\n`);
      }
      return;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Session + TurnContext bootstrap (minimum-viable T5 scaffolding).
// Later tranches replace these with their real subsystems:
//   T6  — RolloutRecorder / event-log sidecars / hooks registry
//   T7  — ToolRegistry extensions + StreamingToolExecutor
//   T9  — McpConnectionManager, AgentControl, AgentIdentityManager
//   T10 — real SessionConfiguration (config.json + precedence)
//   T11 — permissions / sandbox / approval
//   T13 — provider factory + multi-provider registry
// ─────────────────────────────────────────────────────────────────────

function buildPlaceholderServices(
  provider: LLMProvider,
  registry: ReturnType<typeof buildToolRegistry>,
): SessionServices {
  const noopAsync = async () => {
    /* placeholder */
  };
  return {
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    unifiedExecManager: { maxTimeoutMs: 0 },
    analyticsEventsClient: { emit: noopAsync },
    hooks: {
      startupWarnings: () => [],
      executePreCompact: noopAsync,
      executePostCompact: noopAsync,
      executeStop: noopAsync,
      executeStopFailure: noopAsync,
    },
    rollout: undefined,
    userShell: {
      path: process.env.SHELL ?? "/bin/sh",
      deriveExecArgs: (input: string) => ["-c", input],
    },
    agentIdentityManager: { ensureRegistered: noopAsync },
    shellSnapshotTx: {
      value: null,
      isClosed: false,
      next: () => {},
      subscribe: () => () => {},
      changes: async function* () {
        // empty
      },
      complete: () => {},
    } as unknown as SessionServices["shellSnapshotTx"],
    showRawAgentReasoning: false,
    execPolicy: { current: () => null },
    authManager: { mode: "bearer_key" },
    sessionTelemetry: {},
    modelsManager: {
      getModelInfo: async (slug: string) => ({
        slug,
        effectiveContextWindowPercent: 1,
        supportedReasoningLevels: [],
        defaultReasoningSummary: "auto",
        truncationPolicy: "off",
        usedFallbackModelMetadata: false,
      }),
      tryListModels: () => undefined,
      listModels: async () => [],
    },
    toolApprovals: {
      hasApproval: () => false,
      approve: () => {},
    },
    guardianRejections: new Map(),
    skillsManager: {
      skillsForConfig: async () => ({ invokedSkills: [] }),
    },
    pluginsManager: {
      pluginsForConfig: async () => ({ effectiveSkillRoots: () => null }),
    },
    mcpManager: {
      effectiveServers: async () => new Map(),
      toolPluginProvenance: async () => null,
    },
    skillsWatcher: { start: () => {} },
    agentControl: {
      maxThreads: 0,
      spawnAgent: async () => null,
      shutdownAgentTree: noopAsync,
    },
    networkApproval: { enabled: () => false },
    threadStore: {
      threadName: async () => undefined,
      setThreadName: noopAsync,
    },
    modelClient: { setWindowGeneration: () => {} },
    codeModeService: { enabled: () => false },
    provider,
    registry,
    // T11 W3-A: placeholder permission-mode registry. The real bootstrap
    // path (ConfigStore → initialize-permission-context → registry) lands
    // once the permissions wiring integrates with the CLI entry point.
    permissionModeRegistry: new PermissionModeRegistry(
      createEmptyToolPermissionContext(),
    ),
  };
}

function buildMinimalConfig(cwd: string, model: string): Config {
  return {
    model,
    cwd,
    features: {
      appsEnabledForAuth: () => false,
      useLegacyLandlock: () => false,
    },
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
}

function buildMinimalModelInfo(slug: string): ModelInfo {
  return {
    slug,
    effectiveContextWindowPercent: 1,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

// ─────────────────────────────────────────────────────────────────────
// T10 Group I — config ↔ session-configuration bridge
// ─────────────────────────────────────────────────────────────────────

/**
 * Map the AgenCConfig `approval_policy` enum (dash-separated, codex
 * convention) onto the session `ApprovalPolicy` enum (underscore-
 * separated, codex port convention). Absent field → `on_request`.
 */
function mapApprovalPolicy(
  raw: AgenCConfig["approval_policy"] | undefined,
): SessionConfiguration["approvalPolicy"]["value"] {
  switch (raw) {
    case "never":
      return "never";
    case "on-failure":
      return "on_failure";
    case "on-request":
      return "on_request";
    case "untrusted":
      return "untrusted";
    default:
      return "on_request";
  }
}

/**
 * Map the AgenCConfig `sandbox_mode` enum (dash-separated) onto the
 * session `SandboxPolicy` enum (underscore-separated). Absent field →
 * `workspace_write`.
 */
function mapSandboxPolicy(
  raw: AgenCConfig["sandbox_mode"] | undefined,
): SessionConfiguration["sandboxPolicy"]["value"] {
  switch (raw) {
    case "read-only":
      return "read_only";
    case "danger-full-access":
      return "danger_full_access";
    case "workspace-write":
      return "workspace_write";
    default:
      return "workspace_write";
  }
}

/**
 * Build a fresh SessionConfiguration from a loaded AgenCConfig + the
 * resolved workspace + model. Used at init time and (future) between
 * turns on config reload so session state mirrors the config snapshot.
 *
 * Propagates the following codex-rooted AgenCConfig fields into the
 * session configuration so a reload carries them forward:
 *   - `personality`           → `personality`
 *   - `reasoning_summary`     → `modelReasoningSummary`
 *   - `compact_prompt`        → `compactPrompt`
 */
export function sessionConfigurationFromAgenCConfig(params: {
  readonly config: AgenCConfig;
  readonly workspaceRoot: string;
  readonly model: string;
}): SessionConfiguration {
  const approval = mapApprovalPolicy(params.config.approval_policy);
  const sandbox = mapSandboxPolicy(params.config.sandbox_mode);
  const base: SessionConfiguration = {
    cwd: params.workspaceRoot,
    approvalPolicy: { value: approval },
    sandboxPolicy: { value: sandbox },
    fileSystemSandboxPolicy: {
      allowWrite: sandbox === "workspace_write" ? [params.workspaceRoot] : [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    windowsSandboxLevel: "none",
    collaborationMode: { model: params.model },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
  // Propagate the shared codex-rooted fields when present on the
  // loaded config. Undefined values stay off so callers can distinguish
  // "operator set a default" from "operator set X explicitly".
  return {
    ...base,
    ...(params.config.personality !== undefined
      ? { personality: params.config.personality }
      : {}),
    ...(params.config.reasoning_summary !== undefined
      ? { modelReasoningSummary: params.config.reasoning_summary }
      : {}),
    ...(params.config.compact_prompt !== undefined
      ? { compactPrompt: params.config.compact_prompt }
      : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// T10 Group I — I-60 hard-fail disambiguation
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the configured model slug against the provider catalog and
 * hard-fail at init when the slug is ambiguous or unknown. Returns the
 * canonical `{provider, model}` pair on success. Matches the I-60 CLI
 * contract: print a clear, actionable error, then exit 1.
 */
export function resolveModelOrExit(
  slug: string,
  catalog: Readonly<Record<string, readonly string[]>> = PROVIDER_MODEL_CATALOG,
  exit: (code: number) => never = ((code: number) => {
    process.exit(code);
  }) as (code: number) => never,
  errSink: (line: string) => void = (line) => process.stderr.write(line),
): { provider: string; model: string } {
  try {
    return resolveModelDisambiguated(slug, catalog);
  } catch (err) {
    if (err instanceof AmbiguousModelError) {
      const candidates = err.candidates
        .map((c) => `${c.provider}:${c.model}`)
        .join(", ");
      errSink(
        `agenc: ambiguous model '${slug}' — matches ${err.candidates.length} providers. ` +
          `Use 'provider:model' form. Candidates: ${candidates}\n`,
      );
      exit(1);
    }
    if (err instanceof UnknownModelError) {
      // UnknownModelError already composes the canonical message with
      // the provider list + "Use provider:model form" guidance (see
      // `UnknownModelError.providers`). Keep the `agenc: ` CLI prefix
      // + trailing newline here; everything else comes from the error.
      errSink(`agenc: ${err.message}\n`);
      exit(1);
    }
    throw err;
  }
  // Unreachable — exit above terminates the process.
  throw new Error("resolveModelOrExit: unreachable");
}

// ─────────────────────────────────────────────────────────────────────
// T10 Group I — T9 delegate adapter for memory extraction
// ─────────────────────────────────────────────────────────────────────

/**
 * Default timeout applied to the extraction subagent. The extractor is
 * a best-effort summarizer; if the child hangs we drop the attempt and
 * let the next turn retry once more growth accrues.
 */
export const EXTRACT_MEMORIES_TIMEOUT_MS = 30_000;

/**
 * Inline prompt handed to the extraction subagent. Kept as a template
 * literal (not a prompt file) so changes stay auditable in this file
 * and so the surface remains obvious during runtime triage.
 */
function buildExtractPrompt(transcript: string): string {
  return [
    "You are extracting durable memories from the current session. Input: the last N assistant+user messages. Output: JSON array of candidates with shape:",
    "[ { \"name\": \"<slug>\", \"description\": \"<one-line>\", \"type\": \"user\"|\"feedback\"|\"project\"|\"reference\", \"body\": \"<the memory content>\" } ]",
    "Only extract non-ephemeral, user-specific, durable facts. Skip code patterns, ephemeral state, PR/commit references. Output ONLY valid JSON, no prose.",
    "",
    "--- TRANSCRIPT ---",
    transcript,
  ].join("\n");
}

/**
 * Allowed values for the extractor's memory `type` frontmatter field.
 * Mirrors the MEMORY_TYPES set from the memory subsystem but kept local
 * so the bridge doesn't pull in extra module surface.
 */
const EXTRACT_MEMORY_TYPES: ReadonlySet<string> = new Set([
  "user",
  "feedback",
  "project",
  "reference",
]);

/**
 * Parse a subagent's final message as a JSON array of memory candidates
 * and convert each valid entry into a `MemoryCandidate` rooted under
 * `memoryDir`. Malformed entries are skipped; a fully malformed JSON
 * response throws so the caller can emit the parse-failure warning.
 */
export function parseExtractedMemoryCandidates(
  raw: string,
  memoryDir: string,
): readonly MemoryCandidate[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("extractor response was not a JSON array");
  }
  const out: MemoryCandidate[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const description =
      typeof rec.description === "string" ? rec.description.trim() : "";
    const type =
      typeof rec.type === "string" && EXTRACT_MEMORY_TYPES.has(rec.type)
        ? (rec.type as "user" | "feedback" | "project" | "reference")
        : undefined;
    const body = typeof rec.body === "string" ? rec.body : "";
    if (name === "" || type === undefined || body.length === 0) continue;
    // Slugify the name for the filename; strip unsafe chars so the
    // path join below stays confined to memoryDir.
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug.length === 0) continue;
    out.push({
      filePath: join(memoryDir, `${slug}.md`),
      frontmatter: {
        name,
        description,
        type,
        extra: {},
      },
      body,
    });
  }
  return out;
}

/**
 * Build an `ExtractMemoriesFn` that spawns an `explorer`-role subagent
 * via `delegate()` to parse a transcript into memory candidates. The
 * child is asked for a strict JSON array; the final message is parsed
 * and validated against the `MemoryCandidate` shape.
 *
 * Failure policy:
 *   - `session()` returns null → return [] (startup / post-shutdown).
 *   - JSON parse failure       → emit warning `memory_extract_parse_failed`, return [].
 *   - subagent error / timeout → emit warning `memory_extract_failed`, return [].
 *
 * Timeout: `EXTRACT_MEMORIES_TIMEOUT_MS` (30s). The timeout is a guard
 * against a hung child; the promise race ensures the sidecar's
 * fire-and-forget invocation doesn't keep a handle around forever.
 */
export function buildExtractMemoriesViaSubagent(params: {
  readonly session: () => Session | null;
  readonly memoryDir: string;
  readonly delegateFn?: typeof import("../agents/delegate.js").delegate;
  readonly timeoutMs?: number;
}): ExtractMemoriesFn {
  return async (
    transcript: string,
  ): Promise<readonly MemoryCandidate[]> => {
    const s = params.session();
    if (s === null) return [];
    const timeoutMs = params.timeoutMs ?? EXTRACT_MEMORIES_TIMEOUT_MS;

    const emitWarning = (cause: string, message: string): void => {
      try {
        s.emit({
          id: s.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: { cause, message },
          },
        });
      } catch {
        /* best effort — warning emission must not mask the caller. */
      }
    };

    let rawFinal: string;
    try {
      // Lazy-import to avoid pulling the delegate graph in when the
      // CLI short-circuits (slash commands, init_aborted, etc.).
      const delegateFn =
        params.delegateFn ??
        (await import("../agents/delegate.js")).delegate;
      const { control, registry } = (
        await import("./delegate-tool.js")
      ).ensureAgentControl(s);

      const deadline = new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(
                `memory_extract_timeout: extraction did not finish within ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        ).unref?.();
      });

      const dispatch = delegateFn({
        parent: s,
        parentPath: "/root",
        control,
        registry,
        taskPrompt: buildExtractPrompt(transcript),
        role: "explorer",
      });

      const outcome = await Promise.race([dispatch, deadline]);
      if (outcome.kind !== "sync_completed") {
        emitWarning(
          "memory_extract_failed",
          outcome.kind === "rejected"
            ? `delegate rejected: ${outcome.reason}`
            : `unexpected delegate outcome: ${outcome.kind}`,
        );
        return [];
      }
      rawFinal = outcome.result.finalMessage ?? "";
      if (rawFinal.trim().length === 0) {
        emitWarning(
          "memory_extract_parse_failed",
          "extractor returned an empty final message",
        );
        return [];
      }
    } catch (err) {
      emitWarning(
        "memory_extract_failed",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }

    try {
      return parseExtractedMemoryCandidates(rawFinal, params.memoryDir);
    } catch (err) {
      emitWarning(
        "memory_extract_parse_failed",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  };
}

// ─────────────────────────────────────────────────────────────────────
// T10 Group I — runSingleTurn seam (R1: multi-turn future-proofing)
// ─────────────────────────────────────────────────────────────────────

/**
 * Inputs the single-turn helper needs per invocation. Kept narrow so a
 * future multi-turn REPL loop can call `runSingleTurn` repeatedly with
 * the same shared state and a fresh `input` each pass.
 */
export interface RunSingleTurnOpts {
  readonly session: Session;
  readonly ctx: ReturnType<typeof buildTurnContext>;
  readonly input: string;
  /** T10: config snapshot + latch so `maybeReloadConfigBetweenTurns` can drain SIGUSR1. */
  readonly configStore: ConfigStore;
  readonly configReloadLatch: ConfigReloadLatch;
  /** Pre-built, per-session memory + project-instructions inputs. */
  readonly projectInstructions: string;
  readonly memoryPromptText: string;
  readonly allMemories: readonly MemoryEntry[];
  /** Tool registry + MCP inputs that shape the system prompt. */
  readonly enabledToolNames: ReadonlySet<string>;
  readonly mcpServers: readonly McpServerInstructionsInput[];
  readonly provider: string;
  /** Optional: injected for tests so we don't have to spin real runTurn. */
  readonly runTurnFn?: typeof runTurn;
  readonly reloadConfigFn?: typeof maybeReloadConfigBetweenTurns;
  readonly assembleSystemPromptFn?: typeof assembleSystemPrompt;
}

/**
 * Drive a single LLM turn through the T10 pipeline:
 *   1. drain the I-47 config-reload latch (between-turn only)
 *   2. assemble the system prompt (tiered instructions + memory tail)
 *   3. inject per-turn memory attachments
 *   4. invoke `runTurn` and forward every event
 *
 * A future multi-turn REPL loop calls this repeatedly with the same
 * session + ctx and a fresh `input` each iteration. Today `main()`
 * calls it exactly once for the one-shot CLI flow.
 */
export async function* runSingleTurn(
  opts: RunSingleTurnOpts,
): AsyncGenerator<PhaseEvent, Terminal | undefined> {
  const reload = opts.reloadConfigFn ?? maybeReloadConfigBetweenTurns;
  const assemble = opts.assembleSystemPromptFn ?? assembleSystemPrompt;
  const drive = opts.runTurnFn ?? runTurn;

  // I-47: drain SIGUSR1 before we build the system prompt + send the
  // turn so any reload takes effect on this exact turn, not the one
  // after. Call is idempotent when the latch is unset.
  await reload({
    latch: opts.configReloadLatch,
    store: opts.configStore,
    session: opts.session,
  });

  const assembled = await assemble({
    session: opts.session,
    ctx: opts.ctx,
    projectInstructions: opts.projectInstructions,
    memoryPrompt: opts.memoryPromptText,
    mcpServers: [...opts.mcpServers],
    enabledToolNames: opts.enabledToolNames,
    provider: opts.provider,
  });

  const selectedMemories = selectRelevantMemoriesForTurn(
    opts.allMemories,
    opts.input,
    opts.session,
  );
  const systemPrompt = injectAttachmentsIntoPrompt(
    assembled.text,
    selectedMemories,
  );

  const iter = drive(opts.session, opts.ctx, opts.input, { systemPrompt });
  while (true) {
    const step = await iter.next();
    if (step.done) return step.value;
    yield step.value;
  }
}

// ─────────────────────────────────────────────────────────────────────
// T10 A+ Fix-α — TurnStateAccumulator
// ─────────────────────────────────────────────────────────────────────

/**
 * Subscribes to the session's EventLog and maintains the cumulative
 * token + tool counters the memory auto-save sidecar needs to evaluate
 * `shouldExtract()`.
 *
 * Semantics line up with `shouldExtract` (auto-save.ts):
 *   - `tokensConsumed`: cumulative sum of every `token_count.totalTokens`
 *     emitted since session start (each `token_count` event carries
 *     per-stream usage, not cumulative, per stream-model.ts:281).
 *   - `toolCallsIssued`: cumulative count of `tool_call_completed`
 *     events since session start.
 *   - `lastTurnHadNoTools`: latched per turn — set to `true` when the
 *     last completed turn emitted zero `tool_call_started` events,
 *     `false` otherwise. Updated on `turn_complete`. Between turns
 *     `currentTurnHadTools` is reset by `turn_started`.
 *
 * Tracking tool calls via `tool_call_completed` matches the task
 * contract; tracking "this turn had tools" via `tool_call_started`
 * correctly flags turns that started a tool but never finished one
 * (abort mid-tool), so the natural-break branch of `shouldExtract`
 * doesn't fire mid-tool-use.
 */
export class TurnStateAccumulator {
  private tokensConsumed = 0;
  private toolCallsIssued = 0;
  private currentTurnHadTools = false;
  private lastTurnHadNoTools = false;
  private unsubscribe: (() => void) | null = null;

  /** Attach to an EventLog. Idempotent — re-subscribing is a no-op. */
  subscribe(log: { subscribe: (fn: (e: Event) => void) => () => void }): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = log.subscribe((event) => this.onEvent(event));
  }

  /** Detach from the EventLog. Safe to call multiple times. */
  detach(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** Observe one event. Exposed for direct calls in tests. */
  onEvent(event: Event): void {
    switch (event.msg.type) {
      case "turn_started": {
        // Reset the per-turn tool flag; counters stay cumulative.
        this.currentTurnHadTools = false;
        return;
      }
      case "tool_call_started": {
        this.currentTurnHadTools = true;
        return;
      }
      case "tool_call_completed": {
        this.toolCallsIssued += 1;
        this.currentTurnHadTools = true;
        return;
      }
      case "token_count": {
        // `token_count.totalTokens` is per-stream usage, not cumulative
        // (stream-model.ts:281). Sum them across the session.
        const delta = event.msg.payload.totalTokens ?? 0;
        if (delta > 0) this.tokensConsumed += delta;
        return;
      }
      case "turn_complete": {
        this.lastTurnHadNoTools = !this.currentTurnHadTools;
        return;
      }
      default:
        return;
    }
  }

  /**
   * Read-through view of the accumulator. Returns a snapshot object
   * with the three fields the memory auto-save sidecar consumes. Safe
   * to call at any time (values are primitives; no copy semantics
   * required).
   */
  snapshot(): {
    readonly tokensConsumed: number;
    readonly toolCallsIssued: number;
    readonly lastTurnHadNoTools: boolean;
  } {
    return {
      tokensConsumed: this.tokensConsumed,
      toolCallsIssued: this.toolCallsIssued,
      lastTurnHadNoTools: this.lastTurnHadNoTools,
    };
  }

  /** Reset counters to zero. Intended for tests + session recycling. */
  reset(): void {
    this.tokensConsumed = 0;
    this.toolCallsIssued = 0;
    this.currentTurnHadTools = false;
    this.lastTurnHadNoTools = false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────

export async function main(): Promise<number> {
  // I-51: init step abort + reverse-cleanup stack. Signal handlers for
  // Ctrl+C / SIGTERM / SIGHUP during init feed this controller; each
  // async init step observes signal.aborted.
  const initAbort = new AbortController();
  const cleanup = new InitCleanupStack();
  const uninstallInitSignals = installInitSignalHandlers(initAbort);

  const throwIfAborted = (step: string) => {
    if (initAbort.signal.aborted) {
      throw new InitAbortedError(`${step}: ${String(initAbort.signal.reason ?? "aborted")}`);
    }
  };

  // I-47 latch — SIGUSR1 flips this; `maybeReloadConfigBetweenTurns`
  // drains it before the next runTurn call.
  const configReloadLatch: ConfigReloadLatch = { requested: false };

  try {
    // Step 1: validate HOME (I-52).
    validateAgencHome();
    throwIfAborted("validateAgencHome");

    // Step 2: resolve API key.
    const apiKey = resolveApiKey();
    throwIfAborted("resolveApiKey");

    // Step 3: resolve user message (may block on stdin).
    const userMessage = await resolveUserMessage(initAbort.signal);
    throwIfAborted("resolveUserMessage");

    // Step 3b: boot ConfigStore (loads ~/.agenc/config.toml + env
    // overrides) so every downstream consumer reads the same snapshot.
    const agencHome = resolveAgencHomeFromEnv(process.env);
    const configStore = new ConfigStore({
      home: agencHome,
      env: process.env,
    });
    await configStore.reload();
    throwIfAborted("ConfigStore.reload");

    const workspaceRoot =
      resolveWorkspaceFromEnv(process.env) ?? processCwd();
    const rawModel = configStore.current().model ?? DEFAULT_MODEL;

    // I-60 hard-fail: ambiguous / unknown model slug must exit at init
    // with a clear `provider:model` recommendation instead of letting
    // the provider silently pick one arm.
    const { provider: resolvedProvider, model } = resolveModelOrExit(rawModel);

    // Step 4: build tool registry. T6 gap #119 — the bash tool
    // lifecycle observer needs the Session to emit events through,
    // but Session is built further down. Allocate a late-bound slot
    // that the bash tool / MCP manager observers close over; we fill
    // it right after Session construction so every subsequent spawn
    // or MCP call lands `exec_command_*` / `mcp_tool_call_*` in the
    // event log.
    const sessionSlot: SessionSlot = { current: null };
    // T9: holds the full `Session` reference for the delegate tool.
    // `sessionSlot` only carries the narrow ObserverSessionSink shape
    // the bash/MCP observers need; AgentControl wants the real Session.
    const delegateSessionHolder: { current: Session | null } = {
      current: null,
    };
    const bashExecObserver = createBashExecObserverForSlot(sessionSlot);
    const mcpCallObserver = createMCPCallObserverForSlot(sessionSlot);
    // T9: register the subagent-spawn dispatcher as a built-in tool.
    // Session is late-bound so the delegate call picks up the real
    // Session once it's constructed a few steps down.
    const delegateTool = buildDelegateTool({
      getSession: () => delegateSessionHolder.current,
    });
    const registry = buildToolRegistry({
      workspaceRoot,
      bashExecObserver,
      extraTools: [delegateTool],
    });
    throwIfAborted("buildToolRegistry");

    // Step 5: construct provider via the factory so T13's multi-
    // provider work hooks in cleanly and the I-60 disambiguation
    // result (`resolvedProvider`) actually drives routing. Today the
    // factory only wires Grok; other providers throw
    // `ProviderNotImplementedError` until T13 lands the adapters.
    const provider: LLMProvider = createProvider(resolvedProvider as ProviderName, {
      apiKey,
      model,
      tools: registry.toLLMTools(),
    });
    throwIfAborted("createProvider");

    const conversationId = `conv-${Date.now().toString(36)}`;
    const config = buildMinimalConfig(workspaceRoot, model);
    const modelInfo = buildMinimalModelInfo(model);
    const services = buildPlaceholderServices(provider, registry);

    // T10 Group I: derive SessionConfiguration from the typed
    // AgenCConfig snapshot so approval/sandbox/cwd match what the
    // operator set in ~/.agenc/config.toml (with env overrides).
    const initialState: SessionState = {
      sessionConfiguration: sessionConfigurationFromAgenCConfig({
        config: configStore.current(),
        workspaceRoot,
        model,
      }),
      history: [],
    };

    // Step 6: construct Session. Push its shutdown into the reverse-
    // cleanup stack so abort during subsequent init steps unwinds it.
    const session = new Session({
      conversationId,
      initialState,
      features: config.features,
      services,
      jsRepl: { id: `repl-${conversationId}` },
    });
    cleanup.push("session.shutdown", () => session.shutdown());
    throwIfAborted("Session");

    // T6 gap #119: now that the Session exists, fill the observer
    // slot so bash spawns and MCP tool calls emit their `*_begin` /
    // `*_end` EventMsg variants through `session.emit(...)`. Any
    // future `new MCPManager(...)` site owned by the CLI MUST call
    // `manager.setCallObserver(mcpCallObserver)` BEFORE `start()`
    // so the observer is baked into every bridge at creation time.
    sessionSlot.current = session;
    // T9: give the delegate tool its real Session reference.
    delegateSessionHolder.current = session;
    // Exported for the future MCPManager wiring site (no MCPManager
    // is constructed in this entrypoint yet — the placeholder
    // services.mcpManager is a stub until T9 lands).
    void mcpCallObserver;
    // Future MCPManager attach site. When the CLI gains a first-class
    // MCPManager (T9), uncomment the block below — `getMcpConfigFromEnv`
    // lets ops seed servers via `AGENC_MCP_SERVERS` today, and
    // `attachMcpManagerToSession` MUST run BEFORE `manager.start()` so
    // `mcp_tool_call_begin` / `mcp_tool_call_end` are captured from the
    // very first bridge. Leaving it commented keeps the ordering doc
    // and the call surface discoverable without dragging the full
    // MCPManager wiring in today.
    //
    // import { MCPManager } from "../mcp-client/manager.js";
    // import {
    //   attachMcpManagerToSession,
    //   getMcpConfigFromEnv,
    // } from "../session/mcp-startup.js";
    // const mcpManager = new MCPManager(getMcpConfigFromEnv());
    // attachMcpManagerToSession(mcpManager, session, sessionSlot);
    // await mcpManager.start();

    let sessionRef: Session | null = session;
    // Stable container the memory sidecar closes over — unlike
    // `sessionRef` (a let binding in this function), this holder
    // survives reassignment and test introspection.
    const sessionRefForMemory: { current: Session | null } = {
      current: session,
    };
    installSignalHandlers(() => sessionRef, configReloadLatch);

    // Step 7a: mount RolloutStore (T6 — I-4 fsync + I-23 flock +
    // I-49 schema version). On SessionLockedError, bail fast with
    // the holder PID (another AgenC process owns the session).
    // On SchemaMismatchError, bail with the migration message.
    // Resolve project-root markers from config so the store slugs
    // from the nearest `.git` (or other marker) ancestor. Two checkouts
    // nested under the same repo now map to the same projects/<slug>/
    // directory. Undefined → store uses its own defaults.
    const sessionProjectRootMarkers = configStore.current().project_root_markers;
    let rolloutStore: RolloutStore | null = null;
    try {
      rolloutStore = new RolloutStore({
        cwd: workspaceRoot,
        sessionId: conversationId,
        agencVersion: "0.2.0",
        ...(sessionProjectRootMarkers !== undefined
          ? { projectRootMarkers: sessionProjectRootMarkers }
          : {}),
      });
      rolloutStore.open({
        sessionId: conversationId,
        timestamp: new Date().toISOString(),
        cwd: workspaceRoot,
        originator: "agenc-cli",
        agencVersion: "0.2.0",
        model,
        modelProvider: resolvedProvider,
      });
      session.mountRolloutStore(rolloutStore);
      cleanup.push("rollout-store.close", () => rolloutStore?.close());
    } catch (err) {
      if (err instanceof SessionLockedError) {
        process.stderr.write(`agenc: ${err.message}\n`);
        return 1;
      }
      if (err instanceof SchemaMismatchError) {
        process.stderr.write(`agenc: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
    throwIfAborted("RolloutStore");

    // Step 7b: I-48 orphan-TurnStarted + I-25 snapshot-seq check.
    // On resume, scan the rollout for unmatched TurnStarted events
    // and emit synthetic TurnAborted{reason:'process_killed'} markers;
    // also validate the index.json snapshot against the rollout
    // and emit warning:'snapshot_behind_rollout' if stale.
    try {
      const existingItems = rolloutStore.readAll();
      if (existingItems.length > 0) {
        // I-25: feed the snapshot into reconstruction so it can
        // report snapshot_behind_rollout.
        const indexSnapshot = readIndexSnapshot(
          join(
            getProjectDir(workspaceRoot, sessionProjectRootMarkers),
            "sessions",
            conversationId,
            "index.json",
          ),
        );
        const reconstruction = reconstructFromRollout(existingItems, {
          ...(indexSnapshot ? { indexSnapshot } : {}),
        });
        if (reconstruction.synthesizedEvents.length > 0) {
          for (const synth of reconstruction.synthesizedEvents) {
            if (synth.type === "event_msg") {
              session.emit(synth.payload);
            } else {
              rolloutStore.appendRollout(synth);
            }
          }
        }
      }
    } catch (err) {
      // Orphan-recovery failures are best-effort. Surface as warning
      // but keep going; resume still works with partial metadata.
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "orphan_recovery_failed",
            message: err instanceof Error ? err.message : String(err),
          },
        },
      });
    }

    // Step 7c: mount sidecars (T6 §C).
    const projectDir = getProjectDir(workspaceRoot, sessionProjectRootMarkers);
    const sidecarManager = new SidecarManager({
      onDiagnostic: (d) => {
        // Route sidecar diagnostics through the event log so they
        // land in the rollout alongside other errors.
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: d.level,
            payload: { cause: d.cause, message: d.message },
          },
        } as Parameters<typeof session.emit>[0]);
      },
    });
    const fileHistory = new FileHistory({
      projectDir,
      onDiagnostic: (d) => sidecarManager.recordDiagnostic({
        sidecar: "file-history",
        level: "warning",
        cause: d.cause,
        message: d.message,
        at: Date.now(),
      }),
    });
    sidecarManager.register(new FileHistorySidecar({ fileHistory }));
    sidecarManager.register(
      new ErrorLogSidecar({
        projectDir,
        sessionId: conversationId,
      }),
    );
    const costSidecar = new CostSidecar({
      budgetTracker: session.budgetTracker,
      projectDir,
      sessionId: conversationId,
      onDiagnostic: (d) =>
        sidecarManager.recordDiagnostic({
          sidecar: "cost",
          level: d.level,
          cause: d.cause,
          message: d.message,
          at: Date.now(),
        }),
    });
    // Load lifetime totals before the sidecar observes any events so
    // `/status` and lifetime accessors reflect prior sessions
    // immediately on resume. Cost totals survive session boundaries,
    // scoped per project.
    await costSidecar.loadFromDisk();
    sidecarManager.register(costSidecar);

    // T10 Group I: memory auto-save sidecar. Turn-complete events feed
    // a threshold check; if tripped, the extractor (T9 delegate when
    // reachable; stub otherwise) produces MemoryCandidates that get
    // written through the I-29 write-lock.
    const memoryDir = join(agencHome, "memory");
    const memoryMdPath = join(memoryDir, "MEMORY.md");
    const extractMemoriesFn = buildExtractMemoriesViaSubagent({
      session: () => sessionRefForMemory.current,
      memoryDir,
    });
    // T10 A+ Fix-α: real per-turn telemetry. The accumulator
    // subscribes to the session EventLog BEFORE the sidecar so
    // `tool_call_completed`, `token_count`, `turn_started`, and
    // `turn_complete` events update the cumulative counters that back
    // `shouldExtract`. Without this, `getTurnState` returned zeros and
    // the auto-save predicate could never fire in production.
    const turnStateAccumulator = new TurnStateAccumulator();
    turnStateAccumulator.subscribe(session.eventLog);
    cleanup.push("turn-state-accumulator.detach", () =>
      turnStateAccumulator.detach(),
    );
    const getTurnState = (): MemoryTurnState | null =>
      turnStateAccumulator.snapshot();
    const memoryAutoSaveSidecar = registerAutoSaveSidecar({
      session: { memoryDir, memoryMdPath },
      extractor: extractMemoriesFn,
      getTurnState,
      // I-8: route `memory_write_contention` warnings (from
      // FsLockTimeoutError / FsLockUnavailableError inside
      // writeMemoryFile / upsertIndexEntry) through the typed event
      // bus instead of stderr.
      emitWarning: (message: string) => {
        const active = sessionRefForMemory.current;
        if (active === null) return;
        active.emit({
          id: active.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: {
              cause: "memory_write_contention",
              message,
            },
          },
        });
      },
    });
    sidecarManager.register(memoryAutoSaveSidecar);

    await sidecarManager.start(session.eventLog);
    cleanup.push("sidecar-manager.stop", () => sidecarManager.stop());

    // Step 8: build TurnContext.
    const subId = session.nextInternalSubId();
    const ctx = buildTurnContext({
      conversationId,
      subId,
      config,
      modelInfo,
      provider,
      sessionConfiguration: initialState.sessionConfiguration,
    });
    throwIfAborted("buildTurnContext");

    // Emit a session_meta event to stamp the session_configured record.
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "session_configured",
        payload: {
          sessionId: conversationId,
          model,
          modelProviderId: resolvedProvider,
          cwd: workspaceRoot,
          historyLogId: 0,
          historyEntryCount: 0,
          initialMessages: [],
          rolloutPath: rolloutStore.rolloutPath,
        },
      },
    });

    // Init complete — tear down init-phase signal handlers (Session
    // now owns its own) and drop the cleanup stack since the session
    // finally-block below takes over.
    uninstallInitSignals();
    // Drain the stack without running finalisers; session.shutdown()
    // below handles the Session cleanup.
    await cleanup.unwind(() => {
      /* swallow — we're handing off to session's own lifecycle */
    });

    // T9 / T11-W3: slash-command short-circuit.
    //
    // Two dispatch paths coexist during the W3 transition:
    //
    //   1. Worktree adapters (`/enter-worktree`, `/exit-worktree`) still
    //      go through the bespoke session-bound handler — the generic
    //      registry adapters cannot thread `PendingWorktreeState`
    //      through `dispatchSlashCommand` yet (tracked as a follow-up).
    //
    //   2. Every other `/...` line routes through `runSlashCommand`,
    //      which parses via `commands/dispatcher.ts`, loads the full
    //      default registry (help, status, init, diff, exit, clear,
    //      context, keybindings, resume, fork, plan, permissions,
    //      config, model, provider, compact), and dispatches with the
    //      full `SlashCommandContext`.
    const worktreeCommand = parseSlashCommand(userMessage);
    let pendingWorktree: PendingWorktreeState | null = null;
    const originalCwd = processCwd();
    if (worktreeCommand) {
      try {
        const result = await handleSlashCommand({
          session,
          command: worktreeCommand,
          originalCwd,
          pendingWorktree,
        });
        pendingWorktree = result.pendingWorktree;
        if (result.cwd !== processCwd()) {
          try {
            process.chdir(result.cwd);
          } catch (err) {
            process.stderr.write(
              `agenc: chdir(${result.cwd}) failed: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        process.stdout.write(`${result.message}\n`);
        return result.exitCode;
      } finally {
        sessionRef = null;
        // Flush sidecars (incl. CostSidecar cross-session persistence)
        // before closing the event log via session.shutdown().
        await sidecarManager.stop().catch(() => {
          /* best effort */
        });
        await session.shutdown().catch(() => {
          /* best effort */
        });
      }
    }
    void pendingWorktree;

    // W3: generic slash dispatcher path. Only route through the
    // dispatcher when the input actually parses as a slash command;
    // otherwise fall through to the LLM turn. The dispatcher has its
    // own unknown-command reporting + result rendering.
    if (parseDispatcherInput(userMessage)) {
      try {
        const runResult = await runSlashCommand(userMessage, {
          session,
          cwd: processCwd(),
          home: agencHome,
          configStore,
        });
        switch (runResult.kind) {
          case "skip":
            process.stderr.write(
              "agenc: slash command rejected (multi-line input not allowed)\n",
            );
            return 1;
          case "unknown":
            process.stderr.write(`agenc: ${runResult.message}\n`);
            return 1;
          case "blocked_by_bridge":
            process.stderr.write(`agenc: ${runResult.message}\n`);
            return 1;
          case "dispatched": {
            const r = runResult.result;
            switch (r.kind) {
              case "text":
              case "compact":
                process.stdout.write(`${r.text}\n`);
                return 0;
              case "prompt":
                // Re-injected prompt would feed back into the turn
                // loop; one-shot CLI has no loop yet, so surface the
                // prompt to stdout + exit 0.
                process.stdout.write(`${r.content}\n`);
                return 0;
              case "skip":
                return 0;
              case "exit":
                return r.code;
              case "error":
                process.stderr.write(`agenc: ${r.message}\n`);
                return 1;
            }
          }
        }
      } finally {
        sessionRef = null;
        sessionRefForMemory.current = null;
        await sidecarManager.stop().catch(() => {
          /* best effort */
        });
        await session.shutdown().catch(() => {
          /* best effort */
        });
      }
    }

    // T10 Group I: load tiered AGENTS.md/CLAUDE.md (managed/user/
    // project/local) + memory prompt once, then assemble the real
    // system prompt. The dynamic tail picks up env info, project
    // instructions, memory, and MCP server instructions.
    const currentConfig = configStore.current();
    const projectInstructionsResult = await loadTieredInstructions({
      cwd: workspaceRoot,
      ...(currentConfig.project_root_markers !== undefined
        ? { projectRootMarkers: currentConfig.project_root_markers }
        : {}),
      ...(currentConfig.project_doc_max_bytes !== undefined
        ? { projectDocMaxBytes: currentConfig.project_doc_max_bytes }
        : {}),
    });
    const assembledProjectInstructions = assembleTieredInstructions(
      projectInstructionsResult,
    );

    const loadedMemory = await loadMemoryPrompt({
      memoryDir,
      memoryMdPath,
    });

    // Scan the memory directory once so every turn can consult the
    // full set for per-turn attachment selection.
    const memoryScan = await scanMemoryDir(memoryDir);
    const allMemories: readonly MemoryEntry[] = memoryScan.entries;

    const mcpServers: McpServerInstructionsInput[] = [];
    const enabledToolNames = new Set<string>(
      registry.tools.map((t) => t.name),
    );

    // R1 seam: one LLM turn runs through `runSingleTurn`, which owns
    // the between-turn reload + system-prompt assembly + runTurn loop.
    // A future multi-turn REPL iterates this helper in a while-loop;
    // the single-shot CLI just runs it exactly once.
    try {
      for await (const event of runSingleTurn({
        session,
        ctx,
        input: userMessage,
        configStore,
        configReloadLatch,
        projectInstructions: assembledProjectInstructions,
        memoryPromptText: loadedMemory.text,
        allMemories,
        enabledToolNames,
        mcpServers,
        provider: resolvedProvider,
      })) {
        renderEvent(event);
        if (event.type === "turn_complete") {
          if (event.stopReason === "error") return 1;
          if (event.stopReason === "cancelled") return 130;
          return 0;
        }
      }
    } finally {
      sessionRef = null;
      sessionRefForMemory.current = null;
      // Flush sidecars (incl. CostSidecar cross-session persistence)
      // before closing the event log via session.shutdown().
      await sidecarManager.stop().catch(() => {
        /* best effort */
      });
      await session.shutdown().catch(() => {
        /* best effort */
      });
    }

    // Generator ended without yielding turn_complete — shouldn't happen,
    // but surface as an error rather than a silent 0 exit.
    return 1;
  } catch (error) {
    // I-51: on abort, run reverse cleanup + emit init_aborted.
    if (error instanceof InitAbortedError) {
      process.stderr.write(`agenc: ${error.message}\n`);
      await cleanup.unwind((name, err) => {
        process.stderr.write(
          `agenc: cleanup[${name}] failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
      return 130;
    }
    // Other init errors: still run cleanup, then re-throw so the
    // top-level catch surfaces the message.
    await cleanup.unwind((name, err) => {
      process.stderr.write(
        `agenc: cleanup[${name}] failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
    throw error;
  } finally {
    uninstallInitSignals();
  }
}

/**
 * Detect whether this module is being invoked as the CLI entrypoint
 * (via `node dist/bin/agenc.js` or the `agenc` binary) rather than
 * imported by tests / other code. Only the direct-invocation path
 * drains the main loop and calls `process.exit()`.
 *
 * Tests import `main` explicitly and drive it with their own stubs;
 * they MUST NOT trigger the IIFE.
 *
 * Detection strategy: inspect `process.argv[1]` (Node fills this with
 * the resolved script path when the file is the direct entry point).
 * Works under both CJS and ESM emit from tsup without touching
 * `import.meta`, which is forbidden in the CJS output target.
 */
function isDirectInvocation(): boolean {
  // Env opt-out: tests can force the IIFE off even on odd harnesses.
  if (process.env.AGENC_CLI_ENTRY_DISABLE === "1") return false;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  // The CLI binary resolves to `<prefix>/bin/agenc.js` (or `.mjs`) and
  // the `agenc` shim in `package.json.bin` symlinks to this script.
  // Match the tail of the entry path so both `node .../agenc.js` and
  // the installed `agenc` CLI pass the check.
  return /[\\/]bin[\\/]agenc(?:\.[mc]?js)?$/.test(argv1);
}

if (isDirectInvocation()) {
  void (async () => {
    try {
      const code = await main();
      process.exit(code);
    } catch (error) {
      process.stderr.write(
        `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
  })();
}
