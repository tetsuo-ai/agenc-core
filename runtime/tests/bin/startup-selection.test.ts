import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultConfig } from "../config/schema.js";
import { ConfigStore } from "../config/store.js";
import {
  readStartupCliFlags,
  resolveCanonicalStartupSelection,
  startupConfigLayerOptions,
} from "./startup-selection.js";

describe("resolveCanonicalStartupSelection", () => {
  it("reads the canonical top-level model without provider fallback", () => {
    const resolved = resolveCanonicalStartupSelection({
      config: {
        ...defaultConfig(),
        model: "grok-build-0.1",
        model_provider: "grok",
        providers: { grok: { default_model: "grok-4.3" } },
      },
    });

    expect(resolved.provider).toBe("grok");
    expect(resolved.model).toBe("grok-build-0.1");
  });

  it("reads the complete built-in default pair", () => {
    const resolved = resolveCanonicalStartupSelection({
      config: defaultConfig(),
    });

    expect(resolved.provider).toBe("grok");
    expect(resolved.model).toBe("grok-4.6");
  });

  it("does not infer a missing half of the canonical pair", () => {
    expect(() =>
      resolveCanonicalStartupSelection({
        config: { model: "gpt-5" },
      })
    ).toThrow(/must contain a provider\/model pair/u);
  });

  it("rejects a startup model denied by managed availableModels policy", () => {
    expect(() =>
      resolveCanonicalStartupSelection({
        config: {
          ...defaultConfig(),
          model_provider: "openai",
          model: "gpt-5",
          availableModels: ["grok-4.6"],
        },
      })
    ).toThrow(/managed availableModels policy/u);
  });

  it("accepts and provider-localizes an allowed qualified GitHub model", () => {
    const resolved = resolveCanonicalStartupSelection({
      config: {
        ...defaultConfig(),
        model_provider: "github",
        model: "github:copilot:gpt-5.3-codex",
        availableModels: ["github:copilot:gpt-5.3-codex"],
      },
    });

    expect(resolved).toMatchObject({
      provider: "github",
      model: "gpt-5.3-codex",
      config: {
        model_provider: "github",
        model: "gpt-5.3-codex",
      },
    });
  });
});

describe("readStartupCliFlags --permission-mode validation", () => {
  it.each([
    ["--yolo", "--dangerously-bypass-approvals-and-sandbox"],
    ["--allow-dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox"],
    ["--proactive", "--autonomous"],
  ])("rejects retired startup flag %s", (flag, replacement) => {
    expect(() => readStartupCliFlags(["node", "agenc", flag])).toThrow(
      `unknown option '${flag}'. Use '${replacement}' instead.`,
    );
  });

  it("parses --bare only in the startup option region", () => {
    expect(
      readStartupCliFlags(["node", "agenc", "--bare", "explain"]),
    ).toMatchObject({ simpleMode: true });
    expect(
      readStartupCliFlags(["node", "agenc", "--", "--bare"]),
    ).not.toHaveProperty("simpleMode");
    expect(
      readStartupCliFlags(["node", "agenc", "explain", "--bare"]),
    ).not.toHaveProperty("simpleMode");
  });

  it("parses --config only in the startup option region", () => {
    expect(
      readStartupCliFlags([
        "node",
        "agenc",
        "--config",
        "operator.toml",
        "explain",
      ]),
    ).toMatchObject({ configPath: "operator.toml" });
    expect(
      readStartupCliFlags([
        "node",
        "agenc",
        "explain",
        "--config",
        "operator.toml",
      ]),
    ).not.toHaveProperty("configPath");
  });

  it("accepts a valid --permission-mode value", () => {
    const flags = readStartupCliFlags([
      "node",
      "agenc",
      "--permission-mode",
      "plan",
    ]);
    expect(flags.permissionMode).toBe("plan");
  });

  it("defaults (undefined) when --permission-mode is absent", () => {
    const flags = readStartupCliFlags(["node", "agenc"]);
    expect(flags.permissionMode).toBeUndefined();
  });

  it("throws on an invalid --permission-mode typo (no silent drop)", () => {
    // Regression: a typo toward a MORE restrictive mode must NOT silently
    // coerce to undefined (which boots in the LESS restrictive DEFAULT mode).
    expect(() =>
      readStartupCliFlags(["node", "agenc", "--permission-mode", "plann"]),
    ).toThrow(/unknown permission mode 'plann'\. Expected one of:/);
  });

  it("throws on a wrong-case --permission-mode value", () => {
    expect(() =>
      readStartupCliFlags(["node", "agenc", "--permission-mode", "Plan"]),
    ).toThrow(/unknown permission mode 'Plan'\. Expected one of:/);
  });

  it.each(["unattended", "bubble"])(
    "rejects internal --permission-mode value %s",
    (mode) => {
      expect(() =>
        readStartupCliFlags([
          "node",
          "agenc",
          "--permission-mode",
          mode,
        ]),
      ).toThrow(`unknown permission mode '${mode}'. Expected one of:`);
    },
  );

  it("ignores startup-looking tokens after the positional prompt begins", () => {
    const flags = readStartupCliFlags([
      "node",
      "agenc",
      "explain",
      "--provider",
      "openai",
      "--model",
      "gpt-5",
      "--profile",
      "fast",
      "--permission-mode",
      "bypassPermissions",
      "--dangerously-bypass-approvals-and-sandbox",
      "--autonomous",
    ]);

    expect(flags).toEqual({});
  });

  it("ignores startup-looking tokens after the end-of-options delimiter", () => {
    const flags = readStartupCliFlags([
      "node",
      "agenc",
      "--",
      "--provider",
      "openai",
      "--model",
      "gpt-5",
      "--permission-mode",
      "bypassPermissions",
      "--dangerously-bypass-approvals-and-sandbox",
      "--autonomous",
    ]);

    expect(flags).toEqual({});
  });
});

describe("canonical startup ConfigStore layers", () => {
  it("passes literal provider/model CLI intent to the repository", () => {
    expect(
      startupConfigLayerOptions({
        cli: { provider: "openai" },
        cwd: "/workspace",
      }),
    ).toEqual({ cliOverrides: { model_provider: "openai" } });
    expect(
      startupConfigLayerOptions({
        cli: { model: "gpt-5" },
        cwd: "/workspace",
      }),
    ).toEqual({ cliOverrides: { model: "gpt-5" } });
  });

  it("resolves a model-only CLI patch through the canonical repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-startup-model-only-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });

    try {
      const env = { AGENC_HOME: home, HOME: home };
      const store = new ConfigStore({
        home,
        cwd: workspace,
        env,
        ...startupConfigLayerOptions({
          cli: { model: "gpt-5" },
          cwd: workspace,
        }),
      });

      await expect(store.reload()).resolves.toMatchObject({
        model_provider: "openai",
        model: "gpt-5",
      });
      expect(store.provenance("model_provider")?.scope).toBe("cli");
      expect(store.provenance("model")?.scope).toBe("cli");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the ConfigStore's immutable environment snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-startup-env-snapshot-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const env: NodeJS.ProcessEnv = {
      AGENC_HOME: home,
      HOME: home,
      AGENC_PROVIDER: "openai",
    };
    const previousAmbientProvider = process.env.AGENC_PROVIDER;

    try {
      const cli = Object.freeze({ model: "gpt-5" });
      const store = new ConfigStore({
        home,
        cwd: workspace,
        env,
        ...startupConfigLayerOptions({ cli, cwd: workspace }),
      });
      env.AGENC_PROVIDER = "grok";
      process.env.AGENC_PROVIDER = "grok";

      await expect(store.reload()).resolves.toMatchObject({
        model_provider: "openai",
        model: "gpt-5",
      });
      expect(store.provenance("model_provider")?.scope).toBe("cli");
    } finally {
      if (previousAmbientProvider === undefined) {
        delete process.env.AGENC_PROVIDER;
      } else {
        process.env.AGENC_PROVIDER = previousAmbientProvider;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit config, profile, and CLI values on reload and subscription", async () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-startup-authority-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const explicitConfig = join(workspace, "operator.toml");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(
      explicitConfig,
      [
        "config_version = 2",
        'model_provider = "grok"',
        'model = "grok-4.3"',
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        "[tools_config]",
        'enabled_tools = ["Write"]',
        "[profiles.operator]",
        'model = "grok-4.5"',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        "[profiles.operator.tools_config]",
        'enabled_tools = ["FileRead"]',
        'disabled_tools = ["Write"]',
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      const cli = readStartupCliFlags([
        "node",
        "agenc",
        "--config",
        "operator.toml",
        "--profile",
        "operator",
        "--provider",
        "grok",
        "--model",
        "grok-4.6",
      ]);
      const env = {
        AGENC_HOME: home,
        HOME: home,
        AGENC_MODEL: "grok-4.4",
      };
      const store = new ConfigStore({
        home,
        cwd: workspace,
        env,
        ...startupConfigLayerOptions({ cli, cwd: workspace }),
      });
      const observed: unknown[] = [];
      const unsubscribe = store.subscribe((config) => observed.push(config));

      const first = await store.reload();
      const selection = resolveCanonicalStartupSelection({
        config: first,
        profileName: cli.profile,
      });
      const expected = {
        model_provider: "grok",
        model: "grok-4.6",
        approval_policy: "never",
        sandbox_mode: "read-only",
        tools_config: {
          enabled_tools: ["FileRead"],
          disabled_tools: ["Write"],
        },
      };

      expect(first).toMatchObject(expected);
      expect(selection).toMatchObject({
        config: expected,
        profileName: "operator",
        provider: "grok",
        model: "grok-4.6",
      });
      expect(store.provenance("model")?.scope).toBe("cli");
      expect(store.provenance("sandbox_mode")?.scope).toBe("profile");
      expect(store.sources("flag")).toEqual([
        expect.objectContaining({ path: explicitConfig }),
      ]);

      const reloaded = await store.reload();
      expect(reloaded).toMatchObject(expected);
      expect(store.current()).toBe(reloaded);
      expect(observed).toHaveLength(2);
      expect(observed).toEqual([
        expect.objectContaining(expected),
        expect.objectContaining(expected),
      ]);
      unsubscribe();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
