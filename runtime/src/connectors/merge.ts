import {
  connectorInstallUrl,
  ordinalCompare,
  sortConnectorsByAccessibilityAndName,
} from "./metadata.js";
import type { AppInfo } from "./types.js";

export function mergeConnectors(
  connectors: readonly AppInfo[],
  accessibleConnectors: readonly AppInfo[],
): AppInfo[] {
  const merged = new Map<string, MutableAppInfo>();

  for (const connector of connectors) {
    merged.set(connector.id, {
      ...connector,
      isAccessible: false,
      pluginDisplayNames: [...connector.pluginDisplayNames],
    });
  }

  for (const connector of accessibleConnectors) {
    const existing = merged.get(connector.id);
    if (!existing) {
      merged.set(connector.id, {
        ...connector,
        isAccessible: true,
        pluginDisplayNames: [...connector.pluginDisplayNames],
      });
      continue;
    }

    existing.isAccessible = true;
    if (existing.name === existing.id && connector.name !== connector.id) {
      existing.name = connector.name;
    }
    if (existing.description === undefined && connector.description !== undefined) {
      existing.description = connector.description;
    }
    if (existing.logoUrl === undefined && connector.logoUrl !== undefined) {
      existing.logoUrl = connector.logoUrl;
    }
    if (existing.logoUrlDark === undefined && connector.logoUrlDark !== undefined) {
      existing.logoUrlDark = connector.logoUrlDark;
    }
    if (
      existing.distributionChannel === undefined &&
      connector.distributionChannel !== undefined
    ) {
      existing.distributionChannel = connector.distributionChannel;
    }
    existing.pluginDisplayNames.push(...connector.pluginDisplayNames);
  }

  return sortConnectorsByAccessibilityAndName(
    [...merged.values()].map((connector) => ({
      ...connector,
      installUrl: connector.installUrl ?? connectorInstallUrl(connector.name, connector.id),
      pluginDisplayNames: uniqueSorted(connector.pluginDisplayNames),
    })),
  );
}

export function mergePluginConnectors(
  connectors: readonly AppInfo[],
  pluginAppIds: Iterable<string>,
): AppInfo[] {
  const merged = connectors.map((connector) => ({ ...connector }));
  const connectorIds = new Set(merged.map((connector) => connector.id));
  for (const connectorId of pluginAppIds) {
    if (!connectorIds.has(connectorId)) {
      connectorIds.add(connectorId);
      merged.push(pluginConnectorToAppInfo(connectorId));
    }
  }
  return sortConnectorsByAccessibilityAndName(merged);
}

export function mergePluginConnectorsWithAccessible(
  pluginAppIds: Iterable<string>,
  accessibleConnectors: readonly AppInfo[],
): AppInfo[] {
  const accessibleConnectorIds = new Set(accessibleConnectors.map((connector) => connector.id));
  const pluginConnectors = [...pluginAppIds]
    .filter((connectorId) => accessibleConnectorIds.has(connectorId))
    .map(pluginConnectorToAppInfo);
  return mergeConnectors(pluginConnectors, accessibleConnectors);
}

export function pluginConnectorToAppInfo(connectorId: string): AppInfo {
  return {
    id: connectorId,
    name: connectorId,
    installUrl: connectorInstallUrl(connectorId, connectorId),
    isAccessible: false,
    isEnabled: true,
    pluginDisplayNames: [],
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(ordinalCompare);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

type MutableAppInfo = Mutable<Omit<AppInfo, "pluginDisplayNames" | "isAccessible">> & {
  isAccessible: boolean;
  pluginDisplayNames: string[];
  description?: string;
  logoUrl?: string;
  logoUrlDark?: string;
  distributionChannel?: string;
};
