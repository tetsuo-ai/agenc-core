import { formatAgentRoleLabel } from "../../agents/role-presentation.js";
import type { AgentStatus } from "../../agents/status.js";

const PROMPT_PREVIEW_CHARS = 160;
const STATUS_MESSAGE_PREVIEW_CHARS = 240;
const STATUS_ERROR_PREVIEW_CHARS = 160;

export interface CollabAgentLabelInput {
  readonly threadId?: string;
  readonly nickname?: string | null;
  readonly role?: string | null;
  readonly roleDisplayName?: string | null;
}

export interface SpawnRequestSummary {
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
}

export interface CollabAgentStatusEntry extends CollabAgentLabelInput {
  readonly status: AgentStatus;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function compactTranscriptText(value: string, max: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

export function formatCollabAgentLabel(agent: CollabAgentLabelInput): string {
  const name = clean(agent.nickname) ?? clean(agent.threadId) ?? "agent";
  const roleName = clean(agent.role);
  const role =
    clean(agent.roleDisplayName) ??
    (roleName !== undefined ? formatAgentRoleLabel(roleName, roleName) : undefined);
  return role !== undefined ? `${name} [${role}]` : name;
}

export function formatSpawnRequestSuffix(
  request: SpawnRequestSummary | undefined,
): string {
  const model = clean(request?.model);
  const effort = clean(request?.reasoningEffort);
  if (model === undefined && effort === undefined) return "";
  if (model === undefined) return ` (${effort})`;
  if (effort === undefined) return ` (${model})`;
  return ` (${model} ${effort})`;
}

export function formatPromptPreview(prompt: string | undefined): string | undefined {
  const trimmed = clean(prompt);
  if (trimmed === undefined) return undefined;
  return compactTranscriptText(trimmed, PROMPT_PREVIEW_CHARS);
}

export function formatAgentStatusSummary(status: AgentStatus): string {
  switch (status.status) {
    case "pending_init":
      return "Pending init";
    case "idle":
      return "Idle";
    case "running":
      return "Running";
    case "completed": {
      const message = clean(status.lastMessage);
      if (message === undefined) return "Completed";
      return `Completed - ${compactTranscriptText(message, STATUS_MESSAGE_PREVIEW_CHARS)}`;
    }
    case "errored": {
      const error = clean(status.error);
      if (error === undefined) return "Error";
      return `Error - ${compactTranscriptText(error, STATUS_ERROR_PREVIEW_CHARS)}`;
    }
    case "shutdown":
      return "Shutdown";
    case "not_found":
      return "Not found";
    case "interrupted":
      return "Interrupted";
  }
}

export function formatWaitCompleteLines(
  statuses: Readonly<Record<string, AgentStatus>>,
  agentStatuses: readonly CollabAgentStatusEntry[] = [],
): readonly string[] {
  if (Object.keys(statuses).length === 0 && agentStatuses.length === 0) {
    return ["No agents completed yet"];
  }

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of agentStatuses) {
    const threadId = clean(entry.threadId);
    if (threadId !== undefined) seen.add(threadId);
    lines.push(
      `${formatCollabAgentLabel(entry)}: ${formatAgentStatusSummary(entry.status)}`,
    );
  }

  const extras = Object.entries(statuses)
    .filter(([threadId]) => !seen.has(threadId))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [threadId, status] of extras) {
    lines.push(
      `${formatCollabAgentLabel({ threadId })}: ${formatAgentStatusSummary(status)}`,
    );
  }
  return lines;
}

export function formatAgentToolError(result: unknown): string | undefined {
  if (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result)
  ) {
    const error = (result as Record<string, unknown>).error;
    return typeof error === "string" ? error : undefined;
  }
  return undefined;
}
