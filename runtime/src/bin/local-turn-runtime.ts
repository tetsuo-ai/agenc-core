import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { PhaseEvent } from "../phases/events.js";
import type { Terminal } from "../session/turn-state.js";
import type { LLMContentPart } from "../llm/types.js";
import type { ConfigStore } from "../config/store.js";
import type { ConfigReloadLatch, maybeReloadConfigBetweenTurns } from "./agenc-main.js";
import { runTurn } from "../session/run-turn.js";
import { assembleSystemPrompt, buildAssembleSystemPromptOpts, resolveMemoryPromptInputs,
  type McpServerInstructionsInput } from "../prompts/system-prompt.js";
import { getOutputStyleConfig } from "../constants/outputStyles.js";
import { loadSessionMcpServerInstructions } from "../prompts/mcp-server-instructions.js";

export interface RunSingleTurnOpts {
  readonly session: Session;
  readonly ctx: TurnContext;
  readonly input: string | readonly LLMContentPart[];
  readonly agencHome?: string;
  /**
   * Transcript-facing prompt when `input` has model-only attachments injected.
   * `null` suppresses the visible user-message event for internal meta turns.
   */
  readonly displayInput?: string | null;
  readonly userStopGenerationToRelease?: number;
  /** T10: config snapshot + latch so `maybeReloadConfigBetweenTurns` can drain SIGUSR1. */
  readonly configStore: ConfigStore;
  readonly configReloadLatch: ConfigReloadLatch;
  /**
   * Preferred seam: load fresh prompt/memory/MCP inputs for this turn.
   * Called after between-turn reload handling so AGENTS, MEMORY, and
   * MCP instructions observe the latest snapshot on the next turn.
   */
  readonly loadTurnInputsFn?: () => Promise<PreparedTurnRuntimeInputs>;
  /** Compatibility direct inputs retained for focused unit tests. */
  readonly memoryPromptText?: string;
  readonly memoryInstructionsText?: string;
  readonly allMemories?: readonly [];
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
 *   3. invoke `runTurn` and forward every event
 *
 * A future multi-turn REPL loop calls this repeatedly with the same
 * session + ctx and a fresh `input` each iteration. The daemon-backed
 * one-shot CLI does not load this local compatibility driver.
 */
export async function* runSingleTurn(
  opts: RunSingleTurnOpts,
  defaultReload: typeof maybeReloadConfigBetweenTurns,
): AsyncGenerator<PhaseEvent, Terminal | undefined> {
  const reload = opts.reloadConfigFn ?? defaultReload;
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
        memoryPromptText: opts.memoryPromptText ?? "",
        memoryInstructionsText: opts.memoryInstructionsText ?? "",
        allMemories: opts.allMemories ?? [],
        enabledToolNames: opts.enabledToolNames ?? new Set<string>(),
        mcpServers: opts.mcpServers ?? [],
      };

  // Surface the active permission mode to the model. Approval-policy and
  // sandbox-mode prose is injected as a dynamic section by the assembler
  // when a context is supplied.
  let permissionContext = null as ReturnType<
    typeof opts.session.permissionModeRegistry.current
  > | null;
  try {
    permissionContext = opts.session.permissionModeRegistry.current();
  } catch {
    permissionContext = null;
  }

  // Route through the shared {@link buildAssembleSystemPromptOpts} helper
  // so the /context display (`runContextUsage`) and this production turn
  // driver always pass the same input shape to `assembleSystemPrompt`.
  // Adding a new required field here forces both sites to update at
  // compile time, preventing silent under-counts in the displayed
  // context size.
  const assembled = await assemble({
    ...buildAssembleSystemPromptOpts({
      session: opts.session,
      ctx: opts.ctx,
      // Session.runTurn is the sole owner of workspace instruction loading.
      projectInstructions: "",
      memoryInstructions: turnInputs.memoryInstructionsText ?? "",
      memoryPrompt: turnInputs.memoryPromptText,
      mcpServers: turnInputs.mcpServers,
      enabledToolNames: turnInputs.enabledToolNames,
      outputStyle: await getOutputStyleConfig(),
      provider: opts.provider,
      permissionContext,
      autonomousMode:
        (opts.ctx.config as { readonly autonomousMode?: boolean } | undefined)
          ?.autonomousMode === true,
    }),
    deferPermissionInstructions: opts.ctx.permissionInstructionsDeferred === true,
  });

  const iter = drive(opts.session, opts.ctx, opts.input, {
    systemPrompt: assembled.text,
    systemPromptReplacesBase: true,
    displayUserMessage: opts.displayInput,
    userStopGenerationToRelease: opts.userStopGenerationToRelease,
  });
  while (true) {
    const step = await iter.next();
    if (step.done) return step.value;
    yield step.value;
  }
}

export interface PreparedTurnRuntimeInputs {
  /** Memory directory block for the dynamic system-prompt tail. */
  readonly memoryPromptText: string;
  /** Path-free memory instructions for the cacheable system-prompt head. */
  readonly memoryInstructionsText?: string;
  readonly allMemories: readonly [];
  readonly enabledToolNames: ReadonlySet<string>;
  readonly mcpServers: readonly McpServerInstructionsInput[];
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
  const memory = await resolveMemoryPromptInputs(params.session, params.workspaceRoot);

  return {
    memoryPromptText: memory.memoryPrompt,
    memoryInstructionsText: memory.memoryInstructions,
    allMemories: [],
    enabledToolNames: new Set(params.registry.tools.map((tool) => tool.name)),
    mcpServers: await loadSessionMcpServerInstructions(
      params.session,
      currentConfig,
    ),
  };
}
