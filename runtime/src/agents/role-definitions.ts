import type { AgentRole } from "./role.js";
import { listAgentRoles, loadMarkdownAgentRoles } from "./role.js";

export type AgentRoleDefinition = {
  agentType: string;
  whenToUse: string;
  tools?: string[];
  source: "built-in";
  baseDir: "built-in";
  getSystemPrompt: () => string;
};

function projectAgentRole(role: AgentRole): AgentRoleDefinition {
  const description = role.config.description ?? role.name;
  const systemPrompt = role.config.systemPrompt ?? "";
  const tools = role.config.allowlist
    ? Array.from(role.config.allowlist)
    : undefined;
  const definition: AgentRoleDefinition = {
    agentType: role.name,
    whenToUse: description,
    source: "built-in",
    baseDir: "built-in",
    getSystemPrompt: () => systemPrompt,
    ...(tools !== undefined ? { tools } : {}),
  };
  return definition;
}

export function listAgentRoleDefinitions(
  cwd?: string,
): readonly AgentRoleDefinition[] {
  loadMarkdownAgentRoles(cwd);
  return listAgentRoles(cwd).map(projectAgentRole);
}
