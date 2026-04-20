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
import { GrokProvider } from "../llm/grok/index.js";
import type { LLMToolCall } from "../llm/types.js";
import type { PhaseEvent } from "../phases/events.js";
import { Session } from "../session/session.js";
import type {
  SessionServices,
  SessionState,
} from "../session/session.js";
import {
  buildTurnContext,
  type Config,
  type ModelInfo,
} from "../session/turn-context.js";
import { runTurn } from "../session/run-turn.js";
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
  type PendingWorktreeState,
} from "./slash.js";

const DEFAULT_MODEL = "grok-4-fast";

// ─────────────────────────────────────────────────────────────────────
// Argv / stdin / env resolution
// ─────────────────────────────────────────────────────────────────────

function resolveApiKey(): string {
  const key =
    process.env.XAI_API_KEY ??
    process.env.GROK_API_KEY ??
    process.env.AGENC_XAI_API_KEY ??
    "";
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

function installSignalHandlers(getSession: () => Session | null): void {
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
    // T10 wires the real config reloader; here we just signal the session.
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
// System prompt + rendering
// ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are AgenC, a coding assistant running in a terminal.

Do real tool calls instead of narrating. Prefer system.readFile,
system.editFile, system.bash, system.grep, system.glob over describing
what you would do. End the turn when the work is done or when you
genuinely need user input — not to announce progress.

Trust the output of tools you already ran. If a file's content is in
your context from a prior read, don't re-read it. Report outcomes
faithfully: if a command fails, say so; do not claim success without
evidence.

When modifying an existing file, prefer system.editFile over
system.writeFile. Read before editing so the match is grounded in the
actual file bytes.`;

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
  provider: GrokProvider,
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
// main
// ─────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
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

    const workspaceRoot = process.env.AGENC_WORKSPACE ?? processCwd();
    const model = process.env.AGENC_MODEL ?? DEFAULT_MODEL;

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

    // Step 5: construct provider.
    const provider = new GrokProvider({
      apiKey,
      model,
      tools: registry.toLLMTools(),
    });
    throwIfAborted("GrokProvider");

    const conversationId = `conv-${Date.now().toString(36)}`;
    const config = buildMinimalConfig(workspaceRoot, model);
    const modelInfo = buildMinimalModelInfo(model);
    const services = buildPlaceholderServices(provider, registry);

    const initialState: SessionState = {
      sessionConfiguration: {
        cwd: workspaceRoot,
        approvalPolicy: { value: "never" },
        sandboxPolicy: { value: "read_only" },
        fileSystemSandboxPolicy: {
          allowWrite: [],
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
        collaborationMode: { model },
        dynamicTools: [],
        sessionSource: "cli_main",
      },
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
    installSignalHandlers(() => sessionRef);

    // Step 7a: mount RolloutStore (T6 — I-4 fsync + I-23 flock +
    // I-49 schema version). On SessionLockedError, bail fast with
    // the holder PID (another AgenC process owns the session).
    // On SchemaMismatchError, bail with the migration message.
    let rolloutStore: RolloutStore | null = null;
    try {
      rolloutStore = new RolloutStore({
        cwd: workspaceRoot,
        sessionId: conversationId,
        agencVersion: "0.2.0",
      });
      rolloutStore.open({
        sessionId: conversationId,
        timestamp: new Date().toISOString(),
        cwd: workspaceRoot,
        originator: "agenc-cli",
        agencVersion: "0.2.0",
        model,
        modelProvider: "grok",
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
            getProjectDir(workspaceRoot),
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
    const projectDir = getProjectDir(workspaceRoot);
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
          modelProviderId: "grok",
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

    // T9: slash-command short-circuit. If the user's line is a
    // worktree control command, run it directly + skip the LLM turn.
    // The full slash dispatcher lands in T11; this is the minimum
    // wiring so `/enter-worktree` + `/exit-worktree` work today.
    const slashCommand = parseSlashCommand(userMessage);
    let pendingWorktree: PendingWorktreeState | null = null;
    const originalCwd = processCwd();
    if (slashCommand) {
      try {
        const result = await handleSlashCommand({
          session,
          command: slashCommand,
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

    try {
      for await (const event of runTurn(session, ctx, userMessage, {
        systemPrompt: SYSTEM_PROMPT,
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
