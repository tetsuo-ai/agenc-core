/**
 * Shared conversion between `LLMMessage` history and the AgenC runtime
 * message shape consumed by the compaction service.
 *
 * Live turns (`run-turn.ts`) and manual `/compact` (`session-compact.ts`)
 * both project history into runtime messages before compaction and project
 * the retained messages back afterwards. Each caller used to carry its own
 * copy of this pair, and the copies drifted: the manual-compaction inverse
 * stopped copying assistant `toolCalls`, so a kept tool result could lose the
 * call that produced it (issue #1792). Both directions live here so every
 * caller preserves the same wire fields: `toolCalls` with their arguments,
 * `toolCallId`, `toolName`, `phase`, provider reasoning state, the
 * runtime-only tool-result integrity and agent-invocation metadata, and the
 * original role of messages whose runtime wire role differs.
 */
import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import {
  cloneLlmContent,
  fromRuntimeMessageContent,
  toRuntimeMessageContent,
} from "../llm/content-conversion.js";
import type { RuntimeMessage } from "../services/compact/types.js";
import { validateAgentInvocationMessageSequence } from "../contracts/agent-invocation-envelope.js";

export type AgenCMessageRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";

export interface AgenCMessage {
  readonly role: AgenCMessageRole;
  readonly content: string | readonly LLMContentPart[];
  readonly providerReasoningContent?: string;
  readonly providerReasoningProvenance?: NonNullable<LLMMessage["providerReasoningProvenance"]>;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly phase?: string;
  readonly runtimeOnly?: NonNullable<LLMMessage["runtimeOnly"]>;
}

export type AgenCRuntimeWireRole = NonNullable<RuntimeMessage["role"]>;

export type AgenCRuntimeMessage = Omit<
  RuntimeMessage,
  "role" | "originalRole" | "message"
> & {
  readonly role?: AgenCRuntimeWireRole;
  readonly originalRole?: AgenCMessage["role"];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly providerReasoningContent?: string;
  readonly providerReasoningProvenance?: NonNullable<LLMMessage["providerReasoningProvenance"]>;
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

type RuntimeOnlyProjectionSource = {
  readonly toolResultIntegrity?: NonNullable<
    NonNullable<LLMMessage["runtimeOnly"]>["toolResultIntegrity"]
  >;
  readonly agentInvocation?: NonNullable<
    NonNullable<LLMMessage["runtimeOnly"]>["agentInvocation"]
  >;
};

/**
 * Project `LLMMessage` history into runtime messages. Runtime wire roles are
 * narrower than LLM roles: `tool` results travel as `user` messages and
 * `developer` messages as `system`, with the original role recorded so the
 * inverse can restore it.
 */
export function toAgenCRuntimeMessages(
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
      ...runtimeWireEnvelope(role, runtimeContent, index),
      ...toolCallsForRuntime(message.toolCalls),
      ...(message.role === "tool" ? { isMeta: true } : {}),
    };
  });
}

/**
 * Project runtime messages back into `LLMMessage` history and validate that
 * the restored sequence still carries complete agent-invocation channels.
 */
export function fromAgenCRuntimeMessages(
  messages: readonly AgenCRuntimeMessage[],
): LLMMessage[] {
  const converted = messages
    .map(fromAgenCRuntimeMessage)
    .filter((message): message is LLMMessage => message !== null);
  validateAgentInvocationMessageSequence(converted);
  return converted;
}

/**
 * Project one runtime message back into an `LLMMessage`, or `null` when the
 * message carries no recognizable role. Messages written by
 * `toAgenCRuntimeMessages` carry a top-level `role` and `content`; older
 * runtime shapes only carry `type` plus a nested `message`. Both shapes share
 * one wire-field projection so they cannot drift apart again.
 */
export function fromAgenCRuntimeMessage(
  message: AgenCRuntimeMessage,
): LLMMessage | null {
  if (message.role && message.content !== undefined) {
    return {
      role: message.originalRole ?? message.role,
      content: fromRuntimeMessageContent(message.content),
      ...projectRuntimeWireFields(message),
    };
  }
  const role = normalizeRole(message.message?.role ?? message.type);
  if (!role) return null;
  return {
    role,
    content: fromRuntimeMessageContent(readRuntimeMessageContent(message)),
    ...projectRuntimeWireFields(message),
  };
}

export function extractMessageText(
  message: AgenCRuntimeMessage | undefined,
): string | undefined {
  if (!message) return undefined;
  const content = readRuntimeMessageContent(message);
  if (typeof content === "string") return content;
  const text = content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function toAgenCMessage(message: LLMMessage): AgenCMessage {
  return {
    role: message.role,
    content: cloneLlmContent(message.content),
    ...(message.providerReasoningContent !== undefined
      ? { providerReasoningContent: message.providerReasoningContent }
      : {}),
    ...(message.providerReasoningProvenance !== undefined
      ? { providerReasoningProvenance: message.providerReasoningProvenance }
      : {}),
    ...(message.toolCallId !== undefined
      ? { toolCallId: message.toolCallId }
      : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
    ...projectRuntimeOnly(message.runtimeOnly),
  };
}

function toAgenCRuntimeWireRole(
  role: LLMMessage["role"],
): AgenCRuntimeWireRole {
  if (role === "tool") return "user";
  if (role === "developer") return "system";
  return role;
}

/**
 * Every optional wire field an `LLMMessage` can carry besides role and
 * content. Assistant `toolCalls` are part of this set: dropping them leaves
 * the following `tool` results without the call they answer, which provider
 * wire normalization then discards as orphans and the model re-issues the
 * same call on its next iteration.
 */
function projectRuntimeWireFields(
  message: AgenCRuntimeMessage,
): Omit<LLMMessage, "role" | "content"> {
  return {
    ...(message.providerReasoningContent !== undefined
      ? { providerReasoningContent: message.providerReasoningContent }
      : {}),
    ...(message.providerReasoningProvenance !== undefined
      ? { providerReasoningProvenance: message.providerReasoningProvenance }
      : {}),
    ...projectToolExchangeFields(message),
    ...projectRuntimeOnly(message.runtimeOnly),
  };
}

/** The tool-exchange fields a persisted runtime message may carry. */
export interface ToolExchangeSource {
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments?: string;
  }[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly phase?: string;
}

/**
 * Restore the tool exchange of a persisted runtime message the way the LLM
 * message expects it: the assistant's calls with their arguments, the result's
 * call id and tool name, and the phase when it is one the runtime emits. Shared
 * by every runtime-to-LLM restore so the copies cannot drift apart again.
 */
export function projectToolExchangeFields(
  message: ToolExchangeSource,
): Pick<LLMMessage, "toolCalls" | "toolCallId" | "toolName" | "phase"> {
  return {
    ...(message.toolCalls !== undefined
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? "",
          })),
        }
      : {}),
    ...(message.toolCallId !== undefined
      ? { toolCallId: message.toolCallId }
      : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase === "commentary" || message.phase === "final_answer"
      ? { phase: message.phase }
      : {}),
  };
}

/** The wire envelope every non-system runtime message carries. */
export function runtimeWireEnvelope(
  role: AgenCRuntimeWireRole,
  content: unknown,
  index: number,
): {
  readonly type: AgenCRuntimeWireRole;
  readonly message: { readonly role: AgenCRuntimeWireRole; readonly content: unknown };
  readonly uuid: string;
  readonly timestamp: string;
} {
  return {
    type: role,
    message: { role, content },
    uuid: `agenc-${role}-${index}`,
    timestamp: new Date(0).toISOString(),
  };
}

/** The assistant's tool calls as the runtime persists them (arguments verbatim). */
export function toolCallsForRuntime(
  toolCalls: LLMMessage["toolCalls"],
): Pick<AgenCRuntimeMessage, "toolCalls"> {
  if (toolCalls === undefined) return {};
  return {
    toolCalls: toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
  };
}

export function projectRuntimeOnly(
  runtimeOnly: RuntimeOnlyProjectionSource | undefined,
): Pick<LLMMessage, "runtimeOnly"> {
  if (
    runtimeOnly?.toolResultIntegrity === undefined &&
    runtimeOnly?.agentInvocation === undefined
  ) {
    return {};
  }
  return {
    runtimeOnly: {
      ...(runtimeOnly.toolResultIntegrity !== undefined
        ? { toolResultIntegrity: runtimeOnly.toolResultIntegrity }
        : {}),
      ...(runtimeOnly.agentInvocation !== undefined
        ? {
            agentInvocation: runtimeOnly.agentInvocation,
            mergeBoundary: "user_context" as const,
          }
        : {}),
    },
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

function readRuntimeMessageContent(
  message: AgenCRuntimeMessage,
): LLMMessage["content"] {
  const content = message.message?.content ?? message.content ?? "";
  return cloneLlmContent(content);
}
