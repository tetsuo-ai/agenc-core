/**
 * `shell-discovery` tests — focused on the pieces that do not touch
 * real filesystem state (`detectShellType`, exec-arg derivation). The
 * full `discoverDefaultUserShell` is exercised indirectly through
 * `bootstrap.test.ts::happy path` which asserts the session ends up
 * with a real discovered shell.
 */

import { describe, expect, it } from "vitest";

import {
  detectShellType,
  discoverDefaultUserShell,
  type ShellType,
} from "./shell-discovery.js";

describe("detectShellType", () => {
  it("identifies zsh by bare name or full path", () => {
    expect(detectShellType("zsh")).toBe("zsh");
    expect(detectShellType("/bin/zsh")).toBe("zsh");
    expect(detectShellType("/usr/local/bin/zsh")).toBe("zsh");
  });

  it("identifies bash by bare name or full path", () => {
    expect(detectShellType("bash")).toBe("bash");
    expect(detectShellType("/bin/bash")).toBe("bash");
  });

  it("identifies sh by bare name or full path", () => {
    expect(detectShellType("sh")).toBe("sh");
    expect(detectShellType("/bin/sh")).toBe("sh");
  });

  it("identifies powershell variants (pwsh, powershell.exe)", () => {
    expect(detectShellType("pwsh")).toBe("powershell");
    expect(detectShellType("/usr/local/bin/pwsh")).toBe("powershell");
    expect(detectShellType("powershell.exe")).toBe("powershell");
  });

  it("identifies cmd", () => {
    expect(detectShellType("cmd")).toBe("cmd");
    expect(detectShellType("cmd.exe")).toBe("cmd");
  });

  it("returns undefined for unknown shells", () => {
    expect(detectShellType("fish")).toBeUndefined();
    expect(detectShellType("/usr/bin/tcsh")).toBeUndefined();
    expect(detectShellType("other")).toBeUndefined();
  });
});

describe("discoverDefaultUserShell", () => {
  it("returns a DiscoveredShell with a non-empty path", () => {
    const shell = discoverDefaultUserShell();
    expect(shell).toBeDefined();
    expect(typeof shell.path).toBe("string");
    expect(shell.path.length).toBeGreaterThan(0);
    // On Unix we should always land on one of the recognized types or
    // the ultimate sh fallback.
    const recognized: ShellType[] = ["zsh", "bash", "sh", "powershell", "cmd"];
    expect(recognized).toContain(shell.shellType);
  });

  it("honors an explicit SHELL env override when the path is a recognized type", () => {
    const shell = discoverDefaultUserShell({
      env: { SHELL: "/bin/sh" },
    });
    // /bin/sh exists on ~every Unix box and should be recognized.
    expect(shell.path).toBe("/bin/sh");
    expect(shell.shellType).toBe("sh");
  });

  it("falls back to ultimate /bin/sh when SHELL is unrecognized and no recognized fallback exists at the provided path", () => {
    const shell = discoverDefaultUserShell({
      env: { SHELL: "/no/such/binary/fish" },
    });
    // The fallback walk tries /bin/zsh, /bin/bash, /bin/sh in order;
    // at least /bin/sh exists on Unix, so we land on sh.
    expect(["zsh", "bash", "sh"]).toContain(shell.shellType);
    expect(shell.path.length).toBeGreaterThan(0);
  });

  it("produces POSIX shell exec args with -c / -lc toggle", () => {
    const shell = discoverDefaultUserShell({
      env: { SHELL: "/bin/sh" },
    });
    const args = shell.deriveExecArgs("echo hi", false);
    expect(args).toEqual(["/bin/sh", "-c", "echo hi"]);
    const loginArgs = shell.deriveExecArgs("echo hi", true);
    expect(loginArgs).toEqual(["/bin/sh", "-lc", "echo hi"]);
  });
});
