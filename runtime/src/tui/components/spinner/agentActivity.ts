import { formatNumber } from "../../../utils/format.js";

export type ActiveLocalAgentTask = {
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

export function normalizeLocalAgentStatus(status: unknown): string {
  if (typeof status !== "string" || status.trim().length === 0) {
    return "idle";
  }
  const value = status.trim().toLowerCase().replaceAll("_", "-");
  switch (value) {
    case "pending":
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "idle":
      return "idle";
    case "awaiting-user":
    case "awaiting-permission":
    case "waiting-on-user":
    case "blocked":
      return "waiting on user";
    case "completing":
      return "completing";
    case "failing":
      return "failing";
    case "failed":
    case "errored":
      return "failed";
    case "completed":
    case "complete":
      return "completed";
    case "cancelled":
    case "canceled":
    case "killed":
      return "cancelled";
    default:
      return value;
  }
}

export function isActiveLocalAgentStatus(status: unknown): boolean {
  switch (normalizeLocalAgentStatus(status)) {
    case "starting":
    case "running":
    case "waiting on user":
    case "completing":
    case "failing":
      return true;
    case "idle":
    case "failed":
    case "completed":
    case "cancelled":
    default:
      return false;
  }
}

export function isStoppableLocalAgentStatus(status: unknown): boolean {
  switch (normalizeLocalAgentStatus(status)) {
    case "starting":
    case "running":
      return true;
    default:
      return false;
  }
}

export function getActiveLocalAgentTasks(
  tasks: Record<string, unknown> | undefined,
): ActiveLocalAgentTask[] {
  return Object.values(tasks ?? {})
    .filter(
      (task): task is ActiveLocalAgentTask =>
        typeof task === "object" &&
        task !== null &&
        (task as ActiveLocalAgentTask).type === "local_agent" &&
        isActiveLocalAgentStatus((task as ActiveLocalAgentTask).status),
    )
    .sort((left, right) =>
      formatLocalAgentName(left).localeCompare(formatLocalAgentName(right)),
    );
}

export function formatLocalAgentName(task: ActiveLocalAgentTask): string {
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
  agents: readonly ActiveLocalAgentTask[],
): string {
  const count = agents.length;
  const names = agents.slice(0, 3).map((agent) => {
    const status = normalizeLocalAgentStatus(agent.status);
    return `${formatLocalAgentName(agent)} ${status}`;
  });
  const more = count > names.length ? ` +${count - names.length}` : "";
  const tokenCount = agents.reduce((total, agent) => {
    const value = agent.progress?.tokenCount;
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
  const tokenSuffix = tokenCount > 0 ? ` · ${formatNumber(tokenCount)} tokens` : "";
  return `${count} ${count === 1 ? "agent" : "agents"}: ${names.join(", ")}${more}${tokenSuffix}`;
}
