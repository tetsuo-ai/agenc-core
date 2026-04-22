import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/worktree.js", () => ({
  hasWorktreeChanges: vi.fn(),
  removeAgentWorktree: vi.fn(),
}));

vi.mock("../session/event-log.js", () => ({
  emitError: vi.fn(),
  emitWarning: vi.fn(),
}));

import {
  hasWorktreeChanges,
  removeAgentWorktree,
} from "../agents/worktree.js";
import { emitError } from "../session/event-log.js";
import { exitWorktree } from "./exit-worktree.js";

const mockHasChanges = vi.mocked(hasWorktreeChanges);
const mockRemove = vi.mocked(removeAgentWorktree);
const mockEmitError = vi.mocked(emitError);

const HANDLE = {
  path: "/repo/.agenc-worktrees/feat",
  branch: "worktree-feat",
  gitRoot: "/repo",
  created: true,
};

function stubSession() {
  return {
    eventLog: {},
    nextInternalSubId: () => "sub-1",
  } as unknown as Parameters<typeof exitWorktree>[0]["session"];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exitWorktree", () => {
  it("keep: returns kept kind even when changes exist", async () => {
    mockHasChanges.mockResolvedValueOnce({ hasCommits: true, isDirty: true });
    const res = await exitWorktree({
      session: stubSession(),
      handle: HANDLE,
      baseCommit: "abc",
      action: "keep",
    });
    expect(res.kind).toBe("kept");
    if (res.kind === "kept") {
      expect(res.changedFiles).toBe(true);
      expect(res.hasCommits).toBe(true);
    }
  });

  it("remove without discardChanges refuses dirty worktree", async () => {
    mockHasChanges.mockResolvedValueOnce({ hasCommits: false, isDirty: true });
    const res = await exitWorktree({
      session: stubSession(),
      handle: HANDLE,
      baseCommit: "abc",
      action: "remove",
    });
    expect(res.kind).toBe("refused");
    if (res.kind === "refused") {
      expect(res.errorCode).toBe(2);
    }
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("remove with discardChanges force-removes dirty worktree", async () => {
    mockHasChanges.mockResolvedValueOnce({ hasCommits: true, isDirty: true });
    mockRemove.mockResolvedValueOnce(undefined);
    const res = await exitWorktree({
      session: stubSession(),
      handle: HANDLE,
      baseCommit: "abc",
      action: "remove",
      discardChanges: true,
    });
    expect(res.kind).toBe("removed");
    expect(mockRemove).toHaveBeenCalledOnce();
  });

  it("remove succeeds when worktree is clean", async () => {
    mockHasChanges.mockResolvedValueOnce({ hasCommits: false, isDirty: false });
    mockRemove.mockResolvedValueOnce(undefined);
    const res = await exitWorktree({
      session: stubSession(),
      handle: HANDLE,
      baseCommit: "abc",
      action: "remove",
    });
    expect(res.kind).toBe("removed");
  });

  it("remove without baseCommit refuses (fail-closed)", async () => {
    const res = await exitWorktree({
      session: stubSession(),
      handle: HANDLE,
      baseCommit: null,
      action: "remove",
    });
    expect(res.kind).toBe("refused");
    if (res.kind === "refused") expect(res.errorCode).toBe(3);
  });

  it("remove refuses when change probes throw", async () => {
    mockHasChanges.mockRejectedValueOnce(new Error("git status failed"));
    const res = await exitWorktree({
      session: stubSession(),
      handle: HANDLE,
      baseCommit: "abc",
      action: "remove",
    });
    expect(res.kind).toBe("refused");
    if (res.kind === "refused") {
      expect(res.errorCode).toBe(3);
    }
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("remove surfaces remove-call errors via emitError", async () => {
    mockHasChanges.mockResolvedValueOnce({ hasCommits: false, isDirty: false });
    mockRemove.mockRejectedValueOnce(new Error("git remove failed"));
    const res = await exitWorktree({
      session: stubSession(),
      handle: HANDLE,
      baseCommit: "abc",
      action: "remove",
    });
    expect(res.kind).toBe("refused");
    expect(mockEmitError).toHaveBeenCalled();
  });
});
