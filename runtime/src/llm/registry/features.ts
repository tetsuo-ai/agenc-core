/**
 * Ports upstream runtime staged feature registry semantics onto AgenC
 * feature names.
 */

import type { ManagedFeatures } from "../../session/turn-context.js";
import { isRecord } from "../../utils/record.js";

export type AgenCFeatureStage =
  | "under_development"
  | "experimental"
  | "stable"
  | "deprecated"
  | "removed";

export type AgenCFeatureKey =
  | "undo"
  | "shell_tool"
  | "unified_exec"
  | "shell_zsh_fork"
  | "shell_snapshot"
  | "js_repl"
  | "code_mode"
  | "code_mode_only"
  | "js_repl_tools_only"
  | "terminal_resize_reflow"
  | "web_search_request"
  | "web_search_cached"
  | "search_tool"
  | "agenc_git_commit"
  | "runtime_metrics"
  | "sqlite"
  | "memories"
  | "chronicle"
  | "child_agents_md"
  | "apply_patch_freeform"
  | "apply_patch_streaming_events"
  | "exec_permission_approvals"
  | "hooks"
  | "request_permissions_tool"
  | "use_linux_sandbox_bwrap"
  | "use_legacy_landlock"
  | "request_rule"
  | "experimental_windows_sandbox"
  | "elevated_windows_sandbox"
  | "remote_models"
  | "enable_request_compression"
  | "multi_agent"
  | "multi_agent_v2"
  | "enable_fanout"
  | "apps"
  | "enable_mcp_apps"
  | "apps_mcp_path_override"
  | "tool_search"
  | "tool_search_always_defer_mcp_tools"
  | "unavailable_dummy_tools"
  | "tool_suggest"
  | "plugins"
  | "plugin_hooks"
  | "in_app_browser"
  | "browser_use"
  | "browser_use_external"
  | "computer_use"
  | "remote_plugin"
  | "external_migration"
  | "image_generation"
  | "skill_mcp_dependency_install"
  | "skill_env_var_dependency_prompt"
  | "steer"
  | "default_mode_request_user_input"
  | "guardian_approval"
  | "goals"
  | "collaboration_modes"
  | "tool_call_mcp_elicitation"
  | "personality"
  | "artifact"
  | "fast_mode"
  | "realtime_conversation"
  | "remote_control"
  | "image_detail_original"
  | "tui_app_server"
  | "prevent_idle_sleep"
  | "workspace_owner_usage_nudge"
  | "responses_websockets"
  | "responses_websockets_v2"
  | "workspace_dependencies";

export interface AgenCFeatureSpec {
  readonly key: AgenCFeatureKey;
  readonly stage: AgenCFeatureStage;
  readonly defaultEnabled: boolean;
  readonly menuName?: string;
  readonly menuDescription?: string;
  readonly announcement?: string;
}

export interface AgenCMultiAgentV2Config {
  readonly enabled?: boolean;
  readonly max_concurrent_threads_per_session?: number;
  readonly min_wait_timeout_ms?: number;
  readonly usage_hint_enabled?: boolean;
  readonly usage_hint_text?: string;
  readonly root_agent_usage_hint_text?: string;
  readonly subagent_usage_hint_text?: string;
  readonly hide_spawn_agent_metadata?: boolean;
}

export interface AgenCAppsMcpPathOverrideConfig {
  readonly enabled?: boolean;
  readonly path?: string;
}

export type AgenCFeatureConfigEntry =
  | boolean
  | AgenCMultiAgentV2Config
  | AgenCAppsMcpPathOverrideConfig;

const PREVENT_IDLE_SLEEP_STAGE: AgenCFeatureStage =
  process.platform === "darwin" ||
  process.platform === "linux" ||
  process.platform === "win32"
    ? "experimental"
    : "under_development";

export const AGENC_FEATURE_SPECS: readonly AgenCFeatureSpec[] = Object.freeze([
  { key: "undo", stage: "removed", defaultEnabled: false },
  { key: "shell_tool", stage: "stable", defaultEnabled: true },
  {
    key: "unified_exec",
    stage: "stable",
    defaultEnabled: process.platform !== "win32",
  },
  { key: "shell_zsh_fork", stage: "under_development", defaultEnabled: false },
  { key: "shell_snapshot", stage: "stable", defaultEnabled: true },
  { key: "js_repl", stage: "removed", defaultEnabled: false },
  { key: "code_mode", stage: "under_development", defaultEnabled: false },
  { key: "code_mode_only", stage: "under_development", defaultEnabled: false },
  { key: "js_repl_tools_only", stage: "removed", defaultEnabled: false },
  {
    key: "terminal_resize_reflow",
    stage: "experimental",
    defaultEnabled: true,
    menuName: "Terminal resize reflow",
    menuDescription:
      "Rebuild AgenC-owned transcript scrollback when the terminal width changes.",
  },
  { key: "web_search_request", stage: "deprecated", defaultEnabled: false },
  { key: "web_search_cached", stage: "deprecated", defaultEnabled: false },
  { key: "search_tool", stage: "removed", defaultEnabled: false },
  { key: "agenc_git_commit", stage: "under_development", defaultEnabled: false },
  { key: "runtime_metrics", stage: "under_development", defaultEnabled: false },
  { key: "sqlite", stage: "removed", defaultEnabled: true },
  {
    key: "memories",
    stage: "experimental",
    defaultEnabled: false,
    menuName: "Memories",
    menuDescription:
      "Allow AgenC to create new memories from conversations and bring relevant memories into new conversations.",
    announcement:
      "NEW: AgenC can now generate and use memories. Try it now with `/memories`.",
  },
  { key: "chronicle", stage: "under_development", defaultEnabled: false },
  { key: "child_agents_md", stage: "under_development", defaultEnabled: false },
  {
    key: "apply_patch_freeform",
    stage: "under_development",
    defaultEnabled: false,
  },
  {
    key: "apply_patch_streaming_events",
    stage: "under_development",
    defaultEnabled: false,
  },
  {
    key: "exec_permission_approvals",
    stage: "under_development",
    defaultEnabled: false,
  },
  { key: "hooks", stage: "stable", defaultEnabled: true },
  {
    key: "request_permissions_tool",
    stage: "under_development",
    defaultEnabled: false,
  },
  { key: "use_linux_sandbox_bwrap", stage: "removed", defaultEnabled: false },
  { key: "use_legacy_landlock", stage: "deprecated", defaultEnabled: false },
  { key: "request_rule", stage: "removed", defaultEnabled: false },
  {
    key: "experimental_windows_sandbox",
    stage: "removed",
    defaultEnabled: false,
  },
  {
    key: "elevated_windows_sandbox",
    stage: "removed",
    defaultEnabled: false,
  },
  { key: "remote_models", stage: "removed", defaultEnabled: false },
  { key: "enable_request_compression", stage: "stable", defaultEnabled: true },
  { key: "multi_agent", stage: "stable", defaultEnabled: true },
  { key: "multi_agent_v2", stage: "under_development", defaultEnabled: false },
  { key: "enable_fanout", stage: "under_development", defaultEnabled: false },
  { key: "apps", stage: "stable", defaultEnabled: true },
  { key: "enable_mcp_apps", stage: "under_development", defaultEnabled: false },
  {
    key: "apps_mcp_path_override",
    stage: "under_development",
    defaultEnabled: false,
  },
  { key: "tool_search", stage: "stable", defaultEnabled: true },
  {
    key: "tool_search_always_defer_mcp_tools",
    stage: "under_development",
    defaultEnabled: false,
  },
  { key: "unavailable_dummy_tools", stage: "stable", defaultEnabled: true },
  { key: "tool_suggest", stage: "stable", defaultEnabled: true },
  { key: "plugins", stage: "stable", defaultEnabled: true },
  { key: "plugin_hooks", stage: "under_development", defaultEnabled: false },
  { key: "in_app_browser", stage: "stable", defaultEnabled: true },
  { key: "browser_use", stage: "stable", defaultEnabled: true },
  { key: "browser_use_external", stage: "stable", defaultEnabled: true },
  { key: "computer_use", stage: "stable", defaultEnabled: true },
  { key: "remote_plugin", stage: "under_development", defaultEnabled: false },
  {
    key: "external_migration",
    stage: "experimental",
    defaultEnabled: false,
    menuName: "External migration",
    menuDescription:
      "Show a startup prompt when AgenC detects migratable external agent config for this machine or project.",
  },
  { key: "image_generation", stage: "stable", defaultEnabled: true },
  {
    key: "skill_mcp_dependency_install",
    stage: "stable",
    defaultEnabled: true,
  },
  {
    key: "skill_env_var_dependency_prompt",
    stage: "under_development",
    defaultEnabled: false,
  },
  { key: "steer", stage: "removed", defaultEnabled: true },
  {
    key: "default_mode_request_user_input",
    stage: "under_development",
    defaultEnabled: false,
  },
  { key: "guardian_approval", stage: "stable", defaultEnabled: true },
  {
    key: "goals",
    stage: "experimental",
    defaultEnabled: false,
    menuName: "Goals",
    menuDescription: "Set a persistent goal AgenC can continue over time.",
  },
  { key: "collaboration_modes", stage: "removed", defaultEnabled: true },
  {
    key: "tool_call_mcp_elicitation",
    stage: "stable",
    defaultEnabled: true,
  },
  {
    key: "personality",
    stage: "stable",
    defaultEnabled: true,
    menuName: "Personality",
    menuDescription:
      "Apply model-specific friendly or pragmatic instruction templates when the selected model advertises them.",
  },
  { key: "artifact", stage: "under_development", defaultEnabled: false },
  { key: "fast_mode", stage: "stable", defaultEnabled: true },
  {
    key: "realtime_conversation",
    stage: "under_development",
    defaultEnabled: false,
  },
  { key: "remote_control", stage: "under_development", defaultEnabled: false },
  { key: "image_detail_original", stage: "removed", defaultEnabled: false },
  { key: "tui_app_server", stage: "removed", defaultEnabled: true },
  {
    key: "prevent_idle_sleep",
    stage: PREVENT_IDLE_SLEEP_STAGE,
    defaultEnabled: false,
    menuName: "Prevent sleep while running",
    menuDescription:
      "Keep your computer awake while AgenC is running a thread.",
    announcement:
      "NEW: Prevent sleep while running is now available in /experimental.",
  },
  {
    key: "workspace_owner_usage_nudge",
    stage: "under_development",
    defaultEnabled: false,
  },
  { key: "responses_websockets", stage: "removed", defaultEnabled: false },
  { key: "responses_websockets_v2", stage: "removed", defaultEnabled: false },
  { key: "workspace_dependencies", stage: "stable", defaultEnabled: true },
]);

const LEGACY_FEATURE_ALIASES: Readonly<Record<string, AgenCFeatureKey>> =
  Object.freeze({
    connectors: "apps",
    enable_experimental_windows_sandbox: "experimental_windows_sandbox",
    include_apply_patch_tool: "apply_patch_freeform",
    experimental_use_freeform_apply_patch: "apply_patch_freeform",
    experimental_use_unified_exec_tool: "unified_exec",
    request_permissions: "exec_permission_approvals",
    web_search: "web_search_request",
    collab: "multi_agent",
    memory_tool: "memories",
    telepathy: "chronicle",
    agenc_hooks: "hooks",
  });

const IGNORED_FEATURE_CONFIG_KEYS: ReadonlySet<AgenCFeatureKey> = new Set([
  "undo",
  "js_repl",
  "js_repl_tools_only",
  "image_detail_original",
  "tui_app_server",
]);

export class AgenCFeatureSet {
  readonly #enabled: Set<AgenCFeatureKey>;

  private constructor(enabled: Iterable<AgenCFeatureKey>) {
    this.#enabled = new Set(enabled);
  }

  static withDefaults(): AgenCFeatureSet {
    return new AgenCFeatureSet(
      AGENC_FEATURE_SPECS.filter((spec) => spec.defaultEnabled).map(
        (spec) => spec.key,
      ),
    );
  }

  static fromConfig(
    entries: Readonly<Record<string, AgenCFeatureConfigEntry | undefined>> = {},
  ): AgenCFeatureSet {
    const features = AgenCFeatureSet.withDefaults();
    features.apply(entries);
    features.normalizeDependencies();
    return features;
  }

  enabled(feature: AgenCFeatureKey): boolean {
    return this.#enabled.has(feature);
  }

  enabledFeatures(): readonly AgenCFeatureKey[] {
    return Object.freeze([...this.#enabled].sort());
  }

  setEnabled(feature: AgenCFeatureKey, enabled: boolean): void {
    if (enabled) {
      this.#enabled.add(feature);
    } else {
      this.#enabled.delete(feature);
    }
  }

  apply(
    entries: Readonly<Record<string, AgenCFeatureConfigEntry | undefined>>,
  ): void {
    for (const [rawKey, rawValue] of Object.entries(entries)) {
      if (rawValue === undefined) continue;
      const feature = featureForKey(rawKey);
      if (feature === undefined || IGNORED_FEATURE_CONFIG_KEYS.has(feature)) {
        continue;
      }
      const enabled = featureEnabledFromConfigEntry(feature, rawValue);
      if (enabled === undefined) continue;
      this.setEnabled(feature, enabled);
    }
  }

  normalizeDependencies(): void {
    if (this.enabled("enable_fanout")) {
      this.setEnabled("multi_agent", true);
    }
    if (this.enabled("code_mode_only")) {
      this.setEnabled("code_mode", true);
    }
  }
}

export function createManagedFeatures(
  config: unknown = {},
): ManagedFeatures {
  const features = AgenCFeatureSet.fromConfig(readFeatureConfigEntries(config));
  return Object.freeze({
    enabled: (feature: string) => {
      const key = featureForKey(feature);
      return key !== undefined && features.enabled(key);
    },
    appsEnabledForAuth: (isChatgptAuth: boolean) =>
      features.enabled("apps") && isChatgptAuth,
    useLegacyLandlock: () => features.enabled("use_legacy_landlock"),
  });
}

export function featureForKey(key: string): AgenCFeatureKey | undefined {
  if (isCanonicalFeatureKey(key)) return key;
  return LEGACY_FEATURE_ALIASES[key];
}

export function isKnownFeatureKey(key: string): boolean {
  return featureForKey(key) !== undefined;
}

export function experimentalFeatureSpecs(): readonly AgenCFeatureSpec[] {
  return Object.freeze(
    AGENC_FEATURE_SPECS.filter((spec) => spec.stage === "experimental"),
  );
}

function featureEnabledFromConfigEntry(
  feature: AgenCFeatureKey,
  value: AgenCFeatureConfigEntry,
): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (!isRecord(value)) return undefined;
  const configured = optionalBoolean(value.enabled);
  if (configured !== undefined) return configured;
  if (feature === "apps_mcp_path_override" && nonEmptyString(value.path)) {
    return true;
  }
  return undefined;
}

function readFeatureConfigEntries(
  config: unknown,
): Readonly<Record<string, AgenCFeatureConfigEntry | undefined>> {
  if (!isRecord(config)) return {};
  const direct = config.features;
  if (isFeatureConfigRecord(direct)) return direct;
  const unknown = isRecord(config._unknown) ? config._unknown.features : undefined;
  return isFeatureConfigRecord(unknown) ? unknown : {};
}

function isFeatureConfigRecord(
  value: unknown,
): value is Readonly<Record<string, AgenCFeatureConfigEntry | undefined>> {
  return isRecord(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalFeatureKey(key: string): key is AgenCFeatureKey {
  return AGENC_FEATURE_SPECS.some((spec) => spec.key === key);
}
