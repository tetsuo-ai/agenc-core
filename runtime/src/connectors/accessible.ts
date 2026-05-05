import {
  connectorInstallUrl,
  normalizeConnectorValue,
  ordinalCompare,
  sortConnectorsByAccessibilityAndName,
} from "./metadata.js";
import type { AccessibleConnectorTool, AppInfo } from "./types.js";

export function collectAccessibleConnectors(
  tools: Iterable<AccessibleConnectorTool>,
): AppInfo[] {
  const connectors = new Map<string, { connector: MutableAppInfo; pluginDisplayNames: Set<string> }>();

  for (const tool of tools) {
    const connectorId = tool.connectorId;
    const connectorName = normalizeConnectorValue(tool.connectorName) ?? connectorId;
    const connectorDescription = normalizeConnectorValue(tool.connectorDescription);
    const existing = connectors.get(connectorId);
    if (existing) {
      if (existing.connector.name === connectorId && connectorName !== connectorId) {
        existing.connector.name = connectorName;
      }
      if (existing.connector.description === undefined && connectorDescription !== undefined) {
        existing.connector.description = connectorDescription;
      }
      for (const displayName of tool.pluginDisplayNames ?? []) {
        existing.pluginDisplayNames.add(displayName);
      }
      continue;
    }

    connectors.set(connectorId, {
      connector: {
        id: connectorId,
        name: connectorName,
        ...(connectorDescription !== undefined ? { description: connectorDescription } : {}),
        isAccessible: true,
        isEnabled: true,
        pluginDisplayNames: [],
      },
      pluginDisplayNames: new Set(tool.pluginDisplayNames ?? []),
    });
  }

  return sortConnectorsByAccessibilityAndName(
    [...connectors.values()].map(({ connector, pluginDisplayNames }) => ({
      ...connector,
      installUrl: connectorInstallUrl(connector.name, connector.id),
      pluginDisplayNames: [...pluginDisplayNames].sort(ordinalCompare),
    })),
  );
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type MutableAppInfo = Mutable<Omit<AppInfo, "pluginDisplayNames">> & {
  pluginDisplayNames: string[];
  description?: string;
};
