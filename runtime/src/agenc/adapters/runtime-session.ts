import type { LLMContentPart, LLMMessage } from "../../llm/types.js";
import {
  AGENC_COMPACT_CALL_METRIC,
  AGENC_COMPACT_DURATION_METRIC,
  agencTelemetry,
  toMetricTags,
} from "../../observability/telemetry.js";
import type { CompactionResult } from "../../services/compact/types.js";
import type { Session } from "../../session/session.js";
import type { TurnContext } from "../../session/turn-context.js";
import type {
  AssistantMessage,
  Terminal,
  TurnState,
} from "../../session/turn-state.js";
import {
  buildAgenCToolUseContext,
  type AgenCToolUseContext,
} from "./tool-use-context.js";
import { toAgenCModelContext } from "./model-context.js";
import {
  buildCompactedRolloutPayload,
  toAgenCMessage,
  type AgenCMessage,
} from "./message-rollout.js";

const AGENC_COMPACT_BOUNDARY = "<compact>";
const PREPARED_TERMINAL = Symbol("agenc_prepared_terminal");
const RECOVERY_PASS: AgenCOverflowRecoveryResult = { kind: "pass" };
const UPSTREAM_CONTEXT_GUARD_ENV = [
  "AGENC_USE_OPENAI",
  "OPENAI_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "AGENC_OPENAI_FALLBACK_CONTEXT_WINDOW",
] as const;

export interface AgenCPreparedTerminal {
  readonly terminal: Terminal;
  readonly assistantMessage: AssistantMessage;
}

type PreparedState = TurnState & {
  [PREPARED_TERMINAL]?: AgenCPreparedTerminal;
};

export interface AgenCAutoCompactResult {
  readonly wasCompacted: boolean;
  readonly compactionResult?: {
    readonly message: string;
    readonly replacementHistory: readonly LLMMessage[];
    readonly preCompactTokens?: number;
    readonly postCompactTokens?: number;
  };
  readonly consecutiveFailures?: number;
}

export interface AgenCManualCompactResult {
  readonly displayText: string;
  readonly compactionResult: NonNullable<AgenCAutoCompactResult["compactionResult"]>;
}

export interface AgenCContextUsageResult {
  readonly text: string;
}

export type AgenCOverflowRecoveryResult =
  | { readonly kind: "applied"; readonly reason: string }
  | { readonly kind: "pass" }
  | { readonly kind: "surface"; readonly reason: string };

type AgenCRuntimeMessage = {
  readonly role?: AgenCMessage["role"];
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
  readonly content?: unknown;
  readonly uuid?: string;
  readonly timestamp?: string;
  readonly isMeta?: boolean;
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

type UpstreamGuardEnv = Partial<Record<(typeof UPSTREAM_CONTEXT_GUARD_ENV)[number], string>>;

export async function prepareAgenCTurnContext(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
): Promise<void> {
  delete (state as PreparedState)[PREPARED_TERMINAL];
  if (signal?.aborted) return;
  toAgenCModelContext(ctx);
  const messages = messagesAfterAgenCBoundary(state.messages);
  const toolUseContext = buildAgenCToolUseContext(session, ctx, {
    querySource: "repl_main_thread",
  });
  try {
    const prepared = await prepareAgenCQueryMessages({
      messages,
      toolUseContext,
      querySource: "repl_main_thread",
      applyContextCollapse: isAgenCContextCollapseRequested(),
    });
    state.messagesForQuery = prepared.messages;
    state.snipTokensFreed = prepared.snipTokensFreed;
    if (prepared.committed) {
      state.messages = [...state.messagesForQuery];
    }
  } catch {
    state.messagesForQuery = messages.map(cloneLLMMessage);
    state.snipTokensFreed = 0;
  }
}

export function getAgenCPreparedTerminal(
  state: TurnState,
): AgenCPreparedTerminal | undefined {
  return (state as PreparedState)[PREPARED_TERMINAL];
}

export async function runAgenCAutoCompact(params: {
  readonly session?: Session;
  readonly ctx?: TurnContext;
  readonly state?: TurnState;
  readonly querySource?: string;
  readonly reason?: string;
  readonly phase?: string;
  readonly initialContextInjection?: string;
}): Promise<AgenCAutoCompactResult> {
  const finishTelemetry = startCompactTelemetry("auto", {
    query_source: params.querySource,
    reason: params.reason,
    phase: params.phase,
  });
  if (!params.session || !params.ctx || !params.state) {
    finishTelemetry("not_configured");
    return compactionNotRun();
  }
  try {
    const state = params.state;
    const sourceMessages =
      state.messagesForQuery.length > 0
        ? state.messagesForQuery
        : state.messages;
    const messages = toAgenCRuntimeMessages(sourceMessages);
    const toolUseContext = buildAgenCToolUseContext(
      params.session,
      params.ctx,
      { querySource: params.querySource },
    );
    const cacheSafeParams = {
      systemPrompt: [],
      userContext: {},
      systemContext: {},
      toolUseContext,
      forkContextMessages: messages,
    };
    const result = await withUpstreamContextGuards(async () => {
      const { autoCompactIfNeeded } =
        await import("../../services/compact/autoCompact.js");
      return autoCompactIfNeeded(
        messages,
        toolUseContext,
        cacheSafeParams,
        params.querySource,
        state.autoCompactTracking,
        state.snipTokensFreed ?? 0,
      );
    }, envForToolUseContext(toolUseContext));
    if (!result.wasCompacted || !result.compactionResult) {
      finishTelemetry("skipped", {
        consecutive_failures: result.consecutiveFailures,
      });
      return compactionNotRun(result.consecutiveFailures);
    }
    params.session.clearProviderResponseId();
    const compactionResult = await toAgenCCompactionResult(
      result.compactionResult as AgenCCompactionResult,
    );
    finishTelemetry("compacted", {
      consecutive_failures: result.consecutiveFailures,
    });
    return {
      wasCompacted: true,
      compactionResult,
      ...(result.consecutiveFailures !== undefined
        ? { consecutiveFailures: result.consecutiveFailures }
        : {}),
    };
  } catch (error) {
    finishTelemetry("error");
    throw error;
  }
}

export async function runAgenCManualCompact(params: {
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
    const result = await withUpstreamContextGuards(async () => {
      const { manualCompactCall } =
        await import("../../services/compact/compact.js");
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

export async function runAgenCContextUsage(params: {
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
    const result = await withUpstreamContextGuards(async () => {
      const { contextUsageCall } = await import("./compact-runtime.js");
      const call = contextUsageCall;
      return call(params.args ?? "", commandContext as never);
    }, envForToolUseContext(toolUseContext));
    finishTelemetry("reported");
    return { text: result.value };
  } catch (error) {
    finishTelemetry("error");
    throw error;
  }
}

export async function runAgenCContextCollapseOverflowRecovery(params: {
  readonly session: Session;
  readonly state: TurnState;
  readonly lastMessage?: AssistantMessage;
}): Promise<AgenCOverflowRecoveryResult> {
  const finishTelemetry = startCompactTelemetry("overflow_recovery");
  try {
    const recovered = await withUpstreamContextGuards(async () => {
      const { recoverFromOverflow } = await import("./compact-runtime.js");
      return recoverFromOverflow(
        toAgenCRuntimeMessages(params.state.messagesForQuery),
      );
    });
    if (recovered.committed <= 0) {
      const result = passRecovery();
      finishTelemetry(result.kind);
      return result;
    }
    params.state.messagesForQuery = fromAgenCRuntimeMessages(
      recovered.messages as AgenCRuntimeMessage[],
    );
    params.state.messages = [...params.state.messagesForQuery];
    const result: AgenCOverflowRecoveryResult = {
      kind: "applied",
      reason: "context_collapse",
    };
    finishTelemetry(result.kind, { reason: result.reason });
    return result;
  } catch (error) {
    finishTelemetry("error");
    throw error;
  }
}

export function buildAgenCCompactedRolloutItem(
  result: NonNullable<AgenCAutoCompactResult["compactionResult"]>,
) {
  return buildCompactedRolloutPayload({
    message: result.message,
    replacementHistory: result.replacementHistory,
    preCompactTokens: result.preCompactTokens,
    postCompactTokens: result.postCompactTokens,
  });
}

export function buildAgenCPostCompactMessages(
  result: NonNullable<AgenCAutoCompactResult["compactionResult"]>,
): LLMMessage[] {
  return result.replacementHistory.map((message) => ({ ...message }));
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

async function prepareAgenCQueryMessages(params: {
  readonly messages: readonly LLMMessage[];
  readonly toolUseContext: AgenCToolUseContext;
  readonly querySource: string;
  readonly applyContextCollapse: boolean;
}): Promise<{
  readonly messages: LLMMessage[];
  readonly snipTokensFreed: number;
  readonly committed: boolean;
}> {
  const finishTelemetry = startCompactTelemetry("prepare_query", {
    query_source: params.querySource,
    context_collapse: params.applyContextCollapse,
  });
  try {
    const result = await withUpstreamContextGuards(async () => {
      let messages = toAgenCRuntimeMessages(params.messages);
      const { applyToolResultBudget } = await import("./compact-runtime.js");
      const budgeted = await applyToolResultBudget(
        messages,
      );
      messages = budgeted.messages as AgenCRuntimeMessage[];
      const { microcompactMessages } =
        await import("../../services/compact/microCompact.js");
      const microcompactResult = await microcompactMessages(
        messages,
        params.toolUseContext,
        params.querySource,
      );
      messages = microcompactResult.messages as AgenCRuntimeMessage[];
      let committed = false;
      if (params.applyContextCollapse) {
        const { applyCollapsesIfNeeded } = await import("./compact-runtime.js");
        const projected = await applyCollapsesIfNeeded(
          messages,
        );
        messages = projected.messages as AgenCRuntimeMessage[];
        committed = projected.committed > 0;
      }
      return {
        messages: fromAgenCRuntimeMessages(messages),
        snipTokensFreed: 0,
        committed,
      };
    }, envForToolUseContext(params.toolUseContext));
    finishTelemetry(result.committed ? "committed" : "unchanged");
    return {
      messages: result.messages,
      snipTokensFreed: result.snipTokensFreed,
      committed: result.committed,
    };
  } catch (error) {
    finishTelemetry("error");
    throw error;
  }
}

function startCompactTelemetry(
  mode: string,
  attributes: Readonly<Record<string, unknown>> = {},
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
  const replacementHistory = await withUpstreamContextGuards(async () => {
    const { buildPostCompactMessages } =
      await import("../../services/compact/compact.js");
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
  } = await import("../../services/compact/compact.js");
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
  await withUpstreamContextGuards(async () => {
    const { resetMicrocompactState } =
      await import("../../services/compact/microCompact.js");
    resetMicrocompactState();
  }, envForToolUseContext(toolUseContext));
}

function toAgenCRuntimeMessages(
  messages: readonly LLMMessage[],
): AgenCRuntimeMessage[] {
  return messages.map((message, index) => {
    const converted = toAgenCMessage(message);
    const upstreamContent = toUpstreamMessageContent(message.content);
    if (message.role === "system") {
      return {
        ...converted,
        type: "system",
        content: upstreamContent,
        uuid: `agenc-system-${index}`,
        timestamp: new Date(0).toISOString(),
      };
    }
    const role = message.role === "tool" ? "user" : message.role;
    return {
      ...converted,
      content: upstreamContent,
      role,
      ...(message.role !== role ? { originalRole: message.role } : {}),
      type: role,
      message: {
        role,
        content: upstreamContent,
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
      content: fromUpstreamMessageContent(message.content),
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
    content: fromUpstreamMessageContent(readContent(message)),
  };
}

function normalizeRole(value: unknown): LLMMessage["role"] | null {
  if (
    value === "system" ||
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

function toUpstreamMessageContent(content: unknown): unknown {
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

function fromUpstreamMessageContent(content: unknown): LLMMessage["content"] {
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

function compactionNotRun(
  consecutiveFailures?: number,
): AgenCAutoCompactResult {
  return {
    wasCompacted: false,
    ...(consecutiveFailures !== undefined ? { consecutiveFailures } : {}),
  };
}

function cloneLLMMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    content: cloneContent(message.content),
  };
}

function passRecovery(): AgenCOverflowRecoveryResult {
  return { ...RECOVERY_PASS };
}

async function withUpstreamContextGuards<T>(
  fn: () => Promise<T>,
  env: UpstreamGuardEnv = {},
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env) as Array<keyof UpstreamGuardEnv>) {
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
): UpstreamGuardEnv {
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

function isAgenCContextCollapseRequested(): boolean {
  return true;
}
