/**
 * Ports per-tool enablement and default approval policy merging from the
 * donor runtime's app/MCP tool config surfaces onto AgenC's flat
 * `tools_config` map.
 *
 * AgenC shape differences:
 *   - Built-in, MCP, dynamic, and model-facing tools all share one flat
 *     registry, so lookup accepts exact tool names plus dotted TOML paths.
 *   - The legacy boolean `tools_config.web_search = false` shorthand is
 *     preserved as an alias for the model-facing `WebSearch` tool and the
 *     provider-native `web_search` name.
 *
 * Cross-cuts deliberately NOT carried:
 *   - App/plugin install-time capability grants; TL-20 only owns runtime
 *     tool filtering and per-tool default approval policy.
 *
 * @module
 */

import type {
  PermissionDefaultMode,
  ToolsConfig,
} from "../config/schema.js";
import { isValidPermissionDefaultMode } from "../config/schema.js";

export interface ResolvedToolConfig {
  readonly enabled?: boolean;
  readonly defaultPermissionMode?: PermissionDefaultMode;
}

const TOOL_CONFIG_ALIASES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    WebSearch: Object.freeze(["web_search"]),
    web_search: Object.freeze(["WebSearch"]),
    view_image: Object.freeze(["ViewImage"]),
    ViewImage: Object.freeze(["view_image"]),
  });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length > 0 ? out : undefined;
}

function candidateToolKeys(toolName: string): readonly string[] {
  const keys = [toolName, ...(TOOL_CONFIG_ALIASES[toolName] ?? [])];
  return [...new Set(keys)];
}

function readDirectOrDotted(
  config: ToolsConfig | undefined,
  key: string,
): unknown {
  if (!config) return undefined;
  if (Object.prototype.hasOwnProperty.call(config, key)) {
    return config[key];
  }
  if (!key.includes(".")) return undefined;

  let cursor: unknown = config;
  for (const part of key.split(".")) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function resolveApprovalModeAlias(
  raw: unknown,
): PermissionDefaultMode | undefined {
  switch (raw) {
    case "approve":
      return "never";
    case "prompt":
      return "untrusted";
    case "auto":
    default:
      return undefined;
  }
}

function coerceToolConfig(raw: unknown): ResolvedToolConfig {
  if (typeof raw === "boolean") {
    return { enabled: raw };
  }
  if (!isPlainObject(raw)) {
    return {};
  }

  const enabled =
    typeof raw.enabled === "boolean" ? raw.enabled : undefined;
  const defaultPermissionMode =
    isValidPermissionDefaultMode(raw.default_permission_mode)
      ? raw.default_permission_mode
      : isValidPermissionDefaultMode(raw.defaultPermissionMode)
        ? raw.defaultPermissionMode
        : resolveApprovalModeAlias(raw.approval_mode);
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(defaultPermissionMode !== undefined
      ? { defaultPermissionMode }
      : {}),
  };
}

export function resolvePerToolConfig(
  config: ToolsConfig | undefined,
  toolName: string,
): ResolvedToolConfig {
  for (const key of candidateToolKeys(toolName)) {
    const resolved = coerceToolConfig(readDirectOrDotted(config, key));
    if (
      resolved.enabled !== undefined ||
      resolved.defaultPermissionMode !== undefined
    ) {
      return resolved;
    }
  }
  return {};
}

function toolNameSetContains(
  values: readonly string[] | undefined,
  toolName: string,
): boolean {
  if (!values) return false;
  const set = new Set(values);
  return candidateToolKeys(toolName).some((key) => set.has(key));
}

export function toolConfigAllowsTool(
  config: ToolsConfig | undefined,
  toolName: string,
): boolean {
  if (!config) return true;

  const enabledTools = readStringArray(config.enabled_tools);
  const disabledTools = readStringArray(config.disabled_tools);
  if (enabledTools && !toolNameSetContains(enabledTools, toolName)) {
    return false;
  }
  if (toolNameSetContains(disabledTools, toolName)) {
    return false;
  }

  return resolvePerToolConfig(config, toolName).enabled !== false;
}
