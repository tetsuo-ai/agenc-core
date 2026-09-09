import { describe, expect, it } from "vitest";

import { checkReadOnlyConstraints } from "../../src/tools/BashTool/readOnlyValidation.js";

const behavior = (command: string): string =>
  (checkReadOnlyConstraints({ command } as never, false) as { behavior: string })
    .behavior;

/**
 * GH_READ_ONLY_COMMANDS is defined beside GIT_READ_ONLY_COMMANDS and was
 * imported by the PowerShell validator only, so `git log` classified as
 * read-only here while `gh pr list` fell through to "no opinion". Anything
 * deciding from that answer — plan mode, and the unattended read-only grant —
 * therefore refused every gh call, including the listings the map exists to
 * describe.
 */
describe("gh read-only classification on the Bash path", () => {
  it("allows the curated listing subcommands", () => {
    for (const command of [
      "gh pr list",
      "gh pr view 1",
      "gh pr diff 1",
      "gh pr checks 1",
      "gh pr status",
      "gh issue list",
      "gh issue view 1",
      "gh run list",
      "gh run view 1",
      "gh repo view",
      "gh release list",
      "gh search prs --owner tetsuo-ai",
      "gh auth status",
    ]) {
      expect(behavior(command), command).toBe("allow");
    }
  });

  it("keeps every mutating subcommand out, including ones that read first", () => {
    // Absence from the map is the whole defence: these must not be classified,
    // so callers fall back to asking a human.
    for (const command of [
      "gh pr merge 1",
      "gh pr close 1",
      "gh pr comment 1 --body x",
      "gh pr edit 1",
      "gh issue create",
      "gh issue close 1",
      "gh release create v1",
      "gh repo delete tetsuo-ai/agenc-core",
      "gh workflow run ci.yml",
      "gh api -X POST /repos/x/y/issues",
    ]) {
      expect(behavior(command), command).not.toBe("allow");
    }
  });

  it("still classifies git, so the shared map was added rather than swapped", () => {
    expect(behavior("git log --oneline -5")).toBe("allow");
    expect(behavior("git status")).toBe("allow");
    expect(behavior("git push")).not.toBe("allow");
  });
});
