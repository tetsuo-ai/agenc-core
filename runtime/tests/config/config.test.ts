import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  defaultConfig,
  mergeConfigs,
  normalizeRawConfig,
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
  KNOWN_CONFIG_KEYS,
} from "../../src/config/schema.js";
import { parseToml, TomlParseError } from "../../src/config/loader.js";
import { CANONICAL_CONFIG_VERSION } from "../../src/config/repository.js";
import {
  resolveProfile,
  listProfiles,
  UnknownProfileError,
} from "../../src/config/profiles.js";
import {
  resolveAgencHome,
  resolveApiKey,
  resolveProfileName,
  resolveProviderBaseURL,
  resolveWorkspace,
  applyEnvOverrides,
} from "../../src/config/env.js";
import {
  buildProviderModelCatalog,
  resolveProviderSettings,
} from "../../src/config/resolve-provider.js";
import { configuredModelForProvider } from "../../src/config/resolve-model.js";
import {
  agentsChangeRevokes,
  ConfigStore,
  narrowAgentsConfig,
  nextConfigReadMark,
  revokeAgentsConfig,
  type ConfigStoreOptions,
} from "../../src/config/store.js";
import {
  getCanonicalSettingsAuthority,
  runWithCanonicalSettingsAuthority,
} from "../../src/utils/settings/canonicalAuthority.js";

// ─────────────────────────────────────────────────────────────────────
// schema
// ─────────────────────────────────────────────────────────────────────

describe("schema: defaultConfig", () => {
  test("returns frozen snapshot with sane defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.configVersion).toBe(CANONICAL_CONFIG_VERSION);
    expect(cfg.model).toBe("grok-4.6");
    expect(cfg.model_provider).toBe("grok");
    expect(cfg.approval_policy).toBe("on-request");
    expect(cfg.approvals_reviewer).toBe("user");
    expect(cfg.sandbox_mode).toBe("workspace-write");
    expect(cfg.max_turns).toBeUndefined();
    expect(cfg.agent_max_threads).toBeUndefined();
    expect(cfg.agent_max_depth).toBe(1);
    expect(cfg.stream_watchdog_timeout_ms).toBe(600_000);
    expect(cfg.auth?.backend).toBe("remote");
    expect(cfg.auth?.managedKeys?.enabled).toBe(true);
    expect(cfg.plugins?.enabled).toBe(false);
    expect(cfg.plugins?.allowlist).toEqual([]);
    expect(cfg.mcp?.server).toEqual({
      enabled: false,
      transport: "stdio",
    });
    expect(cfg.daemon?.autostart).toBe(true);
    expect(cfg.daemon?.autostart).toBe(true);
    expect(cfg.permissions?.defaultMode).toBeUndefined();
    expect(cfg.tui?.theme).toBe("dark");
    expect(cfg.agent?.budget).toEqual({});
    expect(cfg.agent?.retention).toEqual({
      completed_days: 30,
      failed_days: 90,
      snapshot_days: 3,
      snapshot_max_count: 10_000,
      snapshot_max_bytes: 67_108_864,
      rollout_days: 30,
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

  test("deep merges nested TUI preferences", () => {
    const base = defaultConfig();
    const out = mergeConfigs(base, {
      tui: { theme: "light" },
    });
    expect(out.tui?.theme).toBe("light");
    expect(out.tui?.showTurnDuration).toBe(true);
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
      tui: { theme: "light" },
    });
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.tui)).toBe(true);
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

  test("preserves T13 provider config + active model knobs on the typed path", () => {
    const out = normalizeRawConfig({
      approvals_reviewer: "auto_review",
      model_verbosity: "high",
      service_tier: "flex",
      providers: {
        openrouter: {
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

    expect(out.approvals_reviewer).toBe("auto_review");
    expect(out.model_verbosity).toBe("high");
    expect(out.service_tier).toBe("flex");
    expect(out.providers?.openrouter).toEqual({
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
          fallback: {
            targets: [
              { provider: "openai", model: "gpt-5", reason: "burst" },
            ],
            max_failures: 2,
            statuses: [429, 529],
          },
        },
      },
    });

    expect(out.providers?.grok).toEqual({
      fallback: {
        targets: [
          { provider: "openai", model: "gpt-5", reason: "burst" },
        ],
        max_failures: 2,
        statuses: [429, 529],
      },
    });
    expect(out._unknown).toBeUndefined();
  });

  test("preserves runtime/TUI feature config on the typed path", () => {
    const out = normalizeRawConfig({
      tui: { showTurnDuration: false },
      agent_max_threads: 12,
      agent_max_depth: 2,
      ideConnector: { autoInstallExtension: false },
    });
    expect(out.tui).toEqual({ showTurnDuration: false });
    expect(out.agent_max_threads).toBe(12);
    expect(out.agent_max_depth).toBe(2);
    expect(out.ideConnector).toEqual({ autoInstallExtension: false });
    expect(out._unknown).toBeUndefined();
  });

  test("validates tui config shape", () => {
    expect(validateTuiConfig({ showTurnDuration: true })).toEqual({ showTurnDuration: true });
    expect(() => validateTuiConfig({ showTurnDuration: "yes" })).toThrow(
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
      configVersion: CANONICAL_CONFIG_VERSION,
    });
    expect(out.configVersion).toBe(CANONICAL_CONFIG_VERSION);
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

  test("preserves daemon.autostart config on the typed path", () => {
    const out = normalizeRawConfig({
      daemon: { autostart: false },
    });
    expect(out.daemon).toEqual({ autostart: false });
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
          default_permission_mode: "never",
        },
        disabled_tools: ["exec_command"],
      },
    });
    expect(out.tools_config).toEqual({
      exec_command: {
        default_permission_mode: "never",
      },
      disabled_tools: ["exec_command"],
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
    expect(a.tui).not.toBe(b.tui);
    // Values are equal, though.
    expect(a.project_root_markers).toEqual(b.project_root_markers);
    expect(a.tui).toEqual(b.tui);
  });
});

describe("provider resolution (T13)", () => {
  test("resolveProviderSettings honors [providers.<name>] overrides", () => {
    const config = mergeConfigs(defaultConfig(), {
      providers: {
        openrouter: {
          base_url: "https://router.example/v1",
          default_model: "openai/gpt-5-mini",
          context_window_tokens: 400_000,
          max_output_tokens: 128_000,
        },
      },
    });

    const settings = resolveProviderSettings("openrouter", config, {
      OPENROUTER_API_KEY: "or-canonical",
    });

    expect(settings).toMatchObject({
      provider: "openrouter",
      baseURL: "https://router.example/v1",
      defaultModel: "openai/gpt-5-mini",
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
    });
    expect(settings).not.toHaveProperty("apiKey");
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
      baseURL: "http://127.0.0.1:8000/v1",
      defaultModel: "local-model",
    });
    expect(settings).not.toHaveProperty("apiKey");
  });

  test("resolveProviderSettings does not project Bedrock access IDs as API keys", () => {
    const config = mergeConfigs(defaultConfig(), {
      providers: {
        "amazon-bedrock": {
          default_model: "amazon.nova-lite-v1:0",
        },
      },
    });

    const settings = resolveProviderSettings("amazon-bedrock", config, {
      AWS_ACCESS_KEY_ID: "default-bedrock-access-key",
    });

    expect(settings).toMatchObject({
      provider: "amazon-bedrock",
      defaultModel: "amazon.nova-lite-v1:0",
    });
    expect(settings).not.toHaveProperty("apiKey");
  });

  test("resolveProviderSettings canonicalizes provider fallback targets", () => {
    const config = mergeConfigs(defaultConfig(), {
      providers: {
        grok: {
          fallback: {
            targets: [
              { provider: " OpenAI ", model: " gpt-5 ", reason: " burst " },
              { provider: "openai", model: "gpt-5" },
              { provider: " grok ", model: "grok-3" },
            ],
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

  test("buildProviderModelCatalog includes configured provider defaults", () => {
    const config = mergeConfigs(defaultConfig(), {
      providers: {
        openrouter: {
          default_model: "anthropic/claude-3.7-sonnet",
        },
      },
    });

    expect(buildProviderModelCatalog(config).openrouter).toContain(
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

  test("buildProviderModelCatalog omits retired Groq Mixtral models", () => {
    const catalog = buildProviderModelCatalog(defaultConfig());

    expect(catalog.groq).toEqual([
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
    ]);
    expect(
      resolveModelDisambiguated("llama-3.1-8b-instant", catalog),
    ).toEqual({
      provider: "groq",
      model: "llama-3.1-8b-instant",
    });
    expect(() =>
      resolveModelDisambiguated("mixtral-8x7b-32768", catalog)
    ).toThrow(/unknown model/u);
  });
});

// ─────────────────────────────────────────────────────────────────────
// T11 Wave 3 Agent D: permissions block
// ─────────────────────────────────────────────────────────────────────

describe("schema: permissions block (T11)", () => {
  test("permissions is registered as a known key (no longer deferred)", () => {
    expect(KNOWN_CONFIG_KEYS.includes("permissions")).toBe(true);
  });

  test("normalizeRawConfig preserves permissions on the typed path, not _unknown", () => {
    const out = normalizeRawConfig({
      model: "grok-4.3",
      permissions: {
        allow: ["FileRead(*)"],
        deny: ["system.bash(rm -rf *)"],
      },
    });
    expect(out.permissions).toEqual({
      allow: ["FileRead(*)"],
      deny: ["system.bash(rm -rf *)"],
    });
    expect(out._unknown).toBeUndefined();
  });

  test("mergeConfigs deep-merges a permissions overlay onto the base config", () => {
    const base: AgenCConfig = {
      permissions: {
        allow: ["FileRead(*)"],
        defaultMode: "default",
      },
    };
    const out = mergeConfigs(base, {
      permissions: {
        allow: ["FileRead(*)", "Edit(src/**)"],
        defaultMode: "acceptEdits",
      },
    });
    // Arrays replace (right-biased), defaultMode flips to the override.
    expect(out.permissions?.allow).toEqual(["FileRead(*)", "Edit(src/**)"]);
    expect(out.permissions?.defaultMode).toBe("acceptEdits");
    expect(Object.isFrozen(out.permissions)).toBe(true);
  });

  test("validatePermissionsConfig accepts a full well-formed block", () => {
    const out = validatePermissionsConfig({
      allow: ["FileRead(*)"],
      deny: ["system.bash(rm *)"],
      ask: ["Edit(*)"],
      additionalDirectories: ["/tmp/sandbox"],
      defaultMode: "plan",
    });
    expect(out).toBeDefined();
    expect(out?.allow).toEqual(["FileRead(*)"]);
    expect(out?.deny).toEqual(["system.bash(rm *)"]);
    expect(out?.ask).toEqual(["Edit(*)"]);
    expect(out?.additionalDirectories).toEqual(["/tmp/sandbox"]);
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

  test("validatePermissionsConfig rejects a non-array allow field", () => {
    expect(() =>
      validatePermissionsConfig({ allow: "FileRead(*)" as unknown }),
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
    ]) {
      expect(isValidPermissionMode(m)).toBe(true);
    }
    expect(isValidPermissionMode("unattended")).toBe(false);
    expect(isValidPermissionMode("bubble")).toBe(false);
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
  test("validateStatusLineConfig accepts one explicit command", () => {
    const out = validateStatusLineConfig({
      type: "command",
      command: "agenc-status",
      padding: 1,
    });
    expect(out).toEqual({
      type: "command",
      command: "agenc-status",
      padding: 1,
    });
    expect(Object.isFrozen(out)).toBe(true);
  });

  test("validateStatusLineConfig rejects removed item arrays", () => {
    expect(() =>
      validateStatusLineConfig({ items: ["model", "mode"] }),
    ).toThrow(InvalidStatusLineConfigError);
  });

  test("validates outputStyle as a response-style name", () => {
    expect(validateAgenCConfigBlocks({ outputStyle: "concise" }).outputStyle).toBe(
      "concise",
    );
    expect(() =>
      validateAgenCConfigBlocks({ outputStyle: { theme: "dark" } as never }),
    ).toThrow("Invalid outputStyle: expected string");
  });

  test("statusLine is registered as a known key, not deferred", () => {
    expect(KNOWN_CONFIG_KEYS.includes("statusLine")).toBe(true);
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
        default_model: "grok-4.3",
        context_window_tokens: 256_000,
        max_output_tokens: 32_000,
        capability_overrides: {
          supportsToolUse: true,
          acceptsReasoningEffort: true,
        },
        fallback: {
          targets: [
            { provider: "openai", model: "gpt-5", reason: "burst" },
          ],
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

  test("validateProviderConfig accepts zero_data_retention only where the API takes it per request", () => {
    expect(validateProviderConfig({ openrouter: { zero_data_retention: true } })).toEqual({
      openrouter: { zero_data_retention: true },
    });
    expect(validateProviderConfig({ openrouter: { zero_data_retention: false } })).toEqual({
      openrouter: { zero_data_retention: false },
    });
    expect(() =>
      validateProviderConfig({ openrouter: { zero_data_retention: "yes" } }),
    ).toThrow(InvalidProviderConfigError);
    // Every other provider controls retention on its own console; the field
    // must not pretend otherwise.
    for (const provider of ["openai", "anthropic", "grok", "deepseek", "groq"]) {
      expect(() =>
        validateProviderConfig({ [provider]: { zero_data_retention: true } }),
      ).toThrow(/supported only under providers\.openrouter/u);
    }
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

  test("validatePluginsConfig accepts the canonical plugin block", () => {
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
                  default_permission_mode: "on-request",
                },
              },
            },
          },
        },
        remote: { enabled: false },
      },
    });
    expect(out?.dirs).toEqual(["/workspace/plugins"]);
    expect(out?.enabled).toBe(true);
    expect(out?.allowlist).toEqual(["local"]);
    expect(out?.plugins?.remote).toEqual({ enabled: false });
    const local = out?.plugins?.local;
    if (local === undefined) {
      throw new Error("expected plugin entry config");
    }
    expect(local.mcp_servers?.tools?.tools?.read?.default_permission_mode).toBe(
      "on-request",
    );

  });

  test("validatePluginsConfig rejects plugin entry typos", () => {
    let caught: unknown;
    try {
      validatePluginsConfig({
        plugins: { local: { enabled: true, unexpected: "nope" } },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidPluginsConfigError);
    expect((caught as InvalidPluginsConfigError).field).toBe(
      "plugins.local.unexpected",
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
        plugins: { plugins: { local: { enabled: true } } },
        mcp: { server: { enabled: true, transport: "sse", port: 4444 } },
      }),
    );
    expect(out.auth?.backend).toBe("local");
    expect(out.agent?.retention?.completed_days).toBe(7);
    expect(out.providers?.grok?.default_model).toBe("grok-4.5");
    expect(out.plugins?.plugins?.local).toEqual({ enabled: true });
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

  test.each(["defaultPermissionMode", "approval_mode"])(
    "validateAgenCConfigBlocks rejects removed nested alias %s",
    (alias) => {
      expect(() =>
        validateAgenCConfigBlocks(
          normalizeRawConfig({
            tools_config: {
              Edit: { [alias]: alias === "approval_mode" ? "approve" : "never" },
            },
          }),
        )
      ).toThrow(/removed alias; use default_permission_mode/);
    },
  );
});

describe("schema: hooks block", () => {
  test("validateHooksConfig accepts canonical command hooks", () => {
    const out = validateHooksConfig({
      PreToolUse: [
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

  test("validateHooksConfig rejects removed event-name aliases", () => {
    expect(() => validateHooksConfig({ preToolUse: [] })).toThrow(
      /unsupported event/,
    );
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
    "vendor-a": ["grok-4.3", "grok-3"],
    openrouter: ["grok-4.3", "gpt-4o"],
    openai: ["gpt-4o", "o1"],
    "amazon-bedrock": ["amazon.nova-pro-v1:0"],
  };

  test("unique slug resolves to single provider", () => {
    const out = resolveModelDisambiguated("grok-3", catalog);
    expect(out).toEqual({ provider: "vendor-a", model: "grok-3" });
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
      "vendor-a",
    ]);
    expect(err.message).toContain("vendor-a:grok-4.3");
    expect(err.message).toContain("openrouter:grok-4.3");
  });

  test("unknown slug throws UnknownModelError", () => {
    expect(() =>
      resolveModelDisambiguated("mystery-model", catalog),
    ).toThrow(UnknownModelError);
  });

  test("provider:model form short-circuits", () => {
    const out = resolveModelDisambiguated("vendor-a:grok-4.3", catalog);
    expect(out).toEqual({ provider: "vendor-a", model: "grok-4.3" });
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
      "vendor-a",
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

describe("TOML migration parser: parseToml", () => {
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

  test("duplicate key assignment reports values for strict rejection", () => {
    const warnings: Array<{
      key: string;
      previousValue: unknown;
      newValue: unknown;
    }> = [];
    parseToml(
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
    expect(warnings).toEqual([
      { key: "model", previousValue: "first", newValue: "second" },
    ]);
  });

  test("duplicate key fires with fully-qualified dotted path under [table]", () => {
    const warnings: string[] = [];
    parseToml(
      `
[mcp_servers.github]
command = "gh-a"
command = "gh-b"
      `,
      { onDuplicateKey: (w) => warnings.push(w.key) },
    );
    expect(warnings).toEqual(["mcp_servers.github.command"]);
  });

  test("table redefinition reports the table for strict rejection", () => {
    const warnings: string[] = [];
    parseToml(
      `
[foo]
a = 1

[foo]
b = 2
      `,
      { onDuplicateKey: (w) => warnings.push(w.key) },
    );
    expect(warnings).toEqual(["foo"]);
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
          tools_config: { disabled_tools: ["WebSearch"] },
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
    expect(out.tools_config?.disabled_tools).toEqual(["WebSearch"]);
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
          model: "x-ai/grok-4.3",
          model_provider: "openrouter",
        },
      },
    });
    const out = resolveProfile(cfg, "remote");
    expect(out.model).toBe("x-ai/grok-4.3");
    expect(out.model_provider).toBe("openrouter");
  });

  test("provider-only profiles select that provider's canonical default", () => {
    const cfg = mergeConfigs(defaultConfig(), {
      profiles: {
        remote: { model_provider: "openai" },
      },
    });

    expect(resolveProfile(cfg, "remote")).toMatchObject({
      model_provider: "openai",
      model: "gpt-5",
    });
  });

  test("profiles cannot bind a known model to the wrong provider", () => {
    const cfg = mergeConfigs(defaultConfig(), {
      profiles: {
        invalid: { model_provider: "grok", model: "gpt-5" },
      },
    });

    expect(() => resolveProfile(cfg, "invalid")).toThrow(
      "belongs to provider 'openai'",
    );
  });

  test("resolveProfile does not apply fields outside the profile contract", () => {
    const cfg = mergeConfigs(defaultConfig(), {
      profiles: {
        weird: {
          ...(({ retired_field: "ignored" }) as unknown as Record<
            string,
            unknown
          >),
          model: "grok-3",
        },
      },
    });
    const out = resolveProfile(cfg, "weird");
    expect(out.model).toBe("grok-3");
    expect(out).not.toHaveProperty("retired_field");
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
    const fixtureHome = mkdtempSync(join(tmpdir(), "agenc-env-home-"));
    try {
      expect(resolveAgencHome({ HOME: fixtureHome })).toBe(
        join(realpathSync(fixtureHome), ".agenc"),
      );
    } finally {
      rmSync(fixtureHome, { recursive: true, force: true });
    }
  });

  test("resolveApiKey prefers XAI_API_KEY over the documented GROK alias", () => {
    expect(
      resolveApiKey({
        XAI_API_KEY: "xai",
        GROK_API_KEY: "grok",
      }),
    ).toBe("xai");
  });

  test("resolveApiKey falls back to GROK_API_KEY only", () => {
    expect(resolveApiKey({ GROK_API_KEY: "g" })).toBe("g");
    expect(resolveApiKey({ AGENC_XAI_API_KEY: "retired" })).toBeUndefined();
    expect(resolveApiKey({})).toBeUndefined();
  });

  test("resolveProfileName / resolveWorkspace", () => {
    expect(resolveProfileName({ AGENC_PROFILE: "fast" })).toBe("fast");
    expect(resolveProfileName({})).toBeUndefined();
    expect(resolveWorkspace({ AGENC_WORKSPACE: "/work" })).toBe("/work");
    expect(resolveWorkspace({})).toBeUndefined();
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
    expect(out.model).toBe("gpt-5");
  });

  test.each([
    ["gpt-5", "openai"],
    ["claude-opus-4-7", "anthropic"],
  ])(
    "applyEnvOverrides resolves model-only %s to its provider",
    (model, provider) => {
      const out = applyEnvOverrides(defaultConfig(), { AGENC_MODEL: model });
      expect(out).toMatchObject({ model, model_provider: provider });
    },
  );

  test("applyEnvOverrides rejects an ambiguous model-only selector", () => {
    const base = mergeConfigs(defaultConfig(), {
      providers: {
        grok: { default_model: "shared-model" },
        openai: { default_model: "shared-model" },
      },
    });
    expect(() =>
      applyEnvOverrides(base, { AGENC_MODEL: "shared-model" }),
    ).toThrow(AmbiguousModelError);
  });

  test("applyEnvOverrides captures only canonical AGENC_EFFORT_LEVEL values", () => {
    const base = mergeConfigs(defaultConfig(), { reasoning_effort: "low" });
    expect(
      applyEnvOverrides(base, { AGENC_EFFORT_LEVEL: "minimal" }).reasoning_effort,
    ).toBe("minimal");
    expect(
      applyEnvOverrides(base, { AGENC_EFFORT_LEVEL: "xhigh" }).reasoning_effort,
    ).toBe("xhigh");
    expect(
      applyEnvOverrides(base, { AGENC_EFFORT_LEVEL: "none" }).reasoning_effort,
    ).toBe("none");
    expect(
      applyEnvOverrides(base, { AGENC_EFFORT_LEVEL: "max" }).reasoning_effort,
    ).toBe("max");
  });

  test.each(["auto", "unset", "warp", ""])(
    "applyEnvOverrides rejects non-canonical AGENC_EFFORT_LEVEL=%j",
    (value) => {
      expect(() => applyEnvOverrides(
        mergeConfigs(defaultConfig(), { reasoning_effort: "low" }),
        { AGENC_EFFORT_LEVEL: value },
      )).toThrow(/invalid AGENC_EFFORT_LEVEL.*minimal, low, medium, high, xhigh, max, or none/u);
    },
  );

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

  test("applyEnvOverrides keeps AGENC_WORKSPACE out of config and propagates AGENC_AUTONOMOUS", () => {
    const base = defaultConfig();
    const out = applyEnvOverrides(base, {
      AGENC_WORKSPACE: "/work/project",
      AGENC_AUTONOMOUS: "true",
    });
    expect(out).not.toHaveProperty("workspace");
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

  test("applyEnvOverrides captures loop, coordinator, and watchdog policy once", () => {
    const out = applyEnvOverrides(defaultConfig(), {
      AGENC_MAX_TURNS: "42",
      AGENC_COORDINATOR_MODE: "off",
      AGENC_STREAM_IDLE_TIMEOUT_MS: "15_000",
    });
    expect(out.max_turns).toBe(42);
    expect(out.coordinator_mode).toBe(false);
    expect(out.stream_watchdog_timeout_ms).toBe(15_000);

    const disabled = applyEnvOverrides(out, {
      AGENC_COORDINATOR_MODE: "yes",
      AGENC_STREAM_IDLE_TIMEOUT_MS: "0",
    });
    expect(disabled.coordinator_mode).toBe(true);
    expect(disabled.stream_watchdog_timeout_ms).toBe(0);
  });

  test("applyEnvOverrides folds AGENC_XAI_INCREMENTAL into providers.grok", () => {
    const base = normalizeRawConfig({
      providers: { grok: { timeout_ms: 5_000 } },
    });
    const on = applyEnvOverrides(base, { AGENC_XAI_INCREMENTAL: "1" });
    expect(on.providers?.grok).toEqual({
      timeout_ms: 5_000,
      incremental_continuation: true,
    });
    const off = applyEnvOverrides(on, { AGENC_XAI_INCREMENTAL: "off" });
    expect(off.providers?.grok?.incremental_continuation).toBe(false);

    const warnings: string[] = [];
    const invalid = applyEnvOverrides(
      base,
      { AGENC_XAI_INCREMENTAL: "sometimes" },
      (message) => warnings.push(message),
    );
    expect(invalid.providers?.grok?.incremental_continuation).toBeUndefined();
    expect(warnings).toEqual([
      '[agenc:config] invalid AGENC_XAI_INCREMENTAL="sometimes"; expected boolean-like value',
    ]);
    // The flag is off unless set.
    expect(defaultConfig().providers?.grok?.incremental_continuation).toBeUndefined();
  });

  test("providers.<provider>.incremental_continuation is a Grok-only boolean", () => {
    expect(
      normalizeRawConfig({
        providers: { grok: { incremental_continuation: true } },
      }).providers?.grok,
    ).toEqual({ incremental_continuation: true });
    expect(
      validateProviderConfig({ grok: { incremental_continuation: true } }),
    ).toEqual({ grok: { incremental_continuation: true } });
    expect(() =>
      validateProviderConfig({ grok: { incremental_continuation: "yes" } }),
    ).toThrow(InvalidProviderConfigError);
    expect(() =>
      validateProviderConfig({ openai: { incremental_continuation: true } }),
    ).toThrow(/allowed only under providers.grok/u);
  });

  test("applyEnvOverrides diagnoses invalid loop, coordinator, and watchdog values", () => {
    const warnings: string[] = [];
    const out = applyEnvOverrides(
      defaultConfig(),
      {
        AGENC_MAX_TURNS: "0",
        AGENC_COORDINATOR_MODE: "sometimes",
        AGENC_STREAM_IDLE_TIMEOUT_MS: "-1",
      },
      (message) => warnings.push(message),
    );
    expect(out.max_turns).toBeUndefined();
    expect(out.coordinator_mode).toBeUndefined();
    // An invalid override leaves the ten-minute default in place.
    expect(out.stream_watchdog_timeout_ms).toBe(600_000);
    expect(warnings).toEqual([
      '[agenc:config] invalid AGENC_MAX_TURNS="0"; expected a positive integer',
      '[agenc:config] invalid AGENC_COORDINATOR_MODE="sometimes"; expected boolean-like value',
      '[agenc:config] invalid AGENC_STREAM_IDLE_TIMEOUT_MS="-1"; expected a non-negative integer',
    ]);
  });

  test.each([
    "DISABLE_AUTO_COMPACT",
    "DISABLE_COMPACT",
    "AGENC_DISABLE_STREAM_WATCHDOG",
    "AGENC_ENABLE_STREAM_WATCHDOG",
    "AGENC_ALWAYS_ENABLE_EFFORT",
    "AGENC_HEARTBEAT_MODEL",
    "AGENC_HEARTBEAT_AGENT",
    "AGENC_GATEWAY_HOOKS_TOKEN",
    "AGENC_SPECULATION_ENABLED",
    "AGENC_DISABLE_GIT_INSTRUCTIONS",
    "AGENC_DISABLE_AUTO_MEMORY",
    "AGENC_DISABLE_FILE_CHECKPOINTING",
    "AGENC_ENABLE_SDK_FILE_CHECKPOINTING",
    "AGENC_USE_READABLE_STDIN",
    "AGENC_USE_POWERSHELL_TOOL",
    "OPENAI_MODEL",
    "OPENAI_COMPATIBLE_MODEL",
    "ANTHROPIC_MODEL",
    "GEMINI_MODEL",
    "MISTRAL_MODEL",
    "NVIDIA_MODEL",
    "MINIMAX_MODEL",
    "GITHUB_MODEL",
    "AWS_BEDROCK_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
  ] as const)("rejects removed environment authority %s", (name) => {
    expect(() => applyEnvOverrides(defaultConfig(), { [name]: "0" })).toThrow(
      /obsolete configuration environment variable/,
    );
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

  test("applyEnvOverrides does NOT leak API keys into config snapshot", () => {
    const base = defaultConfig();
    const out = applyEnvOverrides(base, {
      XAI_API_KEY: "secret-xai",
      GROK_API_KEY: "secret-grok",
    });
    // No api-key field should appear anywhere in the merged snapshot.
    const json = JSON.stringify(out);
    expect(json).not.toContain("secret-xai");
    expect(json).not.toContain("secret-grok");
    expect(() =>
      applyEnvOverrides(base, { AGENC_XAI_API_KEY: "retired" }),
    ).toThrow(/obsolete configuration environment variable.*AGENC_XAI_API_KEY/u);
  });

  test("resolveProviderBaseURL follows canonical provider endpoint aliases", () => {
    expect(
      resolveProviderBaseURL("lmstudio", {
        OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
      }),
    ).toBeUndefined();
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
      resolveProviderBaseURL("openai-compatible", {
        OPENAI_API_BASE: "http://127.0.0.1:7000/v1",
      }),
    ).toBe("http://127.0.0.1:7000/v1");
    expect(resolveProviderBaseURL("openai", {
      OPENAI_API_BASE: "https://openai-proxy.example/v1",
    })).toBe("https://openai-proxy.example/v1");
    expect(resolveProviderBaseURL("grok", {
      GROK_BASE_URL: "https://grok-proxy.example/v1",
    })).toBe("https://grok-proxy.example/v1");
    expect(resolveProviderBaseURL("ollama", {
      OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    })).toBe("http://127.0.0.1:11434");
    expect(resolveProviderBaseURL("github", {
      GITHUB_BASE_URL: "https://github-proxy.example",
    })).toBe("https://github-proxy.example");
    expect(resolveProviderBaseURL("agenc", {
      AGENC_BASE_URL: "https://managed.example/v1",
    })).toBe("https://managed.example/v1");
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
    expect(store.current().model_provider).toBe("grok");
  });

  test("current() resolves a provider-only base before the first reload", () => {
    const store = new ConfigStore({
      home: dir,
      env: {},
      base: { model_provider: "openai" },
    });

    expect(store.current()).toMatchObject({
      model_provider: "openai",
      model: "gpt-5",
    });
  });

  test("current() resolves a known environment model provider-neutrally", () => {
    const store = new ConfigStore({
      home: dir,
      env: { AGENC_MODEL: "claude-opus-4-7" },
    });

    expect(store.current()).toMatchObject({
      model_provider: "anthropic",
      model: "claude-opus-4-7",
    });
  });

  test("fixture reloads fold provider-only snapshots through the same authority", async () => {
    const store = new ConfigStore({
      home: dir,
      env: {},
      loader: async () => ({ model_provider: "openai" }),
    });

    await expect(store.reload()).resolves.toMatchObject({
      model_provider: "openai",
      model: "gpt-5",
    });
  });

  test("reload() uses an immutable snapshot of a caller-supplied environment", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      'config_version = 2\nmodel = "disk-model"\n',
    );
    const env: NodeJS.ProcessEnv = {
      AGENC_HOME: dir,
      HOME: dir,
      AGENC_MODEL: "captured-model",
    };
    const previousAmbientModel = process.env.AGENC_MODEL;
    const store = new ConfigStore({
      home: dir,
      env,
      cwd: dir,
      managedConfigPath: join(dir, "missing-managed.toml"),
      managedDropInDir: join(dir, "missing-managed.d"),
    });

    try {
      env.AGENC_MODEL = "mutated-caller-model";
      process.env.AGENC_MODEL = "mutated-ambient-model";

      expect((await store.reload()).model).toBe("captured-model");
      expect(store.current().model).toBe("captured-model");
    } finally {
      if (previousAmbientModel === undefined) delete process.env.AGENC_MODEL;
      else process.env.AGENC_MODEL = previousAmbientModel;
    }
  });

  test("reload() snapshots process.env when no environment is supplied", async () => {
    const previousAmbientModel = process.env.AGENC_MODEL;
    try {
      writeFileSync(
        join(dir, "config.toml"),
        'config_version = 2\nmodel = "disk-model"\n',
      );
      process.env.AGENC_MODEL = "captured-ambient-model";
      const store = new ConfigStore({
        home: dir,
        cwd: dir,
        managedConfigPath: join(dir, "missing-managed.toml"),
        managedDropInDir: join(dir, "missing-managed.d"),
      });
      process.env.AGENC_MODEL = "mutated-ambient-model";

      expect((await store.reload()).model).toBe("captured-ambient-model");
      expect(store.current().model).toBe("captured-ambient-model");
    } finally {
      if (previousAmbientModel === undefined) delete process.env.AGENC_MODEL;
      else process.env.AGENC_MODEL = previousAmbientModel;
    }
  });

  test("reload() re-reads disk and fires subscribers", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.toml"),
      `config_version = 2\nmodel = "grok-3"\nmax_turns = 5\n`,
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

  test("prepareReload keeps config and subscribers unchanged until coordinated publication", async () => {
    const store = new ConfigStore({
      home: dir,
      env: {},
      loader: async () => ({ model: "staged-model" }),
    });
    const previous = store.current();
    const seen: string[] = [];
    store.subscribe((config) => seen.push(config.model ?? ""));

    const prepared = await store.prepareReload();

    expect(store.current()).toBe(previous);
    expect(prepared.config.model).toBe("staged-model");
    expect(prepared.authority.current()).toBe(prepared.config);
    expect(seen).toEqual([]);

    prepared.commit();
    expect(store.current()).toBe(prepared.config);
    expect(seen).toEqual([]);

    prepared.publish();
    expect(seen).toEqual(["staged-model"]);
    prepared.settle();
  });

  test("prepared reload holds serialization through settlement and can restore a published snapshot", async () => {
    let calls = 0;
    const store = new ConfigStore({
      home: dir,
      env: {},
      loader: async () => ({ model: calls++ === 0 ? "first" : "second" }),
    });
    const original = store.current();
    const seen: string[] = [];
    store.subscribe((config) => seen.push(config.model ?? ""));

    const first = await store.prepareReload();
    first.commit();
    first.publish();
    const second = store.reload();
    await Promise.resolve();
    expect(calls).toBe(1);

    first.rollback();
    expect(store.current()).toBe(original);
    expect(seen).toEqual(["first", original.model ?? ""]);
    first.settle();

    await expect(second).resolves.toMatchObject({ model: "second" });
    expect(calls).toBe(2);
  });

  test("throwing warning sinks and subscribers cannot split prepared publication or restoration", async () => {
    const onWarn = vi.fn(() => {
      throw new Error("warning sink failed");
    });
    const store = new ConfigStore({
      home: dir,
      env: {},
      onWarn,
      loader: async ({ onWarn: warn }) => {
        warn?.("staged warning");
        return { model: "staged-model" };
      },
    });
    const previous = store.current();
    const seen: string[] = [];
    store.subscribe(() => {
      throw new Error("subscriber failed");
    });
    store.subscribe((config) => seen.push(config.model ?? ""));

    const prepared = await store.prepareReload();
    prepared.commit();
    expect(() => prepared.publish()).not.toThrow();
    expect(seen).toEqual(["staged-model"]);

    expect(() => prepared.rollback()).not.toThrow();
    expect(store.current()).toBe(previous);
    expect(seen).toEqual(["staged-model", previous.model ?? ""]);
    prepared.settle();
    expect(onWarn).toHaveBeenCalled();
  });

  test("reload() rejects invalid canonical config without fallback", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.toml"),
      `
config_version = 2
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

    await expect(store.reload()).rejects.toThrow(
      "Invalid agent.retention.snapshot_max_count",
    );
    expect(store.current().agent?.retention?.snapshot_max_count).toBe(10_000);
    expect(store.warnings()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("reload() observes file changes between calls", async () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.toml");
    writeFileSync(path, `config_version = 2\nmodel = "a"\n`);

    const store = new ConfigStore({ home: dir, env: {} });
    const first = await store.reload();
    expect(first.model).toBe("a");

    writeFileSync(path, `config_version = 2\nmodel = "b"\n`);
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

  test("serializes concurrent reloads in invocation order", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const seen: string[] = [];
    const store = new ConfigStore({
      home: dir,
      env: {},
      loader: async () => {
        const call = calls;
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (call === 0) await firstBlocked;
          return { model: call === 0 ? "first" : "second" };
        } finally {
          active -= 1;
        }
      },
    });
    store.subscribe((config) => seen.push(config.model ?? ""));

    const first = store.reload();
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = store.reload();
    await Promise.resolve();
    expect(calls).toBe(1);

    releaseFirst();
    await expect(first).resolves.toMatchObject({ model: "first" });
    await expect(second).resolves.toMatchObject({ model: "second" });
    expect(store.current().model).toBe("second");
    expect(seen).toEqual(["first", "second"]);
    expect(maxActive).toBe(1);
  });

  describe("reloadAgentsSection", () => {
    const toml = (lines: readonly string[]): string =>
      ["config_version = 2", ...lines, ""].join("\n");
    const sessionStore = (options: Partial<ConfigStoreOptions> = {}) =>
      new ConfigStore({
        home: dir,
        env: { AGENC_HOME: dir, HOME: dir },
        cwd: dir,
        managedConfigPath: join(dir, "missing-managed.toml"),
        managedDropInDir: join(dir, "missing-managed.d"),
        ...options,
      });

    test("takes only the agents section from disk and runs only the listeners subscribed to it", async () => {
      const path = join(dir, "config.toml");
      writeFileSync(path, toml([
        'model = "grok-3"',
        "max_turns = 5",
        "[agents]",
        "cross_provider_enabled = true",
        'allowed_providers = ["deepseek"]',
      ]));
      const store = sessionStore();
      await store.reload();
      const before = store.current();
      const everyReload = vi.fn();
      const agentsSection = vi.fn();
      store.subscribe(everyReload);
      store.subscribe(agentsSection, { sections: ["agents"] });

      // One save turned the feature off and also changed the model.
      writeFileSync(path, toml([
        'model = "grok-4"',
        "max_turns = 9",
        "[agents]",
        "cross_provider_enabled = false",
        'allowed_providers = ["deepseek", "openai"]',
      ]));
      await expect(store.reloadAgentsSection()).resolves.toBe(true);

      const after = store.current();
      expect(after.agents).toEqual({
        cross_provider_enabled: false,
        allowed_providers: ["deepseek", "openai"],
        cross_provider_ask_each_spawn: false,
        cross_provider_auto: false,
      });
      for (const key of Object.keys(before) as (keyof AgenCConfig)[]) {
        if (key !== "agents") expect(after[key]).toBe(before[key]);
      }
      expect(after.model).toBe("grok-3");
      expect(after.max_turns).toBe(5);
      expect(everyReload).not.toHaveBeenCalled();
      expect(agentsSection).toHaveBeenCalledTimes(1);
      expect(agentsSection).toHaveBeenCalledWith(
        after,
        expect.objectContaining({ sections: ["agents"] }),
      );

      // An unchanged section publishes nothing.
      await expect(store.reloadAgentsSection()).resolves.toBe(false);
      expect(store.current()).toBe(after);
      expect(agentsSection).toHaveBeenCalledTimes(1);

      // A full reload still takes every change and runs every listener.
      await store.reload();
      expect(store.current().model).toBe("grok-4");
      expect(everyReload).toHaveBeenCalledTimes(1);
      expect(agentsSection).toHaveBeenCalledTimes(2);
    });

    test("keeps the agents section of the session's explicit --config file", async () => {
      const user = join(dir, "config.toml");
      const explicit = join(dir, "explicit.toml");
      writeFileSync(user, toml([
        "[agents]",
        "cross_provider_enabled = true",
        'allowed_providers = ["deepseek"]',
      ]));
      writeFileSync(explicit, toml([
        "[agents]",
        "cross_provider_enabled = true",
        'allowed_providers = ["openai"]',
        "cross_provider_ask_each_spawn = true",
      ]));
      const store = sessionStore({ flagConfigPath: explicit });
      await store.reload();
      const operatorAgents = {
        cross_provider_enabled: true,
        allowed_providers: ["openai"],
        cross_provider_ask_each_spawn: true,
        cross_provider_auto: false,
      };
      expect(store.current().agents).toEqual(operatorAgents);

      // Desktop writes user config; the explicit file still decides.
      writeFileSync(user, toml([
        "[agents]",
        "cross_provider_enabled = false",
        "allowed_providers = []",
      ]));
      await expect(store.reloadAgentsSection()).resolves.toBe(false);
      expect(store.current().agents).toEqual(operatorAgents);

      // A change to that file itself reaches the session.
      writeFileSync(explicit, toml([
        "[agents]",
        "cross_provider_enabled = false",
        'allowed_providers = ["openai"]',
        "cross_provider_ask_each_spawn = true",
      ]));
      await expect(store.reloadAgentsSection()).resolves.toBe(true);
      expect(store.current().agents).toEqual({
        ...operatorAgents,
        cross_provider_enabled: false,
      });
    });

    test("leaves the store as it was when its sources cannot be read", async () => {
      const path = join(dir, "config.toml");
      writeFileSync(path, toml([
        "[agents]",
        "cross_provider_enabled = true",
        'allowed_providers = ["deepseek"]',
      ]));
      const store = sessionStore();
      await store.reload();
      const before = store.current();
      const agentsSection = vi.fn();
      store.subscribe(agentsSection, { sections: ["agents"] });

      writeFileSync(path, toml(["[agents]", 'cross_provider_enabled = "no"']));
      await expect(store.reloadAgentsSection()).rejects.toThrow(/cross_provider_enabled/u);
      expect(store.current()).toBe(before);
      expect(agentsSection).not.toHaveBeenCalled();

      // The failed read released the store for the next one.
      writeFileSync(path, toml(["[agents]", "cross_provider_enabled = false"]));
      await expect(store.reloadAgentsSection()).resolves.toBe(true);
      expect(store.current().agents?.cross_provider_enabled).toBe(false);
    });

    test("keeps the caller's settings authority", async () => {
      writeFileSync(join(dir, "config.toml"), toml([
        "[agents]",
        "cross_provider_enabled = true",
      ]));
      const store = sessionStore();
      const caller = sessionStore();
      // The daemon refreshes many sessions' stores from one async context.
      await runWithCanonicalSettingsAuthority(caller, async () => {
        await expect(store.reloadAgentsSection()).resolves.toBe(true);
        expect(getCanonicalSettingsAuthority()).toBe(caller);
      });
    });

    test("narrowAgentsConfig keeps only what both allow and never widens", () => {
      const current = {
        cross_provider_enabled: true,
        allowed_providers: ["deepseek", "openai"],
      };
      expect(narrowAgentsConfig(current, {
        cross_provider_enabled: true,
        allowed_providers: ["grok", "deepseek"],
        cross_provider_ask_each_spawn: true,
      })).toEqual({
        cross_provider_enabled: true,
        allowed_providers: ["deepseek"],
        cross_provider_ask_each_spawn: true,
        cross_provider_auto: false,
      });
      // A wider limit adds nothing, and either side turns the feature off.
      expect(narrowAgentsConfig(current, {
        cross_provider_enabled: true,
        allowed_providers: ["deepseek", "openai", "grok"],
      })).toEqual({ ...current, cross_provider_ask_each_spawn: false, cross_provider_auto: false });
      expect(narrowAgentsConfig(
        { ...current, cross_provider_enabled: false },
        { cross_provider_enabled: true, allowed_providers: ["deepseek"] },
      ).cross_provider_enabled).toBe(false);
      expect(narrowAgentsConfig(current, {
        cross_provider_enabled: false,
        allowed_providers: ["deepseek"],
      }).cross_provider_enabled).toBe(false);
      expect(narrowAgentsConfig(
        { ...current, cross_provider_ask_each_spawn: true },
        { cross_provider_enabled: true, allowed_providers: ["deepseek"] },
      ).cross_provider_ask_each_spawn).toBe(true);
      // No limit allows nothing.
      expect(narrowAgentsConfig(current, undefined)).toEqual({
        cross_provider_enabled: false,
        allowed_providers: [],
        cross_provider_ask_each_spawn: false,
        cross_provider_auto: false,
      });
    });

    test("narrowing and revoking cover automatic choice and sub-agent limits", () => {
      const own = { cross_provider_enabled: true, allowed_providers: ["deepseek"], cross_provider_auto: true,
        subagent_limits: { deepseek: { effort: "high" as const, speed: "fast" as const }, openai: { effort: "medium" as const } } };
      // Each limit ends no higher than both, and automatic choice needs both.
      expect(narrowAgentsConfig(own, { ...own, cross_provider_auto: false, subagent_limits: { deepseek: { effort: "low" } } }))
        .toEqual({ cross_provider_enabled: true, allowed_providers: ["deepseek"], cross_provider_ask_each_spawn: false,
          cross_provider_auto: false, subagent_limits: { deepseek: { effort: "low" } } });
      expect(narrowAgentsConfig(own, { ...own, subagent_limits: { deepseek: { effort: "max", speed: "fast" }, openai: { effort: "max" } } }))
        .toEqual({ ...own, cross_provider_ask_each_spawn: false });
      // A save that lowered DeepSeek's effort takes only that away.
      const lowered = { previous: own, next: { ...own,
        subagent_limits: { ...own.subagent_limits, deepseek: { effort: "low" as const, speed: "fast" as const } } } };
      expect(agentsChangeRevokes(lowered)).toBe(true);
      expect(revokeAgentsConfig(own, lowered).subagent_limits)
        .toEqual({ deepseek: { effort: "low", speed: "fast" }, openai: { effort: "medium" } });
      // Raising a limit takes nothing away, and grants nothing to a session that cannot read it.
      const raised = { previous: own, next: { ...own, subagent_limits: { ...own.subagent_limits, openai: { effort: "max" as const } } } };
      expect(agentsChangeRevokes(raised)).toBe(false);
      expect(revokeAgentsConfig(own, raised).subagent_limits).toEqual(own.subagent_limits);
      // Removing a limit returns that provider to the lowest.
      const removed = { previous: own, next: { ...own, subagent_limits: { deepseek: own.subagent_limits.deepseek } } };
      expect(revokeAgentsConfig(own, removed).subagent_limits).toEqual({ deepseek: { effort: "high", speed: "fast" } });
      // Turning automatic choice off takes it away.
      const manual = { previous: own, next: { ...own, cross_provider_auto: false } };
      expect(agentsChangeRevokes(manual)).toBe(true);
      expect(revokeAgentsConfig(own, manual).cross_provider_auto).toBe(false);
    });

    test("revokeAgentsConfig takes away only what the daemon's view lost and never widens", () => {
      // The session's own --config file also allows grok.
      const own = {
        cross_provider_enabled: true,
        allowed_providers: ["deepseek", "openai", "grok"],
      };
      const before = {
        cross_provider_enabled: true,
        allowed_providers: ["deepseek", "openai"],
      };
      const off = { cross_provider_enabled: false, allowed_providers: [] };
      // A save that took nothing away, one that added a provider, and one
      // that kept the feature off leave the session as it is.
      for (const change of [
        { previous: before, next: before },
        { previous: before, next: { ...before, allowed_providers: ["deepseek", "openai", "agenc"] } },
        { previous: off, next: off },
      ]) {
        expect(agentsChangeRevokes(change)).toBe(false);
        expect(revokeAgentsConfig(own, change)).toEqual({
          ...own,
          cross_provider_ask_each_spawn: false,
          cross_provider_auto: false,
        });
      }
      // The user removed openai: only openai goes.
      const removed = { previous: before, next: { ...before, allowed_providers: ["deepseek"] } };
      expect(agentsChangeRevokes(removed)).toBe(true);
      expect(revokeAgentsConfig(own, removed)).toEqual({
        cross_provider_enabled: true,
        allowed_providers: ["deepseek", "grok"],
        cross_provider_ask_each_spawn: false,
        cross_provider_auto: false,
      });
      // Turning the feature off, or asking at each spawn, reaches it too.
      const disabled = { previous: before, next: { ...before, cross_provider_enabled: false } };
      const asking = { previous: before, next: { ...before, cross_provider_ask_each_spawn: true } };
      expect(agentsChangeRevokes(disabled) && agentsChangeRevokes(asking)).toBe(true);
      expect(revokeAgentsConfig(own, disabled).cross_provider_enabled).toBe(false);
      expect(revokeAgentsConfig(own, asking).cross_provider_ask_each_spawn).toBe(true);
      // A session that is off stays off, and gains nothing the save added.
      expect(revokeAgentsConfig(
        { cross_provider_enabled: false, allowed_providers: ["deepseek"] },
        { previous: off, next: { ...before, allowed_providers: ["deepseek", "grok"] } },
      )).toEqual({
        cross_provider_enabled: false,
        allowed_providers: ["deepseek"],
        cross_provider_ask_each_spawn: false,
        cross_provider_auto: false,
      });
      // Without the view before the save, it keeps only what both allow.
      expect(agentsChangeRevokes({ next: before })).toBe(true);
      expect(revokeAgentsConfig(own, { next: before })).toEqual(narrowAgentsConfig(own, before));
      expect(revokeAgentsConfig(own, {})).toEqual(narrowAgentsConfig(own, undefined));
    });

    test("limitAgentsSection narrows the section at once, tells only the agents listeners, and never widens it", async () => {
      writeFileSync(join(dir, "config.toml"), toml([
        'model = "grok-3"',
        "[agents]",
        "cross_provider_enabled = true",
        'allowed_providers = ["deepseek", "openai"]',
      ]));
      const store = sessionStore();
      await store.reload();
      const before = store.current();
      const everyReload = vi.fn();
      const agentsSection = vi.fn();
      store.subscribe(everyReload);
      store.subscribe(agentsSection, { sections: ["agents"] });

      // The daemon's own view dropped openai; this session cannot read its
      // sources, so it keeps only what both allow.
      expect(store.limitAgentsSection({
        cross_provider_enabled: true,
        allowed_providers: ["deepseek", "grok"],
      }, nextConfigReadMark())).toBe(true);
      expect(store.current().agents).toEqual({
        cross_provider_enabled: true,
        allowed_providers: ["deepseek"],
        cross_provider_ask_each_spawn: false,
        cross_provider_auto: false,
      });
      expect(store.current().model).toBe(before.model);
      expect(store.authoritySnapshot().config).toBe(store.current());
      expect(everyReload).not.toHaveBeenCalled();
      expect(agentsSection).toHaveBeenCalledOnce();
      expect(agentsSection).toHaveBeenCalledWith(
        store.current(),
        expect.objectContaining({ sections: ["agents"] }),
      );

      // A wider view gives nothing back.
      expect(store.limitAgentsSection({
        cross_provider_enabled: true,
        allowed_providers: ["deepseek", "openai", "grok"],
      }, nextConfigReadMark())).toBe(false);
      expect(store.current().agents?.allowed_providers).toEqual(["deepseek"]);
      expect(agentsSection).toHaveBeenCalledOnce();
    });

    test("a read from before the limit stays within it when a held reload publishes it or rolls back", async () => {
      const path = join(dir, "config.toml");
      const enabled = toml([
        "[agents]",
        "cross_provider_enabled = true",
        'allowed_providers = ["deepseek"]',
      ]);
      const disabled = toml(["[agents]", "cross_provider_enabled = false"]);
      const published = vi.fn();
      for (const ending of ["settle", "rollback"] as const) {
        writeFileSync(path, enabled);
        const store = sessionStore();
        await store.reload();
        store.subscribe((config) => published(config.agents?.cross_provider_enabled));
        // A coordinated reload read the sources before the user's save and
        // still holds the store when a refresh gives up on it.
        const held = await store.prepareReload();
        writeFileSync(path, disabled);
        expect(store.limitAgentsSection(
          { cross_provider_enabled: false },
          nextConfigReadMark(),
        )).toBe(true);
        held.commit();
        held.publish();
        expect(store.current().agents?.cross_provider_enabled).toBe(false);
        // The older snapshot a rollback restores was read before it too.
        if (ending === "rollback") held.rollback();
        held.settle();
        expect(store.current().agents?.cross_provider_enabled, ending).toBe(false);

        // The next read of the sources began after the limit and replaces it.
        await expect(store.reloadAgentsSection()).resolves.toBe(false);
        writeFileSync(path, enabled);
        await expect(store.reloadAgentsSection()).resolves.toBe(true);
        expect(store.current().agents?.cross_provider_enabled).toBe(true);
      }
      expect(published).not.toHaveBeenCalledWith(true);
    });

    test("the agents listeners hear a limit on a committed read that rolls back unpublished", async () => {
      const path = join(dir, "config.toml");
      writeFileSync(path, toml([
        "[agents]",
        "cross_provider_enabled = true",
        'allowed_providers = ["deepseek"]',
      ]));
      const store = sessionStore();
      await store.reload();
      const everyReload = vi.fn();
      const agentsSection = vi.fn();
      store.subscribe(everyReload);
      store.subscribe(
        (config) => agentsSection(config.agents?.cross_provider_enabled),
        { sections: ["agents"] },
      );
      // A coordinated reload queues behind another holder of the lock.
      const first = await store.prepareReload();
      const queued = store.prepareReload();
      // The user turns the feature off, and a refresh begins.
      writeFileSync(path, toml(["[agents]", "cross_provider_enabled = false"]));
      const since = nextConfigReadMark();
      first.rollback();
      first.settle();
      // The coordinated reload reads the save, after the refresh began, and
      // commits it. The refresh then gives up on this store.
      const coordinated = await queued;
      coordinated.commit();
      store.limitAgentsSection({ cross_provider_enabled: false }, since);
      // Its permission publication fails, so it never publishes the commit.
      coordinated.rollback();
      coordinated.settle();
      expect(store.current().agents?.cross_provider_enabled).toBe(false);
      expect(agentsSection).toHaveBeenCalledWith(false);
      expect(agentsSection).not.toHaveBeenCalledWith(true);
      expect(everyReload).not.toHaveBeenCalled();
      // The refresh's own read, queued behind it, has nothing left to tell.
      await expect(store.reloadAgentsSection()).resolves.toBe(false);
      expect(agentsSection).toHaveBeenCalledOnce();
    });

    test("a rollback of a committed reload tells the agents listeners what it takes back", async () => {
      const path = join(dir, "config.toml");
      writeFileSync(path, toml(["[agents]", "cross_provider_enabled = false"]));
      const store = sessionStore();
      await store.reload();
      const everyReload = vi.fn();
      store.subscribe(everyReload);
      writeFileSync(path, toml([
        "[agents]",
        "cross_provider_enabled = true",
        'allowed_providers = ["deepseek"]',
      ]));
      const coordinated = await store.prepareReload();
      coordinated.commit();
      // A child starts on deepseek while the commit is live but unpublished,
      // and subscribes after reading current().
      expect(store.current().agents?.cross_provider_enabled).toBe(true);
      const agentsSection = vi.fn();
      store.subscribe(
        (config) => agentsSection(config.agents?.cross_provider_enabled),
        { sections: ["agents"] },
      );
      coordinated.rollback();
      coordinated.settle();
      expect(store.current().agents?.cross_provider_enabled).toBe(false);
      expect(agentsSection).toHaveBeenCalledExactlyOnceWith(false);

      // A rolled back reload that did not change the section tells no one.
      writeFileSync(path, toml(["[agents]", "cross_provider_enabled = false"]));
      const unrelated = await store.prepareReload();
      unrelated.commit();
      unrelated.rollback();
      unrelated.settle();
      expect(agentsSection).toHaveBeenCalledOnce();
      expect(everyReload).not.toHaveBeenCalled();
    });

    test("a published full reload from after the limit replaces it", async () => {
      const path = join(dir, "config.toml");
      writeFileSync(path, toml([
        "[agents]",
        "cross_provider_enabled = true",
        'allowed_providers = ["deepseek"]',
      ]));
      const store = sessionStore();
      await store.reload();
      const readBefore = store.agentsReadStartedAt();
      store.limitAgentsSection({ cross_provider_enabled: false }, nextConfigReadMark());
      expect(store.current().agents?.cross_provider_enabled).toBe(false);
      await store.reload();
      expect(store.agentsReadStartedAt()).toBeGreaterThan(readBefore);
      expect(store.current().agents?.cross_provider_enabled).toBe(true);
    });

    test("no source reads the agents section from layers, provenance, ignored values or a prepared read", () => {
      // A section refresh or limit changes current().agents only. The layers,
      // provenance and ignored values still describe the last full reload.
      // The repository loader builds those layers and strips agents from the
      // project and local ones.
      const sourceRoot = join(import.meta.dirname, "../../src");
      const layerRead = /\.(?:sources|provenance|ignored)\(|\.layers\b|\bgetSettingsForSource\(|\bgetCanonicalConfigLayers\(|\bmergeConfigLayerSnapshots\(/u;
      // A prepared reload, and a read of a store's sources, hold what they
      // read. While a limit applies, their agents can be wider than
      // current().agents. The store itself commits and publishes a prepared
      // read within the limit.
      const preparedRead = /\.prepareReload\(|\.readSourceAuthority\(|\bPreparedConfigStoreReload\b/u;
      const agentsRead = /\b(?:cross_provider_enabled|allowed_providers|cross_provider_ask_each_spawn|cross_provider_auto|subagent_limits)\b|["'`]agents[."'`]|\.agents\b/u;
      // Comment lines read nothing.
      const code = (source: string): string =>
        source.split("\n").filter((line) => !/^\s*(?:\/\/|\/\*|\*)/u.test(line)).join("\n");
      const files = (directory: string): string[] =>
        readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) return files(path);
          return /\.tsx?$/u.test(entry.name) ? [path] : [];
        });
      const readsAgentsFrom = (path: string, source: string): boolean =>
        agentsRead.test(source) &&
        (layerRead.test(source) || (path !== "config/store.ts" && preparedRead.test(source)));
      const violations = files(sourceRoot)
        .map((path) => relative(sourceRoot, path))
        .filter((path) => path !== "config/repository.ts")
        .filter((path) => readsAgentsFrom(path, code(readFileSync(join(sourceRoot, path), "utf8"))));
      expect(violations).toEqual([]);
      // The guard sees a read through the layers, a prepared reload or its
      // authority, and a read of the sources, but not a comment.
      for (const probe of [
        'store.sources("user")[0]?.config.agents?.cross_provider_enabled',
        "const prepared = await store.prepareReload();\nconst agents = prepared.config.agents;",
        "(prepared: PreparedConfigStoreReload) => prepared.authority.current().agents",
        "const authority = await store.readSourceAuthority();\nauthority.current().agents",
      ]) {
        expect(readsAgentsFrom("probe.ts", code(probe)), probe).toBe(true);
      }
      expect(readsAgentsFrom("probe.ts", code(
        "const prepared = await store.prepareReload();\n// It reads `state.agents` later.",
      ))).toBe(false);
    });
  });
});
