export type PluginEnabledEdit = readonly [keyPath: string, value: unknown];

export function collectPluginEnabledCandidates(
  edits: Iterable<PluginEnabledEdit>,
): ReadonlyMap<string, boolean> {
  const pendingChanges = new Map<string, boolean>();
  for (const [keyPath, value] of edits) {
    const segments = keyPath.split(".");
    if (
      segments.length === 3 &&
      segments[0] === "plugins" &&
      segments[2] === "enabled" &&
      typeof value === "boolean"
    ) {
      pendingChanges.set(segments[1] ?? "", value);
      continue;
    }

    if (segments.length === 2 && segments[0] === "plugins") {
      const enabled = enabledFromTable(value);
      if (enabled !== null) pendingChanges.set(segments[1] ?? "", enabled);
      continue;
    }

    if (segments.length === 1 && segments[0] === "plugins" && isRecord(value)) {
      for (const [pluginId, pluginValue] of Object.entries(value)) {
        const enabled = enabledFromTable(pluginValue);
        if (enabled !== null) pendingChanges.set(pluginId, enabled);
      }
    }
  }
  return new Map([...pendingChanges.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function collectPluginEnabledCandidateRecord(
  edits: Iterable<PluginEnabledEdit>,
): Readonly<Record<string, boolean>> {
  return Object.freeze(Object.fromEntries(collectPluginEnabledCandidates(edits)));
}

function enabledFromTable(value: unknown): boolean | null {
  if (!isRecord(value)) return null;
  return typeof value.enabled === "boolean" ? value.enabled : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
