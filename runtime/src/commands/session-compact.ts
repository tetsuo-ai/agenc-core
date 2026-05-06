import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import type { LLMContentPart, LLMMessage, LLMProvider, LLMTool } from "../llm/types.js";
import { readProviderFactoryOptions } from "../llm/provider.js";
import type { CompactionResult, RuntimeMessage } from "../services/compact/types.js";
import type { CompactedItem, ResponseItem } from "../session/rollout-item.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import { modelContextWindow } from "../session/turn-context.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from "../constants/toolLimits.js";
import {
  AGENC_COMPACT_CALL_METRIC,
  AGENC_COMPACT_DURATION_METRIC,
  agencTelemetry,
  toMetricTags,
} from "../observability/telemetry.js";

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Compact the current conversation",
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      await ensureNoActiveTurn(ctx);
      const turnContext = ctx.session.newDefaultTurnWithSubId(
        ctx.session.nextInternalSubId(),
      );
      if (!turnContext) {
        return { kind: "error", message: "No turn context is available." };
      }
      const result = await runManualCompact({
        session: ctx.session,
        ctx: turnContext,
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
  description: "Show current context usage",
  immediate: true,
  supportsNonInteractive: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const turnContext = ctx.session.newDefaultTurnWithSubId(
        ctx.session.nextInternalSubId(),
      );
      if (!turnContext) {
        return { kind: "error", message: "No turn context is available." };
      }
      const result = await runContextUsage({
        session: ctx.session,
        ctx: turnContext,
        args: ctx.argsRaw,
      });
      return {
        kind: "text",
        text: result.text,
      };
    }),
};

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
  readonly toolCalls?: readonly { readonly id: string; readonly name: string }[];
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
  const finishTelemetry = startCompactTelemetry("manual");
  try {
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
      return call(params.customInstructions ?? "", commandContext as never);
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
    finishTelemetry("compacted");
    return {
      displayText: typeof result.displayText === "string"
        ? result.displayText
        : compactionResult.message,
      compactionResult,
    };
  } catch (error) {
    finishTelemetry("error");
    throw error;
  }
}

async function runContextUsage(params: {
  readonly session: Session;
  readonly ctx: TurnContext;
  readonly args?: string;
}): Promise<AgenCContextUsageResult> {
  const finishTelemetry = startCompactTelemetry("context_usage");
  try {
    const sourceMessages = params.session.snapshotHistoryMessages();
    const messages = toAgenCRuntimeMessages(messagesAfterAgenCBoundary(sourceMessages));
    const toolUseContext = buildAgenCToolUseContext(
      params.session,
      params.ctx,
      { querySource: "context" },
    );
    const commandContext = {
      ...toolUseContext,
      messages,
      options: {
        ...toolUseContext.options,
        customSystemPrompt: undefined,
        appendSystemPrompt: undefined,
      },
    };
    const result = await withCompactContextGuards(async () => {
      return contextUsageCall(params.args ?? "", commandContext as never);
    }, envForToolUseContext(toolUseContext));
    finishTelemetry("reported");
    return { text: result.value };
  } catch (error) {
    finishTelemetry("error");
    throw error;
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
  return {
    role: message.role,
    content: cloneContent(message.content),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
  };
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

async function contextUsageCall(
  _args: string,
  context: {
    readonly messages?: RuntimeMessage[];
    readonly options?: {
      readonly contextWindowTokens?: number;
    };
  }
): Promise<{ readonly value: string }> {
  const messages = context.messages ?? [];
  const used = roughRuntimeTokenCount(messages);
  const window = context.options?.contextWindowTokens ?? 0;
  const percent = window > 0
    ? Math.min(100, Math.round((used / window) * 100))
    : 0;
  return {
    value: window > 0
      ? `Context: ${used.toLocaleString()} / ${window.toLocaleString()} tokens (${percent}%)`
      : `Context: ${used.toLocaleString()} estimated tokens`,
  };
}

function startCompactTelemetry(
  mode: string,
  attributes: Readonly<Record<string, unknown>> = {}
): (status: string, additionalAttributes?: Readonly<Record<string, unknown>>) => void {
  const baseTags = toMetricTags({ mode, ...attributes });
  const timer = agencTelemetry.timer(AGENC_COMPACT_DURATION_METRIC, baseTags);
  let finished = false;
  return (
    status: string,
    additionalAttributes: Readonly<Record<string, unknown>> = {},
  ) => {
    if (finished) return;
    finished = true;
    const tags = toMetricTags({ mode, ...attributes, status, ...additionalAttributes });
    agencTelemetry.counter(AGENC_COMPACT_CALL_METRIC, 1, tags);
    timer.end(tags);
  };
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

function cloneDocumentContentPart(item: object): LLMContentPart | null {
  const record = item as Record<string, unknown>;
  if (record.type !== "document") return null;
  const source =
    record.source && typeof record.source === "object"
      ? (record.source as Record<string, unknown>)
      : null;
  if (
    source?.type !== "base64" ||
    source.media_type !== "application/pdf" ||
    typeof source.data !== "string" ||
    source.data.length === 0
  ) {
    return null;
  }
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: source.data,
    },
    ...(typeof record.title === "string" && record.title.length > 0
      ? { title: record.title }
      : {}),
    ...(typeof record.filename === "string" && record.filename.length > 0
      ? { filename: record.filename }
      : {}),
    ...(typeof record.fallbackText === "string"
      ? { fallbackText: record.fallbackText }
      : {}),
    ...(typeof record.fallbackTextTruncated === "boolean"
      ? { fallbackTextTruncated: record.fallbackTextTruncated }
      : {}),
    ...(typeof record.fallbackTextError === "string" &&
    record.fallbackTextError.length > 0
      ? { fallbackTextError: record.fallbackTextError }
      : {}),
  };
}

function cloneContent(content: unknown): LLMMessage["content"] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: LLMContentPart[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const document = cloneDocumentContentPart(item);
      if (document !== null) {
        parts.push(document);
        continue;
      }
      if (
        "type" in item &&
        item.type === "image_url" &&
        "image_url" in item &&
        item.image_url &&
        typeof item.image_url === "object" &&
        "url" in item.image_url &&
        typeof item.image_url.url === "string"
      ) {
        parts.push({
          type: "image_url",
          image_url: { url: item.image_url.url },
        });
        continue;
      }
      if ("text" in item && typeof item.text === "string") {
        parts.push({ type: "text", text: item.text });
      }
    }
    return parts;
  }
  return "";
}

function toRuntimeMessageContent(content: unknown): unknown {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((item) => {
    if (!item || typeof item !== "object") return { type: "text", text: "" };
    const document = cloneDocumentContentPart(item);
    if (document !== null) return document;
    if (
      "type" in item &&
      item.type === "image_url" &&
      "image_url" in item &&
      item.image_url &&
      typeof item.image_url === "object" &&
      "url" in item.image_url &&
      typeof item.image_url.url === "string"
    ) {
      return {
        type: "image",
        source: { type: "url", url: item.image_url.url },
      };
    }
    if ("text" in item && typeof item.text === "string") {
      return { type: "text", text: item.text };
    }
    return { ...item };
  });
}

function fromRuntimeMessageContent(content: unknown): LLMMessage["content"] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: LLMContentPart[] = [];
  let textOnly = true;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const document = cloneDocumentContentPart(item);
    if (document !== null) {
      textOnly = false;
      parts.push(document);
      continue;
    }
    if (
      "type" in item &&
      item.type === "image" &&
      "source" in item &&
      item.source &&
      typeof item.source === "object" &&
      "url" in item.source &&
      typeof item.source.url === "string"
    ) {
      textOnly = false;
      parts.push({
        type: "image_url",
        image_url: { url: item.source.url },
      });
      continue;
    }
    if (
      "type" in item &&
      item.type === "image_url" &&
      "image_url" in item &&
      item.image_url &&
      typeof item.image_url === "object" &&
      "url" in item.image_url &&
      typeof item.image_url.url === "string"
    ) {
      textOnly = false;
      parts.push({
        type: "image_url",
        image_url: { url: item.image_url.url },
      });
      continue;
    }
    if ("text" in item && typeof item.text === "string") {
      parts.push({ type: "text", text: item.text });
    }
  }
  if (textOnly) {
    return parts.map((part) => part.type === "text" ? part.text : "").join("\n");
  }
  return parts;
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
  for (const key of COMPACT_CONTEXT_GUARD_ENV) {
    previous.set(key, process.env[key]);
    const next = env[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of COMPACT_CONTEXT_GUARD_ENV) {
      const value = previous.get(key);
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

function roughRuntimeTokenCount(messages: readonly RuntimeMessage[]): number {
  return Math.ceil(
    messages.reduce(
      (total, message) => total + runtimeMessageText(message).length,
      0,
    ) / 4,
  );
}

function runtimeMessageText(message: RuntimeMessage): string {
  const content = message.message?.content ?? message.content ?? "";
  if (typeof content === "string") return content;
  return JSON.stringify(content ?? "");
}
