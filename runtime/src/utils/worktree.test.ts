import { afterEach, describe, expect, it } from "vitest";
import {
  generateTmuxSessionName,
  getCurrentWorktreeSession,
  keepWorktree,
  restoreWorktreeSession,
} from "./worktree.js";

afterEach(() => {
  restoreWorktreeSession(null);
});

describe("getCurrentWorktreeSession", () => {
  it("defaults to null instead of a truthy stub", () => {
    expect(getCurrentWorktreeSession()).toBeNull();
  });

  it("stores and clears the active worktree session", async () => {
    const session = {
      originalCwd: "/repo",
      worktreePath: "/repo/.agenc-worktrees/feat",
      worktreeName: "feat",
      worktreeBranch: "worktree-feat",
      sessionId: "session-1",
    };

    restoreWorktreeSession(session);
    expect(getCurrentWorktreeSession()).toEqual(session);

    await keepWorktree();
    expect(getCurrentWorktreeSession()).toBeNull();
  });
});

describe("generateTmuxSessionName", () => {
  it("sanitizes path separators for tmux session names", () => {
    expect(generateTmuxSessionName("/repo/name", "feature/worktree")).toBe(
      "name_feature_worktree",
    );
  });
});
