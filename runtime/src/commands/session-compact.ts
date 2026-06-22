import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import React from "react";
import type { LLMContentPart, LLMMessage, LLMProvider, LLMTool } from "../llm/types.js";
import {
  cloneLlmContent as cloneContent,
  fromRuntimeMessageContent,
  toRuntimeMessageContent,
} from "../llm/content-conversion.js";
import { readProviderFactoryOptions } from "../llm/provider.js";
import type { CompactionResult, RuntimeMessage } from "../services/compact/types.js";
import type { CompactedItem, ResponseItem } from "../session/rollout-item.js";
import type { Session } from "../session/session.js";
import { llmMessageToResponseItem } from "../session/message-history-conversion.js";
import type { TurnContext } from "../session/turn-context.js";
import { modelContextWindow } from "../session/turn-context.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../permissions/types.js";
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from "../constants/toolLimits.js";
import {
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from "../services/compact/autoCompact.js";
import { roughTokenCountEstimationForMessages } from "../llm/token-estimation.js";
import {
  assembleSystemPrompt,
  buildAssembleSystemPromptOpts,
  type McpServerInstructionsInput,
} from "../prompts/system-prompt.js";
import { loadSessionMcpServerInstructions } from "../prompts/mcp-server-instructions.js";
import {
  assembleTieredInstructions,
  loadTieredInstructions,
} from "../prompts/agenc-md.js";
import { openCompactStatusModal } from "./compact-menu.js";
import { openAsyncLocalJsxCommand } from "./local-jsx-command.js";

/**
 * Both /compact and /context allocate a fresh TurnContext via the
 * in-process Session API. The TUI dispatches against an
 * AgenCBridgeSession (daemon client; tui/session-types.ts:36) that
 * does NOT expose `newDefaultTurnWithSubId` or `nextInternalSubId`,
 * so calling them unguarded raises `is not a function` and surfaces
 * as a raw JS exception in a red user-facing box. Treat the missing
 * methods as "this command needs the in-process runtime" and return
 * a friendly explanation instead of crashing.
 */
function tryAllocateTurnContext(ctx: SlashCommandContext): {
  readonly ok: true;
  readonly turnContext: TurnContext;
} | { readonly ok: false; readonly message: string } {
  const session = ctx.session as unknown as {
    newDefaultTurnWithSubId?: (subId: string) => TurnContext | null | undefined;
    nextInternalSubId?: () => string;
  };
  if (
    typeof session.newDefaultTurnWithSubId !== "function" ||
    typeof session.nextInternalSubId !== "function"
  ) {
    return {
      ok: false,
      message:
        "This command requires the in-process runtime and is not yet supported when the TUI is running against the daemon.",
    };
  }
  const turnContext = session.newDefaultTurnWithSubId(
    session.nextInternalSubId(),
  );
  if (!turnContext) {
    return { ok: false, message: "No turn context is available." };
  }
  return { ok: true, turnContext };
}

/**
 * Result of the daemon-backed `session.partialCompactFromMessage` RPC,
 * narrowed to the fields `/compact` needs. The bridge session declares
 * this method (tui/daemon-session.ts); the in-process Session does not,
 * so its absence is the signal to fall back to the in-process path.
 */
interface DaemonCompactResult {
  readonly ok: boolean;
  readonly message?: string;
}

type DaemonCompactFn = (params: {
  readonly messageOrdinal: number;
  readonly direction: "from" | "up_to";
  readonly feedback?: string;
}) => Promise<DaemonCompactResult>;

function daemonCompactFn(ctx: SlashCommandContext): DaemonCompactFn | null {
  const fn = (ctx.session as unknown as {
    partialCompactFromMessage?: DaemonCompactFn;
  }).partialCompactFromMessage;
  return typeof fn === "function" ? fn.bind(ctx.session) : null;
}

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Compact the current conversation",
  supportedSurfaces: ["runtime", "daemon-tui"],
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      await ensureNoActiveTurn(ctx);
      const allocated = tryAllocateTurnContext(ctx);
      if (!allocated.ok) {
        // Daemon-backed TUI: the in-process compaction path is unavailable
        // (no `newDefaultTurnWithSubId`), but the daemon already exposes a
        // fully-wired `session.partialCompactFromMessage` RPC. Compact the
        // live session forward from its first active message
        // (messageOrdinal: 0, direction: "from") = a full compaction. The
        // daemon emits its own `context_compacted` boundary event, already
        // rendered by the transcript, so we only surface a short summary.
        const daemonCompact = daemonCompactFn(ctx);
        if (daemonCompact !== null) {
          const feedback = ctx.argsRaw.trim();
          const result = await daemonCompact({
            messageOrdinal: 0,
            direction: "from",
            ...(feedback.length > 0 ? { feedback } : {}),
          });
          if (!result.ok) {
            return {
              kind: "error",
              message:
                result.message ?? "Conversation compaction failed.",
            };
          }
          return {
            kind: "compact",
            text: "Conversation compacted.",
          };
        }
        const contextText = await buildFallbackContextUsageText(
          ctx,
          allocated.message,
        );
        if (
          openCompactStatusModal(ctx, {
            message: allocated.message,
            contextText,
          })
        ) {
          return { kind: "skip" };
        }
        return { kind: "error", message: allocated.message };
      }
      const result = await runManualCompact({
        session: ctx.session,
        ctx: allocated.turnContext,
        customInstructions: ctx.argsRaw,
      });
      return {
        kind: "compact",
        text: result.displayText,
      };
    }),
};

export const contextCommand: SlashCommand = {
  name: "context",
  aliases: ["ctx"],
  description: "Show current context usage",
  supportedSurfaces: ["runtime", "daemon-tui"],
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const allocated = tryAllocateTurnContext(ctx);
      if (!allocated.ok) {
        const text = await buildFallbackContextUsageText(ctx, allocated.message);
        if (await openContextUsageModal(ctx, text)) {
          return { kind: "skip" };
        }
        return { kind: "text", text };
      }
      const result = await runContextUsage({
        session: ctx.session,
        ctx: allocated.turnContext,
        args: ctx.argsRaw,
      });
      if (await openContextUsageModal(ctx, result.text)) {
        return { kind: "skip" };
      }
      return {
        kind: "text",
        text: result.text,
      };
    }),
};

async function openContextUsageModal(
  ctx: SlashCommandContext,
  text: string,
): Promise<boolean> {
  return openAsyncLocalJsxCommand(ctx, async close => {
    const { ContextUsageModal } = await import(
      "../tui/components/v2/ContextUsageModal.js"
    );
    return React.createElement(ContextUsageModal, { text, onDone: close });
  });
}

async function buildFallbackContextUsageText(
  ctx: SlashCommandContext,
  reason: string,
): Promise<string> {
  const snapshot = await readDaemonTokenSnapshot(ctx);
  const sessionTokenUsage = readSessionTokenUsage(ctx.session, snapshot);
  const tools = readFallbackTools(ctx.session);
  const messages = readFallbackMessages(ctx.session);
  const config = ctx.configStore?.current() ?? ctx.session.services.configStore?.current?.();
  const model = readFallbackModel(ctx, config);
  const contextWindowTokens = readFallbackContextWindow(config);
  const estimated = computeContextUsageBreakdown({
    messages,
    tools,
    ...(model !== undefined ? { model } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(sessionTokenUsage !== undefined ? { sessionTokenUsage } : {}),
  });
  const totalFromEvents = snapshot?.tokenUsage?.totalTokens;
  const breakdown =
    typeof totalFromEvents === "number" && Number.isFinite(totalFromEvents)
      ? {
          ...estimated,
          messagesTokens: Math.max(0, totalFromEvents - estimated.toolsTokens),
          totalUsed: totalFromEvents,
          freeUntilCompact: Math.max(0, estimated.compactionThreshold - totalFromEvents),
          freeUntilHardLimit: Math.max(0, estimated.hardLimit - totalFromEvents),
        }
      : estimated;
  return [
    formatContextUsageReport(breakdown),
    `  • estimate: ${reason}`,
  ].join("\n");
}

async function readDaemonTokenSnapshot(
  ctx: SlashCommandContext,
): Promise<{ readonly tokenUsage?: {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
} } | null> {
  const getDaemonSnapshot = (
    ctx.session as unknown as {
      getDaemonSessionSnapshot?: () => Promise<{
        readonly tokenUsage?: {
          readonly inputTokens?: number;
          readonly outputTokens?: number;
          readonly totalTokens?: number;
          readonly costUsd?: number;
        };
      }>;
    }
  ).getDaemonSessionSnapshot;
  if (typeof getDaemonSnapshot !== "function") return null;
  try {
    return await getDaemonSnapshot();
  } catch {
    return null;
  }
}

function readSessionTokenUsage(
  session: Session,
  snapshot: Awaited<ReturnType<typeof readDaemonTokenSnapshot>>,
): ContextUsageInputs["sessionTokenUsage"] | undefined {
  if (snapshot?.tokenUsage?.totalTokens !== undefined) {
    return {
      promptTokens: snapshot.tokenUsage.inputTokens ?? snapshot.tokenUsage.totalTokens,
      cachedInputTokens: 0,
    };
  }
  const unsafePeek = (session as unknown as {
    state?: { unsafePeek?: () => unknown };
  }).state?.unsafePeek;
  const state = typeof unsafePeek === "function"
    ? unsafePeek.call((session as unknown as { state?: unknown }).state)
    : null;
  const usage = state && typeof state === "object"
    ? (state as { totalTokenUsage?: ContextUsageInputs["sessionTokenUsage"] }).totalTokenUsage
    : undefined;
  return usage;
}

function readFallbackTools(session: Session): readonly LLMTool[] {
  try {
    return session.services.registry?.toLLMTools?.() ?? [];
  } catch {
    return [];
  }
}

function readFallbackMessages(session: Session): RuntimeMessage[] {
  try {
    const snapshotHistoryMessages = (session as unknown as {
      snapshotHistoryMessages?: () => readonly LLMMessage[];
    }).snapshotHistoryMessages;
    return typeof snapshotHistoryMessages === "function"
      ? toAgenCRuntimeMessages(snapshotHistoryMessages.call(session))
      : [];
  } catch {
    return [];
  }
}

function readFallbackModel(
  ctx: SlashCommandContext,
  config: { readonly model?: string } | undefined,
): string | undefined {
  const appState = ctx.appState?.getAppState?.();
  if (appState && typeof appState === "object") {
    const model = (appState as { readonly mainLoopModel?: unknown }).mainLoopModel;
    if (typeof model === "string" && model.trim().length > 0) return model;
  }
  return config?.model;
}

function readFallbackContextWindow(
  config: {
    readonly model_provider?: string;
    readonly providers?: Readonly<Record<string, { readonly context_window_tokens?: number }>>;
  } | undefined,
): number | undefined {
  const provider = config?.model_provider;
  if (!provider) return undefined;
  const contextWindow = config?.providers?.[provider]?.context_window_tokens;
  return typeof contextWindow === "number" && contextWindow > 0
    ? contextWindow
    : undefined;
}

async function ensureNoActiveTurn(ctx: SlashCommandContext): Promise<void> {
  const activeTurn = (ctx.session as unknown as {
    activeTurn?: { unsafePeek?: () => unknown };
  }).activeTurn;
  if (activeTurn?.unsafePeek?.() != null) {
    throw new Error(
      "Cannot compact right now: a turn is currently in flight; wait for it to complete before running /compact.",
    );
  }
}

interface AgenCModelContext {
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
}

function toAgenCModelContext(ctx: TurnContext): AgenCModelContext {
  const contextWindowTokens = modelContextWindow(ctx) ?? ctx.modelInfo.contextWindow;
  if (
    typeof contextWindowTokens !== "number" ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    throw new Error(`Missing context window for model ${ctx.modelInfo.slug}`);
  }
  return {
    model: ctx.modelInfo.slug,
    contextWindowTokens,
    ...(ctx.modelInfo.maxOutputTokens !== undefined
      ? { maxOutputTokens: ctx.modelInfo.maxOutputTokens }
      : {}),
  };
}

interface AgenCToolUseContext {
  readonly abortController: AbortController;
  readonly agentId?: string;
  readonly sessionId: string;
  readonly options: {
    readonly mainLoopModel: string;
    readonly tools: readonly AgenCRuntimeTool[];
    readonly mcpClients: readonly unknown[];
    readonly contextWindowTokens: number;
    readonly maxOutputTokens?: number;
    readonly providerOverride?: {
      readonly model: string;
      readonly baseURL: string;
      readonly apiKey: string;
    };
    readonly querySource?: string;
    readonly agentDefinitions: { readonly activeAgents: readonly unknown[] };
    readonly isNonInteractiveSession: boolean;
    readonly cwd?: string;
    readonly verbose: boolean;
  };
  readonly getAppState: () => {
    readonly toolPermissionContext: unknown;
    readonly agentDefinitions: { readonly activeAgents: readonly unknown[] };
    readonly tasks: Record<string, unknown>;
  };
  readonly readFileState: Map<string, unknown>;
  readonly loadedNestedMemoryPaths: Set<string>;
  readonly setStreamMode: (mode: "requesting" | "responding" | null) => void;
  readonly setResponseLength: (updater: (length: number) => number) => void;
  readonly onCompactProgress: (event: unknown) => void;
  readonly setSDKStatus: (status: "compacting" | null) => void;
  readonly addNotification: (notification: unknown) => void;
  readonly emitWarning: (warning: { readonly cause: string; readonly message: string }) => void;
  readonly queryTracking?: {
    readonly chainId?: string;
    readonly depth?: number;
  };
  readonly clearProviderResponseId: () => void;
  readonly rolloutStore?: unknown;
  readonly session?: { readonly rolloutStore?: unknown };
  readonly provider?: LLMProvider;
  readonly cwd?: string;
}

type AgenCRuntimeTool = LLMTool & {
  readonly name: string;
  readonly description: string;
  readonly inputJSONSchema: Record<string, unknown>;
  readonly isMcp: boolean;
  readonly maxResultSizeChars: number;
};

function buildAgenCToolUseContext(
  session: Session,
  ctx: TurnContext,
  opts: { readonly querySource?: string; readonly verbose?: boolean } = {},
): AgenCToolUseContext {
  const model = toAgenCModelContext(ctx);
  const providerOverride = buildProviderOverride(session, model.model);
  const surface = readSessionSurface(session);
  const agentDefinitions = {
    activeAgents: Array.isArray(surface.agentDefinitions?.activeAgents)
      ? [...surface.agentDefinitions.activeAgents]
      : [],
  };
  const cwd = ctx.cwd;
  return {
    abortController: session.abortController ?? new AbortController(),
    sessionId: session.conversationId,
    options: {
      mainLoopModel: model.model,
      tools: toAgenCRuntimeTools(session.services.registry.toLLMTools()),
      mcpClients: Array.isArray(surface.mcpClients) ? surface.mcpClients : [],
      contextWindowTokens: model.contextWindowTokens,
      ...(model.maxOutputTokens !== undefined
        ? { maxOutputTokens: model.maxOutputTokens }
        : {}),
      ...(providerOverride !== undefined ? { providerOverride } : {}),
      ...(opts.querySource !== undefined ? { querySource: opts.querySource } : {}),
      agentDefinitions,
      isNonInteractiveSession: false,
      cwd,
      verbose: opts.verbose ?? false,
    },
    getAppState: () => ({
      toolPermissionContext:
        session.permissionModeRegistry?.current?.() ??
        session.services.permissionModeRegistry?.current?.() ??
        createEmptyToolPermissionContext(),
      agentDefinitions,
      tasks: surface.tasks ?? {},
    }),
    readFileState: surface.readFileState ?? new Map<string, unknown>(),
    loadedNestedMemoryPaths:
      surface.loadedNestedMemoryPaths ?? new Set<string>(),
    setStreamMode: surface.setStreamMode ?? (() => {}),
    setResponseLength: surface.setResponseLength ?? (() => {}),
    onCompactProgress: surface.onCompactProgress ?? (() => {}),
    setSDKStatus: surface.setSDKStatus ?? (() => {}),
    addNotification: surface.addNotification ?? (() => {}),
    emitWarning:
      surface.emitWarning ??
      ((warning) => {
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: warning,
          },
        });
      }),
    ...(surface.queryTracking !== undefined
      ? { queryTracking: surface.queryTracking }
      : {}),
    clearProviderResponseId: () => session.clearProviderResponseId(),
    ...(session.rolloutStore !== undefined ? { rolloutStore: session.rolloutStore } : {}),
    ...(session.rolloutStore !== undefined
      ? { session: { rolloutStore: session.rolloutStore } }
      : {}),
    provider: session.services.provider,
    cwd,
  };
}

function toAgenCRuntimeTools(tools: readonly LLMTool[]): AgenCRuntimeTool[] {
  return tools.map((tool) => {
    const name = tool.function.name;
    return {
      ...tool,
      name,
      description: tool.function.description,
      inputJSONSchema: tool.function.parameters,
      isMcp: name.startsWith("mcp__"),
      maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
    };
  });
}

function buildProviderOverride(
  session: Session,
  fallbackModel: string,
): AgenCToolUseContext["options"]["providerOverride"] | undefined {
  const provider = session.services.provider;
  const options = readProviderFactoryOptions(provider);
  const model = firstNonEmpty(options.model, fallbackModel);
  const baseURL = firstNonEmpty(options.baseURL);
  if (!model || !baseURL) return undefined;
  return {
    model,
    baseURL,
    apiKey: options.apiKey ?? "",
  };
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

type SessionSurface = {
  readonly readFileState?: Map<string, unknown>;
  readonly loadedNestedMemoryPaths?: Set<string>;
  readonly mcpClients?: readonly unknown[];
  readonly agentDefinitions?: { readonly activeAgents?: readonly unknown[] };
  readonly tasks?: Record<string, unknown>;
  readonly queryTracking?: {
    readonly chainId?: string;
    readonly depth?: number;
  };
  readonly setStreamMode?: (mode: "requesting" | "responding" | null) => void;
  readonly setResponseLength?: (updater: (length: number) => number) => void;
  readonly onCompactProgress?: (event: unknown) => void;
  readonly setSDKStatus?: (status: "compacting" | null) => void;
  readonly addNotification?: (notification: unknown) => void;
  readonly emitWarning?: (warning: { readonly cause: string; readonly message: string }) => void;
};

function readSessionSurface(session: Session): SessionSurface {
  const snapshot = session.state.unsafePeek() as unknown as Record<string, unknown>;
  const direct = session as unknown as Record<string, unknown>;
  const read = <T>(key: keyof SessionSurface): T | undefined => {
    const directValue = direct[key];
    if (directValue !== undefined) return directValue as T;
    const snapshotValue = snapshot[key];
    if (snapshotValue !== undefined) return snapshotValue as T;
    return undefined;
  };
  return {
    readFileState: read<Map<string, unknown>>("readFileState"),
    loadedNestedMemoryPaths: read<Set<string>>("loadedNestedMemoryPaths"),
    mcpClients: read<readonly unknown[]>("mcpClients"),
    agentDefinitions:
      read<{ readonly activeAgents?: readonly unknown[] }>("agentDefinitions"),
    tasks: read<Record<string, unknown>>("tasks"),
    queryTracking: read<{ readonly chainId?: string; readonly depth?: number }>(
      "queryTracking",
    ),
    setStreamMode:
      read<(mode: "requesting" | "responding" | null) => void>("setStreamMode"),
    setResponseLength:
      read<(updater: (length: number) => number) => void>("setResponseLength"),
    onCompactProgress: read<(event: unknown) => void>("onCompactProgress"),
    setSDKStatus: read<(status: "compacting" | null) => void>("setSDKStatus"),
    addNotification: read<(notification: unknown) => void>("addNotification"),
    emitWarning:
      read<(warning: { readonly cause: string; readonly message: string }) => void>(
        "emitWarning",
      ),
  };
}

const AGENC_COMPACT_BOUNDARY = "<compact>";
const COMPACT_CONTEXT_GUARD_ENV = [
  "AGENC_USE_OPENAI",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW",
] as const;

interface AgenCAutoCompactResult {
  readonly wasCompacted: boolean;
  readonly compactionResult?: {
    readonly message: string;
    readonly replacementHistory: readonly LLMMessage[];
    readonly preCompactTokens?: number;
    readonly postCompactTokens?: number;
  };
  readonly consecutiveFailures?: number;
}

interface AgenCManualCompactResult {
  readonly displayText: string;
  readonly compactionResult: NonNullable<AgenCAutoCompactResult["compactionResult"]>;
}

interface AgenCContextUsageResult {
  readonly text: string;
}

type AgenCMessageRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";

interface AgenCMessage {
  readonly role: AgenCMessageRole;
  readonly content: string | readonly LLMContentPart[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly phase?: string;
}

type AgenCRuntimeWireRole = NonNullable<RuntimeMessage["role"]>;

type AgenCRuntimeMessage = Omit<
  RuntimeMessage,
  "role" | "originalRole" | "message"
> & {
  readonly role?: AgenCRuntimeWireRole;
  readonly originalRole?: AgenCMessage["role"];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments?: string;
  }[];
  readonly phase?: string;
  readonly type?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
  };
};

type AgenCCompactionResult = {
  readonly boundaryMarker?: AgenCRuntimeMessage;
  readonly summaryMessages?: readonly AgenCRuntimeMessage[];
  readonly messagesToKeep?: readonly AgenCRuntimeMessage[];
  readonly attachments?: readonly AgenCRuntimeMessage[];
  readonly hookResults?: readonly AgenCRuntimeMessage[];
  readonly userDisplayMessage?: string;
  readonly preCompactTokenCount?: number;
  readonly postCompactTokenCount?: number;
  readonly truePostCompactTokenCount?: number;
};

type CompactGuardEnv = Partial<Record<(typeof COMPACT_CONTEXT_GUARD_ENV)[number], string>>;

async function runManualCompact(params: {
  readonly session: Session;
  readonly ctx: TurnContext;
  readonly customInstructions?: string;
}): Promise<AgenCManualCompactResult> {
  const sourceMessages = params.session.snapshotHistoryMessages();
  const messages = toAgenCRuntimeMessages(messagesAfterAgenCBoundary(sourceMessages));
  if (messages.length === 0) {
    throw new Error("No messages to compact");
  }
  const toolUseContext = buildAgenCToolUseContext(
    params.session,
    params.ctx,
    { querySource: "compact" },
  );
  const commandContext = {
    ...toolUseContext,
    messages,
    setMessages: () => {},
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    onChangeAPIKey: () => {},
    options: {
      ...toolUseContext.options,
      commands: [],
      debug: false,
      thinkingConfig: {},
      mcpResources: {},
      dynamicMcpConfig: {},
      ideInstallationStatus: null,
      theme: "dark",
    },
  };
  const result = await withCompactContextGuards(async () => {
    const { manualCompactCall } =
      await import("../services/compact/compact.js");
    const call = manualCompactCall;
    return await call(params.customInstructions ?? "", commandContext as never);
  }, envForToolUseContext(toolUseContext));
  if (result.type !== "compact") {
    throw new Error("Compact command did not return a compaction result");
  }
  const compactionResultWithSlashMessages =
    await addManualCompactSlashMessages(
      result.compactionResult as AgenCCompactionResult,
      params.customInstructions ?? "",
      typeof result.displayText === "string" ? result.displayText : undefined,
    );
  await resetAgenCMicrocompactState(toolUseContext);
  const compactionResult = await toAgenCCompactionResult(
    compactionResultWithSlashMessages,
    toolUseContext,
  );
  const compacted = compactionResult.replacementHistory.map(cloneLLMMessage);
  await params.session.state.with((sessionState) => {
    sessionState.history = compacted.map(cloneLLMMessage);
  });
  params.session.clearProviderResponseId();
  params.session.rolloutStore?.appendRollout(
    {
      type: "compacted",
      payload: buildAgenCCompactedRolloutItem(compactionResult),
    },
    { durable: true },
  );
  return {
    displayText: typeof result.displayText === "string"
      ? result.displayText
      : compactionResult.message,
    compactionResult,
  };
}

async function runContextUsage(params: {
  readonly session: Session;
  readonly ctx: TurnContext;
  readonly args?: string;
}): Promise<AgenCContextUsageResult> {
  // The session's history (snapshotHistoryMessages) starts AFTER
  // the synthetic system message; durableHistoryStartIndex in
  // run-turn.ts strips it before the snapshot is recorded. So to
  // count what the model actually receives on the next turn we
  // have to RECONSTRUCT the per-turn system prompt and prepend it
  // ourselves. Reuses the same buildAssembleSystemPromptOpts +
  // assembleSystemPrompt + tiered loader (mtime-cached after Phase
  // 3 sg-4) that runSingleTurn calls — no parallel assembly path.
  //
  // Every field below mirrors what `runSingleTurn` resolves at
  // agenc.ts:760-770 so the displayed token count reflects the
  // actual wire payload (including the # MCP Server Instructions
  // block and the # Autonomous work section, which the previous
  // version of this code silently dropped).
  const tools = params.session.services.registry.toLLMTools();
  // Carry-forward #64: production resolves enabledToolNames from
  // `registry.allSpecs()` (via `prepareTurnRuntimeInputs.params.registry.tools`
  // at agenc.ts:852); /context here used `toLLMTools()` which only
  // returns visibleSpecs. The two diverge on deferred MCP tools that
  // are registered but not yet listed. Match production by walking
  // allSpecs when the registry exposes them; fall back to the visible
  // set when allSpecs isn't available (test fixtures).
  const allSpecsFn = (params.session.services.registry as unknown as {
    readonly allSpecs?: () => readonly { readonly name: string }[];
  }).allSpecs;
  const enabledToolNames = new Set(
    typeof allSpecsFn === "function"
      ? allSpecsFn.call(params.session.services.registry).map((spec) => spec.name)
      : tools.map((tool) => tool.function.name),
  );
  const projectInstructions = await loadProjectInstructionsForContext(
    params.session,
    params.ctx.cwd,
  );
  const mcpServers = await loadMcpServerInstructionsForContext(params.session);
  const systemMessage = await buildSyntheticSystemMessage({
    session: params.session,
    ctx: params.ctx,
    projectInstructions,
    mcpServers,
    enabledToolNames,
  });
  const sourceMessages = params.session.snapshotHistoryMessages();
  const conversationMessages = toAgenCRuntimeMessages(sourceMessages);
  const messages = systemMessage !== null
    ? [systemMessage, ...conversationMessages]
    : conversationMessages;
  const toolUseContext = buildAgenCToolUseContext(
    params.session,
    params.ctx,
    { querySource: "context" },
  );
  const sessionState = params.session.state.unsafePeek() as
    | { readonly totalTokenUsage?: {
        readonly promptTokens: number;
        readonly cachedInputTokens: number;
      } }
    | null;
  const sessionTokenUsage = sessionState?.totalTokenUsage !== undefined
    ? {
        promptTokens: sessionState.totalTokenUsage.promptTokens,
        cachedInputTokens: sessionState.totalTokenUsage.cachedInputTokens,
      }
    : undefined;
  const commandContext = {
    ...toolUseContext,
    messages,
    tools,
    options: {
      ...toolUseContext.options,
      customSystemPrompt: undefined,
      appendSystemPrompt: undefined,
    },
    ...(sessionTokenUsage !== undefined ? { sessionTokenUsage } : {}),
  };
  const result = await withCompactContextGuards(async () => {
    return contextUsageCall(params.args ?? "", commandContext as never);
  }, envForToolUseContext(toolUseContext));
  return { text: result.value };
}

/**
 * Resolve the project-tier AGENC.md (and tiered chain) for the
 * current cwd in the same shape runSingleTurn passes to
 * assembleSystemPrompt. Goes through the mtime-cached
 * loadTieredInstructions, so on a warm cache this is a few stat()
 * syscalls. Failures are best-effort: /context must never throw on
 * a missing/malformed AGENC.md. The production assembler at
 * `prepareTurnRuntimeInputs` surfaces these as user-visible warnings
 * via `formatTieredInstructionWarnings`; /context intentionally
 * skips that sink so the status display stays a read-only operation
 * — the warnings will still appear at the next real turn boundary.
 */
async function loadProjectInstructionsForContext(
  session: Session,
  cwd: string | undefined,
): Promise<string> {
  if (cwd === undefined) return "";
  try {
    // Carry-forward #63: pass projectRootMarkers and projectDocMaxBytes
    // from the active config the same way `prepareTurnRuntimeInputs`
    // does at agenc.ts:823-831. Without these, /context loads the
    // tier chain with default markers/limits and produces a count
    // that diverges from the real turn payload whenever the user
    // has either field set in their config.
    const currentConfig = session.services.configStore?.current();
    const tiered = await loadTieredInstructions({
      cwd,
      ...(currentConfig?.project_root_markers !== undefined
        ? { projectRootMarkers: currentConfig.project_root_markers }
        : {}),
      ...(currentConfig?.project_doc_max_bytes !== undefined
        ? { projectDocMaxBytes: currentConfig.project_doc_max_bytes }
        : {}),
    });
    return assembleTieredInstructions(tiered);
  } catch {
    return "";
  }
}

/**
 * Resolve connected-MCP-server `instructions` blocks for /context.
 * Mirrors `prepareTurnRuntimeInputs` at agenc.ts so the displayed
 * token count includes the `# MCP Server Instructions` section. Failure
 * to reach the MCP manager (no config store, transient disconnection)
 * collapses to the empty list — /context still produces a usable count
 * for the conversation + tool catalog + remainder of the system prompt.
 */
async function loadMcpServerInstructionsForContext(
  session: Session,
): Promise<readonly McpServerInstructionsInput[]> {
  try {
    const config = session.services.configStore?.current();
    if (config === undefined) return [];
    return await loadSessionMcpServerInstructions(session, config);
  } catch {
    return [];
  }
}

/**
 * Build a synthetic role:"system" RuntimeMessage that mirrors the
 * system prompt the next turn would carry. Used by /context so the
 * displayed token count includes AGENC.md + the assembler's static
 * head + dynamic sections (permissions, env-info, MCP server
 * instructions, autonomous-work prose, etc.).
 *
 * Routes through {@link buildAssembleSystemPromptOpts} so the input
 * shape stays in lock-step with `runSingleTurn`'s call at
 * agenc.ts:760-770. If a new field is added there, this site fails
 * to compile, preventing the silent under-count regression that the
 * Phase 3 reviewer flagged on commit 4ba0b3d4.
 *
 * Returns null if assembly fails — /context falls back to counting
 * only conversation + tools, which is still an improvement over the
 * pre-Phase-3 chars/4 heuristic. The caller surfaces a telemetry
 * tag (`systemAssemblyFailed`) so silent regressions become visible
 * to the operator.
 */
async function buildSyntheticSystemMessage(opts: {
  readonly session: Session;
  readonly ctx: TurnContext;
  readonly projectInstructions: string;
  readonly mcpServers: readonly McpServerInstructionsInput[];
  readonly enabledToolNames: ReadonlySet<string>;
}): Promise<RuntimeMessage | null> {
  try {
    let permissionContext: ToolPermissionContext | null = null;
    try {
      permissionContext = opts.session.permissionModeRegistry.current();
    } catch {
      permissionContext = null;
    }
    const autonomousMode =
      (opts.ctx.config as { readonly autonomousMode?: boolean } | undefined)
        ?.autonomousMode === true;
    const provider = opts.ctx.modelProviderId;
    const assembled = await assembleSystemPrompt(
      buildAssembleSystemPromptOpts({
        session: opts.session,
        ctx: opts.ctx,
        projectInstructions: opts.projectInstructions,
        // /context isn't a real turn boundary, so it has no `memdir`
        // tail to surface. Production passes
        // `turnInputs.memoryPromptText`, which is currently always ""
        // out of `prepareTurnRuntimeInputs`. Match that explicitly.
        memoryPrompt: "",
        mcpServers: opts.mcpServers,
        enabledToolNames: opts.enabledToolNames,
        provider,
        permissionContext,
        autonomousMode,
      }),
    );
    return {
      role: "system",
      type: "system",
      content: assembled.text,
      message: { role: "system", content: assembled.text },
    };
  } catch {
    return null;
  }
}

function buildAgenCCompactedRolloutItem(
  result: NonNullable<AgenCAutoCompactResult["compactionResult"]>,
) {
  return buildCompactedRolloutPayload({
    message: result.message,
    replacementHistory: result.replacementHistory,
    preCompactTokens: result.preCompactTokens,
    postCompactTokens: result.postCompactTokens,
  });
}

function toAgenCMessage(message: LLMMessage): AgenCMessage {
  return {
    role: message.role,
    content: cloneContent(message.content),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
  };
}

function toResponseItem(message: LLMMessage): ResponseItem {
  return llmMessageToResponseItem(message);
}

function buildCompactedRolloutPayload(params: {
  readonly message: string;
  readonly replacementHistory?: readonly LLMMessage[];
  readonly preCompactTokens?: number;
  readonly postCompactTokens?: number;
}): CompactedItem {
  return {
    message: params.message,
    ...(params.replacementHistory !== undefined
      ? { replacementHistory: params.replacementHistory.map(toResponseItem) }
      : {}),
    ...(params.preCompactTokens !== undefined
      ? { preCompactTokens: params.preCompactTokens }
      : {}),
    ...(params.postCompactTokens !== undefined
      ? { postCompactTokens: params.postCompactTokens }
      : {}),
  };
}

function messagesAfterAgenCBoundary(
  messages: readonly LLMMessage[],
): LLMMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith(AGENC_COMPACT_BOUNDARY)
    ) {
      return messages.slice(index + 1).map((item) => ({ ...item }));
    }
  }
  return messages.map((item) => ({ ...item }));
}

interface ContextUsageInputs {
  /**
   * The full conversation message history (must include the system
   * message and any AGENC.md content already merged into it). Used
   * with the family-aware token estimator from llm/token-estimation,
   * the same one auto-compaction uses, so the displayed numbers
   * match the threshold the auto-compactor will actually evaluate.
   */
  readonly messages: RuntimeMessage[];
  /**
   * The tool catalog the model is being told about. Counted as JSON
   * (which is how tools are serialized on the wire) so the display
   * accounts for tool overhead. The previous estimator excluded this
   * entirely and reported numbers far below what the model sees.
   */
  readonly tools: readonly LLMTool[];
  /** Provider hint forwarded to the family-aware estimator. */
  readonly providerHint?: { readonly provider?: string; readonly model?: string };
  /**
   * The model id used for window/threshold lookups. When undefined or
   * empty, falls back to the table-driven default in
   * lookupContextWindowForModel (128k).
   */
  readonly model?: string;
  /**
   * The configured hard limit for this session, when present.
   * Overrides the model-string lookup. This is the
   * AGENC_AUTO_COMPACT_WINDOW env or providers.<slug>.context_window_tokens
   * value flowing through CompactContext.options.contextWindowTokens.
   */
  readonly contextWindowTokens?: number;
  /**
   * Session-wide cumulative token usage from `session.state.totalTokenUsage`.
   * Optional: when missing the cache-hit summary is omitted from the
   * formatted report. The messages-API providers surface `cachedInputTokens`
   * and `cacheCreationInputTokens` separately; the Responses-API path
   * caches under the hood but does not break the count out by hit/miss.
   */
  readonly sessionTokenUsage?: {
    readonly promptTokens: number;
    readonly cachedInputTokens?: number;
    readonly cacheCreationInputTokens?: number;
  };
}

interface ContextUsageBreakdown {
  readonly hardLimit: number;
  readonly compactionThreshold: number;
  readonly autoCompactEnabled: boolean;
  readonly messagesTokens: number;
  readonly toolsTokens: number;
  readonly totalUsed: number;
  readonly freeUntilCompact: number;
  readonly freeUntilHardLimit: number;
  /**
   * Cumulative cache-hit ratio for this session, expressed as
   * cachedInputTokens / promptTokens (0..1). Undefined when no usage
   * data has landed yet (turn 0) or the provider doesn't report
   * cached-input breakdowns.
   */
  readonly cacheHitRatio?: number;
  readonly sessionPromptTokens?: number;
  readonly sessionCachedInputTokens?: number;
  readonly sessionCacheCreationTokens?: number;
}

/**
 * Compute the four-field breakdown {@link contextUsageCall} renders.
 * Pure function so it can be unit-tested without spinning up a
 * session, and so the math lives in one place rather than embedded in
 * the rendering code.
 *
 * Reuse over duplication:
 *   - getEffectiveContextWindowSize / getAutoCompactThreshold come
 *     from services/compact/autoCompact (same helpers the live
 *     auto-compactor uses to decide whether to fire). We MUST display
 *     the same numbers it will act on.
 *   - roughTokenCountEstimationForMessages comes from
 *     llm/token-estimation (family-aware: different model families
 *     pick different bytes/token ratios). Replaces the old chars/4
 *     heuristic that under-counted dense code blobs by ~30%.
 */
export function computeContextUsageBreakdown(
  inputs: ContextUsageInputs,
): ContextUsageBreakdown {
  // Use the same threshold helpers the auto-compactor uses so the
  // displayed numbers match what will actually fire.
  const lookup = inputs.contextWindowTokens !== undefined && inputs.contextWindowTokens > 0
    ? { options: { contextWindowTokens: inputs.contextWindowTokens, mainLoopModel: inputs.model } }
    : (inputs.model ?? "");
  const hardLimit = getEffectiveContextWindowSize(
    typeof lookup === "string" ? lookup : (lookup as never),
  );
  const autoCompactEnabled = isAutoCompactEnabled();
  const compactionThreshold = autoCompactEnabled
    ? getAutoCompactThreshold(typeof lookup === "string" ? lookup : (lookup as never))
    : hardLimit;
  const messagesTokens = roughTokenCountEstimationForMessages(
    inputs.messages,
    inputs.providerHint,
  );
  const toolsTokens = estimateToolCatalogTokens(inputs.tools);
  const totalUsed = messagesTokens + toolsTokens;
  // Cache-hit ratio is cumulative session-wide. Messages-API providers
  // surface `cachedInputTokens` and `cacheCreationInputTokens` separately
  // from the prompt total; Responses-API providers cache under the hood
  // without exposing the split (so we omit the line for them).
  let cacheHitRatio: number | undefined;
  let sessionPromptTokens: number | undefined;
  let sessionCachedInputTokens: number | undefined;
  let sessionCacheCreationTokens: number | undefined;
  if (inputs.sessionTokenUsage) {
    const usage = inputs.sessionTokenUsage;
    if (usage.cachedInputTokens !== undefined && usage.promptTokens > 0) {
      cacheHitRatio = Math.max(
        0,
        Math.min(1, usage.cachedInputTokens / usage.promptTokens),
      );
      sessionPromptTokens = usage.promptTokens;
      sessionCachedInputTokens = usage.cachedInputTokens;
      sessionCacheCreationTokens = usage.cacheCreationInputTokens;
    }
  }
  return {
    hardLimit,
    compactionThreshold,
    autoCompactEnabled,
    messagesTokens,
    toolsTokens,
    totalUsed,
    freeUntilCompact: Math.max(0, compactionThreshold - totalUsed),
    freeUntilHardLimit: Math.max(0, hardLimit - totalUsed),
    ...(cacheHitRatio !== undefined ? { cacheHitRatio } : {}),
    ...(sessionPromptTokens !== undefined ? { sessionPromptTokens } : {}),
    ...(sessionCachedInputTokens !== undefined
      ? { sessionCachedInputTokens }
      : {}),
    ...(sessionCacheCreationTokens !== undefined
      ? { sessionCacheCreationTokens }
      : {}),
  };
}

/**
 * Token estimate for the model-facing tool catalog. Tools are
 * serialized to JSON on the wire (one object per tool with name,
 * description, input schema), so a JSON-length / 4 estimate is the
 * cheapest faithful proxy. This is intentionally an over-estimate vs
 * the family-aware tokenizer for messages — the catalog is shorter
 * than the conversation, and over-counting tool overhead is the
 * conservative direction (the model sees this overhead too).
 */
function estimateToolCatalogTokens(tools: readonly LLMTool[]): number {
  if (tools.length === 0) return 0;
  // Stringify is best-effort: schemas can contain unserializable
  // values in tests, in which case we fall back to summing the
  // declared name+description lengths so we don't return zero.
  try {
    return Math.ceil(JSON.stringify(tools).length / 4);
  } catch {
    let chars = 0;
    for (const tool of tools) {
      chars += (tool.function?.name ?? "").length;
      chars += (tool.function?.description ?? "").length;
    }
    return Math.ceil(chars / 4);
  }
}

function formatContextUsageReport(breakdown: ContextUsageBreakdown): string {
  const used = breakdown.totalUsed.toLocaleString();
  const hard = breakdown.hardLimit.toLocaleString();
  const threshold = breakdown.compactionThreshold.toLocaleString();
  const usedPct = breakdown.hardLimit > 0
    ? Math.min(100, Math.round((breakdown.totalUsed / breakdown.hardLimit) * 100))
    : 0;
  const lines: string[] = [
    `Context: ${used} / ${hard} tokens (${usedPct}% of hard limit)`,
    `  • messages: ${breakdown.messagesTokens.toLocaleString()} tokens`,
    `  • tool catalog: ${breakdown.toolsTokens.toLocaleString()} tokens`,
  ];
  if (breakdown.autoCompactEnabled) {
    lines.push(
      `  • compaction threshold: ${threshold} tokens (${breakdown.freeUntilCompact.toLocaleString()} until auto-compact fires)`,
    );
  } else {
    lines.push(
      `  • auto-compact: disabled (hard limit applies; ${breakdown.freeUntilHardLimit.toLocaleString()} tokens free)`,
    );
  }
  if (
    breakdown.cacheHitRatio !== undefined &&
    breakdown.sessionPromptTokens !== undefined &&
    breakdown.sessionCachedInputTokens !== undefined
  ) {
    const pct = Math.round(breakdown.cacheHitRatio * 100);
    const cached = breakdown.sessionCachedInputTokens.toLocaleString();
    const prompt = breakdown.sessionPromptTokens.toLocaleString();
    const creation =
      breakdown.sessionCacheCreationTokens !== undefined
        ? `, ${breakdown.sessionCacheCreationTokens.toLocaleString()} written to cache`
        : "";
    lines.push(
      `  • prompt cache: ${pct}% hit (${cached} / ${prompt} prompt tokens served from cache${creation})`,
    );
  }
  return lines.join("\n");
}

async function contextUsageCall(
  _args: string,
  context: {
    readonly messages?: RuntimeMessage[];
    readonly options?: {
      readonly contextWindowTokens?: number;
      readonly mainLoopModel?: string;
      readonly tools?: readonly LLMTool[];
    };
    readonly provider?: { readonly name?: string };
    readonly tools?: readonly LLMTool[];
    readonly sessionTokenUsage?: {
      readonly promptTokens: number;
      readonly cachedInputTokens?: number;
      readonly cacheCreationInputTokens?: number;
    };
  }
): Promise<{ readonly value: string }> {
  const breakdown = computeContextUsageBreakdown({
    messages: context.messages ?? [],
    tools: context.tools ?? context.options?.tools ?? [],
    ...(context.options?.mainLoopModel !== undefined
      ? { model: context.options.mainLoopModel }
      : {}),
    ...(context.options?.contextWindowTokens !== undefined
      ? { contextWindowTokens: context.options.contextWindowTokens }
      : {}),
    providerHint: {
      ...(context.provider?.name !== undefined
        ? { provider: context.provider.name }
        : {}),
      ...(context.options?.mainLoopModel !== undefined
        ? { model: context.options.mainLoopModel }
        : {}),
    },
    ...(context.sessionTokenUsage !== undefined
      ? { sessionTokenUsage: context.sessionTokenUsage }
      : {}),
  });
  return { value: formatContextUsageReport(breakdown) };
}

async function toAgenCCompactionResult(
  result: AgenCCompactionResult,
  toolUseContext?: AgenCToolUseContext,
): Promise<NonNullable<AgenCAutoCompactResult["compactionResult"]>> {
  const replacementHistory = await withCompactContextGuards(async () => {
    const { buildPostCompactMessages } =
      await import("../services/compact/compact.js");
    return fromAgenCRuntimeMessages(
      buildPostCompactMessages(toCompactServiceResult(result)) as AgenCRuntimeMessage[],
    );
  }, toolUseContext ? envForToolUseContext(toolUseContext) : undefined);
  const postCompactTokens =
    result.truePostCompactTokenCount ?? result.postCompactTokenCount;
  return {
    message:
      result.userDisplayMessage ??
      extractMessageText(result.summaryMessages?.at(-1)) ??
      "Conversation compacted",
    replacementHistory,
    ...(result.preCompactTokenCount !== undefined
      ? { preCompactTokens: result.preCompactTokenCount }
      : {}),
    ...(postCompactTokens !== undefined ? { postCompactTokens } : {}),
  };
}

function toCompactServiceResult(result: AgenCCompactionResult): CompactionResult {
  if (!result.boundaryMarker) {
    throw new Error("Compaction result is missing its boundary marker");
  }
  return {
    boundaryMarker: result.boundaryMarker,
    summaryMessages: result.summaryMessages ?? [],
    attachments: result.attachments ?? [],
    hookResults: result.hookResults ?? [],
    ...(result.messagesToKeep !== undefined
      ? { messagesToKeep: result.messagesToKeep }
      : {}),
    ...(result.userDisplayMessage !== undefined
      ? { userDisplayMessage: result.userDisplayMessage }
      : {}),
    ...(result.preCompactTokenCount !== undefined
      ? { preCompactTokenCount: result.preCompactTokenCount }
      : {}),
    ...(result.postCompactTokenCount !== undefined
      ? { postCompactTokenCount: result.postCompactTokenCount }
      : {}),
    ...(result.truePostCompactTokenCount !== undefined
      ? { truePostCompactTokenCount: result.truePostCompactTokenCount }
      : {}),
  };
}

async function addManualCompactSlashMessages(
  result: AgenCCompactionResult,
  args: string,
  displayText: string | undefined,
): Promise<AgenCCompactionResult> {
  const {
    createSyntheticUserCaveatMessage,
    createUserMessage,
    formatCommandInputTags,
  } = await import("../services/compact/compact.js");
  const slashMessages: AgenCRuntimeMessage[] = [
    createSyntheticUserCaveatMessage(),
    createUserMessage({
      content: formatCommandInputTags("compact", args),
    }),
    ...(displayText
      ? [
        createUserMessage({
          content: `<local-command-stdout>${displayText}</local-command-stdout>`,
          timestamp: new Date(Date.now() + 100).toISOString(),
        }),
      ]
      : []),
  ] as AgenCRuntimeMessage[];
  return {
    ...result,
    messagesToKeep: [
      ...(result.messagesToKeep ?? []),
      ...slashMessages,
    ],
  };
}

async function resetAgenCMicrocompactState(
  toolUseContext: AgenCToolUseContext,
): Promise<void> {
  await withCompactContextGuards(async () => {
    const { resetMicrocompactState } =
      await import("../services/compact/microCompact.js");
    resetMicrocompactState();
  }, envForToolUseContext(toolUseContext));
}

function toAgenCRuntimeMessages(
  messages: readonly LLMMessage[],
): AgenCRuntimeMessage[] {
  return messages.map((message, index) => {
    const converted = toAgenCMessage(message);
    const runtimeContent = toRuntimeMessageContent(message.content);
    if (message.role === "system") {
      return {
        ...converted,
        role: "system",
        type: "system",
        content: runtimeContent,
        uuid: `agenc-system-${index}`,
        timestamp: new Date(0).toISOString(),
      };
    }
    const role = toAgenCRuntimeWireRole(message.role);
    return {
      ...converted,
      content: runtimeContent,
      role,
      ...(message.role !== role ? { originalRole: message.role } : {}),
      type: role,
      message: {
        role,
        content: runtimeContent,
      },
      uuid: `agenc-${role}-${index}`,
      timestamp: new Date(0).toISOString(),
      ...(message.toolCalls !== undefined
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            })),
          }
        : {}),
      ...(message.role === "tool" ? { isMeta: true } : {}),
    };
  });
}

function toAgenCRuntimeWireRole(role: LLMMessage["role"]): AgenCRuntimeWireRole {
  if (role === "tool") return "user";
  if (role === "developer") return "system";
  return role;
}

function fromAgenCRuntimeMessages(
  messages: readonly AgenCRuntimeMessage[],
): LLMMessage[] {
  return messages
    .map(fromAgenCRuntimeMessage)
    .filter((message): message is LLMMessage => message !== null);
}

function fromAgenCRuntimeMessage(
  message: AgenCRuntimeMessage,
): LLMMessage | null {
  if (message.role && message.content !== undefined) {
    const role = message.originalRole ?? message.role;
    return {
      role,
      content: fromRuntimeMessageContent(message.content),
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      ...(message.phase === "commentary" || message.phase === "final_answer"
        ? { phase: message.phase }
        : {}),
    };
  }
  const role = normalizeRole(message.message?.role ?? message.type);
  if (!role) return null;
  return {
    role,
    content: fromRuntimeMessageContent(readContent(message)),
  };
}

function normalizeRole(value: unknown): LLMMessage["role"] | null {
  if (
    value === "system" ||
    value === "developer" ||
    value === "user" ||
    value === "assistant" ||
    value === "tool"
  ) {
    return value;
  }
  return null;
}

function readContent(
  message: AgenCRuntimeMessage,
): LLMMessage["content"] {
  const content = message.message?.content ?? message.content ?? "";
  return cloneContent(content);
}

function extractMessageText(
  message: AgenCRuntimeMessage | undefined,
): string | undefined {
  if (!message) return undefined;
  const content = readContent(message);
  if (typeof content === "string") return content;
  const text = content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function cloneLLMMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    content: cloneContent(message.content),
  };
}

async function withCompactContextGuards<T>(
  fn: () => Promise<T>,
  env: CompactGuardEnv = {}
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env) as Array<keyof CompactGuardEnv>) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function envForToolUseContext(
  toolUseContext: AgenCToolUseContext,
): CompactGuardEnv {
  const providerOverride = toolUseContext.options.providerOverride;
  if (!providerOverride) return {};
  return {
    AGENC_USE_OPENAI: "1",
    OPENAI_MODEL: providerOverride.model,
    OPENAI_BASE_URL: providerOverride.baseURL,
    OPENAI_API_KEY: providerOverride.apiKey,
    AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW:
      toolUseContext.options.contextWindowTokens.toString(),
  };
}

// roughRuntimeTokenCount removed — its naive chars/4 estimator
// excluded the system prompt and tool catalog, producing displays
// that didn't match what auto-compact decided. /context now flows
// through computeContextUsageBreakdown which reuses the family-aware
// roughTokenCountEstimationForMessages and the same threshold
// helpers as autoCompact.
