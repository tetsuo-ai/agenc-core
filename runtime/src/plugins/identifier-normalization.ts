export function normalizePluginIdentifierSegment(
  value: string,
  fallback: string,
): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  const segment = normalized.length > 0 ? normalized : fallback;
  return /^[a-z]/u.test(segment) ? segment : `cmd_${segment}`;
}

export function normalizePluginIdentifierName(
  parts: readonly string[],
  finalFallback: string,
): string {
  return parts
    .map((part, index) =>
      normalizePluginIdentifierSegment(
        part,
        index === parts.length - 1 ? finalFallback : "namespace",
      )
    )
    .join(":");
}

export function pluginScopedIdentifier(
  pluginName: string,
  parts: readonly string[],
  finalFallback: string,
): string {
  return normalizePluginIdentifierName([pluginName, ...parts], finalFallback);
}
