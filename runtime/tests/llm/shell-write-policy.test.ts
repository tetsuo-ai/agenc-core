import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  classifyShellWorkspaceWritePolicy,
  collectShellWorkspaceDeletionTargets,
} from "../../src/llm/shell-write-policy.js";

const WORKSPACE_ROOT = "/repo";

/** A sed target under /tmp, named as the filesystem reaches it (/private/tmp on macOS). */
function realTmp(name: string): string {
  return join(realpathSync("/tmp"), name);
}

function classify(
  command: string,
  allowWorkspaceDeletions?: boolean,
  // On macOS `sed` may be GNU or BSD sed, so both readings count.
  platform: NodeJS.Platform = "darwin",
) {
  return classifyShellWorkspaceWritePolicy({
    toolName: "exec_command",
    args: { command },
    workspaceRoot: WORKSPACE_ROOT,
    platform,
    ...(allowWorkspaceDeletions === undefined ? {} : { allowWorkspaceDeletions }),
  });
}

/** The command the live session repeated 14 times against the old policy. */
const REFACTOR_CLEANUP =
  "rm arcade15/game.js && ls -la arcade15 && node --check arcade15/main.js";

describe("classifyShellWorkspaceWritePolicy", () => {
  it.each([">", ">>", ">|", "&>", "&>>", "<>", "2>", "3<>"])(
    "blocks workspace writes through %s",
    (operator) => {
      const decision = classify(`cat ${operator} src/output.txt`);
      expect(decision.blockedTargets).toContain("/repo/src/output.txt");
      expect(decision.blocked).toBe(true);
    },
  );

  it.each(["&&", "||", ";", "&", "|", "|&"])(
    "checks writes after chained operator %s",
    (operator) => expect(classify(`echo safe ${operator} touch src/file`).blocked).toBe(true),
  );

  it.each(["echo '>' src/file", "echo \\> src/file", "echo '|' touch src/file"])(
    "does not treat literal metacharacters as shell syntax: %s",
    (command) => {
      expect(classify(command).observedTargets).toEqual([]);
      expect(classify(command).blocked).toBe(false);
    },
  );

  it.each([
    "echo $(touch src/file)", 'echo "$(touch src/file)"', "echo `touch src/file`",
    "cat <(touch src/file)", "echo $\\\n(touch src/file)",
    "cat <<EOF\n$(touch src/file)\nEOF", "echo 'open", 'echo "open', "cat <<EOF\nbody",
  ])("fails closed for active substitution or malformed input: %s", (command) => {
    const decision = classify(command);
    expect(decision.indeterminate).toBe(true);
    expect(decision.blocked).toBe(true);
  });

  it("checks writes after a continued heredoc delimiter", () => {
    expect(classify("cat <<EOF\nEO\\\nF\ntouch src/file").blockedTargets).toContain("/repo/src/file");
  });

  it("treats descriptor moves and closes as non-file redirects", () => {
    expect(classify("cat 2>&1- 3>&-").observedTargets).toEqual([]);
  });

  it("does not interpret here-string data as a path or a command", () => {
    expect(classify('cat <<< "touch src/file > src/output"').blocked).toBe(false);
  });

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

  it.each([
    ["touch ' tmp/x'", "/repo/ tmp/x"],
    ["touch 'tmp '", "/repo/tmp "],
    ["echo hi > ' tmp/x'", "/repo/ tmp/x"],
    ["echo hi | tee ' tmp/x'", "/repo/ tmp/x"],
    ["cp notes.txt ' tmp/x'", "/repo/ tmp/x"],
    // A name with a blank is not the device.
    ["echo hi 2> ' /dev/null'", "/repo/ /dev/null"],
  ])("keeps the blanks of a target name: %s", (command, target) => {
    const decision = classify(command);

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual([target]);
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

    it("keeps the blanks of a removed name", () => {
      const decision = classify("rm ' tmp/x'", false);

      expect(decision.blocked).toBe(true);
      expect(decision.blockedDeletions).toEqual(["/repo/ tmp/x"]);
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

describe("classifyShellWorkspaceWritePolicy under the full bypass", () => {
  /** Approvals bypassed and no sandbox: `--dangerously-bypass-approvals-and-sandbox`. */
  function classifyBypassed(command: string) {
    return classifyShellWorkspaceWritePolicy({
      toolName: "exec_command",
      args: { command },
      workspaceRoot: WORKSPACE_ROOT,
      allowWorkspaceDeletions: true,
      bypassesApprovalsAndSandbox: true,
    });
  }

  it("lets a command with an unresolvable target run and still reports it indeterminate", () => {
    // The Terminal-Bench git-multibranch run lost 51 of 459 shell calls to
    // this refusal, most of them an `echo "$(...)"` next to a harmless write.
    const decision = classifyBypassed(
      'for f in refs/heads/*; do echo "$f: $(cat $f)"; done > /tmp/agenc-bypass/refs.txt',
    );
    expect(decision.indeterminate).toBe(true);
    expect(decision.blocked).toBe(false);
    expect(decision.message).toBeUndefined();
  });

  it("allows removals outside the workspace", () => {
    const decision = classifyBypassed("rm -f /etc/nginx/sites-enabled/default");
    expect(decision.blocked).toBe(false);
    expect(decision.blockedDeletions).toEqual([]);
    // Outside the workspace, so nothing for the file-history sidecar to back up.
    expect(decision.deletionTargets).toEqual([]);
  });

  it.each(["rm -rf /", "rm .git/config", `rm -rf ${WORKSPACE_ROOT}`])(
    "keeps refusing the protected roots: %s",
    (command) => {
      const decision = classifyBypassed(command);
      expect(decision.blocked).toBe(true);
      expect(decision.message).toContain("protected paths");
    },
  );

  it("still routes workspace content writes to Edit and Write", () => {
    const decision = classifyBypassed("cat > src/output.txt");
    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toContain("/repo/src/output.txt");
  });

  it("keeps refusing a sed write into a protected path under tmp", () => {
    const decision = classifyBypassed("sed -i 's/a/b/' tmp/.git/config");
    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual(["/repo/tmp/.git/config"]);
  });

  it("names the file a sed -i edits, never its script", () => {
    // The shape a Linux tester hit in Bypass mode on the release candidate.
    const decision = classifyBypassed("sed -i 's/color = blue/color = red/' config/theme.toml");
    expect(decision.observedTargets).toEqual(["/repo/config/theme.toml"]);
    expect(decision.message ?? "").not.toContain("s/color");
  });

  it("changes nothing while a prompt or a sandbox still gates the command", () => {
    const decision = classify('echo "$(id)" > /tmp/agenc-bypass/out.txt', true);
    expect(decision.blocked).toBe(true);
    expect(decision.message).toContain("Unable to confirm workspace write targets");
  });
});

describe("classifyShellWorkspaceWritePolicy for sed", () => {
  /**
   * The DeepSeek session this was reported from: the command only wrote
   * tmp/verify/game.js, yet the policy refused the substitution program as a
   * workspace file.
   */
  const VERIFY_COPY =
    "cp game.js tmp/verify/game.js && " +
    "sed -i 's/const cols = 12;/const cols = 6;/; s/const rows = 12;/const rows = 6;/' " +
    "tmp/verify/game.js && node tmp/verify/game.js";

  it("allows the in-place edit of a copy under tmp that was refused", () => {
    const decision = classify(VERIFY_COPY);

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
    expect(decision.blockedTargets).toEqual([]);
    expect(decision.observedTargets).toEqual(["/repo/tmp/verify/game.js"]);
    expect(decision.message).toBeUndefined();
  });

  // A Linux tester's session refused `sed -i 's/color = blue/color = red/'
  // <file>` and named `s/color = blue/color = red` as the blocked target.
  // BSD sed takes the word after a bare -i as the backup suffix, which adds
  // a backup when that word is an option (`-e`, `--expression`).
  it.each([
    ["sed -i 's/color = blue/color = red/' config/theme.toml", []],
    ["sed -i -e 's/color = blue/color = red/' config/theme.toml", ["-e"]],
    ["sed -i --expression='s/color = blue/color = red/' config/theme.toml", []],
    ["sed -i --expression 's/color = blue/color = red/' config/theme.toml", ["--expression"]],
  ])("names only the edited file of an in-place edit, never the script: %s", (command, suffixes) => {
    const decision = classify(command);
    const targets = [
      "/repo/config/theme.toml",
      ...suffixes.map((suffix) => `/repo/config/theme.toml${suffix}`),
    ];

    expect(decision.observedTargets).toEqual(targets);
    expect(decision.blockedTargets).toEqual(targets);
    expect(decision.message).not.toContain("s/color");
  });

  it("allows the same in-place edit under tmp", () => {
    const decision = classify("sed -i 's/color = blue/color = red/' tmp/theme.toml");

    expect(decision.blocked).toBe(false);
    expect(decision.observedTargets).toEqual(["/repo/tmp/theme.toml"]);
  });

  it.each([
    ["sed -i 's/a/b/' tmp/file.txt", ["/repo/tmp/file.txt"]],
    [
      "sed -i.bak -e 's/a/b/' -e 's/c/d/' tmp/one.txt tmp/two.txt",
      [
        "/repo/tmp/one.txt",
        "/repo/tmp/one.txt.bak",
        "/repo/tmp/two.txt",
        "/repo/tmp/two.txt.bak",
      ],
    ],
    // BSD: an empty separate argument means no backup. GNU runs the empty
    // script, which copies each file unchanged.
    ["sed -i '' 's/a/b/' tmp/file.txt", ["/repo/tmp/file.txt"]],
    // BSD: a separate backup suffix. GNU cannot compile `.orig` or `bak`
    // (a branch to a label that does not exist) and edits nothing.
    ["sed -i .orig 's/a/b/' tmp/file.txt", ["/repo/tmp/file.txt", "/repo/tmp/file.txt.orig"]],
    ["sed -i bak 's/a/b/' tmp/file.txt", ["/repo/tmp/file.txt", "/repo/tmp/file.txtbak"]],
    ["sed -I .orig 's/a/b/' tmp/file.txt", ["/repo/tmp/file.txt", "/repo/tmp/file.txt.orig"]],
    ["sed --in-place=.bak 's/a/b/' tmp/file.txt", ["/repo/tmp/file.txt", "/repo/tmp/file.txt.bak"]],
    ["sed --expression='s/a/b/' --in-place tmp/file.txt", ["/repo/tmp/file.txt"]],
    // GNU reads the letters after -i as the backup suffix.
    ["sed -ie 's/a/b/' tmp/file.txt", ["/repo/tmp/file.txt", "/repo/tmp/file.txte"]],
    // GNU puts the file name in place of each * of the suffix; BSD appends it.
    [
      "sed -i'tmp/backup/*' 's/a/b/' tmp/file.txt",
      [
        "/repo/tmp/file.txt",
        "/repo/tmp/backup/tmp/file.txt",
        "/repo/tmp/file.txttmp/backup/*",
      ],
    ],
    ["sed -i 's|src/old dir/|src/new dir/|g' tmp/paths.txt", ["/repo/tmp/paths.txt"]],
    ["sed -i -E 's/[0-9]+$//; /^$/d' tmp/log.txt", ["/repo/tmp/log.txt", "/repo/tmp/log.txt-E"]],
    ["sed -n -i '/keep/p' tmp/file.txt", ["/repo/tmp/file.txt"]],
    ["sed -i 's/a/b/' /tmp/scratch.txt", [realTmp("scratch.txt")]],
    ["sed -i 's/a/b/' ../sibling/notes.txt", ["/sibling/notes.txt"]],
    ["sed -i 's/a/b/' dist/app.js build/app.js", ["/repo/dist/app.js", "/repo/build/app.js"]],
    // BSD takes -s and -z, which it does not have, as the backup suffix.
    ["sed -i -s 's/a/b/' tmp/file.txt", ["/repo/tmp/file.txt", "/repo/tmp/file.txt-s"]],
    ["sed -i -z 's/a/b/' tmp/file.txt", ["/repo/tmp/file.txt", "/repo/tmp/file.txt-z"]],
  ])("does not read the script as a file: %s", (command, observedTargets) => {
    const decision = classify(command);

    expect(decision.observedTargets).toEqual(observedTargets);
    expect(decision.blockedTargets).toEqual([]);
    expect(decision.indeterminate).toBe(false);
    expect(decision.blocked).toBe(false);
  });

  it.each([
    ["sed -i 's/a/b/' src/app.ts", ["/repo/src/app.ts"]],
    ["sed -i 's/a/b/' tmp/ok.txt src/app.ts", ["/repo/src/app.ts"]],
    ["sed -i.bak 's/a/b/' src/app.ts", ["/repo/src/app.ts", "/repo/src/app.ts.bak"]],
    ["sed --in-place 's/a/b/' src/app.ts", ["/repo/src/app.ts"]],
    ["sed --in-pl=.orig 's/a/b/' src/app.ts", ["/repo/src/app.ts", "/repo/src/app.ts.orig"]],
    ["sed -Ei 's/a+/b/' src/app.ts", ["/repo/src/app.ts"]],
    ["sed -ni 's/a/b/p' src/app.ts", ["/repo/src/app.ts"]],
    ["sed 's/a/b/' -i src/app.ts", ["/repo/src/app.ts"]],
    ["sed -e 's/a/b/' -i src/app.ts", ["/repo/src/app.ts"]],
    ["sed -i -- 's/a/b/' src/app.ts", ["/repo/src/app.ts", "/repo/src/app.ts--"]],
    // The edited file is under tmp, but GNU's backup is not.
    ["sed -i'bak/*' 's/a/b/' tmp/file.txt", ["/repo/bak/tmp/file.txt"]],
  ])("still blocks an in-place edit of a workspace file: %s", (command, blockedTargets) => {
    const decision = classify(command);

    expect(decision.blocked).toBe(true);
    expect(decision.indeterminate).toBe(false);
    expect(decision.blockedTargets).toEqual(blockedTargets);
    expect(decision.message).toContain("shell_workspace_file_write_disallowed");
  });

  describe("GNU and BSD readings of one command line", () => {
    it.each([
      // BSD rejects -s and -z, so only GNU's reading runs, and it edits .bak.
      ["sed -s -i .bak -e 's/a/b/' tmp/file.txt", ["/repo/.bak"]],
      ["sed -z -i .bak -e 's/a/b/' tmp/file.txt", ["/repo/.bak"]],
      // BSD runs `w src/out` as the script, which creates src/out. GNU would
      // edit a file of that name, which does not exist.
      ["sed -i p 'w src/out' tmp/input", ["/repo/src/out"]],
      // BSD runs /tmp/w.txt as the script: an address, then `w .txt`, which
      // sed opens before it fails for having no file to edit.
      ["sed -i 's/a/b/' /tmp/w.txt", ["/repo/.txt"]],
      // GNU permutes and runs src/x as an -e script, unless POSIXLY_CORRECT
      // is set, when it stops at `s/a/b/` and edits `-e` and src/x.
      ["POSIXLY_CORRECT=1 sed -i 's/a/b/' -e src/x", ["/repo/-e", "/repo/src/x"]],
      ["env POSIXLY_CORRECT=1 sed -i 's/a/b/' -e src/x", ["/repo/-e", "/repo/src/x"]],
      ["sed -i 's/a/b/' -e src/x", ["/repo/-e", "/repo/src/x"]],
    ])("reports a write either sed would make: %s", (command, blockedTargets) => {
      const decision = classify(command);

      expect(decision.blocked).toBe(true);
      expect(decision.indeterminate).toBe(false);
      expect(decision.blockedTargets).toEqual(blockedTargets);
    });

    it.each([
      // BSD takes the first -e as the suffix and edits the words after the
      // script, `-e` and `s/c/d/`, as files; they do not exist.
      ["sed -i -e 's/a/b/' -e 's/c/d/' tmp/file.txt", ["/repo/tmp/file.txt", "/repo/tmp/file.txt-e"]],
      // GNU edits .bak, and s/a/b/p with -n, as files; they do not exist.
      ["sed -i .bak -e 's/a/b/' tmp/file.txt", ["/repo/tmp/file.txt", "/repo/tmp/file.txt.bak"]],
      ["sed -n -i '' 's/a/b/p' tmp/file.txt", ["/repo/tmp/file.txt"]],
    ])("does not report a disputed word that is not a file: %s", (command, observedTargets) => {
      const decision = classify(command);

      expect(decision.blocked).toBe(false);
      expect(decision.indeterminate).toBe(false);
      expect(decision.observedTargets).toEqual(observedTargets);
    });

    it.each([
      ["sed -i 's/a/b/' /tmp/w.txt", [realTmp("w.txt")]],
      ["sed -i 's/a/b/' /tmp/www/index.html", [realTmp("www/index.html")]],
      ["sed -i .bak -e 's/a/b/' tmp/file.txt", ["/repo/tmp/file.txt"]],
      ["sed -i p 'w src/out' tmp/input", ["/repo/tmp/input"]],
    ])("counts only GNU sed's writes on Linux: %s", (command, observedTargets) => {
      const decision = classify(command, undefined, "linux");

      expect(decision.blocked).toBe(false);
      expect(decision.observedTargets).toEqual(observedTargets);
    });

    it("fails closed on a letter GNU may accept as a command in a newer version", () => {
      const decision = classify("sed -i orig 's/a/b/' tmp/file.txt");

      expect(decision.indeterminate).toBe(true);
      expect(decision.blocked).toBe(true);
      expect(decision.observedTargets).toEqual(["/repo/tmp/file.txt", "/repo/tmp/file.txtorig"]);
    });

    it("fails closed on an option neither sed accepts", () => {
      const decision = classify("sed -x p tmp/file.txt");

      expect(decision.indeterminate).toBe(true);
      expect(decision.blocked).toBe(true);
    });
  });

  describe("sed behind env, and gsed", () => {
    it.each([
      "env sed -i 's/a/b/' src/x",
      "env FOO=1 sed -i 's/a/b/' src/x",
      "env -i sed -i 's/a/b/' src/x",
      "env -u HOME -- sed -i 's/a/b/' src/x",
      "env --unset=HOME /usr/bin/sed -i 's/a/b/' src/x",
      "gsed -i 's/a/b/' src/x",
      "env gsed -i 's/a/b/' src/x",
    ])("sends the command to the sed analysis: %s", (command) => {
      const decision = classify(command);

      expect(decision.blocked).toBe(true);
      expect(decision.indeterminate).toBe(false);
      expect(decision.blockedTargets).toEqual(["/repo/src/x"]);
    });

    it("reads gsed as GNU sed only", () => {
      const decision = classify("gsed -i -e 's/a/b/' -e 's/c/d/' tmp/file.txt");

      expect(decision.blocked).toBe(false);
      expect(decision.observedTargets).toEqual(["/repo/tmp/file.txt"]);
    });

    it.each([
      "env -S 'sed -i s/a/b/ src/x'",
      "env --split-string='sed -i s/a/b/ src/x'",
      "env -C src sed -i 's/a/b/' x",
      "env $TOOL -i 's/a/b/' src/x",
      "env --frobnicate sed -i 's/a/b/' tmp/x",
    ])("fails closed when env hides the command: %s", (command) => {
      const decision = classify(command);

      expect(decision.indeterminate).toBe(true);
      expect(decision.blocked).toBe(true);
    });
  });

  it("blocks the file a w command writes even without -i", () => {
    const decision = classify("sed 's/a/b/w out.txt' file.txt");

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual(["/repo/out.txt"]);
    expect(decision.observedTargets).toEqual(["/repo/out.txt"]);
  });

  it.each([
    ["sed -n '$W src/last-line.txt' src/app.ts", ["/repo/src/last-line.txt"]],
    ["sed -n '/error/w src/errors.log' build/out.log", ["/repo/src/errors.log"]],
    ["sed -e 's/a/b/w src/changed.ts' -e p src/app.ts", ["/repo/src/changed.ts"]],
    ["sed -n '/start/,/end/{\n/skip/!w src/range.txt\n}' src/app.ts", ["/repo/src/range.txt"]],
    ["sed ':a;N;$!ba;s/\\n/ /g;w src/joined.txt' src/app.ts", ["/repo/src/joined.txt"]],
    ["sed -n 's/[/]/_/w src/slashes.txt' src/app.ts", ["/repo/src/slashes.txt"]],
    ["sed -n 'p;w src/copy.ts' src/app.ts", ["/repo/src/copy.ts"]],
    ["sed -n '1{w src/first.ts\n}' src/app.ts", ["/repo/src/first.ts"]],
  ])("blocks the w and W targets of a script: %s", (command, blockedTargets) => {
    const decision = classify(command);

    expect(decision.blocked).toBe(true);
    expect(decision.indeterminate).toBe(false);
    expect(decision.blockedTargets).toEqual(blockedTargets);
  });

  it("reads a w file name to the end of the line, as sed does", () => {
    const decision = classify("sed -n 'w tmp/out.txt; p' src/app.ts");

    expect(decision.blocked).toBe(false);
    expect(decision.observedTargets).toEqual(["/repo/tmp/out.txt; p"]);
  });

  it.each([
    // `tmp ` with a trailing blank is not the tmp directory.
    ["sed -n 'w tmp ' tmp/input", ["/repo/tmp "]],
    ["sed -i' tmp/*' 's/a/b/' tmp/file.txt", ["/repo/ tmp/tmp/file.txt"]],
    ["sed -i 's/a/b/' ' tmp/file.txt'", ["/repo/ tmp/file.txt"]],
  ])("keeps the blanks sed keeps in a file name: %s", (command, blockedTargets) => {
    const decision = classify(command);

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual(blockedTargets);
  });

  it("checks the w target and the edited file of one command", () => {
    const decision = classify("sed -i 's/a/b/w tmp/changes.log' src/app.ts");

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual(["/repo/src/app.ts"]);
    // sed opens the w file while it compiles the script, before any edit.
    expect(decision.observedTargets).toEqual(["/repo/tmp/changes.log", "/repo/src/app.ts"]);
  });

  it.each([
    "sed -n '/error/w tmp/errors.log' build/out.log",
    "sed -n 's/a/b/w /dev/stdout' src/app.ts",
    "sed -n 'w /tmp/sed-copy.txt' src/app.ts",
  ])("allows a w target outside the protected workspace files: %s", (command) => {
    const decision = classify(command);

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
  });

  it.each([
    "sed -n 'p' src/app.ts",
    "sed -n '1,20p' src/app.ts",
    "sed -n '/^export /p' src/app.ts",
    "sed 's/w/W/g; s/e/E/' src/app.ts",
    "sed '/marker/r src/header.ts' src/app.ts",
    "sed 'r notes.txt; w src/x.ts' src/app.ts",
    "sed '1i w src/x.ts' src/app.ts",
    "sed '1a\\\nw src/x.ts' src/app.ts",
    "sed -e '$a\\' -e 'w src/x.ts' src/app.ts",
    "sed 'y/abc/xyz/' src/app.ts",
    "sed --quiet --expression='10q;p' src/app.ts",
  ])("does not report a write for a read-only script: %s", (command) => {
    const decision = classify(command);

    expect(decision.observedTargets).toEqual([]);
    expect(decision.indeterminate).toBe(false);
    expect(decision.blocked).toBe(false);
  });

  it("keeps a redirect as the only write of a sed filter", () => {
    const decision = classify("sed 's/a/b/' src/app.ts > tmp/app.ts");

    expect(decision.blocked).toBe(false);
    expect(decision.observedTargets).toEqual(["/repo/tmp/app.ts"]);
  });

  it("leaves a script sed rejects before it opens a file to sed", () => {
    const unbalanced = classify("sed -n '{p' src/app.ts");
    expect(unbalanced.blocked).toBe(false);
    expect(unbalanced.observedTargets).toEqual([]);

    // Both seds refuse a w flag without a file name while compiling.
    const missingFile = classify("sed 's/a/b/w' src/app.ts");
    expect(missingFile.blocked).toBe(false);
    expect(missingFile.indeterminate).toBe(false);
    expect(missingFile.observedTargets).toEqual([]);
  });

  it.each([
    "sed 's/.*/date/e' tmp/file.txt",
    "sed -n '1e' tmp/file.txt",
  ])("fails closed when a script runs its pattern space: %s", (command) => {
    const decision = classify(command);

    expect(decision.indeterminate).toBe(true);
    expect(decision.blocked).toBe(true);
  });

  it.each([
    'sed "$SCRIPT" tmp/file.txt',
    'sed -n "s/x/y/w $OUT" tmp/file.txt',
    'sed -i "$SUFFIX" "s/a/b/" tmp/file.txt',
  ])("fails closed when a shell variable decides what sed writes: %s", (command) => {
    const decision = classify(command);

    expect(decision.indeterminate).toBe(true);
    expect(decision.blocked).toBe(true);
  });

  describe("protected paths", () => {
    it.each([
      ["sed -i 's/a/b/' tmp/.git/config", ["/repo/tmp/.git/config"]],
      ["sed -n 'w tmp/.git/config' tmp/input", ["/repo/tmp/.git/config"]],
      ["sed -n 'w /nobody-home/.bashrc' tmp/input", ["/nobody-home/.bashrc"]],
      ["sed -i 's/a/b/' /nobody-home/.gitconfig", ["/nobody-home/.gitconfig"]],
      ["sed 's/a/b/w dist/.agenc/state.json' tmp/input", ["/repo/dist/.agenc/state.json"]],
    ])("refuses a protected path under a generated directory or outside the workspace: %s", (command, blockedTargets) => {
      const decision = classify(command);

      expect(decision.blocked).toBe(true);
      expect(decision.blockedTargets).toEqual(blockedTargets);
      expect(decision.message).toContain("may not write protected paths");
    });

    it("refuses a write into the AgenC home", () => {
      const decision = classifyShellWorkspaceWritePolicy({
        toolName: "exec_command",
        args: { command: "sed -n 'w /Users/dev/agenc-home/state.json' tmp/input" },
        workspaceRoot: WORKSPACE_ROOT,
        protectedRoots: ["/Users/dev/agenc-home"],
        platform: "darwin",
      });

      expect(decision.blocked).toBe(true);
      expect(decision.blockedTargets).toEqual(["/Users/dev/agenc-home/state.json"]);
    });

    it("protects only what is below the root of a worktree placed under .agenc", () => {
      const inWorktree = (command: string) =>
        classifyShellWorkspaceWritePolicy({
          toolName: "exec_command",
          args: { command },
          workspaceRoot: "/Users/dev/.agenc/worktrees/project",
          platform: "darwin",
        });

      expect(inWorktree("sed -i 's/a/b/' tmp/notes.txt").blocked).toBe(false);
      expect(inWorktree("sed -i 's/a/b/' tmp/.git/config").blocked).toBe(true);
    });
  });

  it.each([
    ['sed -n "/foo$/p" src/app.ts', []],
    ['sed -n "s/foo$/bar/p" src/app.ts', []],
    ['sed "/^$/d" src/app.ts', []],
    ['sed -e "s/ *$//" -e "/^$/d" src/app.ts', []],
    ['sed -i "s/ *$//" tmp/file.txt', ["/repo/tmp/file.txt"]],
  ])("reads a $ anchor in a double-quoted script as literal: %s", (command, observedTargets) => {
    const decision = classify(command);

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
    expect(decision.observedTargets).toEqual(observedTargets);
  });

  it("reads a variable where sed expects a file as that file", () => {
    const decision = classify('sed -n "1,5p" "$f"');

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
  });

  describe("what the command line does not show", () => {
    it.each([
      ["sed -f tmp/evil.sed tmp/input", []],
      ["sed --file=tmp/evil.sed tmp/input", []],
      ["sed --file tmp/evil.sed tmp/input", []],
      ["sed -f tmp/transform.sed src/app.ts", []],
      ["sed -f tmp/evil.sed -e 'w src/x' tmp/input", ["/repo/src/x"]],
      ["sed -f script.sed -i tmp/file.txt", ["/repo/tmp/file.txt"]],
      ["sed -i -f tmp/fix.sed src/app.ts", ["/repo/src/app.ts"]],
      ["sed -i -f tmp/colors.sed config/theme.toml", ["/repo/config/theme.toml"]],
    ])("fails closed on a script file and keeps the targets it sees: %s", (command, targets) => {
      const decision = classify(command);

      expect(decision.indeterminate).toBe(true);
      expect(decision.blocked).toBe(true);
      expect(decision.observedTargets).toEqual(targets);
    });

    it.each([
      ['sed -i "s/$OLD/$NEW/g" tmp/file.txt', ["/repo/tmp/file.txt"]],
      ['sed -n "${START},${END}p" src/app.ts', []],
      ["sed -$FLAGS p src/app.ts", []],
      // The lexer cannot decode $'...' quoting: `\167` is a `w`.
      ["sed $'\\167 src/x' tmp/input", []],
      ["sed $'s/\\t/ /g' src/app.ts", []],
      ["sed -i $'s/\\t/ /g' src/app.ts", ["/repo/src/app.ts"]],
    ])("fails closed on a word the shell still expands: %s", (command, targets) => {
      const decision = classify(command);

      expect(decision.indeterminate).toBe(true);
      expect(decision.blocked).toBe(true);
      expect(decision.observedTargets).toEqual(targets);
    });

    it.each([
      "sed 'e python3 -c \"open(\\\"src/x\\\",\\\"w\\\").close()\"' tmp/input",
      "sed '1e echo done' tmp/file.txt",
    ])("fails closed on a command the script runs: %s", (command) => {
      const decision = classify(command);

      expect(decision.indeterminate).toBe(true);
      expect(decision.blocked).toBe(true);
    });

    it("still checks the targets of a command the script runs", () => {
      const decision = classify("sed '1e touch src/x.ts' tmp/file.txt");

      expect(decision.indeterminate).toBe(true);
      expect(decision.blocked).toBe(true);
      expect(decision.blockedTargets).toEqual(["/repo/src/x.ts"]);
    });

    it.each([
      ["sed --follow-symlinks -i 's/a/b/' tmp/link", ["/repo/tmp/link"]],
      ["sed --follow -i 's/a/b/' tmp/link", ["/repo/tmp/link"]],
      [
        "sed -i --follow-symlinks 's/a/b/' tmp/link",
        ["/repo/tmp/link", "/repo/tmp/link--follow-symlinks"],
      ],
    ])("fails closed on an in-place edit that follows symlinks: %s", (command, targets) => {
      const decision = classify(command);

      expect(decision.indeterminate).toBe(true);
      expect(decision.blocked).toBe(true);
      expect(decision.observedTargets).toEqual(targets);
    });
  });

  it("parses an argument vector without a shell the same way", () => {
    const decision = classifyShellWorkspaceWritePolicy({
      toolName: "exec_command",
      args: { command: "sed", args: ["-i", "s/const cols = 12;/const cols = 6;/", "tmp/game.js"] },
      workspaceRoot: WORKSPACE_ROOT,
    });

    expect(decision.blocked).toBe(false);
    expect(decision.observedTargets).toEqual(["/repo/tmp/game.js"]);
  });
});

describe("classifyShellWorkspaceWritePolicy for sed in a real workspace", () => {
  let workspace = "";
  let home = "";

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "sed-policy-"));
    home = mkdtempSync(join(tmpdir(), "sed-policy-home-"));
    writeFileSync(join(home, ".gitconfig"), "[user]\n");
    mkdirSync(join(workspace, ".git"));
    writeFileSync(join(workspace, ".git", "config"), "[core]\n");
    mkdirSync(join(workspace, "src"));
    mkdirSync(join(workspace, "tmp"));
    writeFileSync(join(workspace, ".env"), "KEY=1\n");
    writeFileSync(join(workspace, "src", "app.ts"), "export {};\n");
    writeFileSync(join(workspace, "src", "x"), "a\n");
    writeFileSync(join(workspace, "tmp", "input"), "a\n");
    writeFileSync(join(workspace, "tmp", "one.txt"), "a\n");
    symlinkSync("../src/app.ts", join(workspace, "tmp", "link"));
    symlinkSync("../src", join(workspace, "tmp", "dirlink"));
    symlinkSync("../src/missing.ts", join(workspace, "tmp", "dangling"));
    symlinkSync("../.git", join(workspace, "tmp", "gitlink"));
    symlinkSync("../missing-dir", join(workspace, "tmp", "nowhere"));
    symlinkSync(join(home, ".gitconfig"), join(workspace, "tmp", "outlink"));
    symlinkSync("../.git/newfile", join(workspace, "tmp", "gitnew"));
    symlinkSync("loop2", join(workspace, "tmp", "loop1"));
    symlinkSync("loop1", join(workspace, "tmp", "loop2"));
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function classifyIn(command: string, platform: NodeJS.Platform = "darwin", bypassed = false) {
    return classifyShellWorkspaceWritePolicy({
      toolName: "exec_command",
      args: { command },
      workspaceRoot: workspace,
      platform,
      ...(bypassed ? { bypassesApprovalsAndSandbox: true } : {}),
    });
  }

  it.each([
    ["sed -n 'w tmp/link' tmp/input", "src/app.ts"],
    ["sed -n 'W tmp/link' tmp/input", "src/app.ts"],
    ["sed 's/a/b/w tmp/link' tmp/input", "src/app.ts"],
    ["sed -n 'w tmp/dirlink/new.ts' tmp/input", "src/new.ts"],
  ])("judges a w file by the file its symlinks reach: %s", (command, reached) => {
    const decision = classifyIn(command);

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual([join(workspace, reached)]);
    expect(classifyIn("sed -n 'w tmp/plain.txt' tmp/input").blocked).toBe(false);
  });

  it("judges a w file behind a symlink to nothing by the file the write would create", () => {
    // tmp/dangling is ../src/missing.ts, which the write creates.
    const decision = classifyIn("sed -n 'w tmp/dangling' tmp/input");

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual([join(workspace, "src/missing.ts")]);
  });

  it.each([false, true])(
    "refuses a w file behind a dangling symlink into a protected path (full bypass: %s)",
    (bypassed) => {
      // tmp/gitnew is ../.git/newfile, which does not exist yet; sed would create it.
      const decision = classifyIn("sed -n 'w tmp/gitnew' tmp/input", "darwin", bypassed);

      expect(decision.blocked).toBe(true);
      expect(decision.blockedTargets).toEqual([join(workspace, ".git/newfile")]);
      expect(decision.message).toContain("may not write protected paths");
    },
  );

  it("refuses a w file whose destination cannot be determined, even with approvals bypassed", () => {
    const decision = classifyIn("sed -n 'w tmp/loop1' tmp/input", "darwin", true);

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual([join(workspace, "tmp/loop1")]);
    expect(decision.message).toContain("destination cannot be determined");
  });

  it.each([
    ["sed -i '' src/x", ["src/x"]],
    ["gsed -i.bak '' src/x", ["src/x", "src/x.bak"]],
  ])("reports the files an empty GNU script rewrites: %s", (command, targets) => {
    for (const platform of ["darwin", "linux"] as const) {
      const decision = classifyIn(command, platform);

      expect(decision.blocked).toBe(true);
      expect(decision.blockedTargets).toEqual(targets.map((target) => join(workspace, target)));
    }
  });

  it.each([
    ["sed -i 's/a/b/' tmp/gitlink/config", [".git/config"]],
    ["sed -i.bak 's/a/b/' tmp/gitlink/config", [".git/config", ".git/config.bak"]],
  ])("resolves the directory of an in-place file through symlinks: %s", (command, targets) => {
    const decision = classifyIn(command);

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual(targets.map((target) => join(workspace, target)));
    expect(decision.message).toContain("may not write protected paths");
  });

  it("judges an in-place file in a linked directory where it lands, and a linked file as written", () => {
    // tmp/dirlink is ../src, so this replaces src/app.ts.
    const throughDirectory = classifyIn("sed -i 's/a/b/' tmp/dirlink/app.ts");
    expect(throughDirectory.blocked).toBe(true);
    expect(throughDirectory.blockedTargets).toEqual([join(workspace, "src/app.ts")]);

    // sed -i replaces the link tmp/link itself, not src/app.ts.
    const leafLink = classifyIn("sed -i 's/a/b/' tmp/link");
    expect(leafLink.blocked).toBe(false);
    expect(leafLink.observedTargets).toEqual([join(workspace, "tmp/link")]);
  });

  it("judges an in-place file behind a directory link to nothing where it would land", () => {
    // tmp/nowhere is ../missing-dir.
    const decision = classifyIn("sed -i 's/a/b/' tmp/nowhere/x");

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual([join(workspace, "missing-dir/x")]);
  });

  it("refuses a w file that reaches a protected file outside the workspace", () => {
    const decision = classifyIn("sed -n 'w tmp/outlink' tmp/input");

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual([join(realpathSync(home), ".gitconfig")]);
    expect(decision.message).toContain("may not write protected paths");
  });

  it("edits a word the readings dispute only when it is a file", () => {
    // GNU edits .env, .bak and tmp/one.txt as files; BSD takes each as the
    // backup suffix. Only .bak does not exist.
    expect(classifyIn("sed -e 's/a/b/' -i .env tmp/input").blockedTargets).toEqual([
      join(workspace, ".env"),
    ]);
    expect(classifyIn("sed -e 's/a/b/' -i .bak tmp/input").blocked).toBe(false);
    expect(classifyIn("sed -e 's/a/b/' -i tmp/one.txt tmp/input").observedTargets).toEqual([
      join(workspace, "tmp/one.txt"),
      join(workspace, "tmp/input"),
      join(workspace, "tmp/inputtmp/one.txt"),
    ]);
  });
});

describe("classifyShellWorkspaceWritePolicy with added directories", () => {
  const ADDED_ROOT = "/srv/agenc-added-root";

  function classifyWithAdded(command: string, allowWorkspaceDeletions: boolean) {
    return classifyShellWorkspaceWritePolicy({
      toolName: "exec_command",
      args: { command },
      workspaceRoot: WORKSPACE_ROOT,
      allowWorkspaceDeletions,
      additionalRoots: [ADDED_ROOT],
    });
  }

  it("treats a removal under an added directory like a workspace removal", () => {
    const promptFree = classifyWithAdded(`rm ${ADDED_ROOT}/stale.log`, true);
    expect(promptFree.blocked).toBe(false);
    // Granted by the user, but not a workspace path: no sidecar backup.
    expect(promptFree.deletionTargets).toEqual([]);

    const prompting = classifyWithAdded(`rm ${ADDED_ROOT}/stale.log`, false);
    expect(prompting.blocked).toBe(true);
    expect(prompting.message).toContain("shell_workspace_file_delete_requires_approval");
    expect(prompting.message).not.toContain("only inside the workspace");
  });

  it("still refuses a removal outside every root", () => {
    const decision = classifyWithAdded("rm /srv/agenc-elsewhere/file.txt", true);
    expect(decision.blocked).toBe(true);
    expect(decision.message).toContain("only inside the workspace");
  });
});
