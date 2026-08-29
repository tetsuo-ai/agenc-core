export interface ParsedPluginIdentifier {
  readonly name: string;
  readonly marketplace?: string;
}

const CANONICAL_PLUGIN_NAME_PATTERN = /^[a-z0-9][-a-z0-9._]*$/u;
const CANONICAL_MARKETPLACE_NAME_PATTERN = /^[a-z][a-z0-9._-]*$/u;

export function isCanonicalPluginName(value: string): boolean {
  return CANONICAL_PLUGIN_NAME_PATTERN.test(value);
}

export function isCanonicalMarketplaceName(value: string): boolean {
  return CANONICAL_MARKETPLACE_NAME_PATTERN.test(value);
}

export function isCanonicalPluginIdentity(value: string): boolean {
  const parsed = parsePluginIdentifier(value);
  return isCanonicalPluginName(parsed.name) &&
    (parsed.marketplace === undefined ||
      isCanonicalMarketplaceName(parsed.marketplace)) &&
    buildPluginIdentifier(parsed.name, parsed.marketplace) === value;
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
