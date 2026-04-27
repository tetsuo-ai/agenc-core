import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
  InvalidPermissionsConfigError,
  InvalidStatusLineConfigError,
  UnknownModelError,
  isValidPermissionMode,
  validatePermissionsConfig,
  validateStatusLineConfig,
  validateOutputStyleConfig,
  KNOWN_CONFIG_KEYS,
  DEFERRED_SETTINGS_KEYS,
} from "./schema.js";
import { parseToml, loadConfig, TomlParseError } from "./loader.js";
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
  resolveModel,
  resolveWorkspace,
  resolveSimpleMode,
  applyEnvOverrides,
} from "./env.js";
import {
  buildProviderModelCatalog,
  configuredModelForProvider,
  resolveProviderSettings,
} from "./index.js";
import { ConfigStore } from "./store.js";

// ─────────────────────────────────────────────────────────────────────
// schema
// ─────────────────────────────────────────────────────────────────────

describe("schema: defaultConfig", () => {
  test("returns frozen snapshot with sane defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.model).toBe("grok-4-fast");
    expect(cfg.approval_policy).toBe("on-request");
    expect(cfg.approvals_reviewer).toBe("user");
    expect(cfg.sandbox_mode).toBe("workspace-write");
    expect(cfg.max_turns).toBeGreaterThan(0);
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
      capability_overrides: {
        acceptsThinkingHistory: true,
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
    });
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
      model: "grok-4-fast",
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
      defaultMode: "plan",
    });
    expect(out).toBeDefined();
    expect(out?.allow).toEqual(["Read(*)"]);
    expect(out?.deny).toEqual(["Bash(rm *)"]);
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

  test("isValidPermissionMode matches all seven mode variants and rejects garbage", () => {
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
    expect(isValidPermissionMode("nonsense")).toBe(false);
    expect(isValidPermissionMode(null)).toBe(false);
    expect(isValidPermissionMode(42)).toBe(false);
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

// ─────────────────────────────────────────────────────────────────────
// I-60: disambiguation
// ─────────────────────────────────────────────────────────────────────

describe("schema: resolveModelDisambiguated (I-60)", () => {
  const catalog: Record<string, readonly string[]> = {
    xai: ["grok-4-fast", "grok-3"],
    openrouter: ["grok-4-fast", "gpt-4o"],
    openai: ["gpt-4o", "o1"],
  };

  test("unique slug resolves to single provider", () => {
    const out = resolveModelDisambiguated("grok-3", catalog);
    expect(out).toEqual({ provider: "xai", model: "grok-3" });
  });

  test("ambiguous slug throws AmbiguousModelError with candidates", () => {
    let caught: unknown;
    try {
      resolveModelDisambiguated("grok-4-fast", catalog);
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
    expect(err.message).toContain("xai:grok-4-fast");
    expect(err.message).toContain("openrouter:grok-4-fast");
  });

  test("unknown slug throws UnknownModelError", () => {
    expect(() =>
      resolveModelDisambiguated("mystery-model", catalog),
    ).toThrow(UnknownModelError);
  });

  test("provider:model form short-circuits", () => {
    const out = resolveModelDisambiguated("xai:grok-4-fast", catalog);
    expect(out).toEqual({ provider: "xai", model: "grok-4-fast" });
  });

  test("provider:model with invalid provider throws UnknownModelError", () => {
    expect(() =>
      resolveModelDisambiguated("bogus:grok-4-fast", catalog),
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
model = "grok-4-fast"
max_turns = 100

[tools_config]
web_search = true
view_image = false
      `,
    );
    expect(out.model).toBe("grok-4-fast");
    expect(out.max_turns).toBe(100);
    expect((out.tools_config as Record<string, unknown>).web_search).toBe(true);
  });

  test("parses arrays of strings", () => {
    const out = parseToml(`project_root_markers = ["a", "b", "c"]`);
    expect(out.project_root_markers).toEqual(["a", "b", "c"]);
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
model = "grok-4-fast"
approval_policy = "never"
      `,
    );
    const profiles = out.profiles as Record<string, Record<string, unknown>>;
    expect(profiles.fast?.model).toBe("grok-4-fast");
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
    expect(out.config.model).toBe("grok-4-fast");
  });

  test("corrupt TOML warns + falls back to defaults with parseError set", async () => {
    writeFileSync(join(dir, "config.toml"), "this is not = = valid");
    const warnings: string[] = [];
    const out = await loadConfig({ home: dir, onWarn: (m) => warnings.push(m) });
    expect(out.exists).toBe(true);
    expect(out.parseError).toBeTruthy();
    expect(warnings.length).toBeGreaterThan(0);
    expect(out.config.model).toBe("grok-4-fast"); // defaulted
  });

  test("valid TOML merges onto defaults", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `
model = "grok-3"
max_turns = 7

[profiles.fast]
model = "grok-4-fast"
      `,
    );
    const out = await loadConfig({ home: dir });
    expect(out.config.model).toBe("grok-3");
    expect(out.config.max_turns).toBe(7);
    expect(out.config.profiles?.fast?.model).toBe("grok-4-fast");
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
      `model = "grok-3"\nmodel = "grok-4-fast"\n`,
    );
    const warnings: string[] = [];
    const out = await loadConfig({
      home: dir,
      onWarn: (m) => warnings.push(m),
    });
    expect(out.exists).toBe(true);
    expect(out.parseError).toBeUndefined();
    expect(out.config.model).toBe("grok-4-fast");
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
          model: "grok-4-fast",
          approval_policy: "never",
          reasoning_effort: "low",
          personality: "fast",
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
    expect(out.model).toBe("grok-4-fast");
    expect(out.approval_policy).toBe("never");
    expect(out.reasoning_effort).toBe("low");
    expect(out.personality).toBe("fast");
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
          model: "grok-4-fast",
          model_provider: "openrouter",
        },
      },
    });
    const out = resolveProfile(cfg, "remote");
    expect(out.model).toBe("grok-4-fast");
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
    expect(resolveProvider({ AGENC_PROVIDER: "  OpenAI  " })).toBe("openai");
    expect(resolveProvider({})).toBeUndefined();
    expect(resolveProfileName({ AGENC_PROFILE: "fast" })).toBe("fast");
    expect(resolveProfileName({})).toBeUndefined();
    expect(resolveModel("grok-4-fast", { AGENC_MODEL: "grok-3" })).toBe(
      "grok-3",
    );
    expect(resolveModel("grok-4-fast", {})).toBe("grok-4-fast");
    expect(resolveWorkspace({ AGENC_WORKSPACE: "/work" })).toBe("/work");
    expect(resolveWorkspace({})).toBeUndefined();
    expect(resolveSimpleMode({ AGENC_SIMPLE: "1" })).toBe(true);
    expect(resolveSimpleMode({ AGENC_SIMPLE: "true" })).toBe(true);
    expect(resolveSimpleMode({ AGENC_SIMPLE: "no" })).toBe(false);
    expect(resolveSimpleMode({})).toBe(false);
  });

  test("applyEnvOverrides — AGENC_MODEL wins over TOML model", () => {
    const base = mergeConfigs(defaultConfig(), { model: "grok-3" });
    const out = applyEnvOverrides(base, { AGENC_MODEL: "grok-4-fast" });
    expect(out.model).toBe("grok-4-fast");
  });

  test("applyEnvOverrides — AGENC_PROVIDER wins over TOML model_provider", () => {
    const base = mergeConfigs(defaultConfig(), { model_provider: "grok" });
    const out = applyEnvOverrides(base, { AGENC_PROVIDER: "openai" });
    expect(out.model_provider).toBe("openai");
  });

  test("applyEnvOverrides is a no-op when no overrides set", () => {
    const base = defaultConfig();
    const out = applyEnvOverrides(base, {});
    expect(out.model).toBe(base.model);
  });

  test("applyEnvOverrides propagates AGENC_WORKSPACE and AGENC_SIMPLE", () => {
    const base = defaultConfig();
    const out = applyEnvOverrides(base, {
      AGENC_WORKSPACE: "/work/project",
      AGENC_SIMPLE: "true",
    });
    expect(out.workspace).toBe("/work/project");
    expect(out.simpleMode).toBe(true);
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
    expect(resolveProviderApiKey("ollama", {})).toBeUndefined();
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
