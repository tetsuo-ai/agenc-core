/** Pure runtime environment validation used before session setup. */
export class AgentRuntimeOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeOptionsError";
  }
}

export const RETIRED_AGENT_RUNTIME_ENV_REPLACEMENTS = Object.freeze({
  AGENC_SIMPLE: "use --bare",
  AGENC_BARE: "use --bare",
} as const);

/** Reject removed runtime-option aliases at every client/startup boundary. */
export function assertNoRetiredAgentRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
): void {
  const present = Object.entries(RETIRED_AGENT_RUNTIME_ENV_REPLACEMENTS)
    .filter(([key]) => env[key] !== undefined);
  if (present.length === 0) return;
  throw new AgentRuntimeOptionsError(
    present
      .map(([key, replacement]) => `${key} was removed; ${replacement}`)
      .join("; "),
  );
}
