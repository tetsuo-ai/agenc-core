import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

import { CommandRegistry, buildDefaultRegistry } from "./registry.js";
import type { SlashCommand, SlashCommandResult } from "./types.js";

const MINIMAL_REGISTRY_NAMES = [
  "help",
  "status",
  "login",
  "logout",
  "whoami",
  "subscription",
  "usage",
  "cost",
  "model",
  "provider",
  "permissions",
  "plan",
  "agents",
  "tasks",
  "config",
  "hooks",
  "skills",
  "mcp",
  "remote",
  "plugins",
  "memory",
  "resume",
  "init",
  "output-style",
  "output-style:new",
  "clear",
  "compact",
  "context",
  "diff",
  "claim",
  "delegate",
  "proof",
  "settle",
  "stake",
  "exit",
] as const;

const DAEMON_TUI_REGISTRY_NAMES = [
  "help",
  "status",
  "login",
  "logout",
  "whoami",
  "subscription",
  "usage",
  "cost",
  "model",
  "provider",
  "permissions",
  "plan",
  "agents",
  "tasks",
  "config",
  "hooks",
  "skills",
  "mcp",
  "remote",
  "plugins",
  "memory",
  "resume",
  "init",
  "output-style",
  "output-style:new",
  "clear",
  "compact",
  "context",
  "diff",
  "claim",
  "delegate",
  "proof",
  "settle",
  "stake",
  "exit",
] as const;

const REMOVED_TUI_COMMANDS = [
  "add-dir",
  "branch",
  "brief",
  "cache-stats",
  "color",
  "commit",
  "copy",
  "doctor",
  "effort",
  "enter-worktree",
  "exit-worktree",
  "export",
  "files",
  "fork",
  "heapdump",
  "ide",
  "install",
  "install-github-app",
  "keybindings",
  "knowledge",
  "onboard-github",
  "pr-comments",
  "release-notes",
  "reload-plugins",
  "rename",
  "review",
  "rewind",
  "sandbox",
  "terminal-setup",
  "theme",
  "vim",
  "wiki",
] as const;

function mkCmd(name: string, aliases?: readonly string[]): SlashCommand {
  return {
    name,
    ...(aliases !== undefined ? { aliases } : {}),
    description: `test ${name}`,
    execute: async () => ({ kind: "text", text: name } satisfies SlashCommandResult),
  };
}

describe("CommandRegistry", () => {
  let reg: CommandRegistry;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reg = new CommandRegistry();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("finds registered commands by name or alias case-insensitively", () => {
    const status = mkCmd("status", ["stat", "s"]);
    reg.register(status);

    expect(reg.find("status")).toBe(status);
    expect(reg.find("STATUS")).toBe(status);
    expect(reg.find("stat")).toBe(status);
    expect(reg.has("s")).toBe(true);
    expect(reg.has("missing")).toBe(false);
  });

  it("keeps registration order in list snapshots", () => {
    reg.register(mkCmd("zeta"));
    const first = reg.list();
    reg.register(mkCmd("alpha"));

    expect(first.map((command) => command.name)).toEqual(["zeta"]);
    expect(reg.list().map((command) => command.name)).toEqual([
      "zeta",
      "alpha",
    ]);
  });

  it("throws on duplicate names and name/alias collisions", () => {
    reg.register(mkCmd("status", ["stat"]));

    expect(() => reg.register(mkCmd("STATUS"))).toThrow(/duplicate/i);
    expect(() => reg.register(mkCmd("stat"))).toThrow(/existing alias/i);
    expect(() => reg.register(mkCmd("search", ["status"]))).toThrow(
      /existing command name/i,
    );
  });

  it("drops alias-to-alias collisions without replacing the first owner", () => {
    const first = mkCmd("status", ["s"]);
    const second = mkCmd("search", ["s"]);

    reg.register(first);
    reg.register(second);

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(reg.find("s")).toBe(first);
    expect(reg.find("search")).toBe(second);
  });

  it("builds the exact minimal runtime slash surface", () => {
    const names = buildDefaultRegistry().list().map((command) => command.name);

    expect(names).toEqual(MINIMAL_REGISTRY_NAMES);
  });

  it("builds the daemon TUI surface from the unified slash palette", () => {
    const registry = buildDefaultRegistry({ surface: "daemon-tui" });

    expect(registry.list().map((command) => command.name)).toEqual(
      DAEMON_TUI_REGISTRY_NAMES,
    );
    for (const name of ["model", "provider", "hooks", "compact", "ctx"]) {
      expect(registry.has(name), `/${name} should dispatch in daemon TUI`).toBe(
        true,
      );
    }
  });

  it("registers protocol commands as the bundled agenc-core plugin surface", () => {
    const registry = buildDefaultRegistry({ surface: "daemon-tui" });

    for (const name of ["claim", "delegate", "proof", "settle", "stake"]) {
      const command = registry.find(name);

      expect(command, `/${name} should be registered`).toBeDefined();
      expect(command?.kind).toBe("protocol");
      expect(command?.source).toBe("plugin");
      expect(command?.loadedFrom).toBe("plugin");
      expect(command?.pluginInfo?.pluginManifest?.name).toBe("agenc-core");
      expect(command?.supportedSurfaces).toEqual(["runtime", "daemon-tui"]);
      expect(command?.immediate).toBe(true);
    }
  });

  it("keeps only expected aliases for retained commands", () => {
    const registry = buildDefaultRegistry();

    expect(registry.has("provider")).toBe(true);
    expect(registry.has("login")).toBe(true);
    expect(registry.has("logout")).toBe(true);
    expect(registry.find("account")?.name).toBe("whoami");
    expect(registry.find("provider")?.name).toBe("provider");
    expect(registry.has("quit")).toBe(true);
    expect(registry.has("reset")).toBe(true);
    expect(registry.has("approvals")).toBe(true);
    expect(registry.find("ctx")?.name).toBe("context");
  });

  it("does not register removed TUI slash commands", () => {
    const registry = buildDefaultRegistry();

    for (const name of REMOVED_TUI_COMMANDS) {
      expect(registry.has(name), `/${name} should not be registered`).toBe(false);
    }
  });
});
