import type { Tool } from "../../tools/types.js";
import {
  strictArgs,
  toolMetadata,
  type MultiAgentV2Options,
} from "./common.js";
import { handleMessageStringTool } from "./message-tool.js";

const TRIGGER_TURN_TASK_DESCRIPTION =
  "Send a message to an existing non-root target agent and trigger a turn in that target. If the target is currently mid-turn, the message is queued and will be used to start the target's next turn, after the current turn completes.";

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
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        message: { type: "string" },
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
