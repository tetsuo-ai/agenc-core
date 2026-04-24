import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry, buildDefaultRegistry } from "./registry.js";
import type {
  SlashCommand,
  SlashCommandContext,
  SlashCommandResult,
} from "./types.js";

function mkCmd(
  name: string,
  aliases?: readonly string[],
  userInvocable?: boolean,
): SlashCommand {
  const cmd: SlashCommand = {
    name,
    description: `test ${name}`,
    execute: async () => ({ kind: "text", text: name } satisfies SlashCommandResult),
  };
  if (aliases !== undefined) {
    (cmd as { aliases?: readonly string[] }).aliases = aliases;
  }
  if (userInvocable !== undefined) {
    (cmd as { userInvocable?: boolean }).userInvocable = userInvocable;
  }
  return cmd;
}

describe("CommandRegistry — basic register/find/has", () => {
  let reg: CommandRegistry;
  beforeEach(() => {
    reg = new CommandRegistry();
  });

  it("register + find by name", () => {
    const help = mkCmd("help");
    reg.register(help);
    expect(reg.find("help")).toBe(help);
  });

  it("find returns undefined for unknown name", () => {
    expect(reg.find("nope")).toBeUndefined();
  });

  it("find by alias", () => {
    const status = mkCmd("status", ["stat", "s"]);
    reg.register(status);
    expect(reg.find("stat")).toBe(status);
    expect(reg.find("s")).toBe(status);
  });

  it("find is case-insensitive", () => {
    const help = mkCmd("help");
    reg.register(help);
    expect(reg.find("HELP")).toBe(help);
    expect(reg.find("Help")).toBe(help);
  });

  it("has() returns true for registered name and alias", () => {
    reg.register(mkCmd("help", ["h"]));
    expect(reg.has("help")).toBe(true);
    expect(reg.has("h")).toBe(true);
    expect(reg.has("HELP")).toBe(true);
  });

  it("has() returns false for unknown", () => {
    expect(reg.has("nope")).toBe(false);
  });
});

describe("CommandRegistry — collision policy", () => {
  let reg: CommandRegistry;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    reg = new CommandRegistry();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("throws on duplicate name", () => {
    reg.register(mkCmd("status"));
    expect(() => reg.register(mkCmd("status"))).toThrow(
      /duplicate command name/i,
    );
  });

  it("throws on duplicate name (case-insensitive)", () => {
    reg.register(mkCmd("status"));
    expect(() => reg.register(mkCmd("STATUS"))).toThrow(
      /duplicate command name/i,
    );
  });

  it("throws when a new command name collides with an existing alias", () => {
    reg.register(mkCmd("status", ["help"]));
    expect(() => reg.register(mkCmd("help"))).toThrow(
      /collides with existing alias/i,
    );
  });

  it("throws when a new alias collides with an existing command name", () => {
    reg.register(mkCmd("help"));
    expect(() => reg.register(mkCmd("status", ["help"]))).toThrow(
      /collides with existing command name/i,
    );
  });

  it("warns + drops the colliding alias (first-registered wins)", () => {
    const first = mkCmd("status", ["s"]);
    const second = mkCmd("search", ["s"]);
    reg.register(first);
    reg.register(second);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(reg.find("s")).toBe(first);
    expect(reg.has("search")).toBe(true);
  });

  it("rolls back partial registration on alias-name collision", () => {
    reg.register(mkCmd("help"));
    expect(() => reg.register(mkCmd("status", ["help", "x"]))).toThrow();
    // status itself must NOT have been registered because its alias was invalid
    expect(reg.has("status")).toBe(false);
    // and the attempted-but-rolled-back alias "x" must also be absent
    expect(reg.has("x")).toBe(false);
  });
});

describe("CommandRegistry — list()", () => {
  it("returns commands in registration order", () => {
    const reg = new CommandRegistry();
    reg.register(mkCmd("zeta"));
    reg.register(mkCmd("alpha"));
    reg.register(mkCmd("mu"));
    const names = reg.list().map((c) => c.name);
    expect(names).toEqual(["zeta", "alpha", "mu"]);
  });

  it("returns a stable snapshot (does not expose internal Map)", () => {
    const reg = new CommandRegistry();
    reg.register(mkCmd("a"));
    const snap1 = reg.list();
    reg.register(mkCmd("b"));
    const snap2 = reg.list();
    // snap1 must not have been mutated by the later register()
    expect(snap1.map((c) => c.name)).toEqual(["a"]);
    expect(snap2.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("returns an empty array for an empty registry", () => {
    expect(new CommandRegistry().list()).toEqual([]);
  });
});

describe("CommandRegistry — fromCommands()", () => {
  it("registers every command in order", () => {
    const reg = CommandRegistry.fromCommands([
      mkCmd("a"),
      mkCmd("b", ["bb"]),
    ]);
    expect(reg.has("a")).toBe(true);
    expect(reg.has("b")).toBe(true);
    expect(reg.has("bb")).toBe(true);
  });

  it("propagates registration errors", () => {
    expect(() =>
      CommandRegistry.fromCommands([mkCmd("dup"), mkCmd("dup")]),
    ).toThrow(/duplicate/i);
  });
});

describe("buildDefaultRegistry()", () => {
  it("includes help and status", () => {
    const reg = buildDefaultRegistry();
    expect(reg.has("help")).toBe(true);
    expect(reg.has("status")).toBe(true);
  });

  it("exposes codex-facing aliases like /provider and /approvals", () => {
    const reg = buildDefaultRegistry();
    expect(reg.has("provider")).toBe(true);
    expect(reg.has("approvals")).toBe(true);
  });

  it("includes the worktree adapters", () => {
    const reg = buildDefaultRegistry();
    expect(reg.has("enter-worktree")).toBe(true);
    expect(reg.has("exit-worktree")).toBe(true);
  });

  it("includes the post-T13 command surfaces", () => {
    const reg = buildDefaultRegistry();
    expect(reg.has("copy")).toBe(true);
    expect(reg.has("mcp")).toBe(true);
    expect(reg.has("skills")).toBe(true);
  });

  it("returns the curated presentation order", () => {
    const reg = buildDefaultRegistry();
    const names = reg.list().map((c) => c.name);
    expect(names.slice(0, 4)).toEqual([
      "model",
      "model-provider",
      "permissions",
      "config",
    ]);
  });

  it("rejects invalid /exit-worktree args instead of treating them as keep", async () => {
    const reg = buildDefaultRegistry();
    const command = reg.find("exit-worktree");
    expect(command).toBeDefined();
    const setPendingWorktreeState = vi.fn();
    const ctx = {
      session: {
        pendingWorktreeState: {
          handle: { path: "/tmp/agenc-worktree" },
          baseCommit: "abc123",
        },
        setPendingWorktreeState,
      },
      argsRaw: "remove discard",
      cwd: "/tmp/project",
      home: "/home/test",
    } as unknown as SlashCommandContext;

    const result = await command!.execute(ctx);

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toMatch(/Usage/);
    expect(setPendingWorktreeState).not.toHaveBeenCalled();
  });
});
