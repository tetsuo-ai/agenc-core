import { formatNumber } from "../../../utils/format.js";

export type RunningLocalAgentTask = {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly status?: unknown;
  readonly description?: unknown;
  readonly agentId?: unknown;
  readonly agentType?: unknown;
  readonly progress?: {
    readonly tokenCount?: unknown;
    readonly lastActivity?: {
      readonly activityDescription?: unknown;
    };
  };
};

export function getRunningLocalAgentTasks(
  tasks: Record<string, unknown> | undefined,
): RunningLocalAgentTask[] {
  return Object.values(tasks ?? {})
    .filter(
      (task): task is RunningLocalAgentTask =>
        typeof task === "object" &&
        task !== null &&
        (task as RunningLocalAgentTask).type === "local_agent" &&
        (task as RunningLocalAgentTask).status === "running",
    )
    .sort((left, right) =>
      formatLocalAgentName(left).localeCompare(formatLocalAgentName(right)),
    );
}

export function formatLocalAgentName(task: RunningLocalAgentTask): string {
  const description =
    typeof task.description === "string" ? task.description.trim() : "";
  if (description && description.length <= 48 && !description.includes("\n")) {
    return description;
  }
  const agentType = typeof task.agentType === "string" ? task.agentType.trim() : "";
  if (agentType && agentType !== "agent") return agentType;
  const agentId = typeof task.agentId === "string" ? task.agentId.trim() : "";
  if (agentId) return agentId.slice(0, 8);
  const id = typeof task.id === "string" ? task.id.trim() : "";
  return id ? id.slice(0, 8) : "agent";
}

export function formatRunningAgentSummary(
  agents: readonly RunningLocalAgentTask[],
): string {
  const count = agents.length;
  const names = agents.slice(0, 3).map(formatLocalAgentName);
  const more = count > names.length ? ` +${count - names.length}` : "";
  const tokenCount = agents.reduce((total, agent) => {
    const value = agent.progress?.tokenCount;
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
  const tokenSuffix = tokenCount > 0 ? ` · ${formatNumber(tokenCount)} tokens` : "";
  return `${count} ${count === 1 ? "agent" : "agents"} running: ${names.join(", ")}${more}${tokenSuffix}`;
}
