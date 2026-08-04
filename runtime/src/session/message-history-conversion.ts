import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import { assertAgentInvocationChannelMessage } from "../contracts/agent-invocation-envelope.js";
import { redactSecretsInValue } from "../secrets/index.js";
import type { ResponseItem } from "./rollout-item.js";
import {
  deterministicToolResultId,
  verifyToolResultIntegrity,
  withPersistedToolResultRepresentation,
  type ToolResultIntegrity,
  type ToolResultRepresentation,
} from "./tool-result-integrity.js";

type RolloutContentPart = Extract<
  ResponseItem["content"],
  ReadonlyArray<unknown>
>[number];

export function llmMessageToResponseItem(message: LLMMessage): ResponseItem {
  assertLlmAgentInvocationMessage(message);
  return {
    role: message.role,
    content: cloneContent(message.content),
    ...(message.toolCalls !== undefined
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        }
      : {}),
    ...(message.toolCallId !== undefined
      ? { toolCallId: message.toolCallId }
      : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
    ...(message.runtimeOnly?.toolResultIntegrity !== undefined
      ? { toolResultIntegrity: message.runtimeOnly.toolResultIntegrity }
      : {}),
    ...(message.runtimeOnly?.agentInvocation !== undefined
      ? { agentInvocation: message.runtimeOnly.agentInvocation }
      : {}),
    ...(message.runtimeOnly?.compactionHistory !== undefined
      ? { compactionHistory: message.runtimeOnly.compactionHistory }
      : {}),
  };
}

/**
 * Convert a newly produced message to the exact representation that the
 * rollout serializer will write. Integrity is checked against the unredacted
 * model-facing tool result first, then rebound to the redacted durable body.
 */
export function llmMessageToDurableResponseItem(
  message: LLMMessage,
): ResponseItem {
  const item = llmMessageToResponseItem(message);
  const integrity = currentIntegrity(message, false);
  return redactResponseItemForPersistence(item, integrity, "authenticate");
}

/**
 * Recreate the already-persisted projection used by checkpoint hashing.
 * Tool-result bodies may have since been bounded in memory, so their sealed
 * persisted identity is retained while all other fields are redacted exactly
 * as they are at the JSONL sink.
 */
export function llmMessageToCheckpointResponseItem(
  message: LLMMessage,
): ResponseItem {
  const item = llmMessageToResponseItem(message);
  const integrity = currentIntegrity(message, true);
  return redactResponseItemForPersistence(item, integrity, "preserve");
}

/**
 * Convert replacement history that a compaction/rewind is about to persist.
 * If a controlled history transformation changed the current tool-result
 * body, retain its immutable original identity and authenticate the new body.
 */
export function llmMessageToReplacementResponseItem(
  message: LLMMessage,
  representation: Exclude<ToolResultRepresentation, "original"> = "compacted",
): ResponseItem {
  const item = llmMessageToResponseItem(message);
  const integrity = replacementIntegrity(message, representation);
  return redactResponseItemForPersistence(item, integrity, "authenticate");
}

export function responseItemToLlmMessage(item: ResponseItem): LLMMessage {
  const message: LLMMessage = {
    role: item.role,
    content: cloneContent(item.content),
    ...(item.toolCalls !== undefined
      ? {
          toolCalls: item.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? "",
          })),
        }
      : {}),
    ...(item.phase === "commentary" || item.phase === "final_answer"
      ? { phase: item.phase }
      : {}),
    ...(item.toolCallId !== undefined ? { toolCallId: item.toolCallId } : {}),
    ...(item.toolName !== undefined ? { toolName: item.toolName } : {}),
    ...(item.toolResultIntegrity !== undefined ||
    item.agentInvocation !== undefined ||
    item.compactionHistory !== undefined
      ? {
          runtimeOnly: {
            ...(item.toolResultIntegrity !== undefined
              ? { toolResultIntegrity: item.toolResultIntegrity }
              : {}),
            ...(item.agentInvocation !== undefined
              ? {
                  agentInvocation: item.agentInvocation,
                  mergeBoundary: "user_context" as const,
                }
              : {}),
            ...(item.compactionHistory !== undefined
              ? { compactionHistory: item.compactionHistory }
              : {}),
          },
        }
      : {}),
  };
  assertLlmAgentInvocationMessage(message);
  return message;
}

export function cloneLlmMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    content: cloneContent(message.content),
    ...(message.toolCalls !== undefined
      ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) }
      : {}),
    ...(message.runtimeOnly !== undefined
      ? { runtimeOnly: { ...message.runtimeOnly } }
      : {}),
  };
}

function assertLlmAgentInvocationMessage(message: LLMMessage): void {
  if (message.runtimeOnly?.agentInvocation === undefined) return;
  assertAgentInvocationChannelMessage(message);
}

function replacementIntegrity(
  message: LLMMessage,
  representation: Exclude<ToolResultRepresentation, "original">,
): ToolResultIntegrity | undefined {
  const integrity = message.runtimeOnly?.toolResultIntegrity;
  if (integrity === undefined) return undefined;
  if (message.role !== "tool" || message.toolCallId === undefined) {
    throw new Error(
      "tool-result integrity metadata is attached to a non-tool message",
    );
  }
  const verification = verifyToolResultIntegrity({
    integrity,
    toolCallId: message.toolCallId,
    content: message.content,
  });
  if (verification.status === "valid") return verification.integrity;
  if (
    verification.status === "invalid" &&
    (verification.failure.code === "persisted_body_digest_mismatch" ||
      verification.failure.code === "persisted_body_length_mismatch")
  ) {
    return withPersistedToolResultRepresentation(
      integrity,
      representation,
      message.content,
    );
  }
  throw new Error(
    `cannot persist transformed tool result: ${verification.failure.reason}`,
  );
}

function currentIntegrity(
  message: LLMMessage,
  allowControlledBodyMismatch: boolean,
): ToolResultIntegrity | undefined {
  const integrity = message.runtimeOnly?.toolResultIntegrity;
  if (integrity === undefined) return undefined;
  if (message.role !== "tool" || message.toolCallId === undefined) {
    throw new Error(
      "tool-result integrity metadata is attached to a non-tool message",
    );
  }
  const verification = verifyToolResultIntegrity({
    integrity,
    toolCallId: message.toolCallId,
    content: message.content,
  });
  if (verification.status === "valid") return verification.integrity;
  if (
    allowControlledBodyMismatch &&
    verification.status === "invalid" &&
    (verification.failure.code === "persisted_body_digest_mismatch" ||
      verification.failure.code === "persisted_body_length_mismatch")
  ) {
    return integrity;
  }
  throw new Error(`cannot persist tool result: ${verification.failure.reason}`);
}

function redactResponseItemForPersistence(
  item: ResponseItem,
  integrity: ToolResultIntegrity | undefined,
  bodyMode: "authenticate" | "preserve",
): ResponseItem {
  const { toolResultIntegrity: _omittedIntegrity, ...unsealedItem } = item;
  const redacted =
    unsealedItem.agentInvocation === undefined
      ? (redactSecretsInValue(unsealedItem) as ResponseItem)
      : (() => {
          const {
            content,
            agentInvocation,
            ...untrustedUnauthenticatedFields
          } = unsealedItem;
          return {
            ...(redactSecretsInValue(untrustedUnauthenticatedFields) as Omit<
              ResponseItem,
              "content" | "agentInvocation"
            >),
            content,
            agentInvocation,
          } as ResponseItem;
        })();
  assertResponseAgentInvocationItem(redacted);
  if (integrity === undefined) return redacted;
  if (redacted.role !== "tool" || redacted.toolCallId === undefined) {
    throw new Error("redaction removed a durable tool-result identity");
  }

  let durableIntegrity = rebindRedactedIdentity(integrity, redacted.toolCallId);
  if (bodyMode === "authenticate") {
    const redactedBody = verifyToolResultIntegrity({
      integrity: durableIntegrity,
      toolCallId: redacted.toolCallId,
      content: redacted.content,
    });
    if (redactedBody.status !== "valid") {
      if (
        redactedBody.status !== "invalid" ||
        (redactedBody.failure.code !== "persisted_body_digest_mismatch" &&
          redactedBody.failure.code !== "persisted_body_length_mismatch")
      ) {
        throw new Error(
          `cannot persist redacted tool result: ${redactedBody.failure.reason}`,
        );
      }
      const representation =
        durableIntegrity.persisted.representation === "original"
          ? "redacted"
          : durableIntegrity.persisted.representation;
      durableIntegrity = withPersistedToolResultRepresentation(
        durableIntegrity,
        representation,
        redacted.content,
      );
    }
  }
  return { ...redacted, toolResultIntegrity: durableIntegrity };
}

function assertResponseAgentInvocationItem(item: ResponseItem): void {
  if (item.agentInvocation === undefined) return;
  assertAgentInvocationChannelMessage({
    role: item.role,
    content: item.content,
    runtimeOnly: { agentInvocation: item.agentInvocation },
  });
}

function rebindRedactedIdentity(
  integrity: ToolResultIntegrity,
  toolCallId: string,
): ToolResultIntegrity {
  const runId = redactSecretsInValue(integrity.runId);
  return {
    ...integrity,
    runId,
    toolCallId,
    resultId: deterministicToolResultId(runId, toolCallId),
  };
}

function cloneContent(
  content: LLMMessage["content"] | ResponseItem["content"],
): LLMMessage["content"] {
  if (typeof content === "string") return content;
  const cloned: LLMContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as RolloutContentPart;
    if (record.type === "document") {
      const source =
        record.source && typeof record.source === "object"
          ? (record.source as Record<string, unknown>)
          : null;
      if (
        source?.type === "base64" &&
        source.media_type === "application/pdf" &&
        typeof source.data === "string"
      ) {
        cloned.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: source.data,
          },
          ...(typeof record.title === "string" ? { title: record.title } : {}),
          ...(typeof record.filename === "string"
            ? { filename: record.filename }
            : {}),
          ...(typeof record.fallbackText === "string"
            ? { fallbackText: record.fallbackText }
            : {}),
          ...(typeof record.fallbackTextTruncated === "boolean"
            ? { fallbackTextTruncated: record.fallbackTextTruncated }
            : {}),
          ...(typeof record.fallbackTextError === "string"
            ? { fallbackTextError: record.fallbackTextError }
            : {}),
        });
      }
      continue;
    }
    if (record.type === "image_url") {
      const image =
        record.image_url && typeof record.image_url === "object"
          ? (record.image_url as Record<string, unknown>)
          : null;
      if (typeof image?.url === "string") {
        cloned.push({
          type: "image_url",
          image_url: { url: image.url },
        });
      }
      continue;
    }
    if (typeof record.text === "string") {
      cloned.push({ type: "text", text: record.text });
    }
  }
  return cloned.length > 0 ? cloned : "";
}
