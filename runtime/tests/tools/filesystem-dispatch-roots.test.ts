import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ALLOWED_ROOTS_SIG_ARG,
  verifyAllowedRoots,
} from "../../src/agents/_deps/filesystem-args.js";
import {
  approvalRootForDispatch,
  filesystemRootsForDispatch,
} from "../../src/tools/filesystem-dispatch-roots.js";

function signedRoots(args: Record<string, unknown>): string[] {
  return verifyAllowedRoots(args[SESSION_ALLOWED_ROOTS_ARG], args[SESSION_ALLOWED_ROOTS_SIG_ARG]);
}

function session(mode: string, added: readonly string[] = []) {
  return {
    permissionModeRegistry: {
      current: () => ({
        mode,
        additionalWorkingDirectories: new Map(
          added.map((path) => [path, { path, source: "cliArg" }]),
        ),
      }),
    },
  };
}

describe("filesystemRootsForDispatch", () => {
  let outside = "";

  beforeEach(async () => {
    outside = await mkdtemp(join(tmpdir(), "agenc-dispatch-roots-"));
  });

  afterEach(async () => {
    if (outside) await rm(outside, { recursive: true, force: true });
    outside = "";
  });

  test("an approval hands the tool the file's directory, as before", () => {
    const target = join(outside, "nginx.conf");
    const approvalRoot = approvalRootForDispatch("Edit", { file_path: target });
    const args = filesystemRootsForDispatch("Edit", { file_path: target }, {
      approvalResolved: true,
      approvalRoot,
      sandboxMode: "workspace_write",
      session: session("default"),
    });
    expect(signedRoots(args)).toContain(dirname(target));
  });

  test("NotebookEdit is widened from notebook_path, the only path field its schema has", () => {
    const target = join(outside, "shared.ipynb");
    const input = { notebook_path: target, cell_id: "0", new_source: "# Shared" };
    for (const [approvalResolved, sandboxMode, mode] of [
      [true, "workspace_write", "default"],
      [false, "danger_full_access", "bypassPermissions"],
    ] as const) {
      const args = filesystemRootsForDispatch("NotebookEdit", input, {
        approvalResolved,
        approvalRoot: approvalRootForDispatch("NotebookEdit", input),
        sandboxMode,
        session: session(mode),
      });
      expect(signedRoots(args)).toContain(dirname(target));
      // The widening rides the internal channel; no file_path is invented.
      expect(Object.keys(args).filter((key) => !key.startsWith("__agenc")).sort())
        .toEqual(["cell_id", "new_source", "notebook_path"]);
    }
  });

  test("the full bypass hands it out without a prompt", () => {
    // Under --dangerously-bypass-approvals-and-sandbox the evaluator never
    // runs, so no approval ever resolved; FileRead /build/... was refused by
    // the tool's own confinement in the Terminal-Bench runs.
    const target = join(outside, "locale_init.cc");
    const args = filesystemRootsForDispatch("FileRead", { file_path: target }, {
      approvalResolved: false,
      sandboxMode: "danger_full_access",
      session: session("bypassPermissions"),
    });
    expect(signedRoots(args)).toContain(dirname(target));
  });

  test("bypassPermissions with a sandbox still on does not widen", () => {
    const target = join(outside, "locale_init.cc");
    const input = { file_path: target };
    const args = filesystemRootsForDispatch("FileRead", input, {
      approvalResolved: false,
      sandboxMode: "workspace_write",
      session: session("bypassPermissions"),
    });
    expect(args).toBe(input);
  });

  test("a path inside a directory the user added is widened in any mode", () => {
    const target = join(outside, "deploy", "hook.sh");
    const args = filesystemRootsForDispatch("Write", { file_path: target }, {
      approvalResolved: false,
      sandboxMode: "workspace_write",
      session: session("default", [outside]),
    });
    expect(signedRoots(args)).toContain(dirname(target));
  });

  test("a prompting session without an added directory leaves the args alone", () => {
    const input = { file_path: join(outside, "x.txt") };
    const args = filesystemRootsForDispatch("Edit", input, {
      approvalResolved: false,
      sandboxMode: "danger_full_access",
      session: session("default"),
    });
    expect(args).toBe(input);
  });

  test("Glob and Grep get their search directory itself under the full bypass", async () => {
    // The first 4.0 trial: `Glob path=/` refused while FileRead /etc/... passed.
    const glob = filesystemRootsForDispatch("Glob", { pattern: "**/*", path: outside }, {
      approvalResolved: false,
      sandboxMode: "danger_full_access",
      session: session("bypassPermissions"),
    });
    expect(signedRoots(glob)).toContain(outside);
    const file = join(outside, "notes.txt");
    await writeFile(file, "x\n");
    const grep = filesystemRootsForDispatch("Grep", { pattern: "x", path: file }, {
      approvalResolved: false,
      sandboxMode: "danger_full_access",
      session: session("bypassPermissions"),
    });
    expect(signedRoots(grep)).toContain(outside);
    await mkdir(join(outside, "src"));
    const absolutePattern = filesystemRootsForDispatch("Glob", { pattern: join(outside, "src", "**", "*.ts") }, {
      approvalResolved: false,
      sandboxMode: "danger_full_access",
      session: session("bypassPermissions"),
    });
    expect(signedRoots(absolutePattern)).toContain(join(outside, "src"));
  });

  test("a Glob of the workspace and a search in a prompting session stay untouched", () => {
    const relative = { pattern: "**/*.ts" };
    expect(
      filesystemRootsForDispatch("Glob", relative, {
        approvalResolved: false,
        sandboxMode: "danger_full_access",
        session: session("bypassPermissions"),
      }),
    ).toBe(relative);
    const prompting = { pattern: "x", path: outside };
    expect(
      filesystemRootsForDispatch("Grep", prompting, {
        approvalResolved: false,
        sandboxMode: "danger_full_access",
        session: session("default"),
      }),
    ).toBe(prompting);
  });

  test("tools without a file_path and unknown sessions are never widened", () => {
    const shell = { cmd: "ls /etc" };
    expect(
      filesystemRootsForDispatch("exec_command", shell, {
        approvalResolved: false,
        sandboxMode: "danger_full_access",
        session: session("bypassPermissions"),
      }),
    ).toBe(shell);
    const noSession = { file_path: join(outside, "x.txt") };
    expect(
      filesystemRootsForDispatch("Edit", noSession, {
        approvalResolved: false,
        sandboxMode: "danger_full_access",
      }),
    ).toBe(noSession);
  });

  describe.skipIf(process.platform === "win32")("symlinks", () => {
    let dirA = "";
    let dirB = "";
    let link = "";

    beforeEach(async () => {
      await mkdir(join(outside, "a"));
      await mkdir(join(outside, "b"));
      dirA = await realpath(join(outside, "a"));
      dirB = await realpath(join(outside, "b"));
      link = join(outside, "link");
      await symlink(dirA, link);
    });

    async function retargetLinkToB(): Promise<void> {
      await symlink(dirB, `${link}.next`);
      await rename(`${link}.next`, link);
    }

    test.each([
      ["NotebookEdit", "notebook_path", "shared.ipynb"],
      ["Edit", "file_path", "notes.txt"],
      ["Write", "file_path", "created.txt"],
    ] as const)(
      "%s: an approval grants the root resolved before the prompt, not where the link points after it",
      async (toolName, pathArg, name) => {
        const input = { [pathArg]: join(link, name) };
        const approvalRoot = approvalRootForDispatch(toolName, input);
        expect(approvalRoot).toBe(dirA);

        await retargetLinkToB();
        const args = filesystemRootsForDispatch(toolName, input, {
          approvalResolved: true,
          approvalRoot,
          sandboxMode: "workspace_write",
          session: session("default"),
        });

        expect(signedRoots(args)).toEqual([dirA]);
      },
    );

    test("an approval without a root captured before the prompt widens nothing", () => {
      const input = { file_path: join(link, "notes.txt") };
      expect(
        filesystemRootsForDispatch("Edit", input, {
          approvalResolved: true,
          sandboxMode: "workspace_write",
          session: session("default"),
        }),
      ).toBe(input);
    });

    test("a symlink inside an added directory that leads out of it is not widened", async () => {
      const added = join(outside, "added");
      await mkdir(added);
      await symlink(dirA, join(added, "escape"));
      const input = { file_path: join(added, "escape", "notes.txt") };

      expect(
        filesystemRootsForDispatch("Write", input, {
          approvalResolved: false,
          sandboxMode: "workspace_write",
          session: session("default", [added]),
        }),
      ).toBe(input);
    });

    test("a path whose resolved form lies in an added directory gets that canonical directory", () => {
      const input = { file_path: join(link, "notes.txt") };
      const args = filesystemRootsForDispatch("Write", input, {
        approvalResolved: false,
        sandboxMode: "workspace_write",
        session: session("default", [dirA]),
      });
      expect(signedRoots(args)).toEqual([dirA]);
    });

    test("the full bypass signs the canonical directory, not the link", () => {
      const input = { file_path: join(link, "notes.txt") };
      const args = filesystemRootsForDispatch("FileRead", input, {
        approvalResolved: false,
        sandboxMode: "danger_full_access",
        session: session("bypassPermissions"),
      });
      expect(signedRoots(args)).toEqual([dirA]);
    });
  });
});
