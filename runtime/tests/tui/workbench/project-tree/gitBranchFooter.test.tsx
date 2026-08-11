import { describe, expect, it } from "vitest";

import {
  parseGitBranchPorcelainV2,
} from "../../../../src/tui/workbench/project-tree/gitStatus.js";
import { formatGitBranchSummary } from "../../../../src/tui/workbench/project-tree/GitBranchFooter.js";

const GLYPHS = { gitBranch: "⎇", arrowUp: "↑", arrowDown: "↓" };

describe("project tree git branch", () => {
  it("reads branch, upstream divergence and dirty count from one porcelain call", () => {
    const raw = [
      "# branch.oid e8bb66f40697f8f12499bbcbce67d7f32c3bbb23",
      "# branch.head feat/iot-builder-skill",
      "# branch.upstream origin/feat/iot-builder-skill",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb runtime/src/tui/glyphs.ts",
      "1 M. N... 100644 100644 100644 ccc ddd runtime/src/tui/ink.ts",
      "? runtime/src/tui/untracked.ts",
      "",
    ].join("\n");

    expect(parseGitBranchPorcelainV2(raw)).toEqual({
      branch: "feat/iot-builder-skill",
      head: "e8bb66f",
      upstream: "origin/feat/iot-builder-skill",
      ahead: 2,
      behind: 1,
      dirtyCount: 3,
    });
  });

  it("returns null outside a repository so the footer renders nothing", () => {
    expect(parseGitBranchPorcelainV2("")).toBeNull();
    expect(parseGitBranchPorcelainV2("fatal: not a git repository\n")).toBeNull();
  });

  // A detached HEAD is exactly when you most need to know where you are, and
  // git reports no branch name for it.
  it("falls back to the short sha on a detached HEAD", () => {
    const parsed = parseGitBranchPorcelainV2(
      ["# branch.oid bb96fd8080cfe01775598d416b981774f07a269a", "# branch.head (detached)", ""].join("\n"),
    );
    expect(parsed).toEqual({ branch: null, head: "bb96fd8", dirtyCount: 0 });
    expect(formatGitBranchSummary(parsed!, GLYPHS)).toBe("⎇ bb96fd8 (detached)");
  });

  it("reports a clean branch without counters", () => {
    expect(
      formatGitBranchSummary(
        { branch: "main", head: "e8bb66f", dirtyCount: 0 },
        GLYPHS,
      ),
    ).toBe("⎇ main");
  });

  it("shows divergence and dirty count when there is something to say", () => {
    expect(
      formatGitBranchSummary(
        {
          branch: "feat/x",
          head: "abc1234",
          upstream: "origin/feat/x",
          ahead: 2,
          behind: 1,
          dirtyCount: 3,
        },
        GLYPHS,
      ),
      // Two spaces after the name and interpuncts between counters: at
      // terminal sizes a single space made "main ↑2" read as one token.
    ).toBe("⎇ feat/x  ↑2 · ↓1 · 3*");
  });
});
