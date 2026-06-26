import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

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
  "plugins",
  "memory",
  "resume",
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

const DAEMON_TUI_NAMES = [
  "help",
  "status",
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
  "plugins",
  "memory",
  "resume",
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

const REMOVED_TUI_NAMES = [
  "add-dir",
  "brief",
  "color",
  "commit",
  "copy",
  "doctor",
  "export",
  "files",
  "fork",
  "heapdump",
  "ide",
  "init",
  "install-github-app",
  "keybindings",
  "onboard-github",
  "release-notes",
  "reload-plugins",
  "review",
  "rewind",
  "sandbox",
  "terminal-setup",
  "theme",
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
    for (const name of ["model", "provider", "hooks", "compact", "context"]) {
      expect(names).toContain(name);
    }
  });

  it("preserves aliases on retained commands", () => {
    const projected = new Map(listTuiCommandList().map((cmd) => [cmd.name, cmd]));

    expect(projected.get("provider")?.aliases).toBeUndefined();
    expect(projected.get("permissions")?.aliases).toEqual([
      "approvals",
      "allowed-tools",
    ]);
    expect(projected.get("clear")?.aliases).toEqual([
      "reset",
      "new",
    ]);
    expect(projected.get("tasks")?.aliases).toEqual(["jobs", "bashes"]);
    expect(projected.get("plugins")?.aliases).toEqual(["plugin", "marketplace"]);
    expect(projected.get("resume")?.aliases).toEqual(["sessions"]);
    expect(projected.get("context")?.aliases).toEqual(["ctx"]);
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
    expect(names.has("plugins")).toBe(true);
    expect(names.has("plugin")).toBe(true);
    expect(names.has("memory")).toBe(true);
    expect(names.has("resume")).toBe(true);
    expect(names.has("agents")).toBe(true);
    expect(names.has("tasks")).toBe(true);
    expect(names.has("bashes")).toBe(true);
    expect(names.has("plan")).toBe(true);
    expect(names.has("context")).toBe(true);
    expect(names.has("ctx")).toBe(true);
  });

  it("remote-mode filtering cannot reintroduce removed commands", () => {
    const remoteNames = filterCommandsForRemoteMode(getCommandsSync()).map(
      (cmd) => cmd.name,
    );

    expect(remoteNames).toEqual([
      "help",
      "status",
      "model",
      "provider",
      "clear",
      "exit",
    ]);
  });

  it("does not leave legacy local-jsx command specs under runtime commands", () => {
    const commandsRoot = resolve(process.cwd(), "src", "commands");
    const offenders: string[] = [];

    for (const file of commandSourceFiles(commandsRoot)) {
      const source = readFileSync(file, "utf8");
      if (/type:\s*['"]local-jsx['"]/.test(source)) {
        offenders.push(file.replace(`${commandsRoot}/`, ""));
      }
    }

    expect(offenders).toEqual([]);
  });
});

function commandSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...commandSourceFiles(path));
    } else if (
      (path.endsWith(".ts") || path.endsWith(".tsx")) &&
      !path.endsWith(".test.ts") &&
      !path.endsWith(".test.tsx")
    ) {
      out.push(path);
    }
  }
  return out;
}
