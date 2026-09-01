import type { Tool, ToolResult } from "../../tools/types.js";
import type { AgentStatus } from "../status.js";
import {
  agentValidationError,
  callIdFromArgs,
  confirmedNoAgentEffect,
  currentAgentContext,
  emit,
  getSessionOrError,
  isCurrentAgentContextError,
  json,
  localZeroAdmissionEstimate,
  receiverMetadataFor,
  resolveAgentId,
  strictArgs,
  stringValue,
  toolMetadata,
  type MultiAgentV2Options,
} from "./common.js";
import { toAgentStatusJson } from "../status.js";

export function createCloseAgentTool(opts: MultiAgentV2Options): Tool {
  const execute = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const strict = strictArgs(args, {
      allowed: new Set(["target"]),
      required: ["target"],
    });
    if (strict) return confirmedNoAgentEffect(strict);
    const target = stringValue(args.target);
    if (!target) return agentValidationError("target is required");
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) {
      return confirmedNoAgentEffect(sessionOrError);
    }
    const { control } = opts.ensureAgentControl(sessionOrError);
    const current = currentAgentContext(sessionOrError, args, opts);
    if (isCurrentAgentContextError(current)) {
      return confirmedNoAgentEffect(current);
    }
    let agentId;
    try {
      agentId = resolveAgentId(sessionOrError, target, current.agentPath, opts);
    } catch (error) {
      return agentValidationError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (agentId === sessionOrError.conversationId) {
      return agentValidationError("root is not a spawned agent");
    }
    const callId = callIdFromArgs(args, "close");
    const receiverMetadata = receiverMetadataFor(sessionOrError, agentId, opts);
    emit(sessionOrError, {
      type: "collab_close_begin",
      payload: {
        callId,
        senderThreadId: current.threadId,
        receiverThreadId: agentId,
        ...receiverMetadata,
      },
    });
    let previous: AgentStatus;
    try {
      const subscription = await control.subscribeStatus(agentId);
      previous = subscription.value;
      subscription.unsubscribe();
    } catch {
      previous =
        control.getLive(agentId)?.status.value ??
        (typeof (control as { getStatus?: unknown }).getStatus === "function"
          ? await control.getStatus(agentId)
          : { status: "not_found" });
    }
    let closeError: unknown;
    try {
      await control.shutdown(agentId, "closed_by_tool");
    } catch (error) {
      closeError = error;
    }
    emit(sessionOrError, {
      type: "collab_close_end",
      payload: {
        callId,
        senderThreadId: current.threadId,
        receiverThreadId: agentId,
        ...receiverMetadata,
        status: previous,
      },
    });
    if (closeError !== undefined) {
      return json(
        {
          error:
            closeError instanceof Error ? closeError.message : String(closeError),
        },
        true,
      );
    }
    return json({ previous_status: toAgentStatusJson(previous) });
  };

  return {
    name: "close_agent",
    description: "Close a spawned agent and its descendants.",
    metadata: toolMetadata("agent", {
      mutating: true,
      virtualNoFsWrites: true,
      keywords: ["agent", "close", "stop"],
    }),
    requiresApproval: true,
    recoveryCategory: "side-effecting",
    admissionEstimate: localZeroAdmissionEstimate,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
      },
      required: ["target"],
      additionalProperties: false,
    },
    execute,
  };
}
