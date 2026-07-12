import { describe, expect, it } from "vitest";

import { defaultConfig } from "../../config/schema.js";
import {
  getModelInstructions,
} from "../../context/personality-spec-instructions.js";
import { buildPrompt } from "../../session/run-turn.js";
import type { TurnContext } from "../../session/turn-context.js";
import { StaticModelsManager } from "../models-manager.js";
import {
  AGENC_FEATURE_SPECS,
  AgenCFeatureSet,
  createManagedFeatures,
  experimentalFeatureSpecs,
  featureForKey,
} from "./features.js";
import {
  listRegisteredModelCatalogEntries,
  resolveModelCapabilityHints,
  resolveModelCatalogMetadata,
  resolveRegisteredModelCatalogEntry,
} from "./model-catalog.js";
import {
  BUILT_IN_PROVIDER_SCOPE_OMISSIONS,
  listBuiltInProviderInfo,
  resolveBuiltInProviderInfo,
} from "./provider-info.js";

const DONOR_MODEL_IDS = Object.freeze([
  // gpt-5 (the openai built-in default) is registered first so the default
  // resolves through the single-source registry rather than heuristic fallback.
  "gpt-5",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
  "gpt-5.2",
  "codex-auto-review", // branding-scan: allow OpenAI model identifier
]);

const DONOR_FEATURE_KEYS = Object.freeze([
  "undo",
  "shell_tool",
  "unified_exec",
  "shell_zsh_fork",
  "shell_snapshot",
  "js_repl",
  "code_mode",
  "code_mode_only",
  "js_repl_tools_only",
  "terminal_resize_reflow",
  "web_search_request",
  "web_search_cached",
  "search_tool",
  "agenc_git_commit",
  "runtime_metrics",
  "sqlite",
  "memories",
  "chronicle",
  "child_agents_md",
  "apply_patch_freeform",
  "apply_patch_streaming_events",
  "exec_permission_approvals",
  "hooks",
  "request_permissions_tool",
  "use_linux_sandbox_bwrap",
  "use_legacy_landlock",
  "request_rule",
  "experimental_windows_sandbox",
  "elevated_windows_sandbox",
  "remote_models",
  "enable_request_compression",
  "multi_agent",
  "multi_agent_v2",
  "enable_fanout",
  "apps",
  "enable_mcp_apps",
  "apps_mcp_path_override",
  "tool_search",
  "tool_search_always_defer_mcp_tools",
  "unavailable_dummy_tools",
  "tool_suggest",
  "plugins",
  "plugin_hooks",
  "in_app_browser",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "remote_plugin",
  "external_migration",
  "image_generation",
  "skill_mcp_dependency_install",
  "skill_env_var_dependency_prompt",
  "steer",
  "default_mode_request_user_input",
  "guardian_approval",
  "goals",
  "collaboration_modes",
  "tool_call_mcp_elicitation",
  "personality",
  "artifact",
  "fast_mode",
  "realtime_conversation",
  "remote_control",
  "image_detail_original",
  "tui_app_server",
  "prevent_idle_sleep",
  "workspace_owner_usage_nudge",
  "responses_websockets",
  "responses_websockets_v2",
  "workspace_dependencies",
]);

describe("LLM registry", () => {
  it("lists built-in providers with request and auth metadata", () => {
    expect(resolveBuiltInProviderInfo("xai")).toMatchObject({
      id: "grok",
      name: "xAI Grok",
      defaultModel: "grok-4.5",
      apiKeyEnvVar: "XAI_API_KEY",
      requestMaxRetries: 4,
      streamMaxRetries: 5,
      streamIdleTimeoutMs: 300_000,
      supportsWebsockets: false,
    });

    expect(resolveBuiltInProviderInfo("agenc")).toMatchObject({
      id: "agenc",
      name: "AgenC",
      requiresManagedAuth: true,
    });
    expect(resolveBuiltInProviderInfo("anthropic")).toMatchObject({
      baseURL: "https://api.anthropic.com/v1",
    });
    expect(resolveBuiltInProviderInfo("amazon-bedrock")).toMatchObject({
      id: "amazon-bedrock",
      name: "Amazon Bedrock",
      defaultModel: "amazon.nova-pro-v1:0",
      baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKeyEnvVar: "AWS_ACCESS_KEY_ID",
    });
    expect(listBuiltInProviderInfo().map((entry) => entry.id)).toContain(
      "openai-compatible",
    );
  });

  it("does not carry unresolved built-in provider scope omissions", () => {
    expect(BUILT_IN_PROVIDER_SCOPE_OMISSIONS).toEqual({});
  });

  it("resolves donor model catalog metadata by exact, prefix, and namespace", () => {
    expect(
      resolveRegisteredModelCatalogEntry({
        provider: "openai",
        model: "gpt-5.4",
      }),
    ).toMatchObject({
      displayName: "gpt-5.4",
      priority: 2,
      defaultReasoningLevel: "xhigh",
    });

    expect(
      resolveModelCatalogMetadata({
        provider: "openai",
        model: "gpt-5.4-2026-02-01",
      }),
    ).toMatchObject({
      contextWindow: 272_000,
    });

    expect(
      resolveModelCatalogMetadata({
        provider: "openai",
        model: "preview/gpt-5.2",
      }),
    ).toMatchObject({
      contextWindow: 272_000,
    });

    expect(
      resolveModelCatalogMetadata({
        provider: "openai",
        model: "preview/gpt-5.4-2026-02-01",
      }),
    ).toMatchObject({
      contextWindow: 272_000,
    });
  });

  it("preserves the complete bundled donor model catalog shape", () => {
    const entries = listRegisteredModelCatalogEntries("openai");

    expect(entries.map((entry) => entry.model)).toEqual(DONOR_MODEL_IDS);
    for (const entry of entries) {
      expect(entry.supportedReasoningLevels).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(entry.supportsVerbosity).toBe(true);
      expect(entry.supportsParallelToolCalls).toBe(true);
      expect(entry.supportsReasoningSummaries).toBe(true);
    }
    expect(entries.find((entry) => entry.model === "gpt-5.4")).toMatchObject({
      maxContextWindow: 1_000_000,
      defaultReasoningLevel: "xhigh",
      additionalSpeedTiers: ["fast"],
    });
    expect(
      entries.find((entry) => entry.model === "codex-auto-review"), // branding-scan: allow OpenAI model identifier
    ).toMatchObject({
      displayName: "AgenC Auto Review",
      visibility: "hide",
      priority: 29,
    });
    const personalityModel = entries.find(
      (entry) => entry.model === "gpt-5.3-codex", // branding-scan: allow OpenAI model identifier
    );
    expect(personalityModel?.modelMessages?.instructionsVariables).toMatchObject({
      personalityFriendly:
        "You optimize for team morale and being a supportive teammate as much as code quality.",
      personalityPragmatic:
        "You are a deeply pragmatic, effective software engineer.",
    });
    expect(
      getModelInstructions({
        modelInfo: personalityModel ?? {},
        baseInstructions: "base",
        personality: "pragmatic",
      }),
    ).toBe("You are a deeply pragmatic, effective software engineer.\n\nbase");
  });

  it("feeds catalog parallel-tool metadata into prompt shaping", async () => {
    const manager = new StaticModelsManager({
      config: defaultConfig(),
      fallbackProvider: "openai",
    });
    const modelInfo = await manager.getModelInfo("gpt-5.4");

    const prompt = buildPrompt(
      [{ role: "user", content: "hello" }],
      [],
      {
        modelInfo,
        dynamicTools: [],
      } as unknown as TurnContext,
      "Follow the local contract.",
    );

    expect(prompt.parallelToolCalls).toBe(true);
    expect(modelInfo.supportsPersonality).toBe(true);
  });

  it("exposes model capability hints from the bundled catalog", () => {
    expect(
      resolveModelCapabilityHints({
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).toMatchObject({
      supportsToolUse: true,
      supportsImageInput: true,
      supportsStructuredOutput: true,
      supportsStructuredOutputWithTools: true,
      supportsProviderNativeWebSearch: true,
      acceptsReasoningEffort: true,
    });
  });

  it("normalizes staged feature defaults and legacy keys", () => {
    const features = AgenCFeatureSet.fromConfig({
      include_apply_patch_tool: true,
      enable_fanout: true,
      code_mode_only: true,
      multi_agent_v2: true,
      apps_mcp_path_override: { path: "/tmp/agenc-apps.mjs" },
      js_repl: true,
      unknown_feature: true,
    });

    expect(featureForKey("web_search")).toBe("web_search_request");
    expect(featureForKey("memory_tool")).toBe("memories");
    expect(featureForKey("telepathy")).toBe("chronicle");
    expect(featureForKey("agenc_hooks")).toBe("hooks");
    expect(features.enabled("shell_tool")).toBe(true);
    expect(features.enabled("apply_patch_freeform")).toBe(true);
    expect(features.enabled("enable_fanout")).toBe(true);
    expect(features.enabled("code_mode_only")).toBe(true);
    expect(features.enabled("code_mode")).toBe(true);
    expect(features.enabled("multi_agent_v2")).toBe(true);
    expect(features.enabled("multi_agent")).toBe(true);
    expect(features.enabled("apps_mcp_path_override")).toBe(true);
    expect(features.enabled("js_repl")).toBe(false);
    expect(experimentalFeatureSpecs().map((entry) => entry.key)).toContain(
      "goals",
    );
  });

  it("keeps multi_agent_v2 independent from the older multi_agent flag", () => {
    const features = AgenCFeatureSet.fromConfig({
      multi_agent: false,
      multi_agent_v2: true,
    });

    expect(features.enabled("multi_agent_v2")).toBe(true);
    expect(features.enabled("multi_agent")).toBe(false);
  });

  it("normalizes structured staged feature config entries", () => {
    const enabled = AgenCFeatureSet.fromConfig({
      multi_agent: false,
      multi_agent_v2: {
        enabled: true,
        max_concurrent_threads_per_session: 3,
        min_wait_timeout_ms: 10_000,
        usage_hint_enabled: true,
        usage_hint_text: "Use agents sparingly.",
        root_agent_usage_hint_text: "Root hint",
        subagent_usage_hint_text: "Child hint",
        hide_spawn_agent_metadata: false,
      },
      apps_mcp_path_override: {
        path: "/tmp/agenc-apps.mjs",
      },
    });
    expect(enabled.enabled("multi_agent_v2")).toBe(true);
    expect(enabled.enabled("multi_agent")).toBe(false);
    expect(enabled.enabled("apps_mcp_path_override")).toBe(true);

    const disabled = AgenCFeatureSet.fromConfig({
      multi_agent_v2: {
        max_concurrent_threads_per_session: 3,
      },
      apps_mcp_path_override: {
        enabled: false,
        path: "/tmp/agenc-apps.mjs",
      },
    });
    expect(disabled.enabled("multi_agent_v2")).toBe(false);
    expect(disabled.enabled("apps_mcp_path_override")).toBe(false);
  });

  it("creates runtime managed features from config feature tables", () => {
    const managed = createManagedFeatures({
      _unknown: {
        features: {
          apps: false,
          use_legacy_landlock: true,
        },
      },
    });

    expect(managed.enabled?.("apps")).toBe(false);
    expect(managed.enabled?.("use_legacy_landlock")).toBe(true);
    expect(managed.appsEnabledForAuth(true)).toBe(false);
    expect(managed.useLegacyLandlock()).toBe(true);
  });

  it("preserves donor feature keys, stages, and default states", () => {
    expect(AGENC_FEATURE_SPECS.map((entry) => entry.key)).toEqual(
      DONOR_FEATURE_KEYS,
    );
    expect(new Set(DONOR_FEATURE_KEYS).size).toBe(DONOR_FEATURE_KEYS.length);

    const specByKey = new Map(
      AGENC_FEATURE_SPECS.map((spec) => [spec.key, spec]),
    );
    expect(specByKey.get("tool_search")).toMatchObject({
      stage: "stable",
      defaultEnabled: true,
    });
    expect(specByKey.get("plugins")).toMatchObject({
      stage: "stable",
      defaultEnabled: true,
    });
    expect(specByKey.get("computer_use")).toMatchObject({
      stage: "stable",
      defaultEnabled: true,
    });
    expect(specByKey.get("enable_request_compression")).toMatchObject({
      stage: "stable",
      defaultEnabled: true,
    });
    expect(specByKey.get("artifact")).toMatchObject({
      stage: "under_development",
      defaultEnabled: false,
    });
    expect(specByKey.get("use_legacy_landlock")).toMatchObject({
      stage: "deprecated",
      defaultEnabled: false,
    });
    expect(specByKey.get("search_tool")).toMatchObject({
      stage: "removed",
      defaultEnabled: false,
    });
    expect(specByKey.get("terminal_resize_reflow")).toMatchObject({
      stage: "experimental",
      defaultEnabled: true,
    });
    expect(specByKey.get("prevent_idle_sleep")?.defaultEnabled).toBe(false);
  });
});
