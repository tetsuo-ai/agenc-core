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

/** Bind MCP expansion and child-process variables to one captured filesystem authority. */
export function snapshotMcpRequestEnvironmentForAuthority(
  environment: ProviderEnvironment,
  authority: {
    readonly agencHome: string;
    readonly pluginStorageRoot: string;
  },
): ProviderEnvironment {
  return Object.freeze({
    ...environment,
    AGENC_HOME: authority.agencHome,
    AGENC_PLUGIN_CACHE_DIR: authority.pluginStorageRoot,
  });
}
