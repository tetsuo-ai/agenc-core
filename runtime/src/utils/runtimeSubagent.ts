// @ts-nocheck
import { randomUUID } from "node:crypto";
import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import type { PhaseEvent } from "../phases/events.js";
import { Session as RuntimeSession, type Session } from "../session/session.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ID_ARG,
} from "../tools/system/filesystem.js";
import { safeStringify } from "../tools/types.js";
import type { Message } from "../types/message.js";
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
  extractTextContent,
  getContentText,
} from "./messages.js";
import { requireCurrentRuntimeSession } from "./currentRuntimeSession.js";

const LEGACY_TO_CODEX_TOOL_NAME: Record<string, string> = {
  Agent: "system.agent.delegate",
  Bash: "system.bash",
  Edit: "system.editFile",
  Glob: "system.glob",
  Grep: "system.grep",
  Read: "system.readFile",
  WebFetch: "system.httpFetch",
  Write: "system.writeFile",
};

const CODEX_TO_LEGACY_TOOL_NAME: Record<string, string> = Object.freeze(
  Object.fromEntries(
    Object.entries(LEGACY_TO_CODEX_TOOL_NAME).map(([legacy, codex]) => [
      codex,
      legacy,
    ]),
  ),
);

export type RuntimeSubagentToolGuard = (
  toolName: string,
  args: Record<string, unknown>,
) => string | undefined | Promise<string | undefined>;

export type RuntimeSubagentCanUseTool = (
  legacyTool: unknown,
  input: Record<string, unknown>,
) => Promise<
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message?: string }
>;

export type RuntimeSubagentOptions = {
  session?: Session | null;
  initialMessages?: Message[];
  taskPrompt: string;
  systemPrompt?: string | readonly string[];
  userContext?: Record<string, string>;
  systemContext?: Record<string, string>;
  toolAllowlist?: string[];
  extraAllowedRoots?: string[];
  legacyTools?: unknown[];
  canUseTool?: RuntimeSubagentCanUseTool;
  dispatchGuard?: RuntimeSubagentToolGuard;
  externalSignal?: AbortSignal;
  onMessage?: (message: Message) => void;
  childConversationId?: string;
};

export type RuntimeSubagentResult = {
  messages: Message[];
  finalMessage: string;
  stopReason: PhaseEvent["type"] extends never
    ? never
    : "completed" | "max_turns" | "cancelled" | "error" | "empty_response";
  toolCallCount: number;
  error?: Error;
};

export interface RuntimeSubagentGenerator
  extends AsyncGenerator<Message, RuntimeSubagentResult, void> {}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return extractTextContent(value, "\n").trim();
  if (value === null || value === undefined) return "";
  return safeStringify(value);
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return extractTextContent(value, "\n").trim();
  if (value && typeof value === "object" && "content" in value) {
    return toolResultText((value as { content?: unknown }).content);
  }
  if (value === null || value === undefined) return "";
  return safeStringify(value);
}

export function mapLegacyToolNameToCodex(name: string): string | null {
  return LEGACY_TO_CODEX_TOOL_NAME[name] ?? null;
}

export function mapLegacyAllowlistToCodex(
  allowlist: readonly string[] | undefined,
): string[] | undefined {
  if (!allowlist || allowlist.length === 0) return undefined;
  const mapped = allowlist
    .map(spec => {
      const openParen = spec.indexOf("(");
      const rawName = openParen >= 0 ? spec.slice(0, openParen) : spec;
      const trimmed = rawName.trim();
      return mapLegacyToolNameToCodex(trimmed) ?? trimmed;
    })
    .filter((name): name is string => typeof name === "string");
  return mapped.length > 0 ? Array.from(new Set(mapped)) : undefined;
}

export function legacyMessagesToRuntimeMessages(
  messages: readonly Message[] | undefined,
): LLMMessage[] {
  if (!messages || messages.length === 0) return [];
  const runtimeMessages: LLMMessage[] = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    if (message.type === "assistant") {
      const content = message.message?.content;
      const text = getContentText(content) ?? messageText(content);
      const toolCalls = Array.isArray(content)
        ? content
            .filter(block => block?.type === "tool_use")
            .map(
              (block): LLMToolCall => ({
                id: String(block.id),
                name: String(block.name),
                arguments: safeStringify(block.input ?? {}),
              }),
            )
        : [];
      if (text || toolCalls.length > 0) {
        runtimeMessages.push({
          role: "assistant",
          content: text || "",
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
      }
      continue;
    }

    if (message.type === "user") {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        const text = getContentText(content) ?? messageText(content);
        if (text) {
          runtimeMessages.push({ role: "user", content: text });
        }
        for (const block of content) {
          if (block?.type !== "tool_result") continue;
          runtimeMessages.push({
            role: "tool",
            content: toolResultText(block.content),
            toolCallId: block.tool_use_id,
            toolName:
              typeof block.tool_name === "string" ? block.tool_name : undefined,
          });
        }
        continue;
      }

      const text = messageText(content);
      if (text) {
        runtimeMessages.push({ role: "user", content: text });
      }
      continue;
    }

    if (message.type === "system" && typeof message.content === "string") {
      runtimeMessages.push({ role: "system", content: message.content });
    }
  }

  return runtimeMessages;
}

function splitInitialMessages(
  initialMessages: ReadonlyArray<LLMMessage>,
  fallbackUserMessage: string,
): { history: LLMMessage[]; userMessage: string } {
  if (initialMessages.length === 0) {
    return { history: [], userMessage: fallbackUserMessage };
  }

  const history = initialMessages.slice(0, -1).map(message => ({ ...message }));
  const last = initialMessages[initialMessages.length - 1];
  if (last?.role === "user" && typeof last.content === "string") {
    return { history, userMessage: last.content };
  }

  return {
    history: initialMessages.map(message => ({ ...message })),
    userMessage: fallbackUserMessage,
  };
}

function formatContextSections(
  heading: string,
  context: Record<string, string> | undefined,
): string | undefined {
  if (!context) return undefined;
  const entries = Object.entries(context).filter(
    ([key, value]) => key.length > 0 && typeof value === "string" && value.length > 0,
  );
  if (entries.length === 0) return undefined;
  return [
    heading,
    ...entries.map(([key, value]) => `## ${key}\n${value}`),
  ].join("\n\n");
}

function normalizeSystemPrompt(
  systemPrompt: RuntimeSubagentOptions["systemPrompt"],
): string | undefined {
  if (!systemPrompt) return undefined;
  if (typeof systemPrompt === "string") {
    return systemPrompt.length > 0 ? systemPrompt : undefined;
  }
  const joined = systemPrompt
    .map(part => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
  return joined.length > 0 ? joined : undefined;
}

function prepareRuntimeSeed(
  options: RuntimeSubagentOptions,
): {
  history: LLMMessage[];
  userMessage: string;
  systemPrompt?: string;
} {
  const runtimeMessages = legacyMessagesToRuntimeMessages(options.initialMessages);
  const { history, userMessage } = splitInitialMessages(
    runtimeMessages,
    options.taskPrompt,
  );

  const userContextText = formatContextSections(
    "User context",
    options.userContext,
  );
  if (userContextText) {
    history.unshift({ role: "user", content: userContextText });
  }

  const systemPrompt = [
    normalizeSystemPrompt(options.systemPrompt),
    formatContextSections("System context", options.systemContext),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n\n");

  return {
    history,
    userMessage,
    ...(systemPrompt ? { systemPrompt } : {}),
  };
}

function filterRegistry(
  base: ToolRegistry,
  allowlist?: readonly string[],
): ToolRegistry {
  if (!allowlist || allowlist.length === 0) {
    return base;
  }

  const allowed = new Set(allowlist);
  const tools = base.tools.filter(tool => allowed.has(tool.name));

  return {
    tools,
    toLLMTools() {
      return tools.map(tool => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    },
    async dispatch(toolCall): Promise<ToolDispatchResult> {
      if (!allowed.has(toolCall.name)) {
        return {
          content: safeStringify({
            error: `tool not allowed for runtime helper: ${toolCall.name}`,
          }),
          isError: true,
        };
      }
      return base.dispatch(toolCall);
    },
  };
}

function parseToolArguments(
  toolCall: LLMToolCall,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(toolCall.arguments ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function buildRegistryForHelper(
  session: Session,
  options: RuntimeSubagentOptions,
  toolAllowlist?: readonly string[],
): ToolRegistry {
  const base = filterRegistry(session.services.registry, toolAllowlist);
  const extraAllowedRoots = (options.extraAllowedRoots ?? []).filter(Boolean);

  return {
    tools: base.tools,
    toLLMTools() {
      return base.toLLMTools();
    },
    async dispatch(toolCall): Promise<ToolDispatchResult> {
      const originalArgs = parseToolArguments(toolCall);

      if (options.dispatchGuard) {
        const denial = await options.dispatchGuard(toolCall.name, originalArgs);
        if (denial) {
          return {
            content: safeStringify({ error: denial }),
            isError: true,
          };
        }
      }

      if (options.canUseTool) {
        const legacyName = CODEX_TO_LEGACY_TOOL_NAME[toolCall.name];
        if (legacyName) {
          const legacyTool = options.legacyTools?.find?.(
            (tool: { name?: string }) => tool?.name === legacyName,
          );
          if (legacyTool) {
            const decision = await options.canUseTool(legacyTool, originalArgs);
            if (decision.behavior === "deny") {
              return {
                content: safeStringify({
                  error: decision.message ?? `tool denied: ${legacyName}`,
                }),
                isError: true,
              };
            }
            if (decision.updatedInput) {
              Object.assign(originalArgs, decision.updatedInput);
            }
          }
        }
      }

      const injectedArgs = {
        ...originalArgs,
        [SESSION_ID_ARG]: options.childConversationId ?? session.conversationId,
        ...(extraAllowedRoots.length > 0
          ? { [SESSION_ALLOWED_ROOTS_ARG]: extraAllowedRoots }
          : {}),
      };

      return base.dispatch({
        ...toolCall,
        arguments: safeStringify(injectedArgs),
      });
    },
  };
}

function buildChildSession(
  parent: Session,
  registry: ToolRegistry,
  conversationId: string,
): RuntimeSession {
  const sessionConfiguration = {
    ...parent.sessionConfiguration,
    ...(parent.sessionConfiguration.originalConfigDoNotUse
      ? {
          originalConfigDoNotUse: {
            ...parent.sessionConfiguration.originalConfigDoNotUse,
          },
        }
      : {}),
  };

  return new RuntimeSession({
    conversationId,
    initialState: {
      sessionConfiguration,
      history: [],
    },
    features: parent.features,
    services: {
      ...parent.services,
      registry,
    },
    jsRepl: parent.jsRepl,
    config: { ...parent.config },
    modelInfo: { ...parent.modelInfo },
  });
}

function legacyToolCallMessage(toolCall: LLMToolCall): Message {
  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(toolCall.arguments ?? "{}");
  } catch {
    parsedInput = {};
  }

  return createAssistantMessage({
    content: [
      {
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.name,
        input: parsedInput,
      },
    ],
  });
}

function legacyToolResultMessage(
  toolCall: LLMToolCall,
  result: ToolDispatchResult,
): Message {
  return createUserMessage({
    content: [
      {
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: result.content,
        is_error: result.isError === true,
        tool_name: toolCall.name,
      },
    ],
  });
}

export async function* streamRuntimeSubagent(
  options: RuntimeSubagentOptions,
): RuntimeSubagentGenerator {
  const session = options.session ?? requireCurrentRuntimeSession();
  const childConversationId = options.childConversationId ?? randomUUID();
  const toolAllowlist = mapLegacyAllowlistToCodex(options.toolAllowlist);
  const registry = buildRegistryForHelper(
    session,
    { ...options, childConversationId },
    toolAllowlist,
  );
  const childSession = buildChildSession(session, registry, childConversationId);
  const { history, userMessage, systemPrompt } = prepareRuntimeSeed(options);
  const messages: Message[] = [];
  let finalMessage = "";
  let stopReason: RuntimeSubagentResult["stopReason"] = "completed";
  let toolCallCount = 0;

  try {
    const iter = childSession.runTurn(userMessage, {
      history,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(options.externalSignal ? { signal: options.externalSignal } : {}),
    });

    while (true) {
      const step = await iter.next();
      if (step.done) {
        const terminalError = step.value?.error;
        if (terminalError instanceof Error) {
          return {
            messages,
            finalMessage,
            stopReason,
            toolCallCount,
            error: terminalError,
          };
        }
        return {
          messages,
          finalMessage,
          stopReason,
          toolCallCount,
        };
      }

      const event = step.value;
      switch (event.type) {
        case "assistant_text": {
          finalMessage = event.content;
          const message = createAssistantMessage({ content: event.content });
          messages.push(message);
          options.onMessage?.(message);
          yield message;
          break;
        }
        case "tool_call": {
          toolCallCount += 1;
          const message = legacyToolCallMessage(event.toolCall);
          messages.push(message);
          options.onMessage?.(message);
          yield message;
          break;
        }
        case "tool_result": {
          const message = legacyToolResultMessage(event.toolCall, event.result);
          messages.push(message);
          options.onMessage?.(message);
          yield message;
          break;
        }
        case "turn_complete":
          finalMessage = event.content;
          stopReason = event.stopReason;
          break;
        case "turn_start":
          break;
      }
    }
  } catch (error) {
    const message = createAssistantAPIErrorMessage({
      content: error instanceof Error ? error.message : String(error),
    });
    messages.push(message);
    options.onMessage?.(message);
    yield message;
    return {
      messages,
      finalMessage,
      stopReason: "error",
      toolCallCount,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    await childSession.shutdown().catch(() => {});
  }
}

export async function runRuntimeSubagent(
  options: RuntimeSubagentOptions,
): Promise<RuntimeSubagentResult> {
  const iter = streamRuntimeSubagent(options);
  while (true) {
    const step = await iter.next();
    if (step.done) {
      return step.value;
    }
  }
}
