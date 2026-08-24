import type { ProviderEnvironment } from "../llm/provider-options.js";

/** Fail-closed fallback for standalone/test MCP factories with no owner. */
export const EMPTY_MCP_REQUEST_ENVIRONMENT: ProviderEnvironment =
  Object.freeze({});

/** Capture transport authority so reconnects cannot observe later mutation. */
export function snapshotMcpRequestEnvironment(
  environment: ProviderEnvironment,
): ProviderEnvironment {
  return Object.freeze({ ...environment });
}
