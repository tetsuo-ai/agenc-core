import type { Tool, ToolResult } from "../../tools/types.js";
import type { AgentStatus } from "../status.js";
import {
  callIdFromArgs,
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
    if (strict) return strict;
    const target = stringValue(args.target);
    if (!target) return json({ error: "target is required" }, true);
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const { control } = opts.ensureAgentControl(sessionOrError);
    const current = currentAgentContext(sessionOrError, args, opts);
    if (isCurrentAgentContextError(current)) return current;
    let agentId;
    try {
      agentId = resolveAgentId(sessionOrError, target, current.agentPath, opts);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        true,
      );
    }
    if (agentId === sessionOrError.conversationId) {
      return json({ error: "root is not a spawned agent" }, true);
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
