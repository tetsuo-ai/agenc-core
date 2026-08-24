export interface ParsedPluginIdentifier {
  readonly name: string;
  readonly marketplace?: string;
}

/** Parse the canonical `name@marketplace` identity without discarding suffixes. */
export function parsePluginIdentifier(plugin: string): ParsedPluginIdentifier {
  const marker = plugin.indexOf("@", 1);
  if (marker === -1) return { name: plugin };
  return {
    name: plugin.slice(0, marker),
    marketplace: plugin.slice(marker + 1) || undefined,
  };
}

export function buildPluginIdentifier(
  name: string,
  marketplace?: string,
): string {
  return marketplace ? `${name}@${marketplace}` : name;
}
