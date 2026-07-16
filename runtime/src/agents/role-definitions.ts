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
  source: "built-in";
  baseDir: "built-in";
  agentRoleFingerprint: string;
  getSystemPrompt: () => string;
};

function projectAgentRole(role: AgentRole): AgentRoleDefinition {
  const description = role.config.description ?? role.name;
  const systemPrompt = role.config.systemPrompt ?? "";
  const tools = role.config.allowlist
    ? Array.from(role.config.allowlist)
    : undefined;
  const definition = {
    agentType: role.name,
    whenToUse: description,
    source: "built-in" as const,
    baseDir: "built-in" as const,
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
