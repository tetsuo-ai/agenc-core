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

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cwd as processCwd } from "node:process";
import {
  routeCLI,
  stripRoutingFlags,
  type BootTUIArgs,
  type ResumeTUIArgs,
} from "./route.js";
import type { LLMToolCall } from "../llm/types.js";
import type { PhaseEvent } from "../phases/events.js";
import { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import { runTurn } from "../session/run-turn.js";
import type { Terminal } from "../session/turn-state.js";
import {
  SchemaMismatchError,
  SessionLockedError,
  getProjectDir,
} from "../session/session-store.js";
import {
  createBashExecObserverForSlot,
  type SessionSlot,
} from "../session/observer-wiring.js";
import { buildDelegateTool } from "./delegate-tool.js";
import {
  runSlashCommand,
} from "./slash.js";
import {
  ConfigStore,
  resolveAgencHome as resolveAgencHomeFromEnv,
  resolveWorkspace as resolveWorkspaceFromEnv,
  type AgenCConfig,
} from "../config/index.js";
import {
  bootstrapLocalRuntimeSession,
  type BootstrapLocalRuntimeSessionOptions,
} from "./bootstrap.js";
import {
  loadTieredInstructions,
  assembleTieredInstructions,
} from "../prompts/claude-md.js";
import {
  loadMemoryPrompt,
  scanMemoryDir,
  selectRelevantMemoriesForTurn,
  injectAttachmentsIntoPrompt,
} from "../prompts/memory/index.js";
import {
  assembleSystemPrompt,
  type McpServerInstructionsInput,
} from "../prompts/system-prompt.js";
import { clearSystemPromptSections } from "../prompts/sections.js";
import type { MemoryEntry } from "../prompts/memory/types.js";
import { enableConfigs } from "../utils/config.js";

export {
  bootstrapLocalRuntimeSession,
  buildExtractMemoriesViaSubagent,
  EXTRACT_MEMORIES_TIMEOUT_MS,
  PROVIDER_MODEL_CATALOG,
  parseExtractedMemoryCandidates,
  resolveModelOrExit,
  sessionConfigurationFromAgenCConfig,
  TurnStateAccumulator,
} from "./bootstrap.js";

// ─────────────────────────────────────────────────────────────────────
// Argv / stdin / env resolution
// ─────────────────────────────────────────────────────────────────────

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
  // Strip routing-level flags (--no-tui, --resume) before treating the
  // residue as the prompt; T12 routing peels these off upstream but
  // legacy entry paths still call `resolveUserMessage` directly.
  const argv = stripRoutingFlags(process.argv.slice(2));
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
export function installInitSignalHandlers(
  initAbort: AbortController,
  proc: Pick<NodeJS.Process, "once" | "removeListener"> = process,
): () => void {
  const onSigInt = () => initAbort.abort("SIGINT during init");
  const onSigTerm = () => initAbort.abort("SIGTERM during init");
  const onSigHup = () => initAbort.abort("SIGHUP during init");
  proc.once("SIGINT", onSigInt);
  proc.once("SIGTERM", onSigTerm);
  proc.once("SIGHUP", onSigHup);
  return () => {
    proc.removeListener("SIGINT", onSigInt);
    proc.removeListener("SIGTERM", onSigTerm);
    proc.removeListener("SIGHUP", onSigHup);
  };
}

// ─────────────────────────────────────────────────────────────────────
// I-52: validate AGENC_HOME / $HOME/.agenc writable before anything else.
// ─────────────────────────────────────────────────────────────────────

export function validateAgencHome(
  env: NodeJS.ProcessEnv = process.env,
  mkdir: typeof mkdirSync = mkdirSync,
): string {
  const explicit = env.AGENC_HOME;
  const home =
    explicit && explicit.length > 0
      ? explicit
      : env.HOME && env.HOME.length > 0
        ? `${env.HOME}/.agenc`
        : "";
  if (!home) {
    throw new Error(
      "HOME unset and AGENC_HOME unset — set AGENC_HOME to a writable dir",
    );
  }
  try {
    mkdir(home, { recursive: true });
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

export function installSignalHandlers(
  getSession: () => Session | null,
  configReloadLatch: ConfigReloadLatch,
  proc: Pick<NodeJS.Process, "once" | "on"> = process,
): void {
  // Wave 5-B: tear the Ink tree down before we abort the session so a
  // lingering renderer can't paint into a terminal that's about to be
  // reset by `signal-exit`. No-op when no TUI is active.
  const unmountActiveInk = (): void => {
    try {
      activeInkUnmount?.();
    } catch {
      // Ink may have torn itself down already.
    }
  };
  // I-45: SIGTERM — orderly shutdown, exit 0.
  proc.once("SIGTERM", () => {
    unmountActiveInk();
    getSession()?.abortTerminal("signal_received");
  });
  // I-46: SIGHUP — same path as stdin loss (T12 wires the stdin handler).
  proc.once("SIGHUP", () => {
    unmountActiveInk();
    getSession()?.abortTerminal("stdin_lost");
  });
  // I-47: SIGUSR1 — config reload requested (takes effect next turn per I-30).
  //       SIGUSR2 — state dump to ~/.agenc/diag-<pid>-<ts>.json (T-future).
  proc.on("SIGUSR1", () => {
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
  proc.on("SIGUSR2", () => {
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
// T10 Group I — runSingleTurn seam (R1: multi-turn future-proofing)
// ─────────────────────────────────────────────────────────────────────

/**
 * Inputs the single-turn helper needs per invocation. Kept narrow so a
 * future multi-turn REPL loop can call `runSingleTurn` repeatedly with
 * the same shared state and a fresh `input` each pass.
 */
export interface RunSingleTurnOpts {
  readonly session: Session;
  readonly ctx: TurnContext;
  readonly input: string;
  /** T10: config snapshot + latch so `maybeReloadConfigBetweenTurns` can drain SIGUSR1. */
  readonly configStore: ConfigStore;
  readonly configReloadLatch: ConfigReloadLatch;
  /**
   * Preferred seam: load fresh prompt/memory/MCP inputs for this turn.
   * Called after between-turn reload handling so AGENTS, MEMORY, and
   * MCP instructions observe the latest snapshot on the next turn.
   */
  readonly loadTurnInputsFn?: () => Promise<PreparedTurnRuntimeInputs>;
  /** Legacy direct inputs retained for focused unit tests. */
  readonly projectInstructions?: string;
  readonly memoryPromptText?: string;
  readonly allMemories?: readonly MemoryEntry[];
  /** Tool registry + MCP inputs that shape the system prompt. */
  readonly enabledToolNames?: ReadonlySet<string>;
  readonly mcpServers?: readonly McpServerInstructionsInput[];
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

  const turnInputs = opts.loadTurnInputsFn
    ? await opts.loadTurnInputsFn()
    : {
        projectInstructions: opts.projectInstructions ?? "",
        memoryPromptText: opts.memoryPromptText ?? "",
        allMemories: opts.allMemories ?? [],
        enabledToolNames: opts.enabledToolNames ?? new Set<string>(),
        mcpServers: opts.mcpServers ?? [],
      };

  const assembled = await assemble({
    session: opts.session,
    ctx: opts.ctx,
    projectInstructions: turnInputs.projectInstructions,
    memoryPrompt: turnInputs.memoryPromptText,
    mcpServers: [...turnInputs.mcpServers],
    enabledToolNames: turnInputs.enabledToolNames,
    provider: opts.provider,
  });

  const selectedMemories = selectRelevantMemoriesForTurn(
    turnInputs.allMemories,
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

export interface PreparedTurnRuntimeInputs {
  readonly projectInstructions: string;
  readonly memoryPromptText: string;
  readonly allMemories: readonly MemoryEntry[];
  readonly enabledToolNames: ReadonlySet<string>;
  readonly mcpServers: readonly McpServerInstructionsInput[];
}

async function loadSessionMcpServerInstructions(
  session: Session,
  config: AgenCConfig,
): Promise<readonly McpServerInstructionsInput[]> {
  const servers = await session.services.mcpManager.effectiveServers(config, null);
  return Array.from(servers.entries())
    .flatMap(([name, info]) => {
      const instructions = (info as { readonly instructions?: unknown }).instructions;
      if (typeof instructions !== "string" || instructions.trim().length === 0) {
        return [];
      }
      return [{ name, instructions: instructions.trim() }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function prepareTurnRuntimeInputs(params: {
  readonly session: Session;
  readonly configStore: ConfigStore;
  readonly workspaceRoot: string;
  readonly memoryDir: string;
  readonly memoryMdPath: string;
  readonly registry: { readonly tools: readonly { readonly name: string }[] };
}): Promise<PreparedTurnRuntimeInputs> {
  const currentConfig = params.configStore.current();
  const projectInstructionsResult = await loadTieredInstructions({
    cwd: params.workspaceRoot,
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
    memoryDir: params.memoryDir,
    memoryMdPath: params.memoryMdPath,
  });
  const memoryScan = await scanMemoryDir(params.memoryDir);

  return {
    projectInstructions: assembledProjectInstructions,
    memoryPromptText: loadedMemory.text,
    allMemories: memoryScan.entries,
    enabledToolNames: new Set(params.registry.tools.map((tool) => tool.name)),
    mcpServers: await loadSessionMcpServerInstructions(params.session, currentConfig),
  };
}

function createSharedBootstrapTooling(): {
  readonly sessionSlot: SessionSlot;
  readonly delegateSessionHolder: { current: Session | null };
  readonly toolRegistryOptions: NonNullable<
    BootstrapLocalRuntimeSessionOptions["toolRegistryOptions"]
  >;
} {
  const sessionSlot: SessionSlot = { current: null };
  const delegateSessionHolder: { current: Session | null } = {
    current: null,
  };
  const bashExecObserver = createBashExecObserverForSlot(sessionSlot);
  const delegateTool = buildDelegateTool({
    getSession: () => delegateSessionHolder.current,
  });
  return {
    sessionSlot,
    delegateSessionHolder,
    toolRegistryOptions: {
      bashExecObserver,
      extraTools: [delegateTool],
    },
  };
}

function installTuiSessionContract(params: {
  readonly session: Session;
  readonly configStore: ConfigStore;
  readonly resolvedProvider: string;
  readonly loadTurnInputsFn: () => Promise<PreparedTurnRuntimeInputs>;
}): () => void {
  const configReloadLatch: ConfigReloadLatch = { requested: false };
  let sessionRef: Session | null = params.session;
  installSignalHandlers(() => sessionRef, configReloadLatch);

  params.session.installTurnDriverHooks({
    submit: async (message: string) => {
      const runPromptTurn = async (prompt: string): Promise<void> => {
        const ctx = params.session.newDefaultTurn();
        const startedAtMs = Date.now();
        await params.session.activeTurn.swap({
          turnId: ctx.subId,
          startedAtMs,
          abortController: new AbortController(),
        });
        try {
          for await (const event of runSingleTurn({
            session: params.session,
            ctx,
            input: prompt,
            configStore: params.configStore,
            configReloadLatch,
            loadTurnInputsFn: params.loadTurnInputsFn,
            provider: params.resolvedProvider,
          })) {
            params.session.emitPhaseEvent(event);
          }
        } finally {
          const current = params.session.activeTurn.unsafePeek();
          if (current?.turnId === ctx.subId) {
            await params.session.activeTurn.swap(null);
          }
        }
      };

      const emitSlashResult = (
        input: string,
        result:
          | { readonly kind: "text"; readonly text: string }
          | { readonly kind: "compact"; readonly text: string }
          | { readonly kind: "prompt"; readonly content: string }
          | { readonly kind: "skip" }
          | { readonly kind: "exit"; readonly code: number }
          | { readonly kind: "error"; readonly message: string },
      ): void => {
        params.session.emitPhaseEvent({
          type: "slash_result",
          input,
          result,
          timestamp: Date.now(),
          turnId: params.session.activeTurn.unsafePeek()?.turnId,
        } as unknown as PhaseEvent);
      };

      const trimmed = message.trimStart();
      if (trimmed.startsWith("/")) {
        const slash = await runSlashCommand(message, {
          session: params.session,
          cwd: params.session.sessionConfiguration.cwd ?? process.cwd(),
          home:
            process.env.HOME ??
            process.env.USERPROFILE ??
            params.session.sessionConfiguration.cwd ??
            process.cwd(),
          configStore: params.configStore,
        });
        switch (slash.kind) {
          case "skip":
            emitSlashResult(message, {
              kind: "error",
              message: /[\r\n]/.test(message)
                ? "slash command rejected (multi-line input not allowed)"
                : "slash command rejected (invalid syntax)",
            });
            return;
          case "unknown":
          case "blocked_by_bridge":
            emitSlashResult(message, {
              kind: "error",
              message: slash.message,
            });
            return;
          case "dispatched":
            emitSlashResult(message, slash.result);
            if (slash.result.kind === "prompt") {
              await runPromptTurn(slash.result.content);
              return;
            }
            if (slash.result.kind === "exit") {
              activeInkUnmount?.();
            }
            return;
        }
      }

      await runPromptTurn(message);
    },
    flushEventLog: () => {
      params.session.rolloutStore?.flushDurable();
    },
  });

  return () => {
    sessionRef = null;
    params.session.installTurnDriverHooks(null);
  };
}

// ─────────────────────────────────────────────────────────────────────
// Wave 5-B: shared module-level unmount ref. Signal handlers call this
// before `session.abortTerminal(...)` so the Ink tree tears down cleanly
// when a TUI is active. The wrapper is `null` while only the one-shot
// path is running.
// ─────────────────────────────────────────────────────────────────────

let activeInkUnmount: (() => void) | null = null;

/** Test-only helper — reset the module-level unmount ref between tests. */
export function __resetActiveInkUnmountForTest(): void {
  activeInkUnmount = null;
}

/** Test-only helper — install an unmount hook from unit tests. */
export function __setActiveInkUnmountForTest(fn: (() => void) | null): void {
  activeInkUnmount = fn;
}

// ─────────────────────────────────────────────────────────────────────
// One-shot CLI — the legacy non-TUI path.
// ─────────────────────────────────────────────────────────────────────

/**
 * Run a single turn through the phase machine and exit. This is the
 * original `main()` body preserved verbatim; Wave 5-B introduces
 * routing above it so piped + `--no-tui` invocations still see the same
 * pixel-identical behavior.
 *
 * When `userMessage` is a non-empty string (routing path), it's used as
 * the prompt directly. Otherwise the function falls back to the
 * `resolveUserMessage` argv/stdin pipeline so legacy entry paths still
 * work without a pre-resolved prompt.
 */
export async function oneShotCLI(
  userMessage: string | null = null,
): Promise<number> {
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

    // Step 2: resolve user message. The router may have pre-resolved
    // the prompt from argv; fall through to stdin when nothing was
    // passed (preserves the legacy piped-only path).
    const resolvedUserMessage =
      userMessage !== null && userMessage.length > 0
        ? userMessage
        : await resolveUserMessage(initAbort.signal);
    throwIfAborted("resolveUserMessage");

    // Step 3: shared local-runtime bootstrap contract. Both the
    // one-shot CLI and TUI entry adapters construct their Session
    // through this helper so the entry surface owns less runtime
    // setup directly.
    const {
      sessionSlot,
      delegateSessionHolder,
      toolRegistryOptions,
    } = createSharedBootstrapTooling();
    const {
      agencHome,
      configStore,
      workspaceRoot,
      resolvedProvider,
      registry,
      session,
      ctx,
      memoryDir,
      memoryMdPath,
      shutdown,
    } = await bootstrapLocalRuntimeSession({
      env: process.env,
      argv: process.argv,
      cwd: processCwd(),
      toolRegistryOptions,
    });
    throwIfAborted("bootstrapLocalRuntimeSession");

    throwIfAborted("Session");

    // Now that the Session exists, fill the bash observer slot so
    // `exec_command_begin` / `exec_command_end` events land on the
    // session event log. MCP attach/start is owned by the session
    // boundary inside `bootstrapLocalRuntimeSession(...)`.
    sessionSlot.current = session;
    // T9: give the delegate tool its real Session reference.
    delegateSessionHolder.current = session;

    let sessionRef: Session | null = session;
    installSignalHandlers(() => sessionRef, configReloadLatch);

    // Init complete — tear down init-phase signal handlers (Session
    // now owns its own) and drop the cleanup stack since the session
    // finally-block below takes over.
    uninstallInitSignals();
    // Drain the stack without running finalisers; the finally-block
    // below hands off to the session lifecycle helper.
    await cleanup.unwind(() => {
      /* swallow — we're handing off to session's own lifecycle */
    });

    // Slash-command short-circuit. `runSlashCommand` is the only entry
    // path now, including the session-backed worktree commands.
    if (resolvedUserMessage.trimStart().startsWith("/")) {
      try {
        const runResult = await runSlashCommand(resolvedUserMessage, {
          session,
          cwd: processCwd(),
          home: agencHome,
          configStore,
        });
        switch (runResult.kind) {
          case "skip":
            process.stderr.write(
              /[\r\n]/.test(resolvedUserMessage)
                ? "agenc: slash command rejected (multi-line input not allowed)\n"
                : "agenc: slash command rejected (invalid syntax)\n",
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
        sessionSlot.current = null;
        delegateSessionHolder.current = null;
        await shutdown().catch(() => {
          /* best effort */
        });
      }
    }

    const loadTurnInputsFn = () =>
      prepareTurnRuntimeInputs({
        session,
        configStore,
        workspaceRoot,
        memoryDir,
        memoryMdPath,
        registry,
      });

    // R1 seam: one LLM turn runs through `runSingleTurn`, which owns
    // the between-turn reload + system-prompt assembly + runTurn loop.
    // A future multi-turn REPL iterates this helper in a while-loop;
    // the single-shot CLI just runs it exactly once.
    try {
      for await (const event of runSingleTurn({
        session,
        ctx,
        input: resolvedUserMessage,
        configStore,
        configReloadLatch,
        loadTurnInputsFn,
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
      sessionSlot.current = null;
      delegateSessionHolder.current = null;
      await shutdown().catch(() => {
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
    if (error instanceof SessionLockedError || error instanceof SchemaMismatchError) {
      process.stderr.write(`agenc: ${error.message}\n`);
      await cleanup.unwind((name, err) => {
        process.stderr.write(
          `agenc: cleanup[${name}] failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      });
      return 1;
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

// ─────────────────────────────────────────────────────────────────────
// T12 Wave 5-B — TUI entry adapters
// ─────────────────────────────────────────────────────────────────────

/**
 * Load `tui/main.js` via dynamic import so the main `tsconfig.json`
 * (which excludes `src/tui/**`) can still typecheck `bin/agenc.ts`.
 * The TUI module itself is compiled through `tsconfig.tui.json`.
 */
async function loadBootTUI(): Promise<
  (opts: {
    session: unknown;
    configStore: unknown;
    model?: string;
    initialPrompt?: string;
  }) => Promise<{ unmount: () => void; waitUntilExit: () => Promise<void> }>
> {
  // The path is relative to the *compiled* output layout (both
  // `src/bin/agenc.ts` and `src/tui/main.tsx` emit into sibling
  // directories under `dist/`). We dodge static resolution by passing
  // the specifier through a variable — the main `tsconfig.json`
  // excludes `src/tui/**` so a direct `import("../tui/main.js")`
  // would fail to typecheck for lack of JSX configuration. The TUI
  // module is compiled through `tsconfig.tui.json` + tsup; runtime
  // resolution works unchanged because `dist/tui/main.js` sits next
  // to `dist/bin/agenc.js`.
  const specifier = "../tui/main.js";
  const mod = (await import(specifier)) as {
    readonly bootTUI: (opts: {
      session: unknown;
      configStore: unknown;
      model?: string;
      initialPrompt?: string;
    }) => Promise<{
      unmount: () => void;
      waitUntilExit: () => Promise<void>;
    }>;
  };
  return mod.bootTUI;
}

type BootTUIEntryArgs = BootTUIArgs & { readonly resumeId?: string };

/**
 * Boot the TUI with a pre-populated composer prompt. Wave 5-B wires the
 * option through to `bootTUI`; actual composer wiring is a follow-up
 * (see TODO inside the composer reducer).
 */
export async function bootTUIEntry(args: BootTUIEntryArgs): Promise<number> {
  try {
    validateAgencHome();
    const {
      sessionSlot,
      delegateSessionHolder,
      toolRegistryOptions,
    } = createSharedBootstrapTooling();
    const {
      configStore,
      workspaceRoot,
      resolvedProvider,
      registry,
      model,
      session,
      memoryDir,
      memoryMdPath,
      shutdown,
    } = await bootstrapLocalRuntimeSession({
      env: process.env,
      argv: process.argv,
      cwd: processCwd(),
      toolRegistryOptions,
      ...(args.resumeId !== undefined ? { conversationId: args.resumeId } : {}),
    });
    try {
      sessionSlot.current = session;
      delegateSessionHolder.current = session;

      const loadTurnInputsFn = () =>
        prepareTurnRuntimeInputs({
          session,
          configStore,
          workspaceRoot,
          memoryDir,
          memoryMdPath,
          registry,
        });
      const uninstallTuiSessionContract = installTuiSessionContract({
        session,
        configStore,
        resolvedProvider,
        loadTurnInputsFn,
      });

      try {
        const boot = await loadBootTUI();
        const handle = await boot({
          session,
          configStore,
          model,
          ...(args.initialPrompt !== undefined
            ? { initialPrompt: args.initialPrompt }
            : {}),
        });
        activeInkUnmount = handle.unmount;
        await handle.waitUntilExit();
        return 0;
      } finally {
        activeInkUnmount = null;
        uninstallTuiSessionContract();
      }
    } finally {
      sessionSlot.current = null;
      delegateSessionHolder.current = null;
      await shutdown().catch(() => {
        /* best effort */
      });
    }
  } catch (error) {
    if (error instanceof SessionLockedError || error instanceof SchemaMismatchError) {
      process.stderr.write(`agenc: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/**
 * Resume a prior session through the TUI. The entry adapter verifies the
 * requested id exists, then re-enters the shared bootstrap path with the
 * original conversation id so rollout reconstruction can hydrate the
 * session state and transcript before Ink mounts.
 */
export async function resumeTUIEntry(args: ResumeTUIArgs): Promise<number> {
  const agencHome = resolveAgencHomeFromEnv(process.env);
  // Fast-path lookup — we just need to confirm the id exists under
  // `<agencHome>/sessions/<id>.json` OR in any per-project rollout
  // directory. Per the task spec, treat a missing session as a hard
  // fail so the caller sees `agenc: session not found: <id>` and exit 1.
  const sessionPath = join(agencHome, "sessions", `${args.resumeId}.json`);
  if (!existsSync(sessionPath)) {
    // Look for the id inside any project rollout directory before
    // giving up so resume still works regardless of where the session
    // was recorded.
    const workspaceRoot = resolveWorkspaceFromEnv(process.env) ?? processCwd();
    const projectDir = getProjectDir(workspaceRoot);
    const rolloutDir = join(projectDir, "sessions", args.resumeId);
    if (!existsSync(rolloutDir)) {
      process.stderr.write(`agenc: session not found: ${args.resumeId}\n`);
      return 1;
    }
  }

  return bootTUIEntry({ resumeId: args.resumeId });
}

/**
 * Openclaude-style CLI startup gate: config reads must be enabled before any
 * downstream path can touch global settings (auto-compact, theme, provider
 * profiles, etc.). AgenC routes both the one-shot and Ink console through this
 * same entrypoint, so the gate belongs here rather than in individual phases.
 */
export function initializeCliRuntime(): void {
  enableConfigs();
}

// ─────────────────────────────────────────────────────────────────────
// main — Wave 5-B routing entrypoint
// ─────────────────────────────────────────────────────────────────────

/**
 * Top-level dispatcher. Branches between the full Ink TUI and the
 * legacy one-shot CLI based on argv + stdio state. See `./route.ts`
 * for the routing table.
 */
export async function main(): Promise<number> {
  initializeCliRuntime();
  return routeCLI({
    argv: process.argv,
    isTTY: Boolean(process.stdin.isTTY),
    isStdoutTTY: Boolean(process.stdout.isTTY),
    bootTUI: (args: BootTUIArgs) => bootTUIEntry(args),
    oneShotCLI: (userMessage: string) =>
      oneShotCLI(userMessage.length > 0 ? userMessage : null),
    resumeTUI: (args: ResumeTUIArgs) => resumeTUIEntry(args),
  });
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
