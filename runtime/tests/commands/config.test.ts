import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createConfigCommand,
  configCommand,
  formatConfigSnapshot,
  getConfigPath,
  getConfigFilePath,
  editorForEnv,
} from "./config.js";
import {
  effectiveBufferEditorConfig,
  readConfigMenuSnapshot,
} from "./config-menu.js";
import { ConfigStore } from "../config/store.js";
import { defaultConfig, type AgenCConfig } from "../config/schema.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

// ─────────────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────────────

interface StubSession {
  services: Record<string, unknown>;
  pendingProviderSwitch:
    | { provider: string; model: string; profile?: string }
    | null;
  setPendingProviderSwitch(
    next:
      | { provider: string; model: string; profile?: string }
      | null,
  ): void;
  emit: () => void;
  nextInternalSubId: () => string;
}

function stubSession(): Session {
  const s: StubSession = {
    services: {},
    pendingProviderSwitch: null,
    setPendingProviderSwitch(next) {
      this.pendingProviderSwitch = next;
    },
    emit: () => {},
    nextInternalSubId: () => "sub-1",
  };
  return s as unknown as Session;
}

function stubCtx(
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext {
  return {
    session: overrides.session ?? stubSession(),
    argsRaw: overrides.argsRaw ?? "",
    cwd: overrides.cwd ?? "/tmp",
    home: overrides.home ?? "/home/test",
    agencHome: overrides.agencHome ?? "/home/test/.agenc",
    configStore: overrides.configStore,
    appState: overrides.appState,
  };
}

function makeStore(base: Partial<AgenCConfig> = {}): ConfigStore {
  return new ConfigStore({
    base: { ...defaultConfig(), ...base } as AgenCConfig,
  });
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

describe("config — getConfigPath", () => {
  it("returns the string form for a scalar key", () => {
    const store = makeStore({ model: "grok-4" });
    expect(getConfigPath(store.current(), "model")).toBe("grok-4");
  });

  it("walks nested paths", () => {
    const store = makeStore({
      tui: { ...defaultConfig().tui, theme: "light" },
    });
    expect(getConfigPath(store.current(), "tui.theme")).toBe("light");
  });

  it("returns 'not set' for missing keys", () => {
    const store = makeStore();
    const r = getConfigPath(store.current(), "absolutely.nonexistent.key");
    expect(r).toMatch(/^not set/);
  });

  it("returns usage hint for empty key", () => {
    expect(getConfigPath(makeStore().current(), "")).toMatch(/Usage/);
  });
});

describe("config — formatConfigSnapshot", () => {
  it("emits JSON serializable output", () => {
    const snap = makeStore().current();
    const out = formatConfigSnapshot(snap);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe("config — getConfigFilePath", () => {
  it("appends config.toml to the home path", () => {
    expect(getConfigFilePath("/home/alice/.agenc")).toBe(
      "/home/alice/.agenc/config.toml",
    );
  });
});

describe("config — editorForEnv", () => {
  it("honors $EDITOR", () => {
    expect(editorForEnv({ EDITOR: "nvim" } as NodeJS.ProcessEnv)).toBe("nvim");
  });
  it("falls back to $VISUAL when EDITOR missing", () => {
    expect(editorForEnv({ VISUAL: "code" } as NodeJS.ProcessEnv)).toBe("code");
  });
  it("defaults to vim when neither is set", () => {
    expect(editorForEnv({} as NodeJS.ProcessEnv)).toBe("vim");
  });
});

// ─────────────────────────────────────────────────────────────────────
// execute — show / get / reload / profile / edit / path
// ─────────────────────────────────────────────────────────────────────

describe("configCommand — execute show/default", () => {
  it("no args → show snapshot as JSON", async () => {
    const store = makeStore({ model: "grok-4-fast" });
    const r = await configCommand.execute(stubCtx({ configStore: store }));
    if (r.kind !== "text") throw new Error("expected text");
    expect(() => JSON.parse(r.text)).not.toThrow();
    expect(r.text).toContain("grok-4-fast");
  });

  it("no args opens a persistent v2 menu when TUI app state is wired", async () => {
    const store = makeStore({ model: "grok-4-fast" });
    const setToolJSX = vi.fn();
    const r = await configCommand.execute(
      stubCtx({
        configStore: store,
        appState: { setToolJSX },
      }),
    );

    expect(r.kind).toBe("skip");
    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({
        isLocalJSXCommand: true,
        shouldHidePromptInput: true,
        jsx: expect.anything(),
      }),
    );
  });

  it("does not retain the retired /settings command alias", () => {
    expect(configCommand.aliases).toBeUndefined();
  });

  it("'show' is an explicit alias", async () => {
    const store = makeStore();
    const r = await configCommand.execute(
      stubCtx({ configStore: store, argsRaw: "show" }),
    );
    expect(r.kind).toBe("text");
  });

  it("errors when no config store is wired", async () => {
    const r = await configCommand.execute(stubCtx({}));
    expect(r.kind).toBe("error");
  });

  it("errors on unknown subcommand", async () => {
    const store = makeStore();
    const r = await configCommand.execute(
      stubCtx({ configStore: store, argsRaw: "launch-the-rockets" }),
    );
    expect(r.kind).toBe("error");
  });
});

describe("config menu snapshot", () => {
  it("summarizes core settings for the v2 menu", () => {
    const store = makeStore({
      model: "grok-4-fast",
      model_provider: "grok",
      mcp_servers: {
        local: { command: "agenc-mcp" },
      },
      profiles: {
        dev: { model: "grok-dev" },
      },
    });
    const snapshot = readConfigMenuSnapshot(stubCtx({ configStore: store }));
    expect(snapshot.configPath).toBe("/home/test/.agenc/config.toml");
    expect(
      snapshot.rows.some(
        row => row.key === "session model" && row.value === "grok-4-fast",
      ),
    ).toBe(true);
    expect(snapshot.rows.filter(row => row.key.includes("model"))).toHaveLength(1);
    expect(
      snapshot.rows.some(
        row => row.key === "mcp server" && row.detail.includes("local"),
      ),
    ).toBe(true);
    expect(
      snapshot.rows.some(
        row => row.key === "profiles" && row.detail.includes("dev"),
      ),
    ).toBe(true);
  });

  it("separates a pending session selection from configured startup settings", () => {
    const store = makeStore({
      model: "grok-4.5",
      model_provider: "grok",
    });
    const session = stubSession() as unknown as {
      sessionConfiguration: {
        provider: { slug: string };
        collaborationMode: { model: string };
      };
    };
    session.sessionConfiguration = {
      provider: { slug: "grok" },
      collaborationMode: { model: "grok-4.5" },
    };
    (session as unknown as StubSession).setPendingProviderSwitch({
      provider: "grok",
      model: "grok-4.6",
    });

    const snapshot = readConfigMenuSnapshot(stubCtx({
      configStore: store,
      session: session as unknown as Session,
    }));
    const modelRows = snapshot.rows.filter(row => row.key.includes("model"));

    expect(modelRows).toEqual([
      expect.objectContaining({
        key: "session model",
        value: "grok-4.6",
        status: "active",
        detail: expect.stringContaining("grok"),
      }),
      expect.objectContaining({
        key: "configured model",
        value: "grok-4.5",
        status: "configured",
        detail: expect.stringContaining("grok"),
      }),
    ]);
  });
});

describe("config menu — effective buffer editor settings", () => {
  it("shows the persisted editor settings when no process override is active", () => {
    expect(effectiveBufferEditorConfig({
      provider: "inline",
      neovim: {
        executable: "/opt/nvim/bin/nvim",
        init: "clean",
        discovery_timeout_ms: 900,
      },
    }, {})).toEqual({
      provider: "inline",
      init: "clean",
      executable: "/opt/nvim/bin/nvim",
      discoveryTimeoutMs: 900,
      environmentOverrides: [],
    });
  });

  it("reports the exact process settings that override the editor config", () => {
    expect(effectiveBufferEditorConfig({
      provider: "inline",
      neovim: {
        executable: "/persisted/nvim",
        init: "clean",
        discovery_timeout_ms: 900,
      },
    }, {
      AGENC_BUFFER_PROVIDER: "neovim",
      AGENC_BUFFER_NVIM: "/environment/nvim",
      AGENC_BUFFER_NVIM_USE_INIT: "true",
      AGENC_BUFFER_NVIM_TIMEOUT_MS: "2750",
    })).toEqual({
      provider: "neovim",
      init: "user",
      executable: "/environment/nvim",
      discoveryTimeoutMs: 2750,
      environmentOverrides: [
        "AGENC_BUFFER_PROVIDER",
        "AGENC_BUFFER_NVIM",
        "AGENC_BUFFER_NVIM_USE_INIT",
        "AGENC_BUFFER_NVIM_TIMEOUT_MS",
      ],
    });
  });
});

describe("configCommand — get", () => {
  it("'get model' returns the model slug", async () => {
    const store = makeStore({ model: "grok-4-beta" });
    const r = await configCommand.execute(
      stubCtx({ configStore: store, argsRaw: "get model" }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toBe("grok-4-beta");
  });

  it("'get nonexistent.key' returns 'not set'", async () => {
    const store = makeStore();
    const r = await configCommand.execute(
      stubCtx({ configStore: store, argsRaw: "get nonexistent.deep.key" }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toMatch(/^not set/);
  });
});

describe("configCommand — reload", () => {
  it("calls ConfigStore.reload and reports the new model", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-cfg-"));
    try {
      writeFileSync(join(tmp, "config.toml"), 'config_version = 2\nmodel = "grok-4-reloaded"\n');
      const store = new ConfigStore({ home: tmp });
      const r = await configCommand.execute(
        stubCtx({ configStore: store, argsRaw: "reload", home: tmp }),
      );
      if (r.kind !== "text") throw new Error(`expected text, got ${r.kind}`);
      expect(r.text).toMatch(/Config reloaded/);
      expect(r.text).toContain("grok-4-reloaded");
      expect(store.current().model).toBe("grok-4-reloaded");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refreshes MCP after reload when the session service is wired", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-cfg-"));
    try {
      writeFileSync(join(tmp, "config.toml"), 'config_version = 2\nmodel = "grok-4-reloaded"\n');
      const store = new ConfigStore({ home: tmp });
      const refreshFromAuthority = vi.fn().mockResolvedValue({
        configuredServers: ["github"],
        requiredServers: ["github"],
      });
      const session = stubSession();
      (session as unknown as StubSession).services = {
        mcpManager: { refreshFromAuthority },
      };

      const r = await configCommand.execute(
        stubCtx({ configStore: store, argsRaw: "reload", home: tmp, session }),
      );

      if (r.kind !== "text") throw new Error(`expected text, got ${r.kind}`);
      expect(refreshFromAuthority).toHaveBeenCalledWith();
      expect(r.text).toContain("MCP refreshed (1 configured, 1 required)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores array-shaped MCP manager services after reload", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-cfg-"));
    try {
      writeFileSync(join(tmp, "config.toml"), 'config_version = 2\nmodel = "grok-4-reloaded"\n');
      const store = new ConfigStore({ home: tmp });
      const refreshFromAuthority = vi.fn().mockResolvedValue({
        configuredServers: ["github"],
        requiredServers: ["github"],
      });
      const session = stubSession();
      (session as unknown as StubSession).services = {
        mcpManager: Object.assign(["spoof"], { refreshFromAuthority }),
      };

      const r = await configCommand.execute(
        stubCtx({ configStore: store, argsRaw: "reload", home: tmp, session }),
      );

      if (r.kind !== "text") throw new Error(`expected text, got ${r.kind}`);
      expect(refreshFromAuthority).not.toHaveBeenCalled();
      expect(r.text).toContain("Config reloaded");
      expect(r.text).not.toContain("MCP refreshed");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("re-applies the reloaded config to the daemon and folds in its summary", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-cfg-"));
    try {
      writeFileSync(join(tmp, "config.toml"), 'config_version = 2\nmodel = "grok-4-reloaded"\n');
      const store = new ConfigStore({ home: tmp });
      const applyDaemonConfig = vi.fn(async () => ({
        applied: true,
        summary: "config reload applied: config reloaded from disk",
      }));
      const session = Object.assign(stubSession(), { applyDaemonConfig });
      const r = await configCommand.execute(
        stubCtx({
          configStore: store,
          argsRaw: "reload",
          home: tmp,
          session: session as unknown as Session,
        }),
      );
      if (r.kind !== "text") throw new Error(`expected text, got ${r.kind}`);
      expect(applyDaemonConfig).toHaveBeenCalledWith({ reload: true });
      expect(r.text).toContain("Config reloaded");
      expect(r.text).toContain(
        "Daemon: config reload applied: config reloaded from disk",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does NOT call the daemon forwarder on reload for the in-process path", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-cfg-"));
    try {
      writeFileSync(join(tmp, "config.toml"), 'config_version = 2\nmodel = "grok-4-reloaded"\n');
      const store = new ConfigStore({ home: tmp });
      const applyDaemonConfig = vi.fn();
      // In-process session: no applyDaemonConfig forwarder.
      const session = stubSession();
      const r = await configCommand.execute(
        stubCtx({ configStore: store, argsRaw: "reload", home: tmp, session }),
      );
      if (r.kind !== "text") throw new Error(`expected text, got ${r.kind}`);
      expect(applyDaemonConfig).not.toHaveBeenCalled();
      expect(r.text).not.toContain("Daemon:");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns an error when the daemon reload apply fails", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-cfg-"));
    try {
      writeFileSync(join(tmp, "config.toml"), 'config_version = 2\nmodel = "grok-4-reloaded"\n');
      const store = new ConfigStore({ home: tmp });
      const applyDaemonConfig = vi.fn(async () => {
        throw new Error("socket closed");
      });
      const session = Object.assign(stubSession(), { applyDaemonConfig });
      const r = await configCommand.execute(
        stubCtx({
          configStore: store,
          argsRaw: "reload",
          home: tmp,
          session: session as unknown as Session,
        }),
      );
      expect(r.kind).toBe("error");
      if (r.kind !== "error") throw new Error("expected error");
      expect(r.message).toContain(
        "Config reloaded client-side, but daemon apply failed",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports MCP refresh failure after config reload", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-cfg-"));
    try {
      writeFileSync(join(tmp, "config.toml"), 'config_version = 2\nmodel = "grok-4-reloaded"\n');
      const store = new ConfigStore({ home: tmp });
      const refreshFromAuthority = vi
        .fn()
        .mockRejectedValue(new Error("required server missing"));
      const session = stubSession();
      (session as unknown as StubSession).services = {
        mcpManager: { refreshFromAuthority },
      };

      const r = await configCommand.execute(
        stubCtx({ configStore: store, argsRaw: "reload", home: tmp, session }),
      );

      expect(r.kind).toBe("error");
      if (r.kind !== "error") throw new Error("expected error");
      expect(r.message).toContain("Config reloaded, but MCP refresh failed");
      expect(r.message).toContain("required server missing");
      expect(store.current().model).toBe("grok-4-reloaded");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects invalid canonical config during reload", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-cfg-"));
    try {
      writeFileSync(
        join(tmp, "config.toml"),
        `config_version = 2

[auth.managedKeys]
enabled = "yes"
        `,
      );
      const store = new ConfigStore({ home: tmp, env: {} });
      const r = await configCommand.execute(
        stubCtx({ configStore: store, argsRaw: "reload", home: tmp }),
      );
      if (r.kind !== "error") throw new Error(`expected error, got ${r.kind}`);
      expect(r.message).toContain("Invalid auth.managedKeys.enabled");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("configCommand — profile", () => {
  it("with no arg shows default when no profile staged", async () => {
    const store = makeStore({
      profiles: { dev: { model: "grok-dev" }, prod: { model: "grok-prod" } },
    });
    const r = await configCommand.execute(
      stubCtx({ configStore: store, argsRaw: "profile" }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toContain("Active profile: (default)");
    expect(r.text).toContain("dev");
    expect(r.text).toContain("prod");
  });

  it("shows staged profile after switch", async () => {
    const store = makeStore({
      profiles: { dev: { model: "grok-dev" } },
    });
    const session = stubSession();
    const ctx = stubCtx({ configStore: store, argsRaw: "profile dev", session });
    const r1 = await configCommand.execute(ctx);
    expect(r1.kind).toBe("text");
    const staged = (session as unknown as {
      pendingProviderSwitch: { profile?: string };
    }).pendingProviderSwitch;
    expect(staged?.profile).toBe("dev");
    // Now query with no arg.
    const r2 = await configCommand.execute(
      stubCtx({ configStore: store, argsRaw: "profile", session }),
    );
    if (r2.kind !== "text") throw new Error("expected text");
    expect(r2.text).toContain("Active profile: dev");
  });

  it("'profile <name>' stages pendingProviderSwitch with profile", async () => {
    const store = makeStore({
      profiles: {
        dev: { model: "grok-dev", model_provider: "grok" },
      },
    });
    const session = stubSession();
    const r = await configCommand.execute(
      stubCtx({ configStore: store, argsRaw: "profile dev", session }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toMatch(/staged/);
    const staged = (session as unknown as {
      pendingProviderSwitch: {
        provider: string;
        model: string;
        profile?: string;
      };
    }).pendingProviderSwitch;
    expect(staged.profile).toBe("dev");
    expect(staged.model).toBe("grok-dev");
    expect(staged.provider).toBe("grok");
  });

  it("resolves a provider-only profile without mixing the prior model", async () => {
    const store = makeStore({
      profiles: {
        remote: { model_provider: "openai" },
      },
    });
    const session = stubSession();
    session.setPendingProviderSwitch({
      provider: "grok",
      model: "grok-4.3",
    });

    const result = await configCommand.execute(
      stubCtx({
        configStore: store,
        argsRaw: "profile remote",
        session,
      }),
    );

    expect(result.kind).toBe("text");
    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({
      provider: "openai",
      model: "gpt-5",
      profile: "remote",
    });
  });

  it("stages the same config-based pair that profile consumption will apply", async () => {
    const store = makeStore({
      model_provider: "openai",
      model: "gpt-5-mini",
      profiles: {
        strict: { reasoning_effort: "low" },
      },
    });
    const session = stubSession();
    session.setPendingProviderSwitch({
      provider: "grok",
      model: "grok-4.3",
    });

    await configCommand.execute(
      stubCtx({
        configStore: store,
        argsRaw: "profile strict",
        session,
      }),
    );

    expect(
      (session as unknown as { pendingProviderSwitch: unknown })
        .pendingProviderSwitch,
    ).toEqual({
      provider: "openai",
      model: "gpt-5-mini",
      profile: "strict",
    });
  });

  it("'profile unknown' returns an error", async () => {
    const store = makeStore({ profiles: { dev: { model: "grok-dev" } } });
    const r = await configCommand.execute(
      stubCtx({ configStore: store, argsRaw: "profile whatever" }),
    );
    expect(r.kind).toBe("error");
  });

  it("'profile' when no profiles declared shows 'no profiles' note", async () => {
    const store = makeStore({});
    const r = await configCommand.execute(
      stubCtx({ configStore: store, argsRaw: "profile" }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toMatch(/no profiles declared/);
  });

  it("re-applies the profile to the daemon when the bridge forwarder is present", async () => {
    const store = makeStore({ profiles: { dev: { model: "grok-dev" } } });
    const applyDaemonConfig = vi.fn(async () => ({
      applied: true,
      summary: "profile dev applied: model base->grok-dev",
    }));
    const session = Object.assign(stubSession(), { applyDaemonConfig });
    const stage = vi.spyOn(session, "setPendingProviderSwitch");
    const r = await configCommand.execute(
      stubCtx({
        configStore: store,
        argsRaw: "profile dev",
        session: session as unknown as Session,
      }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    // The daemon transaction is the only mutation path.
    expect(r.text).toBe("profile dev applied: model base->grok-dev");
    expect(applyDaemonConfig).toHaveBeenCalledWith({ profile: "dev" });
    expect(stage).not.toHaveBeenCalled();
  });

  it("does NOT call the daemon forwarder on the in-process path", async () => {
    const store = makeStore({ profiles: { dev: { model: "grok-dev" } } });
    const applyDaemonConfig = vi.fn();
    // In-process Session has no applyDaemonConfig forwarder.
    const session = stubSession();
    const r = await configCommand.execute(
      stubCtx({ configStore: store, argsRaw: "profile dev", session }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toMatch(/staged/);
    expect(applyDaemonConfig).not.toHaveBeenCalled();
  });

  it("returns an error when the daemon profile apply fails", async () => {
    const store = makeStore({ profiles: { dev: { model: "grok-dev" } } });
    const applyDaemonConfig = vi.fn(async () => {
      throw new Error("socket closed");
    });
    const session = Object.assign(stubSession(), { applyDaemonConfig });
    const r = await configCommand.execute(
      stubCtx({
        configStore: store,
        argsRaw: "profile dev",
        session: session as unknown as Session,
      }),
    );
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("expected error");
    expect(r.message).toContain("Profile apply failed");
  });
});

describe("configCommand — path", () => {
  it("prints the config.toml path under ctx.agencHome when provided", async () => {
    const store = makeStore();
    const r = await configCommand.execute(
      stubCtx({
        configStore: store,
        argsRaw: "path",
        home: "/home/alice",
        agencHome: "/tmp/my-agenc",
      }),
    );
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toBe("/tmp/my-agenc/config.toml");
  });
});

describe("configCommand — edit", () => {
  it("spawns the editor when config.toml exists and returns success", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-cfg-"));
    try {
      writeFileSync(
        join(tmp, "config.toml"),
        'config_version = 2\nmodel = "grok-4.6"\n',
      );
      const spawner = vi.fn().mockResolvedValue(0);
      const cmd = createConfigCommand({
        env: { EDITOR: "myedit" } as NodeJS.ProcessEnv,
        spawner,
      });
      const store = makeStore();
      const r = await cmd.execute(
        stubCtx({ configStore: store, argsRaw: "edit", agencHome: tmp }),
      );
      if (r.kind !== "text") throw new Error("expected text");
      expect(spawner).toHaveBeenCalledTimes(1);
      expect(spawner.mock.calls[0]![0]).toBe("myedit");
      expect(spawner.mock.calls[0]![1]).toHaveLength(1);
      expect(spawner.mock.calls[0]![1][0]).toMatch(
        /\/\.agenc-config-edit-[^/]+\/config\.toml$/u,
      );
      expect(r.text).toMatch(/reload to apply/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("edit on missing config.toml uses a private canonical snapshot", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-cfg-"));
    try {
      const spawner = vi.fn().mockResolvedValue(0);
      const cmd = createConfigCommand({
        env: { EDITOR: "myedit" } as NodeJS.ProcessEnv,
        spawner,
      });
      const store = makeStore();
      const r = await cmd.execute(
        stubCtx({ configStore: store, argsRaw: "edit", agencHome: tmp }),
      );
      if (r.kind !== "text") throw new Error("expected text");
      expect(spawner).toHaveBeenCalledOnce();
      expect(spawner.mock.calls[0]![1][0]).toMatch(
        /\/\.agenc-config-edit-[^/]+\/config\.toml$/u,
      );
      expect(r.text).toMatch(/reload to apply/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("edit reports an error when the editor exits non-zero", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agenc-cfg-"));
    try {
      writeFileSync(join(tmp, "config.toml"), "config_version = 2\n");
      const spawner = vi.fn().mockResolvedValue(2);
      const cmd = createConfigCommand({
        env: { EDITOR: "broken" } as NodeJS.ProcessEnv,
        spawner,
      });
      const store = makeStore();
      const r = await cmd.execute(
        stubCtx({ configStore: store, argsRaw: "edit", agencHome: tmp }),
      );
      expect(r.kind).toBe("error");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("configCommand — services.configStore fallback", () => {
  it("uses session.services.configStore when ctx.configStore is absent", async () => {
    const store = makeStore({ model: "via-services" });
    const session = stubSession();
    (session as unknown as { services: Record<string, unknown> }).services = {
      configStore: store,
    };
    const r = await configCommand.execute(stubCtx({ session, argsRaw: "get model" }));
    if (r.kind !== "text") throw new Error("expected text");
    expect(r.text).toBe("via-services");
  });

  it("ignores array-shaped session.services.configStore fallback", async () => {
    const current = vi.fn(() => makeStore({ model: "spoofed" }).current());
    const session = stubSession();
    (session as unknown as { services: Record<string, unknown> }).services = {
      configStore: Object.assign(["spoof"], { current }),
    };

    const r = await configCommand.execute(
      stubCtx({ session, argsRaw: "get model" }),
    );

    expect(r.kind).toBe("error");
    expect(current).not.toHaveBeenCalled();
  });
});

// guard against unused mkdirSync import warning in environments where the
// removal tests above don't exercise it.
void mkdirSync;
