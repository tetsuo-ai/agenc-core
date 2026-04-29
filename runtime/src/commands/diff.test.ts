import { describe, expect, it } from "vitest";
import { computeDiff } from "./diff.js";

type GitMock = (args: readonly string[]) => {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
};

function makeDeps(mock: GitMock) {
  return {
    runGit: async (args: readonly string[]) =>
      Promise.resolve(mock(args)),
  };
}

describe("computeDiff", () => {
  it("returns 'not a git repository' when rev-parse fails", async () => {
    const deps = makeDeps(() => ({
      stdout: "",
      stderr: "fatal: not a git repo",
      code: 128,
      timedOut: false,
    }));
    const res = await computeDiff("/nope", deps);
    expect(res.kind).toBe("text");
    if (res.kind === "text") expect(res.text).toBe("not a git repository");
  });

  it("formats diff + untracked when repo is present", async () => {
    const deps = makeDeps((args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "true\n", stderr: "", code: 0, timedOut: false };
      }
      if (args[0] === "diff") {
        return {
          stdout: "diff --git a/foo b/foo\n+hello\n",
          stderr: "",
          code: 0,
          timedOut: false,
        };
      }
      if (args[0] === "ls-files") {
        return { stdout: "new.txt\nsub/new2.txt\n", stderr: "", code: 0, timedOut: false };
      }
      return { stdout: "", stderr: "", code: 1, timedOut: false };
    });
    const res = await computeDiff("/repo", deps);
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/# git diff HEAD/);
      expect(res.text).toMatch(/diff --git a\/foo b\/foo/);
      expect(res.text).toMatch(/# untracked files/);
      expect(res.text).toMatch(/new\.txt/);
      expect(res.text).toMatch(/sub\/new2\.txt/);
    }
  });

  it("reports (no changes) and (none) when both commands return empty", async () => {
    const deps = makeDeps((args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "true\n", stderr: "", code: 0, timedOut: false };
      }
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    });
    const res = await computeDiff("/repo", deps);
    expect(res.kind).toBe("text");
    if (res.kind === "text") {
      expect(res.text).toMatch(/\(no changes\)/);
      expect(res.text).toMatch(/\(none\)/);
    }
  });

  it("treats a timed-out rev-parse as 'not a git repository'", async () => {
    const deps = makeDeps(() => ({
      stdout: "",
      stderr: "",
      code: null,
      timedOut: true,
    }));
    const res = await computeDiff("/repo", deps);
    expect(res.kind).toBe("text");
    if (res.kind === "text") expect(res.text).toBe("not a git repository");
  });
});
