import { randomUUID } from "node:crypto";
import type { LLMProvider } from "../../llm/types.js";
import {
  roughTokenCountEstimationForMessages,
  type TokenizerProviderHint,
} from "../../llm/token-estimation.js";

type RuntimeMessage = {
  readonly role?: "system" | "user" | "assistant" | "tool";
  readonly originalRole?: "system" | "user" | "assistant" | "tool";
  readonly type?: string;
  readonly content?: unknown;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolCalls?: readonly { readonly id: string; readonly name: string }[];
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
  };
  readonly uuid?: string;
  readonly timestamp?: string;
  readonly isMeta?: boolean;
};

type CompactContext = {
  readonly abortController?: AbortController;
  readonly provider?: LLMProvider;
  readonly options?: {
    readonly mainLoopModel?: string;
    readonly contextWindowTokens?: number;
    readonly maxOutputTokens?: number;
    readonly querySource?: string;
  };
};

type CompactionResult = {
  readonly boundaryMarker: RuntimeMessage;
  readonly summaryMessages: readonly RuntimeMessage[];
  readonly attachments: readonly RuntimeMessage[];
  readonly hookResults: readonly RuntimeMessage[];
  readonly messagesToKeep?: readonly RuntimeMessage[];
  readonly userDisplayMessage?: string;
  readonly preCompactTokenCount?: number;
  readonly postCompactTokenCount?: number;
  readonly truePostCompactTokenCount?: number;
};

const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const SUMMARY_MAX_OUTPUT_TOKENS = 4_000;
const MICROCOMPACT_MIN_CHARS = 6_000;
const MICROCOMPACT_KEEP_RECENT = 5;
const TOOL_RESULT_CLEARED_MESSAGE = "[Old tool result content cleared]";
const NO_CONTENT_MESSAGE = "(no content)";
const COMMAND_NAME_TAG = "command-name";
const COMMAND_MESSAGE_TAG = "command-message";
const COMMAND_ARGS_TAG = "command-args";
const LOCAL_COMMAND_CAVEAT_TAG = "local-command-caveat";
const MCP_TOOL_PREFIX = "mcp__";
const COMPACTABLE_TOOLS = new Set([
  "Read",
  "Bash",
  "PowerShell",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "Edit",
  "Write",
]);

let microcompactSequence = 0;

export async function autoCompactIfNeeded(
  messages: RuntimeMessage[],
  context: CompactContext,
  _cacheSafeParams?: unknown,
  querySource?: string,
  tracking?: { readonly consecutiveFailures?: number },
  snipTokensFreed = 0,
): Promise<{
  readonly wasCompacted: boolean;
  readonly compactionResult?: CompactionResult;
  readonly consecutiveFailures?: number;
}> {
  if (querySource === "compact" || querySource === "session_memory") {
    return { wasCompacted: false };
  }
  if (isTruthyEnv(process.env.DISABLE_COMPACT) ||
      isTruthyEnv(process.env.DISABLE_AUTO_COMPACT) ||
      isTruthyEnv(process.env.AGENC_DISABLE_AUTO_COMPACT)) {
    return { wasCompacted: false };
  }
  if ((tracking?.consecutiveFailures ?? 0) >= 3) {
    return {
      wasCompacted: false,
      consecutiveFailures: tracking?.consecutiveFailures,
    };
  }
  const tokenCount = Math.max(
    0,
    estimateMessagesTokens(messages, context) - snipTokensFreed,
  );
  if (tokenCount < autoCompactThreshold(context)) {
    return { wasCompacted: false, consecutiveFailures: 0 };
  }
  const compactionResult = await compactMessages(messages, context);
  return {
    wasCompacted: true,
    compactionResult,
    consecutiveFailures: 0,
  };
}

export async function manualCompactCall(
  args: string,
  context: CompactContext & { readonly messages?: RuntimeMessage[] },
): Promise<{
  readonly type: "compact";
  readonly compactionResult: CompactionResult;
  readonly displayText: string;
}> {
  const messages = context.messages ?? [];
  if (messages.length === 0) {
    throw new Error("No messages to compact");
  }
  const compactionResult = await compactMessages(messages, context, args.trim());
  return {
    type: "compact",
    compactionResult,
    displayText: compactionResult.userDisplayMessage ?? "Conversation compacted",
  };
}

export async function contextUsageCall(
  _args: string,
  context: CompactContext & { readonly messages?: RuntimeMessage[] },
): Promise<{ readonly value: string }> {
  const messages = context.messages ?? [];
  const used = estimateMessagesTokens(messages, context);
  const window = context.options?.contextWindowTokens ?? 0;
  const percent = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
  return {
    value: window > 0
      ? `Context: ${used.toLocaleString()} / ${window.toLocaleString()} tokens (${percent}%)`
      : `Context: ${used.toLocaleString()} estimated tokens`,
  };
}

export function buildPostCompactMessages(
  result: CompactionResult,
): RuntimeMessage[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ];
}

export async function microcompactMessages(
  messages: RuntimeMessage[],
  _context?: CompactContext,
  _querySource?: string,
): Promise<{ readonly messages: RuntimeMessage[] }> {
  const compactableIds = collectCompactableToolUseIds(messages);
  const compactableResultPositions = collectCompactableToolResultPositions(
    messages,
    compactableIds,
  );
  const keepIds = new Set(
    compactableResultPositions
      .slice(-MICROCOMPACT_KEEP_RECENT)
      .map((position) => position.toolUseId),
  );
  return {
    messages: messages.map((message) => {
      const rewrittenBlocks = microcompactContentBlocks(
        message.message?.content ?? message.content,
        compactableIds,
        keepIds,
      );
      if (rewrittenBlocks !== undefined) {
        return {
          ...message,
          content: rewrittenBlocks,
          message: {
            role: message.message?.role ?? message.role ?? "user",
            content: rewrittenBlocks,
          },
          isMeta: true,
        };
      }
      const text = messageText(message);
      if (
        text.length < MICROCOMPACT_MIN_CHARS ||
        !isToolLikeMessage(message) ||
        (message.toolCallId !== undefined && keepIds.has(message.toolCallId))
      ) {
        return message;
      }
      microcompactSequence += 1;
      return {
        ...message,
        content:
          `[microcompact:${microcompactSequence}] Older tool output compressed; original length ${text.length.toLocaleString()} characters.`,
        message: {
          role: message.message?.role ?? message.role ?? "user",
          content:
            `[microcompact:${microcompactSequence}] Older tool output compressed; original length ${text.length.toLocaleString()} characters.`,
        },
        isMeta: true,
      };
    }),
  };
}

export function resetMicrocompactState(): void {
  microcompactSequence = 0;
}

export function createUserMessage({
  content,
  isMeta,
  uuid,
  timestamp,
}: {
  readonly content: string | readonly Record<string, unknown>[];
  readonly isMeta?: true;
  readonly uuid?: string;
  readonly timestamp?: string;
}): RuntimeMessage {
  const normalizedContent =
    typeof content === "string" && content.length === 0
      ? NO_CONTENT_MESSAGE
      : content;
  return {
    type: "user",
    role: "user",
    message: {
      role: "user",
      content: normalizedContent,
    },
    content: normalizedContent,
    isMeta,
    uuid: uuid ?? randomUUID(),
    timestamp: timestamp ?? new Date().toISOString(),
  };
}

export function createSyntheticUserCaveatMessage(): RuntimeMessage {
  return createUserMessage({
    content: `<${LOCAL_COMMAND_CAVEAT_TAG}>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</${LOCAL_COMMAND_CAVEAT_TAG}>`,
    isMeta: true,
  });
}

export function formatCommandInputTags(
  commandName: string,
  args: string,
): string {
  return `<${COMMAND_NAME_TAG}>/${commandName}</${COMMAND_NAME_TAG}>
            <${COMMAND_MESSAGE_TAG}>${commandName}</${COMMAND_MESSAGE_TAG}>
            <${COMMAND_ARGS_TAG}>${args}</${COMMAND_ARGS_TAG}>`;
}

export async function applyToolResultBudget(
  messages: RuntimeMessage[],
): Promise<{ readonly messages: RuntimeMessage[] }> {
  return { messages };
}

export async function applyCollapsesIfNeeded(
  messages: RuntimeMessage[],
): Promise<{ readonly messages: RuntimeMessage[]; readonly committed: number }> {
  return { messages, committed: 0 };
}

export async function recoverFromOverflow(
  messages: RuntimeMessage[],
): Promise<{ readonly messages: RuntimeMessage[]; readonly committed: number }> {
  if (messages.length < 4) return { messages, committed: 0 };
  const keepCount = Math.min(3, messages.length);
  const compacted = await compactMessages(messages, {}, "Recover from a prompt-too-long provider response.");
  return {
    messages: [
      compacted.boundaryMarker,
      ...compacted.summaryMessages,
      ...messages.slice(-keepCount),
    ],
    committed: 1,
  };
}

async function compactMessages(
  messages: readonly RuntimeMessage[],
  context: CompactContext,
  customInstructions = "",
): Promise<CompactionResult> {
  const preCompactTokenCount = estimateMessagesTokens(messages, context);
  const keepCount = chooseKeepCount(messages);
  const messagesToSummarize = messages.slice(0, Math.max(0, messages.length - keepCount));
  const messagesToKeep = messages.slice(Math.max(0, messages.length - keepCount));
  const summary = await summarizeMessages(
    messagesToSummarize.length > 0 ? messagesToSummarize : messages,
    context,
    customInstructions,
  );
  const boundaryMarker = createRuntimeMessage(
    "user",
    `<compact>Conversation compacted at ${new Date().toISOString()}</compact>`,
    true,
  );
  const summaryMessage = createRuntimeMessage("user", summary, true);
  const postCompactTokenCount = estimateMessagesTokens(
    [boundaryMarker, summaryMessage, ...messagesToKeep],
    context,
  );
  return {
    boundaryMarker,
    summaryMessages: [summaryMessage],
    messagesToKeep,
    attachments: [],
    hookResults: [],
    userDisplayMessage: "Conversation compacted",
    preCompactTokenCount,
    postCompactTokenCount,
    truePostCompactTokenCount: postCompactTokenCount,
  };
}

async function summarizeMessages(
  messages: readonly RuntimeMessage[],
  context: CompactContext,
  customInstructions: string,
): Promise<string> {
  const transcript = messages.map(formatForSummary).join("\n\n");
  const instruction = [
    "Summarize this conversation for lossless continuation.",
    "Preserve user requests, decisions, file paths, commands, errors, fixes, and pending work.",
    customInstructions ? `Additional compact instructions:\n${customInstructions}` : "",
  ].filter(Boolean).join("\n\n");
  const fallback = fallbackSummary(transcript);
  const provider = context.provider;
  if (!provider) return fallback;
  try {
    const response = await provider.chat(
      [{ role: "user", content: `${instruction}\n\n<transcript>\n${transcript}\n</transcript>` }],
      {
        model: context.options?.mainLoopModel,
        systemPrompt: "You produce compact continuation summaries.",
        maxOutputTokens: Math.min(
          context.options?.maxOutputTokens ?? SUMMARY_MAX_OUTPUT_TOKENS,
          SUMMARY_MAX_OUTPUT_TOKENS,
        ),
        signal: context.abortController?.signal,
      },
    );
    const text = response.content.trim();
    return text.length > 0 ? text : fallback;
  } catch {
    return fallback;
  }
}

function chooseKeepCount(messages: readonly RuntimeMessage[]): number {
  if (messages.length <= 2) return 0;
  return Math.min(4, Math.max(1, Math.floor(messages.length * 0.2)));
}

function autoCompactThreshold(context: CompactContext): number {
  const envWindow = positiveInteger(process.env.AGENC_AUTO_COMPACT_WINDOW);
  const window = envWindow ?? context.options?.contextWindowTokens ?? 200_000;
  const percentOverride = positiveNumber(process.env.AGENC_AUTOCOMPACT_PCT_OVERRIDE);
  if (percentOverride !== undefined && percentOverride > 0 && percentOverride <= 100) {
    return Math.max(1, Math.floor(window * (percentOverride / 100)));
  }
  if (window > AUTOCOMPACT_BUFFER_TOKENS) {
    return Math.max(1, window - AUTOCOMPACT_BUFFER_TOKENS);
  }
  return Math.max(1, Math.floor(window * 0.8));
}

function estimateMessagesTokens(
  messages: readonly RuntimeMessage[],
  context?: CompactContext,
): number {
  return roughTokenCountEstimationForMessages(messages, providerHint(context));
}

function providerHint(context: CompactContext | undefined): TokenizerProviderHint {
  return {
    provider: context?.provider?.name,
    model: context?.options?.mainLoopModel,
  };
}

function messageText(message: RuntimeMessage): string {
  return stringifyContent(message.message?.content ?? message.content ?? "");
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return JSON.stringify(part);
    }).join("\n");
  }
  return JSON.stringify(content ?? "");
}

function formatForSummary(message: RuntimeMessage): string {
  const role = message.message?.role ?? message.role ?? message.type ?? "unknown";
  return `<message role="${role}">\n${messageText(message)}\n</message>`;
}

function fallbackSummary(transcript: string): string {
  const trimmed = transcript.trim();
  if (trimmed.length <= 8_000) return trimmed;
  return `${trimmed.slice(0, 4_000)}\n\n[...middle omitted during compaction...]\n\n${trimmed.slice(-4_000)}`;
}

function createRuntimeMessage(
  role: "user" | "assistant" | "system",
  content: string,
  isMeta: boolean,
): RuntimeMessage {
  return {
    role,
    type: role,
    content,
    message: { role, content },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    isMeta,
  };
}

function isToolLikeMessage(message: RuntimeMessage): boolean {
  return (
    message.role === "tool" ||
    message.originalRole === "tool" ||
    message.isMeta === true ||
    message.type === "tool_result"
  );
}

function collectCompactableToolUseIds(
  messages: readonly RuntimeMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (isCompactableTool(call.name)) ids.add(call.id);
    }
    const blocks = asContentBlocks(message.message?.content ?? message.content);
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      if (typeof block.id !== "string" || typeof block.name !== "string") continue;
      if (isCompactableTool(block.name)) ids.add(block.id);
    }
  }
  return ids;
}

function collectCompactableToolResultPositions(
  messages: readonly RuntimeMessage[],
  compactableIds: ReadonlySet<string>,
): Array<{ readonly toolUseId: string }> {
  const positions: Array<{ readonly toolUseId: string }> = [];
  for (const message of messages) {
    if (
      (message.role === "tool" || message.originalRole === "tool") &&
      message.toolCallId !== undefined &&
      (compactableIds.size === 0 ||
        compactableIds.has(message.toolCallId) ||
        (message.toolName !== undefined && isCompactableTool(message.toolName)))
    ) {
      positions.push({ toolUseId: message.toolCallId });
      continue;
    }
    for (const block of asContentBlocks(message.message?.content ?? message.content)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
        continue;
      }
      if (compactableIds.size === 0 || compactableIds.has(block.tool_use_id)) {
        positions.push({ toolUseId: block.tool_use_id });
      }
    }
  }
  return positions;
}

function microcompactContentBlocks(
  content: unknown,
  compactableIds: ReadonlySet<string>,
  keepIds: ReadonlySet<string>,
): unknown[] | undefined {
  const blocks = asContentBlocks(content);
  if (blocks.length === 0) return undefined;
  let touched = false;
  const rewritten = blocks.map((block) => {
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
      return block;
    }
    if (keepIds.has(block.tool_use_id)) return block;
    if (compactableIds.size > 0 && !compactableIds.has(block.tool_use_id)) {
      return block;
    }
    const text = stringifyContent(block.content ?? "");
    if (text.length < MICROCOMPACT_MIN_CHARS) return block;
    touched = true;
    return {
      ...block,
      content: TOOL_RESULT_CLEARED_MESSAGE,
    };
  });
  return touched ? rewritten : undefined;
}

function asContentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is Record<string, unknown> =>
      typeof block === "object" && block !== null,
  );
}

function isCompactableTool(name: string): boolean {
  return COMPACTABLE_TOOLS.has(name) || name.startsWith(MCP_TOOL_PREFIX);
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = positiveNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}

function positiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
