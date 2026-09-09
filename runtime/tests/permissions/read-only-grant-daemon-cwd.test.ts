/**
 * The daemon condition: the run's folder is not the process's folder.
 *
 * A daemon hosts many sessions and works from its own home (app-server/
 * daemon-working-directory.ts), so for a routine in `~/Documents/project`
 * nothing about the process names that project. Every case here therefore
 * uses a real directory that is NOT `process.cwd()` and a permission context
 * with no directory grants at all, which is what the routine path actually
 * builds. The shipped tests seeded the run folder into
 * `additionalWorkingDirectories`, an alignment production never provides, and
 * that is why they passed while a real routine was refused its own folder.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  readShellCommand,
  shellCallIsGranted,
  type ShellGateDeps,
} from "../../src/permissions/read-only-grant.js";
import { checkReadOnlyConstraints } from "../../src/tools/BashTool/readOnlyValidation.js";
import { checkPathConstraints } from "../../src/tools/BashTool/pathValidation.js";
import { createEmptyToolPermissionContext } from "./types.js";

/** The real gates, so this is checked against shipped behaviour. */
const deps: ShellGateDeps = {
  checkReadOnly: (input) =>
    checkReadOnlyConstraints(input as never, false) as { behavior: string },
  checkPaths: (input, cwd, ctx) =>
    checkPathConstraints(input as never, cwd, ctx) as { behavior: string },
};

/** No directory grants: exactly what the routine path builds. */
const context = createEmptyToolPermissionContext({ mode: "unattended" });

let runFolder: string;
let subFolder: string;

beforeAll(() => {
  runFolder = resolve(mkdtempSync(join(tmpdir(), "readonly-grant-run-")));
  subFolder = join(runFolder, "src");
  mkdirSync(subFolder);
  writeFileSync(join(runFolder, "README.md"), "hello\n");
});

describe("read-only grant in a daemon-hosted run", () => {
  it("is measured against a folder the process is not in", () => {
    expect(runFolder).not.toBe(resolve(process.cwd()));
  });

  it("grants a read-only command in the run's own folder", () => {
    expect(
      shellCallIsGranted(
        "exec_command",
        { cmd: "df -h /", workdir: runFolder },
        runFolder,
        context,
        deps,
      ),
    ).toEqual({ ok: true });
  });

  it("grants reading a file inside the run's folder", () => {
    expect(
      shellCallIsGranted(
        "exec_command",
        { cmd: `cat "${join(runFolder, "README.md")}"` },
        runFolder,
        context,
        deps,
      ),
    ).toEqual({ ok: true });
  });

  it("grants a workdir that is a subdirectory of the run's folder", () => {
    expect(
      shellCallIsGranted(
        "exec_command",
        { cmd: "ls", workdir: subFolder },
        runFolder,
        context,
        deps,
      ),
    ).toEqual({ ok: true });
  });

  it("accepts a relative workdir of '.'", () => {
    expect(
      shellCallIsGranted(
        "exec_command",
        { cmd: "ls", workdir: "." },
        runFolder,
        context,
        deps,
      ),
    ).toEqual({ ok: true });
  });

  it("still refuses reading outside the run's folder", () => {
    expect(
      shellCallIsGranted(
        "exec_command",
        { cmd: "cat /etc/passwd" },
        runFolder,
        context,
        deps,
      ),
    ).toEqual({ ok: false, reason: "it reads outside this project folder" });
  });

  it("still refuses a workdir outside the run's folder", () => {
    expect(
      shellCallIsGranted(
        "exec_command",
        { cmd: "ls", workdir: "/etc" },
        runFolder,
        context,
        deps,
      ),
    ).toEqual({ ok: false, reason: "it runs in a different folder" });
  });

  it("still refuses a command that writes", () => {
    expect(
      shellCallIsGranted(
        "exec_command",
        { cmd: `rm -rf "${runFolder}"` },
        runFolder,
        context,
        deps,
      ),
    ).toEqual({ ok: false, reason: "the command is not read-only" });
  });

  it("refuses when the caller cannot name the run's folder", () => {
    expect(
      shellCallIsGranted("exec_command", { cmd: "ls" }, null, context, deps),
    ).toEqual({ ok: false, reason: "this run has no folder of its own" });
  });
});

describe("system.bash names its per-call folder and operands differently", () => {
  it("reads system.bash's `cwd` as the per-call working directory", () => {
    expect(readShellCommand("system.bash", { command: "ls", cwd: "/etc" })).toEqual(
      { command: "ls", workdir: "/etc" },
    );
  });

  it("refuses a system.bash call whose folder is outside the run's", () => {
    expect(
      shellCallIsGranted(
        "system.bash",
        { command: "ls", cwd: "/etc" },
        runFolder,
        context,
        deps,
      ),
    ).toEqual({ ok: false, reason: "it runs in a different folder" });
  });

  it("refuses direct mode, whose operands never reach either gate", () => {
    // Both gates only ever see the bare word "cat": read-only, no paths.
    expect(
      shellCallIsGranted(
        "system.bash",
        { command: "cat", args: ["/etc/passwd"] },
        runFolder,
        context,
        deps,
      ),
    ).toEqual({ ok: false, reason: "its arguments are not part of the command" });
  });
});
