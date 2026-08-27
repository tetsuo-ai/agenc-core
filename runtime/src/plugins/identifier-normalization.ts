import { boundScopedServerIdentifier } from "../identifiers/server-name.js";
import { isCanonicalPluginIdentity } from "./identifier.js";

const SIMPLE_RUNTIME_PLUGIN_NAMESPACE = /^[a-z][a-z0-9-]*$/u;

/**
 * Project a canonical plugin ID into an injective runtime namespace.
 * Ordinary kebab-case IDs stay readable; every other byte is unambiguously
 * escaped behind a prefix that ordinary IDs cannot produce.
 */
export function canonicalPluginRuntimeNamespace(pluginId: string): string {
  if (!isCanonicalPluginIdentity(pluginId)) {
    throw new Error(`Invalid canonical plugin ID: ${pluginId}`);
  }
  if (SIMPLE_RUNTIME_PLUGIN_NAMESPACE.test(pluginId)) return pluginId;
  const encoded = [...Buffer.from(pluginId, "utf8")]
    .map((byte) =>
      (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)
        ? String.fromCharCode(byte)
        : `_${byte.toString(16).padStart(2, "0")}`
    )
    .join("");
  return `p_${encoded}`;
}

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
  pluginId: string,
  parts: readonly string[],
  finalFallback: string,
): string {
  return normalizePluginIdentifierName(
    [canonicalPluginRuntimeNamespace(pluginId), ...parts],
    finalFallback,
  );
}

export function pluginScopedServerIdentifier(
  pluginId: string,
  serverName: string,
): string {
  const serverParts = serverName.split(":").filter((part) => part.length > 0);
  return boundScopedServerIdentifier(
    normalizePluginIdentifierName(
      [
        "plugin",
        canonicalPluginRuntimeNamespace(pluginId),
        ...(serverParts.length > 0 ? serverParts : ["server"]),
      ],
      "server",
    ),
  );
}
