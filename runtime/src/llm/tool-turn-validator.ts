import type { LLMMessage } from "./types.js";
import { LLMMessageValidationError } from "./errors.js";

const MAX_TOOL_IDS_IN_ERROR = 8;

export type ToolTurnValidationCode =
  | "assistant_tool_call_id_missing"
  | "assistant_tool_call_id_duplicate"
  | "assistant_tool_calls_started_before_results"
  | "tool_message_missing_tool_call_id"
  | "tool_result_without_assistant_call"
  | "tool_result_unknown_id"
  | "tool_result_duplicate"
  | "tool_result_missing";

export interface ToolTurnValidationIssue {
  readonly code: ToolTurnValidationCode;
  readonly index: number | null;
  readonly reason: string;
}

export interface ToolTurnValidationOptions {
  readonly providerName?: string;
  readonly allowLeadingToolResults?: boolean;
}

function summarizeToolIds(ids: Iterable<string>): string {
  const all = Array.from(ids);
  if (all.length <= MAX_TOOL_IDS_IN_ERROR) {
    return all.join(", ");
  }
  const head = all.slice(0, MAX_TOOL_IDS_IN_ERROR).join(", ");
  return `${head} ... (+${all.length - MAX_TOOL_IDS_IN_ERROR} more)`;
}

function makeIssue(
  code: ToolTurnValidationCode,
  index: number | null,
  reason: string,
): ToolTurnValidationIssue {
  return { code, index, reason };
}

/**
 * Inspect messages and return the first tool-turn protocol violation, if any.
 */
export function findToolTurnValidationIssue(
  messages: readonly LLMMessage[],
  options?: ToolTurnValidationOptions,
): ToolTurnValidationIssue | null {
  let pendingToolCallIds: Set<string> | null = null;
  let pendingAssistantIndex = -1;
  const issuedToolCallIds = new Set<string>();
  const resolvedToolCallIds = new Set<string>();
  let allowLeadingToolResults = options?.allowLeadingToolResults === true;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      allowLeadingToolResults = false;
      if (pendingToolCallIds && pendingToolCallIds.size > 0) {
        return makeIssue(
          "assistant_tool_calls_started_before_results",
          i,
          `new assistant tool_calls started before resolving all prior tool results from message[${pendingAssistantIndex}]`,
        );
      }

      const ids = new Set<string>();
      for (const toolCall of msg.toolCalls) {
        const id = toolCall.id?.trim();
        if (!id) {
          return makeIssue(
            "assistant_tool_call_id_missing",
            i,
            "assistant tool_calls contains an empty id",
          );
        }

        if (ids.has(id) || issuedToolCallIds.has(id)) {
          return makeIssue(
            "assistant_tool_call_id_duplicate",
            i,
            `assistant tool_calls contains duplicate id \"${id}\"`,
          );
        }

        ids.add(id);
        issuedToolCallIds.add(id);
      }

      pendingToolCallIds = ids;
      pendingAssistantIndex = i;
      continue;
    }

    if (msg.role === "tool") {
      const toolCallId = msg.toolCallId?.trim();
      if (!toolCallId) {
        return makeIssue(
          "tool_message_missing_tool_call_id",
          i,
          "tool message is missing toolCallId",
        );
      }

      if (resolvedToolCallIds.has(toolCallId)) {
        return makeIssue(
          "tool_result_duplicate",
          i,
          `tool message duplicates result for toolCallId \"${toolCallId}\"`,
        );
      }

      if (!pendingToolCallIds || pendingToolCallIds.size === 0) {
        if (allowLeadingToolResults) {
          resolvedToolCallIds.add(toolCallId);
          continue;
        }
        return makeIssue(
          "tool_result_without_assistant_call",
          i,
          `tool message references \"${toolCallId}\" without a preceding assistant tool_calls message`,
        );
      }

      if (!pendingToolCallIds.has(toolCallId)) {
        return makeIssue(
          "tool_result_unknown_id",
          i,
          `tool message references unknown toolCallId \"${toolCallId}\" (expected one of: ${summarizeToolIds(pendingToolCallIds)})`,
        );
      }

      pendingToolCallIds.delete(toolCallId);
      resolvedToolCallIds.add(toolCallId);
      continue;
    }

    if (pendingToolCallIds && pendingToolCallIds.size > 0) {
      return makeIssue(
        "tool_result_missing",
        i,
        `missing tool result message(s) for toolCallId(s): ${summarizeToolIds(pendingToolCallIds)}. Tool results must immediately follow assistant tool_calls.`,
      );
    }

    if (msg.role !== "system") {
      allowLeadingToolResults = false;
    }
  }

  if (pendingToolCallIds && pendingToolCallIds.size > 0) {
    return makeIssue(
      "tool_result_missing",
      null,
      `missing tool result message(s) for toolCallId(s): ${summarizeToolIds(pendingToolCallIds)}.`,
    );
  }

  return null;
}

/**
 * Repair tool-turn ordering issues by synthesizing missing assistant
 * tool_calls messages before orphaned tool results.
 *
 * This handles the case where history compaction, in-flight retry,
 * or stateful reconciliation drops an assistant message but retains
 * the corresponding tool results.  Rather than crashing the provider
 * call, we synthesize a minimal assistant envelope so the tool result
 * sequence is valid.
 *
 * The function is idempotent — if the sequence is already valid it
 * returns the input unchanged (same array reference).
 */
export function repairToolTurnSequence(
  messages: readonly LLMMessage[],
): readonly LLMMessage[] {
  const issue = findToolTurnValidationIssue(messages);
  if (!issue) return messages;

  const repaired: LLMMessage[] = [];
  let pendingToolCallIds: Set<string> | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      pendingToolCallIds = new Set(
        msg.toolCalls
          .map((tc) => tc.id?.trim())
          .filter((id): id is string => Boolean(id)),
      );
      repaired.push(msg);
      continue;
    }

    if (msg.role === "tool") {
      const toolCallId = msg.toolCallId?.trim();
      if (toolCallId && (!pendingToolCallIds || !pendingToolCallIds.has(toolCallId))) {
        // Collect consecutive orphaned tool messages to synthesize a
        // single assistant envelope for the whole block.
        const orphanedBlock: LLMMessage[] = [msg];
        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") {
          const nextId = messages[j].toolCallId?.trim();
          if (nextId && (!pendingToolCallIds || !pendingToolCallIds.has(nextId))) {
            orphanedBlock.push(messages[j]);
            j++;
          } else {
            break;
          }
        }

        const syntheticToolCalls = orphanedBlock
          .map((orphan) => ({
            id: orphan.toolCallId!,
            name: orphan.toolName ?? "unknown",
            arguments: "{}",
          }));

        repaired.push({
          role: "assistant",
          content: "",
          toolCalls: syntheticToolCalls,
        });
        repaired.push(...orphanedBlock);

        pendingToolCallIds = new Set(
          syntheticToolCalls.map((tc) => tc.id),
        );
        for (const orphan of orphanedBlock) {
          const id = orphan.toolCallId?.trim();
          if (id) pendingToolCallIds.delete(id);
        }
        i = j - 1;
        continue;
      }

      if (toolCallId && pendingToolCallIds) {
        pendingToolCallIds.delete(toolCallId);
      }
      repaired.push(msg);
      continue;
    }

    // Non-tool, non-assistant-with-tool-calls message — reset pending state
    if (msg.role !== "system") {
      pendingToolCallIds = null;
    }
    repaired.push(msg);
  }

  return repaired;
}

/**
 * Validate tool-turn ordering for outbound provider calls.
 * Throws a local 400-class error when sequence is malformed.
 */
export function validateToolTurnSequence(
  messages: readonly LLMMessage[],
  options?: ToolTurnValidationOptions,
): void {
  const issue = findToolTurnValidationIssue(messages, options);
  if (!issue) return;

  throw new LLMMessageValidationError(options?.providerName ?? "llm", {
    validationCode: issue.code,
    messageIndex: issue.index,
    reason: issue.reason,
  });
}
