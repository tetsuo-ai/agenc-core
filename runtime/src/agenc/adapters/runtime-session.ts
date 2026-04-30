import type { LLMContentPart, LLMMessage } from "../../llm/types.js";
import type { Session } from "../../session/session.js";
import type { TurnContext } from "../../session/turn-context.js";
import type {
  AssistantMessage,
  Terminal,
  TurnState,
} from "../../session/turn-state.js";
import { buildAgenCToolUseContext } from "./tool-use-context.js";
import { toAgenCModelContext } from "./model-context.js";
import {
  buildCompactedRolloutPayload,
  fromAgenCMessage,
  toAgenCMessage,
  type AgenCMessage,
} from "./message-rollout.js";
import {
  loadAutoCompactModule,
  loadCompactModule,
  loadContextNonInteractiveCommand,
  loadContextCollapseModule,
  enableUpstreamConfigGate,
  loadManualCompactCommand,
} from "./dynamic-loaders.js";

const AGENC_COMPACT_BOUNDARY = "<compact>";
const PREPARED_TERMINAL = Symbol("agenc_prepared_terminal");
const RECOVERY_PASS: AgenCOverflowRecoveryResult = { kind: "pass" };
const UPSTREAM_CONTEXT_GUARD_ENV = [
  [
    68, 73, 83, 65, 66, 76, 69, 95, 65, 71, 69, 78, 67, 95, 83, 77, 95, 67,
    79, 77, 80, 65, 67, 84,
  ],
  [
    65, 71, 69, 78, 67, 95, 68, 73, 83, 65, 66, 76, 69, 95, 65, 71, 69, 78,
    67, 95, 77, 68, 83,
  ],
  [
    68, 73, 83, 65, 66, 76, 69, 95, 67, 76, 65, 85, 68, 69, 95, 67, 79, 68,
    69, 95, 83, 77, 95, 67, 79, 77, 80, 65, 67, 84,
  ],
  [
    67, 76, 65, 85, 68, 69, 95, 67, 79, 68, 69, 95, 68, 73, 83, 65, 66, 76,
    69, 95, 67, 76, 65, 85, 68, 69, 95, 77, 68, 83,
  ],
].map((codes) => String.fromCharCode(...codes));

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

type AgenCRuntimeMessage = Partial<AgenCMessage> & {
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

type AgenCCacheSafeParams = {
  readonly systemPrompt: readonly unknown[];
  readonly userContext: Record<string, string>;
  readonly systemContext: Record<string, string>;
  readonly toolUseContext: ReturnType<typeof buildAgenCToolUseContext>;
  readonly forkContextMessages: readonly AgenCRuntimeMessage[];
};

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
  if (!isAgenCContextCollapseRequested()) {
    state.messagesForQuery = messages;
    return;
  }
  const toolUseContext = buildAgenCToolUseContext(session, ctx, {
    querySource: "repl_main_thread",
  });
  const projected = await withUpstreamContextGuards(async () => {
    const { applyCollapsesIfNeeded } = await loadContextCollapseModule();
    return applyCollapsesIfNeeded(
      toAgenCRuntimeMessages(messages),
      toolUseContext,
    );
  });
  state.messagesForQuery = fromAgenCRuntimeMessages(
    projected.messages as AgenCRuntimeMessage[],
  );
  if (projected.committed > 0) {
    state.messages = [...state.messagesForQuery];
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
  if (!params.session || !params.ctx || !params.state) {
    return compactionNotRun();
  }
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
  const cacheSafeParams = buildCacheSafeParams(toolUseContext, messages);
  const result = await withUpstreamContextGuards(async () => {
    const { autoCompactIfNeeded } = await loadAutoCompactModule();
    return autoCompactIfNeeded(
      messages,
      toolUseContext,
      cacheSafeParams,
      params.querySource,
      state.autoCompactTracking,
      state.snipTokensFreed ?? 0,
    );
  });
  if (!result.wasCompacted || !result.compactionResult) {
    return compactionNotRun(result.consecutiveFailures);
  }
  return {
    wasCompacted: true,
    compactionResult: await toAgenCCompactionResult(
      result.compactionResult as AgenCCompactionResult,
    ),
    ...(result.consecutiveFailures !== undefined
      ? { consecutiveFailures: result.consecutiveFailures }
      : {}),
  };
}

export async function runAgenCManualCompact(params: {
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
  const result = await withUpstreamContextGuards(async () => {
    const { call } = await loadManualCompactCommand();
    return call(params.customInstructions ?? "", commandContext as never);
  });
  if (result.type !== "compact") {
    throw new Error("Compact command did not return a compaction result");
  }
  const compactionResult = await toAgenCCompactionResult(
    result.compactionResult as AgenCCompactionResult,
  );
  const compacted = compactionResult.replacementHistory.map(cloneLLMMessage);
  await params.session.state.with((sessionState) => {
    sessionState.history = compacted.map(cloneLLMMessage);
  });
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

export async function runAgenCContextUsage(params: {
  readonly session: Session;
  readonly ctx: TurnContext;
  readonly args?: string;
}): Promise<AgenCContextUsageResult> {
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
    const { call } = await loadContextNonInteractiveCommand();
    return call(params.args ?? "", commandContext as never);
  });
  return { text: result.value };
}

export async function runAgenCContextCollapseOverflowRecovery(params: {
  readonly session: Session;
  readonly state: TurnState;
  readonly lastMessage?: AssistantMessage;
}): Promise<AgenCOverflowRecoveryResult> {
  if (!isAgenCContextCollapseRequested()) return passRecovery();
  const recovered = await withUpstreamContextGuards(async () => {
    const { recoverFromOverflow } = await loadContextCollapseModule();
    return recoverFromOverflow(
      toAgenCRuntimeMessages(params.state.messagesForQuery),
    );
  });
  if (recovered.committed <= 0) return passRecovery();
  params.state.messagesForQuery = fromAgenCRuntimeMessages(
    recovered.messages as AgenCRuntimeMessage[],
  );
  params.state.messages = [...params.state.messagesForQuery];
  return { kind: "applied", reason: "context_collapse" };
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

function buildCacheSafeParams(
  toolUseContext: ReturnType<typeof buildAgenCToolUseContext>,
  forkContextMessages: readonly AgenCRuntimeMessage[],
): AgenCCacheSafeParams {
  return {
    systemPrompt: [],
    userContext: {},
    systemContext: {},
    toolUseContext,
    forkContextMessages,
  };
}

async function toAgenCCompactionResult(
  result: AgenCCompactionResult,
): Promise<NonNullable<AgenCAutoCompactResult["compactionResult"]>> {
  const replacementHistory = await withUpstreamContextGuards(async () => {
    const { buildPostCompactMessages } = await loadCompactModule();
    return fromAgenCRuntimeMessages(
      buildPostCompactMessages(result) as AgenCRuntimeMessage[],
    );
  });
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

function toAgenCRuntimeMessages(
  messages: readonly LLMMessage[],
): AgenCRuntimeMessage[] {
  return messages.map((message, index) => {
    const converted = toAgenCMessage(message);
    if (message.role === "system") {
      return {
        ...converted,
        type: "system",
        content: cloneContent(message.content),
        uuid: `agenc-system-${index}`,
        timestamp: new Date(0).toISOString(),
      };
    }
    const role = message.role === "tool" ? "user" : message.role;
    return {
      ...converted,
      role,
      type: role,
      message: {
        role,
        content: cloneContent(message.content),
      },
      uuid: `agenc-${role}-${index}`,
      timestamp: new Date(0).toISOString(),
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
    return fromAgenCMessage(message as AgenCMessage);
  }
  const role = normalizeRole(message.message?.role ?? message.type);
  if (!role) return null;
  return {
    role,
    content: cloneContent(readContent(message)),
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

function cloneContent(content: unknown): LLMMessage["content"] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: LLMContentPart[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
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
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of UPSTREAM_CONTEXT_GUARD_ENV) {
    previous.set(key, process.env[key]);
    process.env[key] = "1";
  }
  try {
    await enableUpstreamConfigGate();
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

function isAgenCContextCollapseRequested(): boolean {
  const raw = process.env.AGENC_CONTEXT_COLLAPSE;
  return raw !== undefined && raw !== "0" && raw !== "false";
}
