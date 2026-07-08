import type { Tool } from "../../tools/types.js";
import type { MultiAgentV2Options } from "./common.js";
import { createAssignTaskTool } from "./assign-task.js";
import { createCloseAgentTool } from "./close-agent.js";
import { createListAgentsTool } from "./list-agents.js";
import { createSendMessageTool } from "./send-message.js";
import { createSpawnAgentTool } from "./spawn.js";
import { createWaitAgentTool } from "./wait.js";

export function createMultiAgentV2Tools(
  opts: MultiAgentV2Options,
): readonly Tool[] {
  return [
    createSpawnAgentTool(opts),
    createWaitAgentTool(opts),
    createCloseAgentTool(opts),
    createAssignTaskTool(opts),
    createSendMessageTool(opts),
    createListAgentsTool(opts),
  ];
}
