import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

import { probePosixShellPath } from "../../../src/utils/shell/posixShellPath.js";

let directory = "";
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "agenc-shell-preflight-"));
  vi.mocked(execFileSync).mockClear();
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(statSync).mockImplementation(actual.statSync).mockClear();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("shell candidate preflight", () => {
  it("does not spawn for a missing absolute candidate or a non-directory parent", () => {
    expect(probePosixShellPath(join(directory, "bash"), {})).toEqual({ ok: false, reason: "not found" });
    const file = join(directory, "file");
    writeFileSync(file, "not a directory");
    expect(probePosixShellPath(join(file, "bash"), {})).toEqual({ ok: false, reason: "not found" });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("does not cache absence and verifies a newly installed shell", () => {
    const shell = join(directory, "bash");
    expect(probePosixShellPath(shell, {})).toEqual({ ok: false, reason: "not found" });
    symlinkSync("/bin/bash", shell);
    expect(probePosixShellPath(shell, {})).toEqual({ ok: true });
    expect(execFileSync).toHaveBeenCalledOnce();
    unlinkSync(shell);
    expect(probePosixShellPath(shell, {})).toEqual({ ok: false, reason: "not found" });
    expect(execFileSync).toHaveBeenCalledOnce();
  });

  it("rejects a broken symlink without spawning but probes every existing target", () => {
    const shell = join(directory, "bash");
    symlinkSync(join(directory, "absent"), shell);
    expect(probePosixShellPath(shell, {})).toEqual({ ok: false, reason: "not found" });
    expect(execFileSync).not.toHaveBeenCalled();
    unlinkSync(shell);
    writeFileSync(shell, "#!/bin/sh\nprintf not-a-shell\n");
    chmodSync(shell, 0o700);
    expect(probePosixShellPath(shell, {})).toMatchObject({ ok: false, reason: expect.stringContaining("did not identify") });
    expect(execFileSync).toHaveBeenCalledOnce();
  });

  it("does not treat stat success as authorization for a non-executable file", () => {
    const shell = join(directory, "bash");
    writeFileSync(shell, "not executable", { mode: 0o600 });
    expect(probePosixShellPath(shell, {})).toEqual({ ok: false, reason: "not executable" });
    expect(execFileSync).toHaveBeenCalledOnce();
  });

  it("retains executable lookup for relative or bare names", () => {
    expect(probePosixShellPath("bash", { PATH: "/bin" })).toEqual({ ok: true });
    expect(statSync).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledOnce();
  });

  it("leaves permission and unexpected stat errors to the executable probe", () => {
    for (const code of ["EACCES", "EIO"]) {
      vi.mocked(statSync).mockImplementationOnce(() => { throw Object.assign(new Error(code), { code }); });
      expect(probePosixShellPath("/bin/bash", {})).toEqual({ ok: true });
    }
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it("still rejects a candidate removed after stat succeeds", async () => {
    const shell = join(directory, "bash");
    symlinkSync("/bin/bash", shell);
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(statSync).mockImplementationOnce(((path: string) => {
      const info = actual.statSync(path);
      unlinkSync(shell);
      return info;
    }) as typeof statSync);
    expect(probePosixShellPath(shell, {})).toEqual({ ok: false, reason: "not found" });
    expect(execFileSync).toHaveBeenCalledOnce();
  });
});
