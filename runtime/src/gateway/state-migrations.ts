import {
  AGENT_RUN_SCHEMA_VERSION,
} from "./agent-run-contract.js";

export function isCompatibleBackgroundRunStateVersion(
  value: unknown,
): value is 1 | typeof AGENT_RUN_SCHEMA_VERSION {
  return value === 1 || value === AGENT_RUN_SCHEMA_VERSION;
}
