import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { probePosixShellPath } from "../../../src/utils/shell/posixShellPath.js";

const actualStatSync = fs.statSync;
let directory = "";
let execSpy: ReturnType<typeof vi.spyOn<typeof childProcess, "execFileSync">>;
let statSpy: ReturnType<typeof vi.spyOn<typeof fs, "statSync">>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agenc-shell-preflight-"));
  // The shell helper may already be imported by native ESM setup. Observe
  // the actual builtins and refresh those named exports, not a test-only copy.
  execSpy = vi.spyOn(childProcess, "execFileSync");
  statSpy = vi.spyOn(fs, "statSync");
  syncBuiltinESMExports();
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("shell candidate preflight", () => {
  it("does not spawn for a missing absolute candidate or a non-directory parent", () => {
    expect(probePosixShellPath(join(directory, "bash"), {})).toEqual({ ok: false, reason: "not found" });
    const file = join(directory, "file");
    writeFileSync(file, "not a directory");
    expect(probePosixShellPath(join(file, "bash"), {})).toEqual({ ok: false, reason: "not found" });
    expect(execSpy).not.toHaveBeenCalled();
  });

  it("does not cache absence and verifies a newly installed shell", () => {
    const shell = join(directory, "bash");
    expect(probePosixShellPath(shell, {})).toEqual({ ok: false, reason: "not found" });
    symlinkSync("/bin/bash", shell);
    expect(probePosixShellPath(shell, {})).toEqual({ ok: true });
    expect(execSpy).toHaveBeenCalledOnce();
    unlinkSync(shell);
    expect(probePosixShellPath(shell, {})).toEqual({ ok: false, reason: "not found" });
    expect(execSpy).toHaveBeenCalledOnce();
  });

  it("rejects a broken symlink without spawning but probes every existing target", () => {
    const shell = join(directory, "bash");
    symlinkSync(join(directory, "absent"), shell);
    expect(probePosixShellPath(shell, {})).toEqual({ ok: false, reason: "not found" });
    expect(execSpy).not.toHaveBeenCalled();
    unlinkSync(shell);
    writeFileSync(shell, "#!/bin/sh\nprintf not-a-shell\n");
    chmodSync(shell, 0o700);
    expect(probePosixShellPath(shell, {})).toMatchObject({ ok: false, reason: expect.stringContaining("did not identify") });
    expect(execSpy).toHaveBeenCalledOnce();
  });

  it("does not treat stat success as authorization for a non-executable file", () => {
    const shell = join(directory, "bash");
    writeFileSync(shell, "not executable", { mode: 0o600 });
    expect(probePosixShellPath(shell, {})).toEqual({ ok: false, reason: "not executable" });
    expect(execSpy).toHaveBeenCalledOnce();
  });

  it("retains executable lookup for relative or bare names", () => {
    expect(probePosixShellPath("bash", { PATH: "/bin" })).toEqual({ ok: true });
    expect(statSpy).not.toHaveBeenCalled();
    expect(execSpy).toHaveBeenCalledOnce();
  });

  it("leaves permission and unexpected stat errors to the executable probe", () => {
    for (const code of ["EACCES", "EIO"]) {
      statSpy.mockImplementationOnce(() => { throw Object.assign(new Error(code), { code }); });
      expect(probePosixShellPath("/bin/bash", {})).toEqual({ ok: true });
    }
    expect(execSpy).toHaveBeenCalledTimes(2);
  });

  it("still rejects a candidate removed after stat succeeds", () => {
    const shell = join(directory, "bash");
    symlinkSync("/bin/bash", shell);
    statSpy.mockImplementationOnce(((path: string) => {
      const info = actualStatSync(path);
      unlinkSync(shell);
      return info;
    }) as typeof fs.statSync);
    expect(probePosixShellPath(shell, {})).toEqual({ ok: false, reason: "not found" });
    expect(execSpy).toHaveBeenCalledOnce();
  });
});
