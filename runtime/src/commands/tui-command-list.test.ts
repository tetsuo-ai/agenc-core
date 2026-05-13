import { describe, expect, it, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

import { buildDefaultRegistry } from "./registry.js";
import {
  builtInCommandNames,
  filterCommandsForRemoteMode,
  getCommandsSync,
  listTuiCommandList,
} from "../commands.js";

const MINIMAL_TUI_NAMES = [
  "help",
  "status",
  "model",
  "model-provider",
  "permissions",
  "plan",
  "agents",
  "config",
  "hooks",
  "skills",
  "mcp",
  "clear",
  "compact",
  "diff",
  "exit",
] as const;

const DAEMON_TUI_NAMES = [
  "help",
  "status",
  "permissions",
  "plan",
  "agents",
  "config",
  "skills",
  "mcp",
  "clear",
  "diff",
  "exit",
] as const;

const REMOVED_TUI_NAMES = [
  "commit",
  "context",
  "copy",
  "cost",
  "doctor",
  "files",
  "fork",
  "heapdump",
  "init",
  "keybindings",
  "memory",
  "plugin",
  "release-notes",
  "reload-plugins",
  "resume",
  "review",
  "rewind",
  "stats",
  "usage",
  "wiki",
] as const;

describe("listTuiCommandList (minimal runtime slash surface)", () => {
  it("returns exactly the retained TUI slash commands in registry order", () => {
    expect(listTuiCommandList().map((cmd) => cmd.name)).toEqual(
      MINIMAL_TUI_NAMES,
    );
  });

  it("projects only local runtime dispatcher commands", () => {
    for (const cmd of listTuiCommandList()) {
      expect(cmd.type).toBe("local");
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
    }
  });

  it("matches the visible subset of buildDefaultRegistry", () => {
    const expected = buildDefaultRegistry()
      .list()
      .filter(
        (cmd) =>
          cmd.userInvocable !== false &&
          (cmd as { isHidden?: boolean }).isHidden !== true &&
          (cmd.isEnabled?.() ?? true),
      )
      .map((cmd) => cmd.name);

    expect(listTuiCommandList().map((cmd) => cmd.name)).toEqual(expected);
  });

  it("lists only daemon-supported commands when passed the daemon TUI registry", () => {
    const registry = buildDefaultRegistry({ surface: "daemon-tui" });
    const names = listTuiCommandList(registry).map((cmd) => cmd.name);

    expect(names).toEqual(DAEMON_TUI_NAMES);
    for (const name of ["model", "model-provider", "hooks", "compact"]) {
      expect(names).not.toContain(name);
    }
  });

  it("preserves aliases on retained commands", () => {
    const projected = new Map(listTuiCommandList().map((cmd) => [cmd.name, cmd]));

    expect(projected.get("model-provider")?.aliases).toEqual(["provider"]);
    expect(projected.get("permissions")?.aliases).toEqual([
      "approvals",
      "allowed-tools",
    ]);
    expect(projected.get("clear")?.aliases).toEqual([
      "reset",
      "new",
    ]);
    expect(projected.get("exit")?.aliases).toEqual(["quit"]);
  });

  it("does not include removed or legacy command surfaces", () => {
    const names = new Set(listTuiCommandList().map((cmd) => cmd.name));
    for (const name of REMOVED_TUI_NAMES) {
      expect(names.has(name), `/${name} should not be in the palette`).toBe(false);
    }
  });

  it("builtInCommandNames reflects the same minimal command names and aliases", () => {
    const names = builtInCommandNames();

    for (const name of MINIMAL_TUI_NAMES) expect(names.has(name)).toBe(true);
    expect(names.has("provider")).toBe(true);
    expect(names.has("quit")).toBe(true);
    expect(names.has("reload-plugins")).toBe(false);
    expect(names.has("history")).toBe(false);
    expect(names.has("agents")).toBe(true);
    expect(names.has("plan")).toBe(true);
  });

  it("remote-mode filtering cannot reintroduce removed commands", () => {
    const remoteNames = filterCommandsForRemoteMode(getCommandsSync()).map(
      (cmd) => cmd.name,
    );

    expect(remoteNames).toEqual([
      "help",
      "status",
      "model",
      "model-provider",
      "clear",
      "exit",
    ]);
  });
});
