import type { AppInfo } from "./types.js";

export function connectorDisplayLabel(connector: Pick<AppInfo, "name">): string {
  return connector.name;
}

export function connectorMentionSlug(connector: Pick<AppInfo, "name">): string {
  return connectorNameSlug(connectorDisplayLabel(connector));
}

export function connectorInstallUrl(name: string, connectorId: string): string {
  const slug = connectorNameSlug(name);
  return `urn:agenc:connector:${slug}:${encodeURIComponent(connectorId)}`;
}

export function sanitizeName(name: string): string {
  return connectorNameSlug(name).replace(/-/gu, "_");
}

export function connectorNameSlug(name: string): string {
  let normalized = "";
  for (const character of name) {
    normalized += /[a-zA-Z0-9]/u.test(character)
      ? character.toLowerCase()
      : "-";
  }
  const trimmed = normalized.replace(/^-+|-+$/gu, "");
  return trimmed.length > 0 ? trimmed : "app";
}

export function ordinalCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function normalizeConnectorName(name: string, connectorId: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : connectorId;
}

export function normalizeConnectorValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function sortConnectorsByAccessibilityAndName<T extends AppInfo>(
  connectors: readonly T[],
): T[] {
  return [...connectors].sort((left, right) =>
    Number(right.isAccessible) - Number(left.isAccessible) ||
    ordinalCompare(left.name, right.name) ||
    ordinalCompare(left.id, right.id)
  );
}
