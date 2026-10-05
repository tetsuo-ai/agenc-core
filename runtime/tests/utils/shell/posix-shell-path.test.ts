import { describe, expect, test } from "vitest";

import {
  isSupportedPosixShellPath,
  supportedPosixShellKind,
} from "../../../src/utils/shell/posixShellPath.js";

describe("supportedPosixShellKind", () => {
  test.each([
    ["/bin/bash", "bash"],
    ["/usr/local/bin/bash", "bash"],
    ["bash.exe", "bash"],
    ["/Git/bin/bash.exe", "bash"],
    ["/bin/BASH", "bash"],
    ["/bin/zsh", "zsh"],
    ["/opt/homebrew/bin/zsh", "zsh"],
    ["zsh.exe", "zsh"],
    ["/bin/Zsh.EXE", "zsh"],
  ] as const)("%s is %s", (shellPath, kind) => {
    expect(supportedPosixShellKind(shellPath)).toBe(kind);
    expect(isSupportedPosixShellPath(shellPath)).toBe(true);
  });

  test.each([
    "/bin/sh",
    "/bin/dash",
    "/usr/bin/fish",
    "/bin/bash-completion",
    "powershell.exe",
    "cmd.exe",
    "pwsh",
    "",
    ".",
    "/usr/bin/bash ",
  ])("%j is not a supported POSIX shell", (shellPath) => {
    expect(supportedPosixShellKind(shellPath)).toBeUndefined();
    expect(isSupportedPosixShellPath(shellPath)).toBe(false);
  });
});
