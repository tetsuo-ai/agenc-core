import type { AgentDefinition } from "../tools/AgentTool/loadAgentsDir.js";
import type { AgentRole } from "./role.js";
import { listAgentRoles } from "./role.js";

function projectAgentRole(role: AgentRole): AgentDefinition {
  const description = role.config.description ?? role.name;
  const systemPrompt = role.config.systemPrompt ?? "";
  const tools = role.config.allowlist
    ? Array.from(role.config.allowlist)
    : undefined;
  const definition: AgentDefinition = {
    agentType: role.name,
    whenToUse: description,
    source: "built-in",
    baseDir: "built-in",
    getSystemPrompt: () => systemPrompt,
    ...(tools !== undefined ? { tools } : {}),
  };
  return definition;
}

export function listAgentRoleDefinitions(): readonly AgentDefinition[] {
  return listAgentRoles().map(projectAgentRole);
}
