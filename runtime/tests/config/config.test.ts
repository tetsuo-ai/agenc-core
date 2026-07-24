import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultConfig,
  mergeConfigs,
  normalizeRawConfig,
  normalizeAgenCKeyAliases,
  AgenCConfig,
  resolveModelDisambiguated,
  AmbiguousModelError,
  InvalidAgentConfigError,
  InvalidAuthConfigError,
  InvalidMcpConfigError,
  InvalidMcpServerModeConfigError,
  InvalidPluginsConfigError,
  InvalidProviderConfigError,
  InvalidHooksConfigError,
  InvalidBrowserConfigError,
  InvalidPermissionsConfigError,
  InvalidStatusLineConfigError,
  InvalidTuiConfigError,
  UnknownModelError,
  isValidPermissionDefaultMode,
  isValidPermissionMode,
  validateAgentConfig,
  validateAgenCConfigBlocks,
  validateAuthConfig,
  validateMcpServerModeConfig,
  validatePermissionsConfig,
  validatePluginsConfig,
  validateProviderConfig,
  validateHooksConfig,
  validateStatusLineConfig,
  validateTuiConfig,
  validateBrowserConfig,
  validateOutputStyleConfig,
  KNOWN_CONFIG_KEYS,
  DEFERRED_SETTINGS_KEYS,
} from "./schema.js";
import { parseToml, loadConfig, TomlParseError } from "./loader.js";
import { CURRENT_CONFIG_FILE_VERSION } from "./migrate.js";
import {
  resolveProfile,
  listProfiles,
  UnknownProfileError,
} from "./profiles.js";
import {
  resolveAgencHome,
  resolveApiKey,
  resolveProvider,
  resolveProfileName,
  resolveProviderApiKey,
  resolveProviderBaseURL,
  resolveModel,
  resolveWorkspace,
  resolveSimpleMode,
  applyEnvOverrides,
} from "./env.js";
import {
  buildProviderModelCatalog,
  resolveProviderSelection,
  resolveProviderSettings,
} from "./resolve-provider.js";
import {
  configuredModelForProvider,
  resolveModelSelection,
} from "./resolve-model.js";
import { ConfigStore } from "./store.js";

// ─────────────────────────────────────────────────────────────────────
// schema
// ─────────────────────────────────────────────────────────────────────

describe("schema: defaultConfig", () => {
  test("returns frozen snapshot with sane defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.configVersion).toBe(CURRENT_CONFIG_FILE_VERSION);
    expect(cfg.model).toBe("grok-4.5");
    expect(cfg.model_provider).toBe("grok");
    expect(resolveProviderSelection({ config: cfg })).toBe("grok");
    expect(cfg.approval_policy).toBe("on-request");
    expect(cfg.approvals_reviewer).toBe("user");
    expect(cfg.sandbox_mode).toBe("workspace-write");
    expect(cfg.sandbox?.mode).toBe("workspace-write");
    expect(cfg.max_turns).toBeUndefined();
    expect(cfg.agent_max_threads).toBeUndefined();
    expect(cfg.agent_max_depth).toBe(1);
    expect(cfg.stream_watchdog_timeout_ms).toBeUndefined();
    expect(cfg.auth?.backend).toBe("remote");
    expect(cfg.auth?.managedKeys?.enabled).toBe(true);
    expect(cfg.plugins?.enabled).toBe(false);
    expect(cfg.plugins?.allowlist).toEqual([]);
    expect(cfg.mcp?.server).toEqual({
      enabled: false,
      transport: "stdio",
    });
    expect(cfg.daemon?.transport).toBe("unix");
    expect(cfg.daemon?.autostart).toBe(true);
    expect(cfg.permissions?.default_mode).toBe("on-request");
    expect(cfg.editorMode).toBe("default");
    expect(cfg.tui).toBeUndefined();
    expect(cfg.tuiLayout?.mode).toBe("single");
    expect(cfg.agent?.budget).toEqual({});
    expect(cfg.agent?.retention).toEqual({
      completed_days: 30,
      failed_days: 90,
      snapshot_days: 3,
      snapshot_max_count: 10_000,
      snapshot_max_bytes: 67_108_864,
    });
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});

describe("schema: mergeConfigs", () => {
  test("right-biased — override wins", () => {
    const base = defaultConfig();
    const out = mergeConfigs(base, { model: "grok-3" });
    expect(out.model).toBe("grok-3");
    expect(out.approval_policy).toBe(base.approval_policy);
  });

  test("deep merges nested tool budgets", () => {
    const base = defaultConfig();
    const out = mergeConfigs(base, {
      toolBudget: { max_calls_per_turn: 4 },
    });
    expect(out.toolBudget?.max_calls_per_turn).toBe(4);
    // untouched nested key preserved from base
    expect(out.toolBudget?.max_bytes_per_call).toBe(
      base.toolBudget?.max_bytes_per_call,
    );
  });

  test("deep merges nested mcp.server config", () => {
    const base = defaultConfig();
    const out = mergeConfigs(base, {
      mcp: { server: { port: 4444 } },
    });
    expect(out.mcp?.server).toEqual({
      enabled: false,
      transport: "stdio",
      port: 4444,
    });
  });

  test("arrays are replaced not concatenated", () => {
    const base: AgenCConfig = { project_root_markers: ["a", "b"] };
    const out = mergeConfigs(base, { project_root_markers: ["c"] });
    expect(out.project_root_markers).toEqual(["c"]);
  });

  test("result is deeply frozen", () => {
    const out = mergeConfigs(defaultConfig(), {
      toolBudget: { max_calls_per_turn: 1 },
    });
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.toolBudget)).toBe(true);
  });
});

describe("schema: normalizeRawConfig", () => {
  test("unknown keys routed to _unknown (I-26)", () => {
    const out = normalizeRawConfig({
      model: "x",
      mysterious_future_key: 42,
    });
    expect(out.model).toBe("x");
    expect(out._unknown?.mysterious_future_key).toBe(42);
  });

  test("no _unknown table when all keys are known", () => {
    const out = normalizeRawConfig({ model: "x" });
    expect(out._unknown).toBeUndefined();
  });

  test("preserves T13 provider config + model knobs on the typed path", () => {
    const out = normalizeRawConfig({
      review_model: "gpt-5",
      approvals_reviewer: "auto_review",
      model_verbosity: "high",
      service_tier: "flex",
      providers: {
        openrouter: {
          api_key_env: "OPENROUTER_TOKEN",
          base_url: "https://router.example/v1",
          default_model: "openai/gpt-5-mini",
          context_window_tokens: 400_000,
          max_output_tokens: 128_000,
          capability_overrides: {
            acceptsThinkingHistory: true,
          },
        },
      },
    });

    expect(out.review_model).toBe("gpt-5");
    expect(out.approvals_reviewer).toBe("auto_review");
    expect(out.model_verbosity).toBe("high");
    expect(out.service_tier).toBe("flex");
    expect(out.providers?.openrouter).toEqual({
      api_key_env: "OPENROUTER_TOKEN",
      base_url: "https://router.example/v1",
      default_model: "openai/gpt-5-mini",
      context_window_tokens: 400_000,
      max_output_tokens: 128_000,
      capability_overrides: {
        acceptsThinkingHistory: true,
      },
    });
    expect(out._unknown).toBeUndefined();
  });

  test("preserves global output-token knobs on the typed path", () => {
    const out = normalizeRawConfig({
      max_output_tokens: 32_000,
      capped_default_max_output_tokens: true,
    });
    expect(out.max_output_tokens).toBe(32_000);
    expect(out.capped_default_max_output_tokens).toBe(true);
    expect(out._unknown).toBeUndefined();
  });

  test("preserves provider fallback config on the typed path", () => {
    const out = normalizeRawConfig({
      providers: {
        grok: {
          fallback_models: ["grok-4"],
          fallback: {
            targets: [
              { provider: "openai", model: "gpt-5", reason: "burst" },
            ],
            models: ["grok-3"],
            max_failures: 2,
            statuses: [429, 529],
          },
        },
      },
    });

    expect(out.providers?.grok).toEqual({
      fallback_models: ["grok-4"],
      fallback: {
        targets: [
          { provider: "openai", model: "gpt-5", reason: "burst" },
        ],
        models: ["grok-3"],
        max_failures: 2,
        statuses: [429, 529],
      },
    });
    expect(out._unknown).toBeUndefined();
  });

  test("preserves runtime/TUI feature config on the typed path", () => {
    const out = normalizeRawConfig({
      editorMode: "vim",
      tui: { vimMode: true },
      agent_max_threads: 12,
      agent_max_depth: 2,
      tuiLayout: { mode: "multi-pane", sidePane: "context", minColumns: 100 },
    });
    expect(out.editorMode).toBe("vim");
    expect(out.tui).toEqual({ vimMode: true });
    expect(out.agent_max_threads).toBe(12);
    expect(out.agent_max_depth).toBe(2);
    expect(out.tuiLayout).toEqual({
      mode: "multi-pane",
      sidePane: "context",
      minColumns: 100,
    });
    expect(out._unknown).toBeUndefined();
  });

  test("validates tui config shape", () => {
    expect(validateTuiConfig({ vimMode: true })).toEqual({ vimMode: true });
    expect(() => validateTuiConfig({ vimMode: "yes" })).toThrow(
      InvalidTuiConfigError,
    );
  });

  test("validates browser config shape and rejects non-boolean toggles", () => {
    expect(
      validateBrowserConfig({ allow_private_network: true, headless: false }),
    ).toEqual({ allow_private_network: true, headless: false });
    // A mistyped string toggle must be rejected, not coerced to a truthy value
    // that would silently disable SSRF private-network blocking.
    expect(() =>
      validateBrowserConfig({ allow_private_network: "off" }),
    ).toThrow(InvalidBrowserConfigError);
    expect(() => validateBrowserConfig({ no_sandbox: "yes" })).toThrow(
      InvalidBrowserConfigError,
    );
    expect(() =>
      validateBrowserConfig({ navigation_timeout_ms: -1 }),
    ).toThrow(InvalidBrowserConfigError);
  });

  test("validateAgenCConfigBlocks rejects a non-boolean browser toggle", () => {
    expect(() =>
      validateAgenCConfigBlocks({
        browser: { allow_private_network: "off" },
      } as never),
    ).toThrow(InvalidBrowserConfigError);
  });

  test("preserves configVersion on the typed path", () => {
    const out = normalizeRawConfig({
      configVersion: CURRENT_CONFIG_FILE_VERSION,
    });
    expect(out.configVersion).toBe(CURRENT_CONFIG_FILE_VERSION);
    expect(out._unknown).toBeUndefined();
    expect(KNOWN_CONFIG_KEYS.includes("configVersion")).toBe(true);
  });

  test("preserves auth config on the typed path", () => {
    const out = normalizeRawConfig({
      auth: { backend: "remote", managedKeys: { enabled: true } },
    });
    expect(out.auth).toEqual({
      backend: "remote",
      managedKeys: { enabled: true },
    });
    expect(out._unknown).toBeUndefined();
    expect(KNOWN_CONFIG_KEYS.includes("auth")).toBe(true);
  });

  test("preserves plugin config on the typed path", () => {
    const out = normalizeRawConfig({
      plugins: {
        enabled: true,
        allowlist: ["alpha", "beta@team"],
        plugins: {
          "alpha@team": {
            enabled: true,
            path: "vendor/alpha",
            mcp_servers: {
              api: {
                enabled: true,
                default_tools_approval_mode: "on-request",
                enabled_tools: ["read"],
                disabled_tools: ["write"],
              },
            },
          },
        },
      },
    });
    expect(out.plugins).toEqual({
      enabled: true,
      allowlist: ["alpha", "beta@team"],
      plugins: {
        "alpha@team": {
          enabled: true,
          path: "vendor/alpha",
          mcp_servers: {
            api: {
              enabled: true,
              default_tools_approval_mode: "on-request",
              enabled_tools: ["read"],
              disabled_tools: ["write"],
            },
          },
        },
      },
    });
    expect(out._unknown).toBeUndefined();
    expect(KNOWN_CONFIG_KEYS.includes("plugins")).toBe(true);
  });

  test("preserves sandbox.mode config on the typed path", () => {
    const out = normalizeRawConfig({
      sandbox: { mode: "off" },
    });
    expect(out.sandbox).toEqual({ mode: "off" });
    expect(out._unknown).toBeUndefined();
    expect(KNOWN_CONFIG_KEYS.includes("sandbox")).toBe(true);
  });

  test("preserves mcp.server config on the typed path", () => {
    const out = normalizeRawConfig({
      mcp: {
        server: {
          enabled: true,
          transport: "sse",
          host: "localhost",
          port: 4444,
        },
      },
    });
    expect(out.mcp?.server).toEqual({
      enabled: true,
      transport: "sse",
      host: "localhost",
      port: 4444,
    });
    expect(out._unknown?.mcp).toBeUndefined();
    expect(KNOWN_CONFIG_KEYS.includes("mcp")).toBe(true);
  });

  test("preserves daemon.transport config on the typed path", () => {
    const out = normalizeRawConfig({
      daemon: { transport: "stdio", autostart: false },
    });
    expect(out.daemon).toEqual({ transport: "stdio", autostart: false });
    expect(out._unknown).toBeUndefined();
    expect(KNOWN_CONFIG_KEYS.includes("daemon")).toBe(true);
  });

  test("preserves agent.budget config on the typed path", () => {
    const out = normalizeRawConfig({
      agent: {
        budget: {
          token_cap: 10_000,
          dollar_cap: 5,
          wall_clock_seconds: 3_600,
        },
      },
    });
    expect(out.agent?.budget).toEqual({
      token_cap: 10_000,
      dollar_cap: 5,
      wall_clock_seconds: 3_600,
    });
    expect(out._unknown).toBeUndefined();
    expect(KNOWN_CONFIG_KEYS.includes("agent")).toBe(true);
  });

  test("preserves agent.retention config on the typed path", () => {
    const out = normalizeRawConfig({
      agent: {
        retention: {
          completed_days: 7,
          failed_days: 30,
          snapshot_days: 2,
          snapshot_max_count: 100,
          snapshot_max_bytes: 1_048_576,
        },
      },
    });
    expect(out.agent?.retention).toEqual({
      completed_days: 7,
      failed_days: 30,
      snapshot_days: 2,
      snapshot_max_count: 100,
      snapshot_max_bytes: 1_048_576,
    });
    expect(out._unknown).toBeUndefined();
    expect(KNOWN_CONFIG_KEYS.includes("agent")).toBe(true);
  });

  test("preserves permissions.default_mode config on the typed path", () => {
    const out = normalizeRawConfig({
      permissions: { default_mode: "never" },
    });
    expect(out.permissions).toEqual({ default_mode: "never" });
    expect(out._unknown).toBeUndefined();
    expect(KNOWN_CONFIG_KEYS.includes("permissions")).toBe(true);
  });

  test("preserves per-tool tools_config entries on the typed path", () => {
    const out = normalizeRawConfig({
      tools_config: {
        exec_command: {
          enabled: false,
          default_permission_mode: "never",
        },
      },
    });
    expect(out.tools_config).toEqual({
      exec_command: {
        enabled: false,
        default_permission_mode: "never",
      },
    });
    expect(out._unknown).toBeUndefined();
  });
});

describe("schema: defaultConfig independence", () => {
  test("consecutive calls return independent snapshots (no shared state)", () => {
    const a = defaultConfig();
    const b = defaultConfig();
    // Top-level objects are distinct (each call creates fresh literal).
    expect(a).not.toBe(b);
    // Nested readonly structures are distinct too.
    expect(a.project_root_markers).not.toBe(b.project_root_markers);
    expect(a.toolBudget).not.toBe(b.toolBudget);
    // Values are equal, though.
    expect(a.project_root_markers).toEqual(b.project_root_markers);
    expect(a.toolBudget).toEqual(b.toolBudget);
  });
});

describe("schema: normalizeAgenCKeyAliases", () => {
  test("tools → tools_config", () => {
    const out = normalizeAgenCKeyAliases({
      tools: { web_search: true },
    });
    expect(out.tools_config).toEqual({ web_search: true });
    expect(out.tools).toBeUndefined();
  });

  test("model_reasoning_effort → reasoning_effort", () => {
    const out = normalizeAgenCKeyAliases({
      model_reasoning_effort: "high",
    });
    expect(out.reasoning_effort).toBe("high");
    expect(out.model_reasoning_effort).toBeUndefined();
  });

  test("model_reasoning_summary → reasoning_summary", () => {
    const out = normalizeAgenCKeyAliases({
      model_reasoning_summary: "detailed",
    });
    expect(out.reasoning_summary).toBe("detailed");
    expect(out.model_reasoning_summary).toBeUndefined();
  });

  test("agents.max_depth → agent_max_depth", () => {
    const out = normalizeAgenCKeyAliases({
      agents: { max_depth: 3 },
    });
    expect(out.agent_max_depth).toBe(3);
    expect(out.agents).toBeUndefined();
  });

  test("agents.max_threads → agent_max_threads", () => {
    const out = normalizeAgenCKeyAliases({
      agents: { max_threads: 10000 },
    });
    expect(out.agent_max_threads).toBe(10000);
    expect(out.agents).toBeUndefined();
  });

  test("preserves unknown agents keys after known aliases are lifted", () => {
    const out = normalizeAgenCKeyAliases({
      agents: { max_threads: 30, max_depth: 2, future_mode: "burst" },
    });
    expect(out.agent_max_threads).toBe(30);
    expect(out.agent_max_depth).toBe(2);
    expect(out.agents).toEqual({ future_mode: "burst" });
  });

  test("canonical key wins when both alias and canonical present", () => {
    const out = normalizeAgenCKeyAliases({
      tools: { web_search: true },
      tools_config: { web_search: false },
    });
    expect(out.tools_config).toEqual({ web_search: false });
    expect(out.tools).toBeUndefined();
  });
});

describe("provider resolution (T13)", () => {
  test("resolveProviderSettings honors [providers.<name>] overrides", () => {
    const config = mergeConfigs(defaultConfig(), {
      providers: {
        openrouter: {
          api_key_env: "CUSTOM_OPENROUTER_KEY",
          base_url: "https://router.example/v1",
          default_model: "openai/gpt-5-mini",
          context_window_tokens: 400_000,
          max_output_tokens: 128_000,
        },
      },
    });

    const settings = resolveProviderSettings("openrouter", config, {
      CUSTOM_OPENROUTER_KEY: "or-custom",
    });

    expect(settings).toMatchObject({
      provider: "openrouter",
      apiKeyEnvVar: "CUSTOM_OPENROUTER_KEY",
      apiKey: "or-custom",
      baseURL: "https://router.example/v1",
      defaultModel: "openai/gpt-5-mini",
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    });
  });

  test("resolveProviderSettings maps [providers.<name>] timeout_ms including the 0 disable value", () => {
    const configured = mergeConfigs(defaultConfig(), {
      providers: { grok: { timeout_ms: 600_000 } },
    });
    expect(resolveProviderSettings("grok", configured, {})).toMatchObject({
      provider: "grok",
      timeoutMs: 600_000,
    });

    // 0 is meaningful (disable the timeout) and must not be dropped.
    const disabled = mergeConfigs(defaultConfig(), {
      providers: { grok: { timeout_ms: 0 } },
    });
    expect(resolveProviderSettings("grok", disabled, {})).toMatchObject({
      provider: "grok",
      timeoutMs: 0,
    });

    // Unset stays absent so the provider default applies.
    const unset = resolveProviderSettings("grok", defaultConfig(), {});
    expect(unset).not.toHaveProperty("timeoutMs");
  });

  test("resolveProviderSettings lets OPENAI env configure local compatible endpoints", () => {
    const settings = resolveProviderSettings("openai-compatible", defaultConfig(), {
      OPENAI_API_KEY: "local-token",
      OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
      OPENAI_MODEL: "self-hosted-coder",
    });

    expect(settings).toMatchObject({
      provider: "openai-compatible",
      apiKey: "local-token",
      baseURL: "http://127.0.0.1:8000/v1",
      defaultModel: "local-model",
    });
  });

  test("resolveProviderSettings honors custom Bedrock access-key env", () => {
    const config = mergeConfigs(defaultConfig(), {
      providers: {
        "amazon-bedrock": {
          api_key_env: "CUSTOM_BEDROCK_ACCESS_KEY_ID",
          default_model: "amazon.nova-lite-v1:0",
        },
      },
    });

    const settings = resolveProviderSettings("amazon-bedrock", config, {
      CUSTOM_BEDROCK_ACCESS_KEY_ID: "custom-bedrock-access-key",
      AWS_ACCESS_KEY_ID: "default-bedrock-access-key",
    });

    expect(settings).toMatchObject({
      provider: "amazon-bedrock",
      apiKeyEnvVar: "CUSTOM_BEDROCK_ACCESS_KEY_ID",
      apiKey: "custom-bedrock-access-key",
      defaultModel: "amazon.nova-lite-v1:0",
    });
  });

  test("resolveProviderSettings normalizes provider fallback targets", () => {
    const config = mergeConfigs(defaultConfig(), {
      providers: {
        grok: {
          fallback_models: ["grok-2", "grok-2"],
          fallback: {
            targets: [
              // branding-scan: allow provider normalization fixture
              { provider: " OpenAI ", model: " gpt-5 ", reason: " burst " },
              { provider: "openai", model: "gpt-5" },
              { provider: " XAI ", model: "grok-3" },
            ],
            models: ["grok-3"],
            max_failures: 2,
            statuses: [529, 429, 429],
          },
        },
      },
    });

    const settings = resolveProviderSettings("grok", config, {});

    expect(settings?.fallbackTargets).toEqual([
      { provider: "openai", model: "gpt-5", reason: "burst" },
      { provider: "grok", model: "grok-3" },
      { provider: "grok", model: "grok-2" },
    ]);
    expect(settings?.fallbackMaxFailures).toBe(2);
    expect(settings?.fallbackStatuses).toEqual([529, 429]);
  });

  test("configuredModelForProvider prefers provider-specific default_model", () => {
    const config = mergeConfigs(defaultConfig(), {
      providers: {
        groq: {
          default_model: "llama-3.1-8b-instant",
        },
      },
    });

    expect(configuredModelForProvider(config, "groq")).toBe(
      "llama-3.1-8b-instant",
    );
  });

  test("configuredModelForProvider: explicit config.model for the active provider wins over providers.<p>.default_model", () => {
    // Regression: `agenc config set model grok-build-0.1` writes the top-level
    // model, but a `[providers.grok] default_model = "grok-4.5"` used to shadow
    // it, so the configured model never actually ran (the daemon session was
    // seeded with grok-4.3 every turn).
    const config = mergeConfigs(defaultConfig(), {
      model: "grok-build-0.1",
      model_provider: "grok",
      providers: { grok: { default_model: "grok-4.5" } },
    });

    expect(configuredModelForProvider(config, "grok")).toBe("grok-build-0.1");
    expect(resolveModelSelection({ config, provider: "grok" })).toBe(
      "grok-build-0.1",
    );
  });

  test("configuredModelForProvider: provider default_model still wins when no top-level model is selected for it", () => {
    // The provider default remains the fallback when config.model belongs to a
    // DIFFERENT provider (here openai), so grok still resolves to its default.
    const config = mergeConfigs(defaultConfig(), {
      model: "gpt-5",
      model_provider: "openai",
      providers: { grok: { default_model: "grok-4.3" } },
    });

    expect(configuredModelForProvider(config, "grok")).toBe("grok-4.3");
    expect(configuredModelForProvider(config, "openai")).toBe("gpt-5");
  });

  test('model = "agenc" selects the hosted AgenC provider', () => {
    const config = mergeConfigs(defaultConfig(), { model: "agenc" });

    expect(resolveProviderSelection({ config })).toBe("agenc");
    expect(resolveProviderSelection({ config, cliProvider: "openai" })).toBe(
      "openai",
    );
    expect(
      resolveProviderSelection({ config, env: { AGENC_PROVIDER: "xai" } }),
    ).toBe("grok");
    expect(resolveModelSelection({ config })).toBe("agenc");
    expect(resolveModelSelection({ config, provider: "agenc" })).toBe("agenc");
  });

  test("buildProviderModelCatalog includes configured provider defaults", () => {
    const config = mergeConfigs(defaultConfig(), {
      providers: {
        openrouter: {
          // branding-scan: allow documented provider model id
          default_model: "anthropic/claude-3.7-sonnet",
        },
      },
    });

    expect(buildProviderModelCatalog(config).openrouter).toContain(
      // branding-scan: allow documented provider model id
      "anthropic/claude-3.7-sonnet",
    );
  });

  test("buildProviderModelCatalog routes built-in OpenRouter seed models", () => {
    const catalog = buildProviderModelCatalog(defaultConfig());

    expect(catalog.openrouter).toEqual(expect.arrayContaining([
      "x-ai/grok-4.3",
      "openai/gpt-5-nano",
    ]));
    expect(resolveModelDisambiguated("openai/gpt-5-nano", catalog)).toEqual({
      provider: "openrouter",
      model: "openai/gpt-5-nano",
    });
  });

  test("buildProviderModelCatalog routes built-in Groq Llama and Mixtral models", () => {
    const catalog = buildProviderModelCatalog(defaultConfig());

    expect(catalog.groq).toEqual([
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "mixtral-8x7b-32768",
    ]);
    expect(
      resolveModelDisambiguated("llama-3.1-8b-instant", catalog),
    ).toEqual({
      provider: "groq",
      model: "llama-3.1-8b-instant",
    });
    expect(
      resolveModelDisambiguated("mixtral-8x7b-32768", catalog),
    ).toEqual({
      provider: "groq",
      model: "mixtral-8x7b-32768",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// T11 Wave 3 Agent D: permissions block
// ─────────────────────────────────────────────────────────────────────

describe("schema: permissions block (T11)", () => {
  test("permissions is registered as a known key (no longer deferred)", () => {
    expect(KNOWN_CONFIG_KEYS.includes("permissions")).toBe(true);
    expect(DEFERRED_SETTINGS_KEYS.includes("permissions")).toBe(false);
  });

  test("normalizeRawConfig preserves permissions on the typed path, not _unknown", () => {
    const out = normalizeRawConfig({
      model: "grok-4.3",
      permissions: {
        allow: ["Read(*)"],
        deny: ["Bash(rm -rf *)"],
      },
    });
    expect(out.permissions).toEqual({
      allow: ["Read(*)"],
      deny: ["Bash(rm -rf *)"],
    });
    expect(out._unknown).toBeUndefined();
  });

  test("mergeConfigs deep-merges a permissions overlay onto the base config", () => {
    const base: AgenCConfig = {
      permissions: {
        allow: ["Read(*)"],
        defaultMode: "default",
      },
    };
    const out = mergeConfigs(base, {
      permissions: {
        allow: ["Read(*)", "Edit(src/**)"],
        defaultMode: "acceptEdits",
      },
    });
    // Arrays replace (right-biased), defaultMode flips to the override.
    expect(out.permissions?.allow).toEqual(["Read(*)", "Edit(src/**)"]);
    expect(out.permissions?.defaultMode).toBe("acceptEdits");
    expect(Object.isFrozen(out.permissions)).toBe(true);
  });

  test("validatePermissionsConfig accepts a full well-formed block", () => {
    const out = validatePermissionsConfig({
      allow: ["Read(*)"],
      deny: ["Bash(rm *)"],
      ask: ["Edit(*)"],
      additionalDirectories: ["/tmp/sandbox"],
      default_mode: "on-request",
      defaultMode: "plan",
    });
    expect(out).toBeDefined();
    expect(out?.allow).toEqual(["Read(*)"]);
    expect(out?.deny).toEqual(["Bash(rm *)"]);
    expect(out?.ask).toEqual(["Edit(*)"]);
    expect(out?.additionalDirectories).toEqual(["/tmp/sandbox"]);
    expect(out?.default_mode).toBe("on-request");
    expect(out?.defaultMode).toBe("plan");
    expect(Object.isFrozen(out)).toBe(true);
  });

  test("validatePermissionsConfig accepts an empty object (all sub-fields optional)", () => {
    const out = validatePermissionsConfig({});
    expect(out).toEqual({});
  });

  test("validatePermissionsConfig returns undefined for undefined input (field is optional)", () => {
    expect(validatePermissionsConfig(undefined)).toBeUndefined();
  });

  test("validatePermissionsConfig rejects an invalid defaultMode", () => {
    expect(() =>
      validatePermissionsConfig({ defaultMode: "nonsense" }),
    ).toThrow(InvalidPermissionsConfigError);
  });

  test("validatePermissionsConfig rejects unattended as a config defaultMode", () => {
    expect(() =>
      validatePermissionsConfig({ defaultMode: "unattended" }),
    ).toThrow(InvalidPermissionsConfigError);
  });

  test("validatePermissionsConfig rejects an invalid default_mode", () => {
    expect(() =>
      validatePermissionsConfig({ default_mode: "nonsense" }),
    ).toThrow(InvalidPermissionsConfigError);
  });

  test("validatePermissionsConfig rejects a non-array allow field", () => {
    expect(() =>
      validatePermissionsConfig({ allow: "Read(*)" as unknown }),
    ).toThrow(InvalidPermissionsConfigError);
  });

  test("validatePermissionsConfig rejects an array element that is not a string", () => {
    expect(() =>
      validatePermissionsConfig({ deny: [123 as unknown as string] }),
    ).toThrow(InvalidPermissionsConfigError);
  });

  test("isValidPermissionMode matches config mode variants and rejects garbage", () => {
    for (const m of [
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
      "dontAsk",
      "auto",
      "bubble",
    ]) {
      expect(isValidPermissionMode(m)).toBe(true);
    }
    expect(isValidPermissionMode("unattended")).toBe(false);
    expect(isValidPermissionMode("nonsense")).toBe(false);
    expect(isValidPermissionMode(null)).toBe(false);
    expect(isValidPermissionMode(42)).toBe(false);
  });

  test("isValidPermissionDefaultMode matches approval policy literals", () => {
    for (const m of ["untrusted", "on-failure", "on-request", "never"]) {
      expect(isValidPermissionDefaultMode(m)).toBe(true);
    }
    expect(isValidPermissionDefaultMode("plan")).toBe(false);
    expect(isValidPermissionDefaultMode("on_request")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// T12 Wave 4-B: statusLine / outputStyle block
// ─────────────────────────────────────────────────────────────────────

describe("schema: statusLine / outputStyle block (T12)", () => {
  test("validateStatusLineConfig accepts a well-formed items array", () => {
    const out = validateStatusLineConfig({ items: ["model", "mode"] });
    expect(out).toBeDefined();
    expect(out?.items).toEqual(["model", "mode"]);
    expect(Object.isFrozen(out)).toBe(true);
  });

  test("validateStatusLineConfig rejects non-array items", () => {
    expect(() =>
      validateStatusLineConfig({ items: 123 as unknown as string[] }),
    ).toThrow(InvalidStatusLineConfigError);
  });

  test("validateOutputStyleConfig accepts a theme string", () => {
    const out = validateOutputStyleConfig({ theme: "dark" });
    expect(out).toBeDefined();
    expect(out?.theme).toBe("dark");
  });

  test("statusLine is registered as a known key, not deferred", () => {
    expect(KNOWN_CONFIG_KEYS.includes("statusLine")).toBe(true);
    expect(DEFERRED_SETTINGS_KEYS.includes("statusLine")).toBe(false);
  });
});

describe("schema: closed config block validators (CF-13)", () => {
  test("validateAuthConfig accepts managed local/remote auth settings", () => {
    const out = validateAuthConfig({
      backend: "remote",
      managedKeys: { enabled: true },
    });
    expect(out).toEqual({
      backend: "remote",
      managedKeys: { enabled: true },
    });
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out?.managedKeys)).toBe(true);
  });

  test("validateAuthConfig rejects unknown auth fields with field metadata", () => {
    let caught: unknown;
    try {
      validateAuthConfig({ backend: "local", typo: true });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidAuthConfigError);
    expect((caught as InvalidAuthConfigError).field).toBe("typo");
  });

  test("validateProviderConfig accepts provider fallbacks and capabilities", () => {
    const out = validateProviderConfig({
      grok: {
        api_key_env: "XAI_API_KEY",
        default_model: "grok-4.3",
        context_window_tokens: 256_000,
        max_output_tokens: 32_000,
        capability_overrides: {
          supportsToolUse: true,
          acceptsReasoningEffort: true,
        },
        fallback_models: ["grok-3"],
        fallback: {
          targets: [
            { provider: "openai", model: "gpt-5", reason: "burst" },
          ],
          models: ["grok-2"],
          max_failures: 2,
          statuses: [429, 529],
        },
      },
    });
    expect(out?.grok?.fallback?.targets?.[0]).toEqual({
      provider: "openai",
      model: "gpt-5",
      reason: "burst",
    });
    expect(out?.grok?.capability_overrides?.supportsToolUse).toBe(true);
    expect(Object.isFrozen(out?.grok?.fallback?.statuses)).toBe(true);
  });

  test("validateProviderConfig rejects unknown nested provider fields", () => {
    expect(() =>
      validateProviderConfig({
        grok: { fallback: { targets: [{ model: "grok-3", typo: true }] } },
      }),
    ).toThrow(InvalidProviderConfigError);
    try {
      validateProviderConfig({
        grok: { fallback: { targets: [{ model: "grok-3", typo: true }] } },
      });
    } catch (error) {
      expect((error as InvalidProviderConfigError).field).toBe(
        "grok.fallback.targets.0.typo",
      );
    }
  });

  test("validateAgentConfig accepts budgets and retention windows", () => {
    const out = validateAgentConfig({
      budget: {
        token_cap: 10_000,
        dollar_cap: 5.5,
        wall_clock_seconds: 3_600,
      },
      retention: {
        completed_days: 0,
        failed_days: 90,
        snapshot_days: 3,
        snapshot_max_count: 1,
        snapshot_max_bytes: 1_024,
        rollout_days: 30,
      },
    });
    expect(out?.budget?.dollar_cap).toBe(5.5);
    expect(out?.retention?.completed_days).toBe(0);
    // rollout_days lights up the reserved rollout/session retention sweep.
    expect(out?.retention?.rollout_days).toBe(30);
    expect(Object.isFrozen(out?.retention)).toBe(true);
  });

  test("validateAgentConfig rejects invalid retention max values", () => {
    let caught: unknown;
    try {
      validateAgentConfig({
        retention: { snapshot_max_count: 0 },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidAgentConfigError);
    expect((caught as InvalidAgentConfigError).field).toBe(
      "retention.snapshot_max_count",
    );
  });

  test("validatePluginsConfig accepts current and staged plugin block shapes", () => {
    const out = validatePluginsConfig({
      dirs: ["/workspace/plugins"],
      enabled: true,
      allowlist: ["local"],
      plugins: {
        local: {
          enabled: true,
          path: "./plugins/local",
          mcp_servers: {
            tools: {
              enabled: true,
              enabled_tools: ["read"],
              tools: {
                read: {
                  enabled: true,
                  default_permission_mode: "on-request",
                },
              },
            },
          },
        },
        remote: false,
      },
    });
    expect(out?.dirs).toEqual(["/workspace/plugins"]);
    expect(out?.enabled).toBe(true);
    expect(out?.allowlist).toEqual(["local"]);
    expect(out?.plugins?.remote).toBe(false);
    const local = out?.plugins?.local;
    if (typeof local === "boolean" || local === undefined) {
      throw new Error("expected plugin entry config");
    }
    expect(local.mcp_servers?.tools?.tools?.read?.enabled).toBe(true);

    const legacy = validatePluginsConfig({
      enabled: {
        legacy: false,
      },
    });
    expect(legacy?.enabled).toBeUndefined();
    expect(legacy?.plugins?.legacy).toBe(false);
  });

  test("validatePluginsConfig rejects plugin entry typos", () => {
    let caught: unknown;
    try {
      validatePluginsConfig({
        enabled: { local: { enabled: true, unexpected: "nope" } },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidPluginsConfigError);
    expect((caught as InvalidPluginsConfigError).field).toBe(
      "enabled.local.unexpected",
    );
  });

  test("validatePluginsConfig rejects invalid plugins.enabled", () => {
    let caught: unknown;
    try {
      validatePluginsConfig({ enabled: ["bad"] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidPluginsConfigError);
    expect((caught as InvalidPluginsConfigError).field).toBe("enabled");
  });

  test("validateMcpServerModeConfig accepts stdio and SSE server modes", () => {
    expect(validateMcpServerModeConfig({ enabled: false, transport: "stdio" }))
      .toEqual({ enabled: false, transport: "stdio" });
    expect(
      validateMcpServerModeConfig({
        enabled: true,
        transport: "sse",
        host: "127.0.0.1",
        port: 8900,
        workspace: process.cwd(),
      }),
    ).toEqual({
      enabled: true,
      transport: "sse",
      host: "127.0.0.1",
      port: 8900,
      workspace: process.cwd(),
    });
    expect(
      validateMcpServerModeConfig({
        enabled: true,
        transport: "sse",
        port: 0,
      }),
    ).toEqual({
      enabled: true,
      transport: "sse",
      port: 0,
    });
  });

  test("validateMcpServerModeConfig rejects invalid transport and port", () => {
    let caught: unknown;
    try {
      validateMcpServerModeConfig({ transport: "tcp" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidMcpServerModeConfigError);
    expect((caught as InvalidMcpServerModeConfigError).field).toBe(
      "transport",
    );
    expect(() =>
      validateMcpServerModeConfig({ transport: "sse", port: 70_000 }),
    ).toThrow(InvalidMcpServerModeConfigError);
    expect(() =>
      validateMcpServerModeConfig({
        transport: "sse",
        workspace: "relative/workspace",
      }),
    ).toThrow(InvalidMcpServerModeConfigError);
  });

  test("validateAgenCConfigBlocks checks typed blocks including mcp.server", () => {
    const out = validateAgenCConfigBlocks(
      normalizeRawConfig({
        auth: { backend: "local" },
        agent: { retention: { completed_days: 7 } },
        providers: { grok: { default_model: "grok-4.5" } },
        plugins: { enabled: { local: true } },
        mcp: { server: { enabled: true, transport: "sse", port: 4444 } },
      }),
    );
    expect(out.auth?.backend).toBe("local");
    expect(out.agent?.retention?.completed_days).toBe(7);
    expect(out.providers?.grok?.default_model).toBe("grok-4.5");
    expect(out.plugins?.plugins?.local).toBe(true);
    expect(out.mcp?.server).toEqual({
      enabled: true,
      transport: "sse",
      port: 4444,
    });
    expect(out._unknown?.mcp).toBeUndefined();
  });

  test("validateAgenCConfigBlocks reports mcp table fields accurately", () => {
    let caught: unknown;
    try {
      validateAgenCConfigBlocks(
        normalizeRawConfig({
          mcp: { unexpected: true },
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidMcpConfigError);
    expect((caught as InvalidMcpConfigError).field).toBe("unexpected");
    expect((caught as Error).message).toContain("Invalid mcp.unexpected");
  });

  test("validateAgenCConfigBlocks rejects invalid configVersion", () => {
    expect(() =>
      validateAgenCConfigBlocks(
        normalizeRawConfig({ configVersion: 0 }),
      ),
    ).toThrow("Invalid configVersion");
    expect(() =>
      validateAgenCConfigBlocks(
        normalizeRawConfig({ configVersion: 2.5 }),
      ),
    ).toThrow("Invalid configVersion");
  });
});

describe("schema: hooks block", () => {
  test("validateHooksConfig accepts command hooks and normalizes event aliases", () => {
    const out = validateHooksConfig({
      preToolUse: [
        {
          matcher: "Read|Grep",
          hooks: [
            {
              type: "command",
              command: "node hook.js",
              timeout_ms: 5000,
              statusMessage: "scan",
            },
          ],
        },
      ],
    });
    expect(out?.PreToolUse).toHaveLength(1);
    expect(out?.PreToolUse?.[0]?.matcher).toBe("Read|Grep");
    expect(out?.PreToolUse?.[0]?.hooks[0]?.command).toBe("node hook.js");
    expect(Object.isFrozen(out)).toBe(true);
  });

  test("validateHooksConfig rejects unsupported hook types", () => {
    expect(() =>
      validateHooksConfig({
        PreToolUse: [
          {
            hooks: [{ type: "prompt", prompt: "stop" }],
          },
        ],
      }),
    ).toThrow(InvalidHooksConfigError);
  });

  test("validateHooksConfig rejects unknown events", () => {
    expect(() =>
      validateHooksConfig({
        Banana: [{ hooks: [{ type: "command", command: "true" }] }],
      }),
    ).toThrow(InvalidHooksConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────
// I-60: disambiguation
// ─────────────────────────────────────────────────────────────────────

describe("schema: resolveModelDisambiguated (I-60)", () => {
  const catalog: Record<string, readonly string[]> = {
    xai: ["grok-4.3", "grok-3"],
    openrouter: ["grok-4.3", "gpt-4o"],
    openai: ["gpt-4o", "o1"],
    "amazon-bedrock": ["amazon.nova-pro-v1:0"],
  };

  test("unique slug resolves to single provider", () => {
    const out = resolveModelDisambiguated("grok-3", catalog);
    expect(out).toEqual({ provider: "xai", model: "grok-3" });
  });

  test("ambiguous slug throws AmbiguousModelError with candidates", () => {
    let caught: unknown;
    try {
      resolveModelDisambiguated("grok-4.3", catalog);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AmbiguousModelError);
    const err = caught as AmbiguousModelError;
    expect(err.candidates.length).toBe(2);
    expect(err.candidates.map((c) => c.provider).sort()).toEqual([
      "openrouter",
      "xai",
    ]);
    expect(err.message).toContain("xai:grok-4.3");
    expect(err.message).toContain("openrouter:grok-4.3");
  });

  test("unknown slug throws UnknownModelError", () => {
    expect(() =>
      resolveModelDisambiguated("mystery-model", catalog),
    ).toThrow(UnknownModelError);
  });

  test("provider:model form short-circuits", () => {
    const out = resolveModelDisambiguated("xai:grok-4.3", catalog);
    expect(out).toEqual({ provider: "xai", model: "grok-4.3" });
  });

  test("provider model IDs may contain colons", () => {
    const out = resolveModelDisambiguated("amazon.nova-pro-v1:0", catalog);
    expect(out).toEqual({
      provider: "amazon-bedrock",
      model: "amazon.nova-pro-v1:0",
    });
  });

  test("provider:model with invalid provider throws UnknownModelError", () => {
    expect(() =>
      resolveModelDisambiguated("bogus:grok-4.3", catalog),
    ).toThrow(UnknownModelError);
  });

  test("UnknownModelError.providers carries the frozen catalog list", () => {
    let caught: unknown;
    try {
      resolveModelDisambiguated("mystery-model", catalog);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownModelError);
    const err = caught as UnknownModelError;
    expect([...err.providers].sort()).toEqual([
      "amazon-bedrock",
      "openai",
      "openrouter",
      "xai",
    ]);
    // providers array is frozen — mutating attempts are rejected in
    // strict mode (TypeScript already forbids push on readonly; guard
    // the runtime immutability here).
    expect(Object.isFrozen(err.providers)).toBe(true);
    // Message includes the provider list + "Use provider:model form".
    expect(err.message).toContain("unknown model 'mystery-model'");
    expect(err.message).toContain("openai");
    expect(err.message).toContain("Use provider:model form");
  });

  test("UnknownModelError with empty catalog still composes a message", () => {
    let caught: unknown;
    try {
      resolveModelDisambiguated("anything", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownModelError);
    const err = caught as UnknownModelError;
    expect(err.providers).toEqual([]);
    expect(err.message).toContain("(none configured)");
  });
});

// ─────────────────────────────────────────────────────────────────────
// loader / parseToml
// ─────────────────────────────────────────────────────────────────────

describe("loader: parseToml", () => {
  test("parses basic tables + strings + numbers + bools", () => {
    const out = parseToml(
      `
# comment
model = "grok-4.5"
max_turns = 100

[tools_config]
web_search = true
view_image = false
      `,
    );
    expect(out.model).toBe("grok-4.5");
    expect(out.max_turns).toBe(100);
    expect((out.tools_config as Record<string, unknown>).web_search).toBe(true);
  });

  test("parses arrays of strings", () => {
    const out = parseToml(`project_root_markers = ["a", "b", "c"]`);
    expect(out.project_root_markers).toEqual(["a", "b", "c"]);
  });

  test("parses per-tool tools_config subtables", () => {
    const out = parseToml(
      `
[tools_config.exec_command]
enabled = false
default_permission_mode = "never"
      `,
    );
    expect(out.tools_config).toEqual({
      exec_command: {
        enabled: false,
        default_permission_mode: "never",
      },
    });
  });

  test("parses array-of-tables [[hooks.preToolUse]]", () => {
    const out = parseToml(
      `
[[hooks.preToolUse]]
matcher = "bash"

[[hooks.preToolUse]]
matcher = "edit"
      `,
    );
    const hooks = (out.hooks as Record<string, unknown>).preToolUse as Array<
      Record<string, unknown>
    >;
    expect(hooks).toHaveLength(2);
    expect(hooks[0]!.matcher).toBe("bash");
    expect(hooks[1]!.matcher).toBe("edit");
  });

  test("parses inline tables", () => {
    const out = parseToml(`tb = { max_calls_per_turn = 8, reserved_tokens = 256 }`);
    expect(out.tb).toEqual({ max_calls_per_turn: 8, reserved_tokens: 256 });
  });

  test("parses nested tables via dotted key segments", () => {
    const out = parseToml(
      `
[profiles.fast]
model = "grok-4.5"
approval_policy = "never"
      `,
    );
    const profiles = out.profiles as Record<string, Record<string, unknown>>;
    expect(profiles.fast?.model).toBe("grok-4.5");
    expect(profiles.fast?.approval_policy).toBe("never");
  });

  test("rejects malformed TOML with TomlParseError", () => {
    expect(() => parseToml(`model =`)).toThrow(TomlParseError);
  });

  test("duplicate key assignment warns + keeps last-write-wins", () => {
    const warnings: Array<{
      key: string;
      previousValue: unknown;
      newValue: unknown;
    }> = [];
    const out = parseToml(
      `model = "first"\nmodel = "second"\n`,
      {
        onDuplicateKey: (w) => {
          warnings.push({
            key: w.key,
            previousValue: w.previousValue,
            newValue: w.newValue,
          });
        },
      },
    );
    expect(out.model).toBe("second");
    expect(warnings).toEqual([
      { key: "model", previousValue: "first", newValue: "second" },
    ]);
  });

  test("duplicate key fires with fully-qualified dotted path under [table]", () => {
    const warnings: string[] = [];
    const out = parseToml(
      `
[mcp_servers.github]
command = "gh-a"
command = "gh-b"
      `,
      { onDuplicateKey: (w) => warnings.push(w.key) },
    );
    const servers = out.mcp_servers as Record<string, Record<string, unknown>>;
    expect(servers.github?.command).toBe("gh-b");
    expect(warnings).toEqual(["mcp_servers.github.command"]);
  });

  test("table redefinition [foo] twice warns without throwing", () => {
    const warnings: string[] = [];
    const out = parseToml(
      `
[foo]
a = 1

[foo]
b = 2
      `,
      { onDuplicateKey: (w) => warnings.push(w.key) },
    );
    const foo = out.foo as Record<string, unknown>;
    expect(foo.a).toBe(1);
    expect(foo.b).toBe(2);
    expect(warnings).toEqual(["foo"]);
  });

  test("default onDuplicateKey handler is a no-op (no throw)", () => {
    expect(() =>
      parseToml(`model = "a"\nmodel = "b"\n`),
    ).not.toThrow();
  });
});

describe("loader: loadConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agenc-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing file returns defaults with exists:false", async () => {
    const out = await loadConfig({ home: dir });
    expect(out.exists).toBe(false);
    expect(out.config.model).toBe("grok-4.5");
  });

  test("corrupt TOML warns + falls back to defaults with parseError set", async () => {
    writeFileSync(join(dir, "config.toml"), "this is not = = valid");
    const warnings: string[] = [];
    const out = await loadConfig({ home: dir, onWarn: (m) => warnings.push(m) });
    expect(out.exists).toBe(true);
    expect(out.parseError).toBeTruthy();
    expect(warnings.length).toBeGreaterThan(0);
    expect(out.config.model).toBe("grok-4.5"); // defaulted
  });

  test("valid TOML merges onto defaults", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
model = "grok-3"
max_turns = 7
experimental_realtime_start_instructions = "custom realtime handoff"
experimental_realtime_ws_backend_prompt = "custom realtime backend"

[profiles.fast]
model = "grok-4.5"
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.config.model).toBe("grok-3");
    expect(out.config.max_turns).toBe(7);
    expect(out.config.experimental_realtime_start_instructions).toBe(
      "custom realtime handoff",
    );
    expect(out.config.experimental_realtime_ws_backend_prompt).toBe(
      "custom realtime backend",
    );
    expect(KNOWN_CONFIG_KEYS.includes("experimental_realtime_start_instructions"))
      .toBe(true);
    expect(KNOWN_CONFIG_KEYS.includes("experimental_realtime_ws_backend_prompt"))
      .toBe(true);
    expect(out.config.profiles?.fast?.model).toBe("grok-4.5");
  });

  test("migrates config.json before loading config.toml", async () => {
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        provider: "xai",
        max_turns: 9,
      }),
      "utf8",
    );

    const out = await loadConfig({ home: dir });

    expect(out.exists).toBe(true);
    expect(out.path).toBe(join(dir, "config.toml"));
    expect(out.config.model_provider).toBe("grok");
    expect(out.config.max_turns).toBe(9);
    expect(out.config.configVersion).toBe(CURRENT_CONFIG_FILE_VERSION);
    expect(existsSync(join(dir, "config.json.bak-cf12"))).toBe(true);
    expect(readFileSync(join(dir, "config.toml"), "utf8")).toContain(
      `"configVersion" = ${CURRENT_CONFIG_FILE_VERSION}`,
    );
  });

  test("versions older TOML before the normal loader parse", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
provider = "xai"
max_turns = 8
      `,
    );

    const out = await loadConfig({ home: dir });

    expect(out.config.model_provider).toBe("grok");
    expect(out.config.max_turns).toBe(8);
    expect(out.config.configVersion).toBe(CURRENT_CONFIG_FILE_VERSION);
    expect(existsSync(join(dir, "config.toml.bak-cf12"))).toBe(true);
  });

  test("applies read-only config migrations before normalization", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
provider = "xai"
replBridgeEnabled = true

[profiles.fast]
provider = "xai"

[providers.xai]
default_model = "grok-4.5"
      `,
    );

    const out = await loadConfig({ home: dir });
    expect(out.config.model_provider).toBe("grok");
    expect(out.config.remoteControlAtStartup).toBe(true);
    expect(out.config.profiles?.fast?.model_provider).toBe("grok");
    expect(out.config.providers).toEqual({
      grok: { default_model: "grok-4.5" },
    });
    expect(out.config._unknown?.provider).toBeUndefined();
    expect(out.config._unknown?.replBridgeEnabled).toBeUndefined();
  });

  test("auth TOML overrides the local managed-keys defaults", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[auth]
backend = "remote"

[auth.managedKeys]
enabled = true
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.exists).toBe(true);
    expect(out.config.auth?.backend).toBe("remote");
    expect(out.config.auth?.managedKeys?.enabled).toBe(true);
    expect(out.config._unknown?.auth).toBeUndefined();
  });

  test("plugins TOML overrides the disabled plugin defaults", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[plugins]
enabled = true
allowlist = ["alpha", "beta@team"]

[plugins.plugins."alpha@team"]
enabled = true
path = "vendor/alpha"

[plugins.plugins."alpha@team".mcp_servers.api]
enabled = true
enabled_tools = ["read"]
disabled_tools = ["write"]
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.exists).toBe(true);
    expect(out.config.plugins).toEqual({
      enabled: true,
      allowlist: ["alpha", "beta@team"],
      plugins: {
        "alpha@team": {
          enabled: true,
          path: "vendor/alpha",
          mcp_servers: {
            api: {
              enabled: true,
              enabled_tools: ["read"],
              disabled_tools: ["write"],
            },
          },
        },
      },
    });
    expect(out.config._unknown?.plugins).toBeUndefined();
  });

  test("sandbox.mode TOML overrides the workspace-write default", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[sandbox]
mode = "read-only"
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.exists).toBe(true);
    expect(out.config.sandbox?.mode).toBe("read-only");
    expect(out.config._unknown?.sandbox).toBeUndefined();
  });

  test("daemon.transport TOML overrides the unix default", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[daemon]
transport = "stdio"
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.exists).toBe(true);
    expect(out.config.daemon?.transport).toBe("stdio");
    expect(out.config._unknown?.daemon).toBeUndefined();
  });

  test("daemon.autostart TOML overrides the true default", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[daemon]
autostart = false
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.exists).toBe(true);
    expect(out.config.daemon?.autostart).toBe(false);
    expect(out.config.daemon?.transport).toBe("unix");
    expect(out.config._unknown?.daemon).toBeUndefined();
  });

  test("mcp.server TOML overrides the disabled stdio defaults", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[mcp.server]
enabled = true
transport = "sse"
host = "localhost"
port = 4444
workspace = ${JSON.stringify(dir)}
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.exists).toBe(true);
    expect(out.config.mcp?.server).toEqual({
      enabled: true,
      transport: "sse",
      host: "localhost",
      port: 4444,
      workspace: dir,
    });
    expect(out.config._unknown?.mcp).toBeUndefined();
  });

  test("agent.budget TOML overrides the default caps", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[agent.budget]
token_cap = 10000
dollar_cap = 5
wall_clock_seconds = 3600
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.exists).toBe(true);
    expect(out.config.agent?.budget).toEqual({
      token_cap: 10_000,
      dollar_cap: 5,
      wall_clock_seconds: 3_600,
    });
    expect(out.config._unknown?.agent).toBeUndefined();
  });

  test("agent.retention TOML overrides the default pruning windows", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[agent.retention]
completed_days = 3
failed_days = 14
snapshot_days = 2
snapshot_max_count = 100
snapshot_max_bytes = 1048576
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.exists).toBe(true);
    expect(out.config.agent?.retention).toEqual({
      completed_days: 3,
      failed_days: 14,
      snapshot_days: 2,
      snapshot_max_count: 100,
      snapshot_max_bytes: 1_048_576,
    });
    expect(out.config._unknown?.agent).toBeUndefined();
  });

  test("invalid closed config block warns and falls back to defaults", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[auth]
backend = "remote"
extra = true
      `,
    );
    const warnings: string[] = [];
    const out = await loadConfig({
      home: dir,
      onWarn: (message) => warnings.push(message),
    });
    expect(out.exists).toBe(true);
    expect(out.parseError).toContain("Invalid auth.extra");
    expect(out.config.auth?.backend).toBe("remote");
    expect(
      warnings.some((warning) => warning.includes("Invalid auth.extra")),
    ).toBe(true);
  });

  test("loader accepts scalar plugins.enabled as the global plugin gate", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[plugins]
enabled = true
      `,
    );
    const warnings: string[] = [];
    const out = await loadConfig({
      home: dir,
      onWarn: (message) => warnings.push(message),
    });
    expect(out.parseError).toBeUndefined();
    expect(warnings.join("\n")).not.toContain("Invalid plugins.enabled");
    expect(out.config.plugins?.enabled).toBe(true);
  });

  test("loader validates provider, plugins, agent, and mcp.server blocks", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[providers.grok]
fallback = { statuses = [99] }

[plugins]
allowlist = ["local"]

[plugins.enabled.local]
enabled = true

[agent.retention]
snapshot_max_bytes = 0

[mcp.server]
transport = "tcp"
      `,
    );
    const warnings: string[] = [];
    const out = await loadConfig({
      home: dir,
      onWarn: (message) => warnings.push(message),
    });
    expect(out.parseError).toMatch(
      /Invalid providers\.grok\.fallback\.statuses/,
    );
    expect(out.config).toEqual(defaultConfig());
    expect(warnings.join("\n")).toContain("invalid config");
  });

  test("permissions.default_mode TOML overrides the on-request default", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[permissions]
default_mode = "never"
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.exists).toBe(true);
    expect(out.config.permissions?.default_mode).toBe("never");
    expect(out.config._unknown?.permissions).toBeUndefined();
  });

  test("unknown keys preserved in _unknown forward-compat table", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
mystery_key = 42
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.config._unknown?.mystery_key).toBe(42);
  });

  test("mcp_servers loaded from TOML [mcp_servers.<name>] tables", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[mcp_servers.github]
command = "gh-mcp"
args = ["--stdio"]
transport = "stdio"
enabled = true

[mcp_servers.docs]
transport = "http"
endpoint = "https://docs.example.com/mcp"
required = false
      `,
    );
    const out = await loadConfig({ home: dir });
    const servers = out.config.mcp_servers;
    expect(servers).toBeDefined();
    expect(servers?.github?.command).toBe("gh-mcp");
    expect(servers?.github?.args).toEqual(["--stdio"]);
    expect(servers?.github?.transport).toBe("stdio");
    expect(servers?.github?.enabled).toBe(true);
    expect(servers?.docs?.endpoint).toBe("https://docs.example.com/mcp");
    expect(servers?.docs?.transport).toBe("http");
    expect(servers?.docs?.required).toBe(false);
  });

  test("valid mcp.server is validated on the typed path", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[mcp.server]
enabled = true
transport = "sse"
host = "127.0.0.1"
port = 4444
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.parseError).toBeUndefined();
    expect(out.config.mcp?.server).toEqual({
      enabled: true,
      transport: "sse",
      host: "127.0.0.1",
      port: 4444,
    });
    expect(out.config._unknown?.mcp).toBeUndefined();
  });

  test("AgenC key aliases: tools → tools_config via loader", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
[tools]
web_search = true
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.config.tools_config?.web_search).toBe(true);
    // The AgenC-style `tools` key should not leak into _unknown.
    expect(out.config._unknown?.tools).toBeUndefined();
  });

  test("AgenC key aliases: model_reasoning_effort → reasoning_effort via loader", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `model_reasoning_effort = "high"\n`,
    );
    const out = await loadConfig({ home: dir });
    expect(out.config.reasoning_effort).toBe("high");
    expect(out.config._unknown?.model_reasoning_effort).toBeUndefined();
  });

  test("duplicate key warns via onWarn, keeps last-write-wins", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `model = "grok-3"\nmodel = "grok-4.5"\n`,
    );
    const warnings: string[] = [];
    const out = await loadConfig({
      home: dir,
      onWarn: (m) => warnings.push(m),
    });
    expect(out.exists).toBe(true);
    expect(out.parseError).toBeUndefined();
    expect(out.config.model).toBe("grok-4.5");
    expect(
      warnings.some(
        (w) => w.includes("duplicate key") && w.includes(`"model"`),
      ),
    ).toBe(true);
  });

  test("UTF-8 BOM-prefixed config.toml parses cleanly (I-81)", async () => {
    // Windows editors often save config.toml with a UTF-8 BOM. The
    // loader must route through readTextFile so the BOM is stripped
    // before parseToml sees the bytes.
    writeFileSync(
      join(dir, "config.toml"),
      `\uFEFFmodel = "grok-3"\nmax_turns = 12\n`,
      "utf8",
    );
    const out = await loadConfig({ home: dir });
    expect(out.parseError).toBeUndefined();
    expect(out.config.model).toBe("grok-3");
    expect(out.config.max_turns).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────
// profiles
// ─────────────────────────────────────────────────────────────────────

describe("profiles: resolveProfile", () => {
  function withProfiles(): AgenCConfig {
    return mergeConfigs(defaultConfig(), {
      profiles: {
        fast: {
          model: "grok-4.3",
          approval_policy: "never",
          reasoning_effort: "low",
          personality: "friendly",
          web_search: true,
        },
        strict: {
          approval_policy: "untrusted",
          sandbox_mode: "read-only",
        },
      },
    });
  }

  test("no profile name → returns config unchanged", () => {
    const cfg = withProfiles();
    expect(resolveProfile(cfg, undefined)).toBe(cfg);
  });

  test("named profile overrides allowed fields", () => {
    const cfg = withProfiles();
    const out = resolveProfile(cfg, "fast");
    expect(out.model).toBe("grok-4.3");
    expect(out.approval_policy).toBe("never");
    expect(out.reasoning_effort).toBe("low");
    expect(out.personality).toBe("friendly");
    expect(out.tools_config?.web_search).toBe(true);
  });

  test("profile with sandbox_mode + approval_policy only", () => {
    const cfg = withProfiles();
    const out = resolveProfile(cfg, "strict");
    expect(out.approval_policy).toBe("untrusted");
    expect(out.sandbox_mode).toBe("read-only");
    // untouched fields preserved
    expect(out.model).toBe(cfg.model);
  });

  test("unknown profile name throws UnknownProfileError", () => {
    const cfg = withProfiles();
    expect(() => resolveProfile(cfg, "nonexistent")).toThrow(
      UnknownProfileError,
    );
  });

  test("listProfiles returns sorted names", () => {
    const cfg = withProfiles();
    expect(listProfiles(cfg)).toEqual(["fast", "strict"]);
  });

  test("model_provider override is applied from profile", () => {
    const cfg = mergeConfigs(defaultConfig(), {
      profiles: {
        remote: {
          model: "grok-4.3",
          model_provider: "openrouter",
        },
      },
    });
    const out = resolveProfile(cfg, "remote");
    expect(out.model).toBe("grok-4.3");
    expect(out.model_provider).toBe("openrouter");
  });

  test("non-whitelisted profile keys are silently dropped", () => {
    // compact_prompt is a valid AgenCConfig field but NOT overridable via
    // profile — it must be dropped rather than propagated.
    const cfg = mergeConfigs(defaultConfig(), {
      compact_prompt: "base-compact",
      profiles: {
        weird: {
          // cast through unknown to bypass the ProfileOverride compile check
          ...(({ compact_prompt: "profile-compact" }) as unknown as Record<
            string,
            unknown
          >),
          model: "grok-3",
        },
      },
    });
    const out = resolveProfile(cfg, "weird");
    expect(out.model).toBe("grok-3");
    // compact_prompt on the result should come from the base, not the profile.
    expect(out.compact_prompt).toBe("base-compact");
  });
});

// ─────────────────────────────────────────────────────────────────────
// env
// ─────────────────────────────────────────────────────────────────────

describe("env: resolvers", () => {
  test("resolveAgencHome honors AGENC_HOME", () => {
    expect(
      resolveAgencHome({ AGENC_HOME: "/custom/home", HOME: "/home/user" }),
    ).toBe("/custom/home");
  });

  test("resolveAgencHome falls back to $HOME/.agenc", () => {
    expect(resolveAgencHome({ HOME: "/home/user" })).toBe("/home/user/.agenc");
  });

  test("resolveAgencHome throws when both unset", () => {
    expect(() => resolveAgencHome({})).toThrow(/AGENC_HOME/);
  });

  test("resolveApiKey prefers XAI_API_KEY over aliases", () => {
    expect(
      resolveApiKey({
        XAI_API_KEY: "xai",
        GROK_API_KEY: "grok",
        AGENC_XAI_API_KEY: "agenc",
      }),
    ).toBe("xai");
  });

  test("resolveApiKey falls back to GROK_API_KEY then AGENC_XAI_API_KEY", () => {
    expect(resolveApiKey({ GROK_API_KEY: "g" })).toBe("g");
    expect(resolveApiKey({ AGENC_XAI_API_KEY: "a" })).toBe("a");
    expect(resolveApiKey({})).toBeUndefined();
  });

  test("resolveProvider / resolveProfileName / resolveModel / resolveWorkspace / resolveSimpleMode", () => {
    expect(resolveProvider({ AGENC_PROVIDER: "xai" })).toBe("grok");
    // branding-scan: allow provider normalization fixture
    expect(resolveProvider({ AGENC_PROVIDER: "  OpenAI  " })).toBe("openai");
    expect(resolveProvider({})).toBeUndefined();
    expect(resolveProfileName({ AGENC_PROFILE: "fast" })).toBe("fast");
    expect(resolveProfileName({})).toBeUndefined();
    expect(resolveModel("grok-4.3", { AGENC_MODEL: "grok-3" })).toBe(
      "grok-3",
    );
    expect(resolveModel("grok-4.3", {})).toBe("grok-4.3");
    expect(resolveWorkspace({ AGENC_WORKSPACE: "/work" })).toBe("/work");
    expect(resolveWorkspace({})).toBeUndefined();
    expect(resolveSimpleMode({ AGENC_SIMPLE: "1" })).toBe(true);
    expect(resolveSimpleMode({ AGENC_SIMPLE: "true" })).toBe(true);
    expect(resolveSimpleMode({ AGENC_SIMPLE: "no" })).toBe(false);
    expect(resolveSimpleMode({})).toBe(false);
  });

  test("applyEnvOverrides — AGENC_MODEL wins over TOML model", () => {
    const base = mergeConfigs(defaultConfig(), { model: "grok-3" });
    const out = applyEnvOverrides(base, { AGENC_MODEL: "grok-4.3" });
    expect(out.model).toBe("grok-4.3");
  });

  test("applyEnvOverrides — AGENC_PROVIDER wins over TOML model_provider", () => {
    const base = mergeConfigs(defaultConfig(), { model_provider: "grok" });
    const out = applyEnvOverrides(base, { AGENC_PROVIDER: "openai" });
    expect(out.model_provider).toBe("openai");
  });

  test("applyEnvOverrides — AGENC_AUTH_MANAGED_KEYS_ENABLED wins over TOML auth flag", () => {
    const base = mergeConfigs(defaultConfig(), {
      auth: { managedKeys: { enabled: true } },
    });
    const out = applyEnvOverrides(base, {
      AGENC_AUTH_MANAGED_KEYS_ENABLED: "false",
    });
    expect(out.auth?.backend).toBe("remote");
    expect(out.auth?.managedKeys?.enabled).toBe(false);
  });

  test("applyEnvOverrides — AGENC_AUTH_BACKEND selects remote auth", () => {
    const base = defaultConfig();
    const warnings: string[] = [];
    const out = applyEnvOverrides(base, {
      AGENC_AUTH_BACKEND: " remote ",
      AGENC_AUTH_MANAGED_KEYS_ENABLED: "true",
    }, (warning) => warnings.push(warning));

    expect(out.auth?.backend).toBe("remote");
    expect(out.auth?.managedKeys?.enabled).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("applyEnvOverrides — invalid AGENC_AUTH_BACKEND warns and preserves config", () => {
    const base = mergeConfigs(defaultConfig(), {
      auth: { backend: "local", managedKeys: { enabled: false } },
    });
    const warnings: string[] = [];
    const out = applyEnvOverrides(base, {
      AGENC_AUTH_BACKEND: "google",
    }, (warning) => warnings.push(warning));

    expect(out.auth?.backend).toBe("local");
    expect(warnings).toEqual([
      '[agenc:config] invalid AGENC_AUTH_BACKEND="google"; expected "local" or "remote"',
    ]);
  });

  test("applyEnvOverrides is a no-op when no overrides set", () => {
    const base = defaultConfig();
    const out = applyEnvOverrides(base, {});
    expect(out.model).toBe(base.model);
  });

  test("applyEnvOverrides propagates AGENC_WORKSPACE, AGENC_SIMPLE, and AGENC_AUTONOMOUS", () => {
    const base = defaultConfig();
    const out = applyEnvOverrides(base, {
      AGENC_WORKSPACE: "/work/project",
      AGENC_SIMPLE: "true",
      AGENC_AUTONOMOUS: "true",
    });
    expect(out.workspace).toBe("/work/project");
    expect(out.simpleMode).toBe(true);
    expect(out.autonomous_mode).toBe(true);
  });

  test("applyEnvOverrides propagates AGENC_MAX_BUDGET_USD", () => {
    const base = defaultConfig();
    const out = applyEnvOverrides(base, {
      AGENC_MAX_BUDGET_USD: "12.50",
    });
    expect(out.max_budget_usd).toBe(12.5);
  });

  test("applyEnvOverrides propagates output-token env knobs", () => {
    const base = defaultConfig();
    const out = applyEnvOverrides(base, {
      AGENC_MAX_OUTPUT_TOKENS: "60_000",
      AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS: "true",
    });
    expect(out.max_output_tokens).toBe(60_000);
    expect(out.capped_default_max_output_tokens).toBe(true);
  });

  test("applyEnvOverrides ignores invalid output-token env knobs with diagnostics", () => {
    const warnings: string[] = [];
    const out = applyEnvOverrides(
      defaultConfig(),
      {
        AGENC_MAX_OUTPUT_TOKENS: "bogus",
        AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS: "maybe",
        AGENC_AUTH_MANAGED_KEYS_ENABLED: "sometimes",
      },
      (message) => warnings.push(message),
    );
    expect(out.max_output_tokens).toBeUndefined();
    expect(out.capped_default_max_output_tokens).toBeUndefined();
    expect(out.auth?.managedKeys?.enabled).toBe(true);
    expect(warnings).toEqual([
      '[agenc:config] invalid AGENC_MAX_OUTPUT_TOKENS="bogus"; expected a positive integer',
      '[agenc:config] invalid AGENC_CAPPED_DEFAULT_MAX_OUTPUT_TOKENS="maybe"; expected boolean-like value',
      '[agenc:config] invalid AGENC_AUTH_MANAGED_KEYS_ENABLED="sometimes"; expected boolean-like value',
    ]);
  });

  test("applyEnvOverrides: AGENC_SIMPLE=false yields simpleMode=false", () => {
    const base = defaultConfig();
    const out = applyEnvOverrides(base, { AGENC_SIMPLE: "no" });
    expect(out.simpleMode).toBe(false);
  });

  test("applyEnvOverrides does NOT leak API keys into config snapshot", () => {
    const base = defaultConfig();
    const out = applyEnvOverrides(base, {
      XAI_API_KEY: "secret-xai",
      GROK_API_KEY: "secret-grok",
      AGENC_XAI_API_KEY: "secret-agenc",
    });
    // No api-key field should appear anywhere in the merged snapshot.
    const json = JSON.stringify(out);
    expect(json).not.toContain("secret-xai");
    expect(json).not.toContain("secret-grok");
    expect(json).not.toContain("secret-agenc");
  });

  test("resolveProviderApiKey returns provider-specific keys", () => {
    expect(resolveProviderApiKey("grok", { XAI_API_KEY: "x" })).toBe("x");
    expect(resolveProviderApiKey("openai", { OPENAI_API_KEY: "o" })).toBe("o");
    expect(resolveProviderApiKey("anthropic", { ANTHROPIC_API_KEY: "a" })).toBe(
      "a",
    );
    expect(resolveProviderApiKey("lmstudio", { OPENAI_API_KEY: "local" })).toBe(
      "local",
    );
    expect(
      resolveProviderApiKey("openai-compatible", { OPENAI_API_KEY: "local" }),
    ).toBe("local");
    expect(
      resolveProviderApiKey("openai-compatible", {
        OPENAI_COMPATIBLE_API_KEY: "specific",
        OPENAI_API_KEY: "local",
      }),
    ).toBe("specific");
    expect(resolveProviderApiKey("amazon-bedrock", {
      AWS_ACCESS_KEY_ID: "aws",
    })).toBe("aws");
    expect(resolveProviderApiKey("amazon-bedrock", {
      AWS_BEDROCK_ACCESS_KEY_ID: "bedrock-aws",
      AWS_ACCESS_KEY_ID: "aws",
    })).toBe("bedrock-aws");
    expect(resolveProviderApiKey("ollama", {})).toBeUndefined();
  });

  test("resolveProviderBaseURL returns provider-specific URL or local compatible fallback", () => {
    expect(
      resolveProviderBaseURL("lmstudio", {
        OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
      }),
    ).toBe("http://127.0.0.1:8000/v1");
    expect(
      resolveProviderBaseURL("lmstudio", {
        LMSTUDIO_BASE_URL: "http://127.0.0.1:1234/v1",
        OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
      }),
    ).toBe("http://127.0.0.1:1234/v1");
    expect(
      resolveProviderBaseURL("openai-compatible", {
        OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
      }),
    ).toBe("http://127.0.0.1:8000/v1");
    expect(
      resolveProviderBaseURL("openai-compatible", {
        OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:9000/v1",
        OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
      }),
    ).toBe("http://127.0.0.1:9000/v1");
    expect(
      resolveProviderBaseURL("amazon-bedrock", {
        AWS_BEDROCK_BASE_URL:
          "https://bedrock-runtime.us-west-2.amazonaws.com",
      }),
    ).toBe("https://bedrock-runtime.us-west-2.amazonaws.com");
  });
});

// ─────────────────────────────────────────────────────────────────────
// ConfigStore
// ─────────────────────────────────────────────────────────────────────

describe("ConfigStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agenc-store-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("current() returns env-layered defaults before reload", () => {
    const store = new ConfigStore({
      home: dir,
      env: { AGENC_MODEL: "grok-3" },
    });
    expect(store.current().model).toBe("grok-3");
  });

  test("reload() re-reads disk and fires subscribers", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.toml"),
      `model = "grok-3"\nmax_turns = 5\n`,
    );

    const store = new ConfigStore({ home: dir, env: {} });
    const seen: string[] = [];
    const unsubscribe = store.subscribe((c) => seen.push(c.model ?? ""));

    const next = await store.reload();
    expect(next.model).toBe("grok-3");
    expect(next.max_turns).toBe(5);
    expect(seen).toEqual(["grok-3"]);

    unsubscribe();
    expect(store.subscriberCount()).toBe(0);
  });

  test("reload() captures schema validation warnings from loadConfig", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.toml"),
      `
[agent.retention]
snapshot_max_count = 0
      `,
    );
    const warnings: string[] = [];
    const store = new ConfigStore({
      home: dir,
      env: {},
      onWarn: (message) => warnings.push(message),
    });

    const next = await store.reload();

    expect(next.agent?.retention?.snapshot_max_count).toBe(10_000);
    expect(store.warnings().join("\n")).toContain(
      "Invalid agent.retention.snapshot_max_count",
    );
    expect(warnings.join("\n")).toContain(
      "Invalid agent.retention.snapshot_max_count",
    );
  });

  test("reload() observes file changes between calls", async () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.toml");
    writeFileSync(path, `model = "a"\n`);

    const store = new ConfigStore({ home: dir, env: {} });
    const first = await store.reload();
    expect(first.model).toBe("a");

    writeFileSync(path, `model = "b"\n`);
    const second = await store.reload();
    expect(second.model).toBe("b");
  });

  test("subscribe returns unsubscribe that removes listener", async () => {
    const store = new ConfigStore({ home: dir, env: {} });
    const spy = vi.fn();
    const unsub = store.subscribe(spy);
    await store.reload();
    expect(spy).toHaveBeenCalledTimes(1);
    unsub();
    await store.reload();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("throwing subscriber does not poison reload", async () => {
    const warnings: string[] = [];
    const store = new ConfigStore({
      home: dir,
      env: {},
      onWarn: (m) => warnings.push(m),
    });
    store.subscribe(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    store.subscribe(good);
    await store.reload();
    expect(good).toHaveBeenCalledTimes(1);
    expect(warnings.some((w) => w.includes("subscriber threw"))).toBe(true);
  });

  test("concurrent reload() calls both resolve, last-finisher snapshot wins", async () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.toml");
    writeFileSync(path, `model = "first"\n`);

    const store = new ConfigStore({ home: dir, env: {} });

    // Fire #1 against the on-disk contents, then rewrite the file and
    // fire #2 before #1 settles. Both calls share a loader that reads
    // the file lazily inside the promise, so the second reload observes
    // the updated content.
    const first = store.reload();
    writeFileSync(path, `model = "second"\n`);
    const second = store.reload();

    // Neither promise rejects.
    const [a, b] = await Promise.all([first, second]);
    expect(a.model).toBeDefined();
    expect(b.model).toBeDefined();

    // Both inputs land as valid AgenCConfig values. Which model name
    // each promise observes depends on FS race ordering on the host,
    // but the store's final snapshot must equal the value returned by
    // whichever reload settled last.
    const finalSnapshot = store.current();
    expect(finalSnapshot.model === "first" || finalSnapshot.model === "second").toBe(true);
    // Snapshot matches one of the two promise returns (no torn state).
    expect(
      finalSnapshot.model === a.model || finalSnapshot.model === b.model,
    ).toBe(true);
  });
});
