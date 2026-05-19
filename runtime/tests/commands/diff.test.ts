import { describe, expect, it, vi } from "vitest";
import {
  collectDiffSnapshot,
  computeDiff,
  diffCommand,
} from "./diff.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

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

function stubCtx(
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext {
  return {
    session: overrides.session ?? ({ services: {} } as unknown as Session),
    argsRaw: overrides.argsRaw ?? "",
    cwd: overrides.cwd ?? "/repo",
    home: overrides.home ?? "/home/test",
    configStore: overrides.configStore,
    appState: overrides.appState,
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
      if (args[0] === "diff" && args[1] === "HEAD") {
        return {
          stdout: "diff --git a/foo b/foo\n+hello\n",
          stderr: "",
          code: 0,
          timedOut: false,
        };
      }
      if (args[0] === "diff" && args[1] === "--name-status") {
        return { stdout: "M\tfoo\n", stderr: "", code: 0, timedOut: false };
      }
      if (args[0] === "diff" && args[1] === "--numstat") {
        return { stdout: "1\t0\tfoo\n", stderr: "", code: 0, timedOut: false };
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

describe("collectDiffSnapshot", () => {
  it("builds v2 rows for single-file and untracked changes", async () => {
    const deps = makeDeps((args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "true\n", stderr: "", code: 0, timedOut: false };
      }
      if (args[0] === "diff" && args[1] === "HEAD") {
        return {
          stdout: [
            "diff --git a/src/a.ts b/src/a.ts",
            "@@ -1 +1 @@",
            "-old",
            "+new",
          ].join("\n"),
          stderr: "",
          code: 0,
          timedOut: false,
        };
      }
      if (args[0] === "diff" && args[1] === "--name-status") {
        return { stdout: "M\tsrc/a.ts\n", stderr: "", code: 0, timedOut: false };
      }
      if (args[0] === "diff" && args[1] === "--numstat") {
        return { stdout: "1\t1\tsrc/a.ts\n", stderr: "", code: 0, timedOut: false };
      }
      if (args[0] === "ls-files") {
        return { stdout: "new.txt\n", stderr: "", code: 0, timedOut: false };
      }
      return { stdout: "", stderr: "", code: 1, timedOut: false };
    });

    const snapshot = await collectDiffSnapshot("/repo", deps);
    expect(snapshot.state).toBe("changed");
    expect(snapshot.files).toHaveLength(2);
    expect(snapshot.files.find(file => file.path === "new.txt")).toEqual(
      expect.objectContaining({
        path: "new.txt",
        status: "untracked",
      }),
    );
    const tracked = snapshot.files.find(file => file.path === "src/a.ts");
    expect(tracked).toEqual(
      expect.objectContaining({
        path: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
      }),
    );
    expect(tracked?.previewLines).toContain("+new");
  });

  it("builds clean state when there are no changed or untracked files", async () => {
    const deps = makeDeps((args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "true\n", stderr: "", code: 0, timedOut: false };
      }
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    });

    const snapshot = await collectDiffSnapshot("/repo", deps);
    expect(snapshot.state).toBe("clean");
    expect(snapshot.files).toHaveLength(0);
  });
});

describe("diffCommand", () => {
  it("opens a persistent v2 menu when TUI app state is wired", async () => {
    const setToolJSX = vi.fn();
    const result = await diffCommand.execute(
      stubCtx({
        appState: { setToolJSX },
      }),
    );

    expect(result.kind).toBe("skip");
    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({
        isLocalJSXCommand: true,
        shouldHidePromptInput: true,
        jsx: expect.anything(),
      }),
    );
  });
});
