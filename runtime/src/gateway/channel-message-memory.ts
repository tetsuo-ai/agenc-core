import type { LLMMessage } from "../llm/types.js";
import type { GatewayMessage } from "./message.js";

export function getMessageMetadataString(
  msg: GatewayMessage,
  key: string,
): string | undefined {
  const value = msg.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resolveChannelWorkspaceId(
  msg: GatewayMessage,
  fallbackWorkspaceId = "default",
): string {
  const workspaceId =
    getMessageMetadataString(msg, "workspace_id") ?? fallbackWorkspaceId;
  const worldId = getMessageMetadataString(msg, "world_id");

  if (msg.channel === "concordia" && worldId) {
    return `${workspaceId}::${worldId}`;
  }

  return workspaceId;
}

export function shouldPersistToDaemonMemory(msg: GatewayMessage): boolean {
  return msg.channel !== "concordia";
}

export function resolveIngestHistoryRole(
  msg: GatewayMessage,
): LLMMessage["role"] {
  const roleCandidate = msg.metadata?.history_role ?? msg.metadata?.role;
  if (
    roleCandidate === "system" ||
    roleCandidate === "assistant" ||
    roleCandidate === "user"
  ) {
    return roleCandidate;
  }
  return "user";
}

export function buildDaemonMemoryEntryOptions(
  msg: GatewayMessage,
  workspaceId: string,
  channelName: string,
): {
  readonly workspaceId: string;
  readonly agentId?: string;
  readonly worldId?: string;
  readonly channel: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
} {
  const agentId = getMessageMetadataString(msg, "agent_id");
  const worldId = getMessageMetadataString(msg, "world_id");
  return {
    workspaceId,
    ...(agentId ? { agentId } : {}),
    ...(worldId ? { worldId } : {}),
    channel: channelName,
    ...(msg.metadata ? { metadata: msg.metadata } : {}),
  };
}
