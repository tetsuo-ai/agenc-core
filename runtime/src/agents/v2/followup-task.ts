import type { Tool } from "../../tools/types.js";
import type { MultiAgentV2Options } from "./common.js";
import { createTriggerTurnTaskTool } from "./assign-task.js";

export function createFollowupTaskTool(opts: MultiAgentV2Options): Tool {
  return createTriggerTurnTaskTool(opts, {
    name: "followup_task",
    keywords: ["agent", "followup", "task"],
    deferred: true,
  });
}
