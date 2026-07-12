import type { ToolResult } from "../../tools/types.js";
import type { ThreadId } from "../registry.js";
import {
  callIdFromArgs,
  currentAgentContext,
  emit,
  getSessionOrError,
  json,
  receiverMetadataFor,
  resolveAgentId,
  stringValue,
  type MultiAgentV2Options,
} from "./common.js";

export type MessageDeliveryMode = "queue_only" | "trigger_turn";

export async function handleMessageStringTool(
  args: Record<string, unknown>,
  opts: MultiAgentV2Options,
  mode: MessageDeliveryMode,
): Promise<ToolResult> {
  const target = stringValue(args.target);
  const message = typeof args.message === "string" ? args.message : undefined;
  if (!target || !message) {
    return json({ error: "target and message are required" }, true);
  }
  if (message.trim().length === 0) {
    return json({ error: "Empty message can't be sent to an agent" }, true);
  }
  const sessionOrError = getSessionOrError(opts);
  if (!("conversationId" in sessionOrError)) return sessionOrError;
  const { control } = opts.ensureAgentControl(sessionOrError);
  const current = currentAgentContext(sessionOrError, args, opts);
  let agentId: ThreadId;
  try {
    agentId = resolveAgentId(sessionOrError, target, current.agentPath, opts);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      true,
    );
  }
  if (mode === "trigger_turn" && agentId === sessionOrError.conversationId) {
    return json({ error: "Tasks can't be assigned to the root agent" }, true);
  }
  const callId = callIdFromArgs(args, "message");
  const live = control.getLive(agentId);
  const metadata = control.getAgentMetadata(agentId);
  const receiverAgentPath = metadata?.agentPath ?? live?.agentPath;
  if (!receiverAgentPath) {
    return json({ error: "target agent is missing an agent_path" }, true);
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
  try {
    await control.sendInterAgentCommunication(agentId, {
      author: current.agentPath,
      recipient: receiverAgentPath,
      content: message,
      triggerTurn: mode === "trigger_turn",
    });
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
  });
}
