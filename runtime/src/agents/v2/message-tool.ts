import type { ToolResult } from "../../tools/types.js";
import {
  AgentAssignmentRejectedError,
  type AgentAssignmentRejectionCode,
} from "../control.js";
import { createMailboxMetadataRecord } from "../mailbox.js";
import type { ThreadId } from "../registry.js";
import {
  agentValidationError,
  callIdFromArgs,
  confirmedNoAgentEffect,
  currentAgentContext,
  emit,
  getSessionOrError,
  isCurrentAgentContextError,
  json,
  receiverMetadataFor,
  resolveAgentId,
  stringValue,
  type MultiAgentV2Options,
} from "./common.js";

export type MessageDeliveryMode = "queue_only" | "trigger_turn";

const ASSIGN_TASK_ADMISSION_REJECTION_CODES: ReadonlySet<AgentAssignmentRejectionCode> =
  new Set([
    "self_target",
    "sender_not_ancestor",
    "worker_not_idle",
    "assignment_outstanding",
  ]);

function assignTaskAdmissionReason(error: unknown): string | undefined {
  if (
    !(error instanceof AgentAssignmentRejectedError) ||
    !ASSIGN_TASK_ADMISSION_REJECTION_CODES.has(error.code)
  ) {
    return undefined;
  }
  return error.message;
}

export const MAX_INTER_AGENT_MESSAGE_CHARACTERS = 65_536;
export const MAX_INTER_AGENT_MESSAGE_BYTES = 65_536;

export async function handleMessageStringTool(
  args: Record<string, unknown>,
  opts: MultiAgentV2Options,
  mode: MessageDeliveryMode,
): Promise<ToolResult> {
  const target = stringValue(args.target);
  const message = typeof args.message === "string" ? args.message : undefined;
  if (!target || !message) {
    return agentValidationError("target and message are required");
  }
  if (message.trim().length === 0) {
    return agentValidationError("Empty message can't be sent to an agent");
  }
  if (
    message.length > MAX_INTER_AGENT_MESSAGE_CHARACTERS ||
    Buffer.byteLength(message, "utf8") > MAX_INTER_AGENT_MESSAGE_BYTES
  ) {
    return agentValidationError(
      `message exceeds the ${MAX_INTER_AGENT_MESSAGE_BYTES}-byte inter-agent limit`,
    );
  }
  const sessionOrError = getSessionOrError(opts);
  if (!("conversationId" in sessionOrError)) {
    return confirmedNoAgentEffect(sessionOrError);
  }
  const { control } = opts.ensureAgentControl(sessionOrError);
  const current = currentAgentContext(sessionOrError, args, opts);
  if (isCurrentAgentContextError(current)) {
    return confirmedNoAgentEffect(current);
  }
  let agentId: ThreadId;
  try {
    agentId = resolveAgentId(sessionOrError, target, current.agentPath, opts);
  } catch (error) {
    return agentValidationError(
      error instanceof Error ? error.message : String(error),
    );
  }
  if (agentId === current.threadId) {
    return agentValidationError("an agent cannot message itself");
  }
  if (mode === "trigger_turn" && agentId === sessionOrError.conversationId) {
    return agentValidationError("Tasks can't be assigned to the root agent");
  }
  const callId = callIdFromArgs(args, "message");
  const live = control.getLive(agentId);
  const metadata = control.getAgentMetadata(agentId);
  const receiverAgentPath = metadata?.agentPath ?? live?.agentPath;
  if (!receiverAgentPath) {
    return agentValidationError("target agent is missing an agent_path");
  }
  emit(sessionOrError, {
    type: "collab_agent_interaction_begin",
    payload: {
      callId,
      senderThreadId: current.threadId,
      receiverThreadId: agentId,
      prompt: message,
    },
  });
  let deliveryError: unknown;
  let acceptedTask:
    { readonly taskId: string; readonly turnId: string } | undefined;
  try {
    if (mode === "trigger_turn") {
      acceptedTask = control.assignTask(agentId, {
        author: current.agentPath,
        recipient: receiverAgentPath,
        content: message,
        taskId: callId,
      });
    } else {
      await control.sendInterAgentCommunication(agentId, {
        author: current.agentPath,
        recipient: receiverAgentPath,
        content: message,
        triggerTurn: false,
        metadata: createMailboxMetadataRecord("inter_agent_communication", [
          ["deliveryMode", mode],
        ]),
      });
    }
  } catch (error) {
    deliveryError = error;
  }
  const status = await control.getStatus(agentId);
  emit(sessionOrError, {
    type: "collab_agent_interaction_end",
    payload: {
      callId,
      senderThreadId: current.threadId,
      receiverThreadId: agentId,
      ...receiverMetadataFor(sessionOrError, agentId, opts),
      prompt: message,
      status,
    },
  });
  if (deliveryError !== undefined) {
    const admissionReason = assignTaskAdmissionReason(deliveryError);
    if (admissionReason !== undefined) {
      return agentValidationError(admissionReason);
    }
    return json(
      {
        error:
          deliveryError instanceof Error
            ? deliveryError.message
            : String(deliveryError),
      },
      true,
    );
  }
  return json({
    ok: true,
    mode: mode === "trigger_turn" ? "assign_task" : "send_message",
    target: receiverAgentPath,
    status,
    ...(acceptedTask !== undefined
      ? {
          task_id: acceptedTask.taskId,
          turn_id: acceptedTask.turnId,
        }
      : {}),
  });
}
