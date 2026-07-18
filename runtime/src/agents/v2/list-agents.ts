import type { AgentPath } from "../registry.js";
import { resolveAgentPath } from "../registry.js";
import type { Tool, ToolResult } from "../../tools/types.js";
import {
  currentAgentContext,
  getSessionOrError,
  json,
  localZeroAdmissionEstimate,
  strictArgs,
  stringValue,
  toListedAgentJson,
  toolMetadata,
  type MultiAgentV2Options,
} from "./common.js";

export function createListAgentsTool(opts: MultiAgentV2Options): Tool {
  const execute = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const strict = strictArgs(args, {
      allowed: new Set(["path_prefix"]),
    });
    if (strict) return strict;
    if (args.path_prefix !== undefined && typeof args.path_prefix !== "string") {
      return json({ error: "path_prefix must be a string" }, true);
    }
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const { control } = opts.ensureAgentControl(sessionOrError);
    control.registerSessionRoot(sessionOrError.conversationId);
    const current = currentAgentContext(sessionOrError, args, opts);
    const pathPrefixRaw = stringValue(args.path_prefix);
    let resolvedPathPrefix: AgentPath | undefined;
    if (pathPrefixRaw !== undefined) {
      try {
        resolvedPathPrefix = resolveAgentPath(current.agentPath, pathPrefixRaw);
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : String(error) },
          true,
        );
      }
    }
    return json({
      agents: control.listAgents({
        ...(resolvedPathPrefix !== undefined
          ? { pathPrefix: resolvedPathPrefix }
          : {}),
      }).map(toListedAgentJson),
    });
  };

  return {
    name: "list_agents",
    description:
      "List live agents in the current root thread tree. Optionally filter by task-path prefix.",
    metadata: toolMetadata("agent", { keywords: ["agent", "list", "status"] }),
    isReadOnly: true,
    recoveryCategory: "idempotent",
    admissionEstimate: localZeroAdmissionEstimate,
    inputSchema: {
      type: "object",
      properties: {
        path_prefix: { type: "string" },
      },
      additionalProperties: false,
    },
    execute,
  };
}
