/**
 * Upstream `AgentDefinition[]` adapter for the AgenC TUI.
 *
 * The upstream-derived `<PromptInput>` consumes an `AgentDefinition[]` for
 * the @-mention agent picker. AgenC's runtime exposes agent ROLES via
 * `runtime/src/agents/role.ts::listAgentRoles()` — a structurally
 * different concept (a personality/config layer applied to spawned
 * subagents, not a list of standalone delegate-able subagent types).
 *
 * Until AgenC introduces a real agent-type registry, this adapter
 * projects each `AgentRole` as a synthesized `BuiltInAgentDefinition`
 * so the picker UI lights up. Selecting one does not change runtime
 * delegation behavior today — that wiring belongs to a separate
 * follow-up tracked outside this adapter.
 *
 * @module
 */
import type { AgentDefinition } from "../upstream/tools/AgentTool/loadAgentsDir.js";
import type { AgentRole } from "../../agents/role.js";
import { listAgentRoles } from "../../agents/role.js";

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

/**
 * Build the upstream-shaped agent list for the TUI.
 *
 * - Calls `listAgentRoles()` once per call (caller is expected to memoize
 *   across renders).
 * - Preserves registration order from the role registry.
 */
export function loadUpstreamAgentList(): readonly AgentDefinition[] {
  const roles = listAgentRoles();
  return roles.map(projectAgentRole);
}
