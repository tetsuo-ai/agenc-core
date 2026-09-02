import { describe, expect, it } from "vitest";

import {
  classifyShellWorkspaceWritePolicy,
  collectShellWorkspaceDeletionTargets,
} from "../../src/llm/shell-write-policy.js";

const WORKSPACE_ROOT = "/repo";

function classify(command: string, allowWorkspaceDeletions?: boolean) {
  return classifyShellWorkspaceWritePolicy({
    toolName: "exec_command",
    args: { command },
    workspaceRoot: WORKSPACE_ROOT,
    ...(allowWorkspaceDeletions === undefined ? {} : { allowWorkspaceDeletions }),
  });
}

/** The command the live session repeated 14 times against the old policy. */
const REFACTOR_CLEANUP =
  "rm arcade15/game.js && ls -la arcade15 && node --check arcade15/main.js";

describe("classifyShellWorkspaceWritePolicy", () => {
  it("does not read the fd prefix of 2>/dev/null as an rmdir operand", () => {
    const decision = classify("rmdir tmp 2>/dev/null");

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
    expect(decision.blockedTargets).toEqual([]);
  });

  it("allows the cleanup chain that was rejected five times in a row", () => {
    const decision = classify(
      "rm -f tmp/snake-sim.js && rmdir tmp 2>/dev/null; ls -la game5 game4b; node --check game5/game.js",
    );

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
  });

  it("ignores program text inside a stdin heredoc", () => {
    const decision = classify(
      [
        "node --check game5/game.js && node <<'JS'",
        "const s = { x: 0 };",
        "const r = { pass: false };",
        "if (s.x === 0 && !r.pass) { console.log(1 > 0); }",
        "JS",
      ].join("\n"),
    );

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
    expect(decision.observedTargets).toEqual([]);
  });

  it("allows a heredoc redirected outside the workspace", () => {
    const decision = classify(
      ["cat > /tmp/game4b_sim.js << 'EOF'", "if (b.x > 40) { x = 1; }", "EOF"].join(
        "\n",
      ),
    );

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
    expect(decision.observedTargets).toEqual(["/tmp/game4b_sim.js"]);
  });

  it("still blocks a heredoc redirected into a workspace source file", () => {
    const decision = classify(
      ["cat > src/x.js <<EOF", "export const x = 1 > 0;", "EOF"].join("\n"),
    );

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual(["/repo/src/x.js"]);
  });

  it("still blocks an fd-prefixed redirect into a workspace file", () => {
    const decision = classify("make 2> build/make.log 2>> src/errors.log");

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual(["/repo/src/errors.log"]);
  });

  it("treats 2>&1 as a descriptor duplication, not a file", () => {
    const decision = classify("npm test 2>&1 | tail -20");

    expect(decision.blocked).toBe(false);
    expect(decision.observedTargets).toEqual([]);
  });

  it("denies with one sentence plus the blocked targets", () => {
    const decision = classify("echo hi > notes.txt");

    expect(decision.blocked).toBe(true);
    expect(decision.message).toBe(
      "shell_workspace_file_write_disallowed: shell commands may not write " +
        "workspace files except under build, dist, logs, .cache, tmp, or coverage; " +
        "use Edit or Write instead. Blocked target(s): /repo/notes.txt",
    );
  });

  describe("workspace deletions", () => {
    it("lets a session that edits without prompting rm a workspace file", () => {
      const decision = classify(REFACTOR_CLEANUP, true);

      expect(decision.blocked).toBe(false);
      expect(decision.indeterminate).toBe(false);
      expect(decision.deletionTargets).toEqual(["/repo/arcade15/game.js"]);
      expect(decision.blockedDeletions).toEqual([]);
      expect(decision.blockedTargets).toEqual([]);
      expect(decision.observedTargets).toEqual(["/repo/arcade15/game.js"]);
    });

    it("sends a deletion through the approval path when the mode prompts", () => {
      const decision = classify(REFACTOR_CLEANUP, false);

      expect(decision.blocked).toBe(true);
      expect(decision.blockedDeletions).toEqual(["/repo/arcade15/game.js"]);
      expect(decision.deletionTargets).toEqual([]);
      expect(decision.message).toBe(
        "shell_workspace_file_delete_requires_approval: deleting or moving " +
          "workspace files with a shell command needs the user's approval in this " +
          "permission mode; ask the user to approve this exact command, or to " +
          "switch to acceptEdits or bypassPermissions, then run it again. Edit and " +
          "Write cannot delete files. Blocked target(s): /repo/arcade15/game.js",
      );
    });

    it("treats rmdir and unlink like rm", () => {
      const decision = classify("unlink src/a.js; rmdir src/empty", true);

      expect(decision.blocked).toBe(false);
      expect(decision.deletionTargets).toEqual(["/repo/src/a.js", "/repo/src/empty"]);
    });

    it("blocks rm outside the workspace even when deletions are allowed", () => {
      const decision = classify("rm ../outside.txt", true);

      expect(decision.blocked).toBe(true);
      expect(decision.blockedDeletions).toEqual(["/outside.txt"]);
      expect(decision.message).toContain(
        "shell_workspace_file_delete_disallowed: shell commands may delete or " +
          "move files only inside the workspace or the system temp directory; ask " +
          "the user to remove anything else themselves. Blocked target(s): /outside.txt",
      );
    });

    it("still lets the shell clean up its own temp files", () => {
      const decision = classify("rm -f /tmp/game4b_sim.js", true);

      expect(decision.blocked).toBe(false);
      expect(decision.deletionTargets).toEqual([]);
      expect(decision.observedTargets).toEqual(["/tmp/game4b_sim.js"]);
    });

    it("blocks rm of protected paths even when deletions are allowed", () => {
      const decision = classify("rm .git/config", true);

      expect(decision.blocked).toBe(true);
      expect(decision.blockedDeletions).toEqual(["/repo/.git/config"]);
      expect(decision.message).toContain(
        "shell_workspace_file_delete_disallowed: shell commands may not delete or " +
          "move protected paths (the workspace root, .git, .agenc, .agents, the " +
          "AgenC home, shell and git config files); ask the user to remove them " +
          "themselves. Blocked target(s): /repo/.git/config",
      );
    });

    it("blocks removing the workspace root, the AgenC home, and the home directory", () => {
      const withHome = classifyShellWorkspaceWritePolicy({
        toolName: "exec_command",
        args: { command: "rm -rf . /Users/dev/agenc-home/state ~/" },
        workspaceRoot: WORKSPACE_ROOT,
        allowWorkspaceDeletions: true,
        protectedRoots: ["/Users/dev/agenc-home"],
      });

      expect(withHome.blocked).toBe(true);
      // `~/` expands dynamically, so it also makes the command indeterminate.
      expect(withHome.indeterminate).toBe(true);
      expect(withHome.blockedDeletions).toEqual([
        "/repo",
        "/Users/dev/agenc-home/state",
      ]);
    });

    it("keeps blocking redirect writes when deletions are allowed", () => {
      const decision = classify("cat > src/x.js <<EOF\nexport const x = 1;\nEOF", true);

      expect(decision.blocked).toBe(true);
      expect(decision.blockedTargets).toEqual(["/repo/src/x.js"]);
      expect(decision.blockedDeletions).toEqual([]);
      expect(decision.message).toContain("shell_workspace_file_write_disallowed");
      expect(decision.message).toContain("use Edit or Write instead");
    });

    it("keeps blocking tee, touch and truncate as content writes", () => {
      expect(classify("echo x | tee src/x.js", true).blocked).toBe(true);
      expect(classify("touch src/new.js", true).blocked).toBe(true);
      expect(classify("truncate -s 0 src/x.js", true).blocked).toBe(true);
    });

    it("treats a rename inside the workspace as a deletion-class mutation", () => {
      const allowed = classify("mv src/old.js src/new.js", true);
      expect(allowed.blocked).toBe(false);
      expect(allowed.deletionTargets).toEqual(["/repo/src/old.js", "/repo/src/new.js"]);
      expect(allowed.blockedTargets).toEqual([]);

      const prompting = classify("mv src/old.js src/new.js", false);
      expect(prompting.blocked).toBe(true);
      expect(prompting.blockedDeletions).toEqual(["/repo/src/old.js", "/repo/src/new.js"]);
      expect(prompting.message).toContain("shell_workspace_file_delete_requires_approval");
    });

    it("keeps a move from outside the workspace as a content write", () => {
      const decision = classify("mv /tmp/generated.js src/x.js", true);

      expect(decision.blocked).toBe(true);
      expect(decision.blockedTargets).toEqual(["/repo/src/x.js"]);
      expect(decision.blockedDeletions).toEqual([]);
      expect(decision.message).toContain("use Edit or Write instead");
    });

    it("still allows deletions under generated output roots without approval", () => {
      const decision = classify("rm -rf dist build/out.js", false);

      expect(decision.blocked).toBe(false);
      expect(decision.deletionTargets).toEqual(["/repo/dist", "/repo/build/out.js"]);
    });

    it("lists the workspace files a command is about to remove for file history", () => {
      expect(
        collectShellWorkspaceDeletionTargets({
          toolName: "exec_command",
          args: { command: REFACTOR_CLEANUP, cwd: "/repo" },
          workspaceRoot: WORKSPACE_ROOT,
        }),
      ).toEqual(["/repo/arcade15/game.js"]);
      // A command the policy refuses will not run, so there is nothing to back up.
      expect(
        collectShellWorkspaceDeletionTargets({
          toolName: "exec_command",
          args: { command: "rm src/a.js ../outside.txt" },
          workspaceRoot: WORKSPACE_ROOT,
        }),
      ).toEqual([]);
      expect(
        collectShellWorkspaceDeletionTargets({
          toolName: "exec_command",
          args: { command: "ls -la" },
          workspaceRoot: WORKSPACE_ROOT,
        }),
      ).toEqual([]);
    });
  });
});
