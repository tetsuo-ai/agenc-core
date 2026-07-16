import type { AgentRole } from "./role.js";
import {
  createAgentRoleWorkspace,
  listAgentRoles,
} from "./role.js";
import { agentDefinitionFingerprint } from "./agent-definition-fingerprint.js";

export type AgentRoleDefinition = {
  agentType: string;
  whenToUse: string;
  tools?: string[];
  disallowedTools?: string[];
  background?: boolean;
  effort?: AgentRole["config"]["reasoningEffort"];
  source:
    | "built-in"
    | "userSettings"
    | "projectSettings"
    | "flagSettings"
    | "policySettings";
  baseDir: "built-in" | "workspace-role";
  agentRoleFingerprint: string;
  getSystemPrompt: () => string;
};

function projectAgentRole(role: AgentRole): AgentRoleDefinition {
  const description = role.config.description ?? role.name;
  const systemPrompt = role.config.systemPrompt ?? "";
  const source =
    role.source === "built-in"
      ? "built-in" as const
      : role.source === "projectSettings"
        ? "projectSettings" as const
        : role.source === "userSettings"
          ? "userSettings" as const
          : role.source === "policySettings"
            ? "policySettings" as const
        : "flagSettings" as const;
  const tools = role.config.allowlist
    ? Array.from(role.config.allowlist)
    : undefined;
  const definition = {
    agentType: role.name,
    whenToUse: description,
    source,
    baseDir:
      source === "built-in" ? "built-in" as const : "workspace-role" as const,
    getSystemPrompt: () => systemPrompt,
    ...(tools !== undefined ? { tools } : {}),
    ...(role.config.disallowlist
      ? { disallowedTools: Array.from(role.config.disallowlist) }
      : {}),
    ...(role.config.background ? { background: true } : {}),
    ...(role.config.reasoningEffort
      ? { effort: role.config.reasoningEffort }
      : {}),
  };
  return {
    ...definition,
    agentRoleFingerprint: agentDefinitionFingerprint(definition),
  };
}

export function listAgentRoleDefinitions(
  cwd: string,
): readonly AgentRoleDefinition[] {
  return listAgentRoles(createAgentRoleWorkspace(cwd)).map(projectAgentRole);
}
