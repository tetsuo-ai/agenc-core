import type { TaskState } from "../../../src/tasks/types.js";

type PreviewAgentFields = Partial<TaskState> &
  Pick<TaskState, "id" | "status">;

/** Minimal local-agent row for preview-invalidation epoch tests. */
export function previewAgentTask(fields: PreviewAgentFields): TaskState {
  const pathHint =
    "prompt" in fields && typeof fields.prompt === "string"
      ? fields.prompt
      : "target.ts";
  return {
    type: "local_agent",
    description: `editing ${pathHint}`,
    startTime: 0,
    outputFile: "",
    outputOffset: 0,
    notified: false,
    agentId: "agent",
    prompt: pathHint,
    agentType: "general",
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...fields,
  } as TaskState;
}
