import type { Tool } from "../../tools/types.js";
import {
  localZeroAdmissionEstimate,
  strictArgs,
  toolMetadata,
  type MultiAgentV2Options,
} from "./common.js";
import {
  handleMessageStringTool,
  MAX_INTER_AGENT_MESSAGE_CHARACTERS,
} from "./message-tool.js";

const TRIGGER_TURN_TASK_DESCRIPTION =
  "Assign one correlated task to an existing non-root reusable worker. The sender must be a strict ancestor, the worker must be idle, and busy workers or workers with an outstanding assignment are rejected.";

export function createTriggerTurnTaskTool(
  opts: MultiAgentV2Options,
  config: {
    readonly name: "assign_task";
    readonly keywords: readonly string[];
  },
): Tool {
  return {
    name: config.name,
    description: TRIGGER_TURN_TASK_DESCRIPTION,
    metadata: toolMetadata("agent", {
      mutating: true,
      keywords: config.keywords,
    }),
    recoveryCategory: "side-effecting",
    admissionEstimate: localZeroAdmissionEstimate,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        message: {
          type: "string",
          maxLength: MAX_INTER_AGENT_MESSAGE_CHARACTERS,
        },
      },
      required: ["target", "message"],
      additionalProperties: false,
    },
    execute: (args) => {
      const strict = strictArgs(args, {
        allowed: new Set(["target", "message"]),
        required: ["target", "message"],
      });
      if (strict) return Promise.resolve(strict);
      return handleMessageStringTool(args, opts, "trigger_turn");
    },
  };
}

export function createAssignTaskTool(opts: MultiAgentV2Options): Tool {
  return createTriggerTurnTaskTool(opts, {
    name: "assign_task",
    keywords: ["agent", "assign", "task"],
  });
}
