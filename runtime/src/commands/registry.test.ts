import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./enter-worktree.js", () => ({
  enterWorktree: vi.fn(),
}));

vi.mock("./exit-worktree.js", () => ({
  exitWorktree: vi.fn(),
}));

vi.mock("../utils/Shell.js", () => ({
  setCwd: vi.fn(),
}));

import { CommandRegistry, buildDefaultRegistry } from "./registry.js";
import { enterWorktree } from "./enter-worktree.js";
import { exitWorktree } from "./exit-worktree.js";
import { setCwd } from "../utils/Shell.js";
import type { SlashCommand, SlashCommandResult } from "./types.js";
import type { PendingWorktreeState } from "../session/pending-worktree.js";

const mockEnterWorktree = vi.mocked(enterWorktree);
const mockExitWorktree = vi.mocked(exitWorktree);
const mockSetCwd = vi.mocked(setCwd);

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
  it("returns commands sorted by name", () => {
    const reg = new CommandRegistry();
    reg.register(mkCmd("zeta"));
    reg.register(mkCmd("alpha"));
    reg.register(mkCmd("mu"));
    const names = reg.list().map((c) => c.name);
    expect(names).toEqual(["alpha", "mu", "zeta"]);
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
  let chdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => undefined);
  });

  afterEach(() => {
    chdirSpy.mockRestore();
  });

  it("includes help and status", () => {
    const reg = buildDefaultRegistry();
    expect(reg.has("help")).toBe(true);
    expect(reg.has("status")).toBe(true);
  });

  it("includes the worktree adapters", () => {
    const reg = buildDefaultRegistry();
    expect(reg.has("enter-worktree")).toBe(true);
    expect(reg.has("exit-worktree")).toBe(true);
  });

  it("returns a stable sorted list", () => {
    const reg = buildDefaultRegistry();
    const names = reg.list().map((c) => c.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it("enters a worktree, switches cwd, and stores pending state", async () => {
    mockEnterWorktree.mockResolvedValueOnce({
      kind: "entered",
      handle: {
        path: "/repo/.agenc-worktrees/feat",
        branch: "worktree-feat",
        gitRoot: "/repo",
        created: true,
      },
      baseCommit: "abc123",
    });
    const reg = buildDefaultRegistry();
    const command = reg.find("enter-worktree");
    const session = {
      pendingWorktreeState: null,
      setPendingWorktreeState(next: PendingWorktreeState | null) {
        this.pendingWorktreeState = next;
      },
    };

    const res = await command!.execute({
      session: session as never,
      argsRaw: "feat",
      cwd: "/repo",
      home: "/home/test",
    });

    expect(res).toEqual({
      kind: "text",
      text: [
        "Entered worktree at /repo/.agenc-worktrees/feat",
        "Branch: worktree-feat",
        "Base commit: abc123",
      ].join("\n"),
    });
    expect(chdirSpy).toHaveBeenCalledWith("/repo/.agenc-worktrees/feat");
    expect(mockSetCwd).toHaveBeenCalledWith("/repo/.agenc-worktrees/feat");
    expect(session.pendingWorktreeState).toEqual({
      handle: {
        path: "/repo/.agenc-worktrees/feat",
        branch: "worktree-feat",
        gitRoot: "/repo",
        created: true,
      },
      baseCommit: "abc123",
      originalCwd: "/repo",
    });
  });

  it("refuses /enter-worktree when a session worktree is already active", async () => {
    const reg = buildDefaultRegistry();
    const command = reg.find("enter-worktree");
    const session = {
      pendingWorktreeState: {
        handle: {
          path: "/repo/.agenc-worktrees/existing",
          branch: "worktree-existing",
          gitRoot: "/repo",
          created: false,
        },
        baseCommit: "base",
        originalCwd: "/repo",
      },
      setPendingWorktreeState(_next: PendingWorktreeState | null) {},
    };

    const res = await command!.execute({
      session: session as never,
      argsRaw: "feat",
      cwd: "/repo",
      home: "/home/test",
    });

    expect(res.kind).toBe("error");
    expect(mockEnterWorktree).not.toHaveBeenCalled();
  });

  it("exits the active worktree, restores cwd, and clears pending state", async () => {
    mockExitWorktree.mockResolvedValueOnce({
      kind: "kept",
      path: "/repo/.agenc-worktrees/feat",
      branch: "worktree-feat",
      changedFiles: false,
      hasCommits: false,
      message:
        "worktree preserved at /repo/.agenc-worktrees/feat (branch=worktree-feat)",
    });
    const reg = buildDefaultRegistry();
    const command = reg.find("exit-worktree");
    const session = {
      pendingWorktreeState: {
        handle: {
          path: "/repo/.agenc-worktrees/feat",
          branch: "worktree-feat",
          gitRoot: "/repo",
          created: true,
        },
        baseCommit: "abc123",
        originalCwd: "/repo",
      } satisfies PendingWorktreeState,
      setPendingWorktreeState(next: PendingWorktreeState | null) {
        this.pendingWorktreeState = next;
      },
    };

    const res = await command!.execute({
      session: session as never,
      argsRaw: "",
      cwd: "/repo/.agenc-worktrees/feat",
      home: "/home/test",
    });

    expect(mockExitWorktree).toHaveBeenCalledWith({
      session,
      handle: {
        path: "/repo/.agenc-worktrees/feat",
        branch: "worktree-feat",
        gitRoot: "/repo",
        created: true,
      },
      baseCommit: "abc123",
      action: "keep",
    });
    expect(res).toEqual({
      kind: "text",
      text: [
        "worktree preserved at /repo/.agenc-worktrees/feat (branch=worktree-feat)",
        "Restored cwd: /repo",
      ].join("\n"),
    });
    expect(chdirSpy).toHaveBeenLastCalledWith("/repo");
    expect(mockSetCwd).toHaveBeenLastCalledWith("/repo");
    expect(session.pendingWorktreeState).toBeNull();
  });

  it("passes remove + discard through to /exit-worktree", async () => {
    mockExitWorktree.mockResolvedValueOnce({
      kind: "removed",
      path: "/repo/.agenc-worktrees/feat",
      branch: "worktree-feat",
      discardedFiles: true,
      discardedCommits: true,
      message:
        "worktree removed at /repo/.agenc-worktrees/feat (branch=worktree-feat)",
    });
    const reg = buildDefaultRegistry();
    const command = reg.find("exit-worktree");
    const session = {
      pendingWorktreeState: {
        handle: {
          path: "/repo/.agenc-worktrees/feat",
          branch: "worktree-feat",
          gitRoot: "/repo",
          created: true,
        },
        baseCommit: "abc123",
        originalCwd: "/repo",
      } satisfies PendingWorktreeState,
      setPendingWorktreeState(next: PendingWorktreeState | null) {
        this.pendingWorktreeState = next;
      },
    };

    await command!.execute({
      session: session as never,
      argsRaw: "remove --discard-changes",
      cwd: "/repo/.agenc-worktrees/feat",
      home: "/home/test",
    });

    expect(mockExitWorktree).toHaveBeenCalledWith({
      session,
      handle: {
        path: "/repo/.agenc-worktrees/feat",
        branch: "worktree-feat",
        gitRoot: "/repo",
        created: true,
      },
      baseCommit: "abc123",
      action: "remove",
      discardChanges: true,
    });
  });

  it("preserves pending worktree state when /exit-worktree refuses", async () => {
    mockExitWorktree.mockResolvedValueOnce({
      kind: "refused",
      reason: "worktree has uncommitted files",
      errorCode: 2,
    });
    const reg = buildDefaultRegistry();
    const command = reg.find("exit-worktree");
    const pending = {
      handle: {
        path: "/repo/.agenc-worktrees/feat",
        branch: "worktree-feat",
        gitRoot: "/repo",
        created: true,
      },
      baseCommit: "abc123",
      originalCwd: "/repo",
    } satisfies PendingWorktreeState;
    const session = {
      pendingWorktreeState: pending,
      setPendingWorktreeState(next: PendingWorktreeState | null) {
        this.pendingWorktreeState = next;
      },
    };

    const res = await command!.execute({
      session: session as never,
      argsRaw: "remove",
      cwd: "/repo/.agenc-worktrees/feat",
      home: "/home/test",
    });

    expect(res).toEqual({
      kind: "error",
      message: "worktree has uncommitted files",
    });
    expect(session.pendingWorktreeState).toBe(pending);
    expect(chdirSpy).not.toHaveBeenCalled();
    expect(mockSetCwd).not.toHaveBeenCalled();
  });
});
