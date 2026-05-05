import { collectAccessibleConnectors } from "./accessible.js";
import type {
  AppConfig,
  AppInfo,
  AppToolApproval,
  AppToolPolicy,
  AppsConfig,
  AppsRequirementsConfig,
  ConnectorToolInfo,
  ToolAnnotations,
} from "./types.js";

export const AGENC_APPS_MCP_SERVER_NAME = "agenc_apps";

export function accessibleConnectorsFromTools(
  tools: Iterable<ConnectorToolInfo>,
  serverName = AGENC_APPS_MCP_SERVER_NAME,
): AppInfo[] {
  const appTools = [...tools].filter((tool) =>
    tool.serverName === serverName && tool.connectorId.trim().length > 0,
  );
  return collectAccessibleConnectors(appTools);
}

export function withAppEnabledState(
  connectors: readonly AppInfo[],
  appsConfig?: AppsConfig | null,
  requirementsConfig?: AppsRequirementsConfig | null,
): AppInfo[] {
  if (!appsConfig && !requirementsConfig) return connectors.map((connector) => ({ ...connector }));

  return connectors.map((connector) => {
    let isEnabled = connector.isEnabled;
    if (
      appsConfig &&
      (appsConfig.default !== undefined || appsConfig.apps?.[connector.id] !== undefined)
    ) {
      isEnabled = appIsEnabled(appsConfig, connector.id);
    }
    if (requirementsConfig?.apps?.[connector.id]?.enabled === false) {
      isEnabled = false;
    }
    return { ...connector, isEnabled };
  });
}

export function withAppPluginSources(
  connectors: readonly AppInfo[],
  toolPluginProvenance: Readonly<Record<string, readonly string[]>>,
): AppInfo[] {
  return connectors.map((connector) => ({
    ...connector,
    pluginDisplayNames: [...(toolPluginProvenance[connector.id] ?? [])],
  }));
}

export function applyRequirementsAppsConstraints(
  appsConfig: AppsConfig,
  requirementsConfig?: AppsRequirementsConfig | null,
): AppsConfig {
  const apps = { ...(appsConfig.apps ?? {}) };
  for (const [appId, requirement] of Object.entries(requirementsConfig?.apps ?? {})) {
    if (requirement.enabled !== false) continue;
    apps[appId] = {
      ...(apps[appId] ?? {}),
      enabled: false,
    };
  }
  return {
    ...(appsConfig.default !== undefined ? { default: appsConfig.default } : {}),
    apps,
  };
}

export function appIsEnabled(
  appsConfig: AppsConfig,
  connectorId?: string | null,
): boolean {
  const defaultEnabled = appsConfig.default?.enabled ?? true;
  if (!connectorId) return defaultEnabled;
  return appsConfig.apps?.[connectorId]?.enabled ?? defaultEnabled;
}

export function appToolPolicyFromAppsConfig(
  appsConfig: AppsConfig | null | undefined,
  connectorId: string | null | undefined,
  toolName: string,
  toolTitle?: string | null,
  annotations?: ToolAnnotations | null,
): AppToolPolicy {
  if (!appsConfig) return defaultAppToolPolicy();

  const app = connectorId ? appsConfig.apps?.[connectorId] : undefined;
  const toolConfig = toolConfigFor(app, toolName, toolTitle);
  const approval = toolApproval(toolConfig, app);

  if (!appIsEnabled(appsConfig, connectorId)) {
    return { enabled: false, approval };
  }

  if (toolConfig?.enabled !== undefined) {
    return { enabled: toolConfig.enabled, approval };
  }

  const defaultToolsEnabled = app?.defaultToolsEnabled ?? app?.default_tools_enabled;
  if (defaultToolsEnabled !== undefined) {
    return { enabled: defaultToolsEnabled, approval };
  }

  const defaultConfig = appsConfig.default;
  const destructiveEnabled = app?.destructiveEnabled ??
    app?.destructive_enabled ??
    defaultConfig?.destructiveEnabled ??
    defaultConfig?.destructive_enabled ??
    true;
  const openWorldEnabled = app?.openWorldEnabled ??
    app?.open_world_enabled ??
    defaultConfig?.openWorldEnabled ??
    defaultConfig?.open_world_enabled ??
    true;
  const destructiveHint = annotations?.destructiveHint ?? true;
  const openWorldHint = annotations?.openWorldHint ?? true;

  return {
    enabled: (destructiveEnabled || !destructiveHint) &&
      (openWorldEnabled || !openWorldHint),
    approval,
  };
}

function defaultAppToolPolicy(): AppToolPolicy {
  return { enabled: true, approval: "auto" };
}

function toolConfigFor(
  app: AppConfig | undefined,
  toolName: string,
  toolTitle?: string | null,
) {
  const tools = app?.tools?.tools;
  return tools?.[toolName] ?? (toolTitle ? tools?.[toolTitle] : undefined);
}

function toolApproval(
  toolConfig: ReturnType<typeof toolConfigFor>,
  app: AppConfig | undefined,
): AppToolApproval {
  return toolConfig?.approvalMode ??
    toolConfig?.approval_mode ??
    app?.defaultToolsApprovalMode ??
    app?.default_tools_approval_mode ??
    "auto";
}
