import type { ToolResult } from "../../tools/types.js";
import { readOnlyCoordinationRefusal } from "../readonly-delegation.js";
import {
  AgentAssignmentRejectedError,
  type AgentAssignmentRejectionCode,
} from "../control.js";
import { createMailboxMetadataRecord } from "../mailbox.js";
import type { ThreadId } from "../registry.js";
import { authorizeChildExecutionPlan, type ChildExecutionPlan } from "../cross-provider.js";
import { liveAgentSession } from "../live-session.js";
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
  const coordinationRefusal = readOnlyCoordinationRefusal(sessionOrError, current.agentPath, metadata ?? live?.metadata, control.getAgentMetadata(current.threadId)?.executionConstraint);
  if (coordinationRefusal !== undefined) return agentValidationError(coordinationRefusal);
  const receiverAgentPath = metadata?.agentPath ?? live?.agentPath;
  if (!receiverAgentPath) {
    return agentValidationError("target agent is missing an agent_path");
  }
  const targetPlan = live?.metadata.executionPlan ?? metadata?.executionPlan;
  if ((live?.metadata.crossProvider !== undefined || metadata?.crossProvider !== undefined) &&
      targetPlan?.crossProvider !== true) {
    return agentValidationError("consent_unavailable: destination has no consent provenance");
  }
  let assignedPlan: ChildExecutionPlan | undefined;
  if (mode === "queue_only" && targetPlan?.crossProvider) {
    // A passive message is prepended to a later assignment, so its text needs
    // consent before it enters the child's mailbox. Settings consent covers
    // it. With per-spawn consent, or after a funds stop, it needs a fresh
    // approval even if the worker holds a reusable session grant.
    const caller = current.threadId === sessionOrError.conversationId
      ? sessionOrError : liveAgentSession(control.getLive(current.threadId)!);
    if (caller === undefined) return agentValidationError("consent_unavailable: calling session is no longer live");
    const previous = targetPlan;
    const parentTurnId = caller.activeTurn?.unsafePeek()?.turnId;
    const proposed: ChildExecutionPlan = { ...previous,
      task: { id: callId, name: previous.task.name, text: message, attachments: [],
        ...(parentTurnId !== undefined ? { parentTurnId } : {}) },
      consentGrant: null,
    };
    const consent = await authorizeChildExecutionPlan(caller, proposed, { fresh: true });
    if (consent.kind !== "granted") {
      return confirmedNoAgentEffect(json({ code: consent.kind, error: consent.reason,
        action: "Keep this message on the current provider or request consent again for a new task." }, true));
    }
  }
  if (mode === "trigger_turn" && targetPlan?.crossProvider) {
    const caller = current.threadId === sessionOrError.conversationId
      ? sessionOrError : liveAgentSession(control.getLive(current.threadId)!);
    if (caller === undefined) return agentValidationError("consent_unavailable: calling session is no longer live; continue this task yourself");
    const previous = targetPlan;
    const parentTurnId = caller.activeTurn?.unsafePeek()?.turnId;
    const proposed: ChildExecutionPlan = { ...previous,
      task: { id: callId, name: previous.task.name, text: message, attachments: [],
        ...(parentTurnId !== undefined ? { parentTurnId } : {}) },
      consentGrant: null,
    };
    const consent = await authorizeChildExecutionPlan(caller, proposed);
    if (consent.kind !== "granted") {
      return confirmedNoAgentEffect(json({ code: consent.kind, error: consent.reason,
        action: "Continue this subtask yourself on the current provider; do not retry the same cross-provider request." }, true));
    }
    assignedPlan = consent.plan;
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
  let passiveAdmission:
    ReturnType<typeof control.sendPassiveMessageToActiveAgent> | undefined;
  try {
    if (mode === "trigger_turn") {
      acceptedTask = control.assignTask(agentId, {
        author: current.agentPath,
        recipient: receiverAgentPath,
        content: message,
        taskId: callId,
        ...(assignedPlan !== undefined ? { executionPlan: assignedPlan } : {}),
      });
    } else if (agentId === sessionOrError.conversationId) {
      await control.sendInterAgentCommunication(agentId, {
        author: current.agentPath,
        recipient: receiverAgentPath,
        content: message,
        triggerTurn: false,
        metadata: createMailboxMetadataRecord("inter_agent_communication", [
          ["deliveryMode", mode],
        ]),
      });
    } else {
      passiveAdmission = control.sendPassiveMessageToActiveAgent(agentId, {
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
  if (passiveAdmission?.accepted === false) {
    return confirmedNoAgentEffect(
      json({
        ok: false,
        delivered: false,
        mode: "send_message",
        target: receiverAgentPath,
        status: passiveAdmission.status,
        hint: "This child is idle or finished. Use assign_task to start an idle worker's next turn.",
      }),
    );
  }
  return json({
    ok: true,
    mode: mode === "trigger_turn" ? "assign_task" : "send_message",
    target: receiverAgentPath,
    status,
    ...(mode === "queue_only"
      ? {
          delivered: false,
          delivery: "accepted_unconfirmed",
          hint: agentId === sessionOrError.conversationId
            ? "Queued for the root mailbox's next drain."
            : "Queued for the child's next turn. If the child finishes first, the message is lost.",
        }
      : {}),
    ...(acceptedTask !== undefined
      ? {
          task_id: acceptedTask.taskId,
          turn_id: acceptedTask.turnId,
        }
      : {}),
  });
}
