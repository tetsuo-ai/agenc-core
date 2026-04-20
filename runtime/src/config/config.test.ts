import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultConfig,
  mergeConfigs,
  normalizeRawConfig,
  AgenCConfig,
  resolveModelDisambiguated,
  AmbiguousModelError,
  UnknownModelError,
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
  resolveModel,
  resolveWorkspace,
  resolveSimpleMode,
  applyEnvOverrides,
} from "./env.js";
import { ConfigStore } from "./store.js";

// ─────────────────────────────────────────────────────────────────────
// schema
// ─────────────────────────────────────────────────────────────────────

describe("schema: defaultConfig", () => {
  test("returns frozen snapshot with sane defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.model).toBe("grok-4-fast");
    expect(cfg.approval_policy).toBe("on-request");
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

  test("resolveModel / resolveWorkspace / resolveSimpleMode", () => {
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

  test("applyEnvOverrides is a no-op when no overrides set", () => {
    const base = defaultConfig();
    const out = applyEnvOverrides(base, {});
    expect(out.model).toBe(base.model);
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
});
