export const AGENT_TOOL_NAME = 'spawn_agent'
export const VERIFICATION_AGENT_TYPE = 'verification'

// Canonical role names of the one-shot read-only built-ins (scanner and Plan).
// Compared via canonicalAgentRoleName so semantic shortcuts and public names
// map here too. `verification` is NOT
// one-shot — it gets resumed with findings.
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'scanner',
  'Plan',
])
