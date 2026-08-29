/**
 * Resolves per-tool filtering and default approval policy from AgenC's flat
 * `tools_config` map.
 *
 * AgenC shape differences:
 *   - Built-in, MCP, dynamic, and model-facing tools all share one flat
 *     registry, so lookup accepts exact dispatch names only.
 *   - Per-tool keys are exact dispatch names. Enablement is expressed only by
 *     `enabled_tools` / `disabled_tools`; per-tool objects carry approval
 *     defaults only.
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
  readonly defaultPermissionMode?: PermissionDefaultMode;
}

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
  return [toolName];
}

function readDirect(
  config: ToolsConfig | undefined,
  key: string,
): unknown {
  if (!config) return undefined;
  return Object.prototype.hasOwnProperty.call(config, key)
    ? config[key]
    : undefined;
}

function coerceToolConfig(raw: unknown): ResolvedToolConfig {
  if (!isPlainObject(raw)) {
    return {};
  }

  const defaultPermissionMode =
    isValidPermissionDefaultMode(raw.default_permission_mode)
      ? raw.default_permission_mode
      : undefined;
  return {
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
    const resolved = coerceToolConfig(readDirect(config, key));
    if (
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

  return true;
}
