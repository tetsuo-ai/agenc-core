import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/worktree.js", () => ({
  validateWorktreeSlug: vi.fn(),
  findGitRoot: vi.fn(),
  getOrCreateWorktree: vi.fn(),
  captureBaseCommit: vi.fn(),
}));

vi.mock("../session/event-log.js", () => ({
  emitError: vi.fn(),
  emitWarning: vi.fn(),
}));

import {
  captureBaseCommit,
  findGitRoot,
  getOrCreateWorktree,
  validateWorktreeSlug,
} from "../agents/worktree.js";
import { emitError, emitWarning } from "../session/event-log.js";
import { enterWorktree } from "./enter-worktree.js";

const mockValidate = vi.mocked(validateWorktreeSlug);
const mockFindRoot = vi.mocked(findGitRoot);
const mockGetOrCreate = vi.mocked(getOrCreateWorktree);
const mockCapture = vi.mocked(captureBaseCommit);
const mockEmitError = vi.mocked(emitError);
const mockEmitWarning = vi.mocked(emitWarning);

function stubSession() {
  return {
    eventLog: {},
    nextInternalSubId: () => "sub-1",
    sessionConfiguration: { cwd: "/repo-from-session" },
  } as unknown as Parameters<typeof enterWorktree>[0]["session"];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enterWorktree", () => {
  it("rejects an invalid slug with typed event", async () => {
    mockValidate.mockImplementationOnce(() => {
      throw new Error("slug invalid");
    });
    const res = await enterWorktree({
      session: stubSession(),
      cwd: "/repo",
      slug: "bad slug",
    });
    expect(res.kind).toBe("rejected");
    if (res.kind === "rejected") expect(res.reason).toContain("slug invalid");
    expect(mockEmitError).toHaveBeenCalled();
  });

  it("rejects when cwd is not inside a git repo", async () => {
    mockValidate.mockImplementation(() => {});
    mockFindRoot.mockReturnValueOnce(null);
    const res = await enterWorktree({
      session: stubSession(),
      cwd: "/repo",
      slug: "ok",
    });
    expect(res.kind).toBe("rejected");
    expect(mockEmitError).toHaveBeenCalled();
  });

  it("returns entered handle + baseCommit on success", async () => {
    mockValidate.mockImplementation(() => {});
    mockFindRoot.mockReturnValueOnce("/repo");
    mockGetOrCreate.mockResolvedValueOnce({
      path: "/repo/.agenc-worktrees/feat",
      branch: "worktree-feat",
      gitRoot: "/repo",
      created: true,
    });
    mockCapture.mockResolvedValueOnce("abc123");
    const res = await enterWorktree({
      session: stubSession(),
      cwd: "/repo",
      slug: "feat",
    });
    expect(res.kind).toBe("entered");
    if (res.kind === "entered") {
      expect(res.handle.path).toBe("/repo/.agenc-worktrees/feat");
      expect(res.baseCommit).toBe("abc123");
    }
    expect(mockFindRoot).toHaveBeenCalledWith("/repo");
  });

  it("falls back to the session cwd when the adapter did not pass one", async () => {
    mockValidate.mockImplementation(() => {});
    mockFindRoot.mockReturnValueOnce("/repo-from-session");
    mockGetOrCreate.mockResolvedValueOnce({
      path: "/repo-from-session/.agenc-worktrees/feat",
      branch: "worktree-feat",
      gitRoot: "/repo-from-session",
      created: true,
    });
    mockCapture.mockResolvedValueOnce("abc123");

    const res = await enterWorktree({
      session: stubSession(),
      slug: "feat",
    });

    expect(res.kind).toBe("entered");
    expect(mockFindRoot).toHaveBeenCalledWith("/repo-from-session");
  });

  it("warns when resuming an existing worktree", async () => {
    mockValidate.mockImplementation(() => {});
    mockFindRoot.mockReturnValueOnce("/repo");
    mockGetOrCreate.mockResolvedValueOnce({
      path: "/repo/.agenc-worktrees/feat",
      branch: "worktree-feat",
      gitRoot: "/repo",
      created: false,
    });
    mockCapture.mockResolvedValueOnce("abc");
    await enterWorktree({ session: stubSession(), cwd: "/repo", slug: "feat" });
    expect(mockEmitWarning).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "worktree_resumed",
      expect.stringContaining("resumed"),
    );
  });

  it("maps create failure into a typed error event", async () => {
    mockValidate.mockImplementation(() => {});
    mockFindRoot.mockReturnValueOnce("/repo");
    mockGetOrCreate.mockRejectedValueOnce(new Error("git failed"));
    const res = await enterWorktree({
      session: stubSession(),
      cwd: "/repo",
      slug: "feat",
    });
    expect(res.kind).toBe("rejected");
    expect(mockEmitError).toHaveBeenCalled();
  });
});
