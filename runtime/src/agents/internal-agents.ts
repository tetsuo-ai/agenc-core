/**
 * Agents the runtime spawns for its own upkeep, such as memory extraction
 * after a turn. They run silently and the user never asked for them, so
 * clients do not list or count them as the user's agents.
 */

/**
 * Delegate agent names must be lowercase letters, digits and underscores
 * (assertValidAgentName); the hyphenated name was rejected at spawn and the
 * extraction never ran.
 */
export const MEMORY_EXTRACTION_AGENT_NAME = "memory_extraction";

const INTERNAL_AGENT_NAMES: ReadonlySet<string> = new Set([
  MEMORY_EXTRACTION_AGENT_NAME,
]);

/** Whether an agent path ("/root/memory_extraction") names an internal upkeep agent. */
export function isInternalAgentPath(agentPath: unknown): boolean {
  if (typeof agentPath !== "string" || agentPath.length === 0) return false;
  return INTERNAL_AGENT_NAMES.has(agentPath.slice(agentPath.lastIndexOf("/") + 1));
}
