import { describe, expect, test, vi } from "vitest";

vi.mock("../../../src/utils/sessionEnvironment.js", () => ({
  getSessionEnvironmentScript: vi.fn(async () => null),
}));

import { createBashShellProvider } from "../../../src/utils/shell/bashProvider.js";
import { createPowerShellProvider } from "../../../src/utils/shell/powershellProvider.js";

describe("bash provider environment authority", () => {
  test("sandbox temp values come from the immutable command plan", async () => {
    const provider = await createBashShellProvider("/bin/sh", {
      skipSnapshot: true,
      childEnvironment: {},
    });

    const prepared = await provider.prepareExecCommand("printf ok", {
      id: "temp-authority",
      sandboxTmpDir: "/sandbox-temp",
      tempRoot: "/session-temp",
      useSandbox: true,
    });

    expect(prepared.environmentOverrides).toMatchObject({
      TMPDIR: "/sandbox-temp",
      AGENC_TMPDIR: "/sandbox-temp",
      TMPPREFIX: "/sandbox-temp/zsh",
    });
  });

  test("keeps interleaved Bash command temp roots isolated", async () => {
    const provider = await createBashShellProvider("/bin/sh", {
      skipSnapshot: true,
      childEnvironment: {},
    });
    const [first, second] = await Promise.all([
      provider.prepareExecCommand("printf first", {
        id: "first",
        sandboxTmpDir: "/sandbox-first",
        tempRoot: "/session-first",
        useSandbox: true,
      }),
      provider.prepareExecCommand("printf second", {
        id: "second",
        sandboxTmpDir: "/sandbox-second",
        tempRoot: "/session-second",
        useSandbox: true,
      }),
    ]);

    expect(first.environmentOverrides.TMPDIR).toBe("/sandbox-first");
    expect(second.environmentOverrides.TMPDIR).toBe("/sandbox-second");
  });

  test("keeps interleaved PowerShell command temp roots isolated", async () => {
    const provider = createPowerShellProvider("pwsh");
    const [first, second] = await Promise.all([
      provider.prepareExecCommand("Write-Output first", {
        id: "first",
        sandboxTmpDir: "/sandbox-first",
        tempRoot: "/session-first",
        useSandbox: true,
      }),
      provider.prepareExecCommand("Write-Output second", {
        id: "second",
        sandboxTmpDir: "/sandbox-second",
        tempRoot: "/session-second",
        useSandbox: true,
      }),
    ]);

    expect(first.environmentOverrides.TMPDIR).toBe("/sandbox-first");
    expect(second.environmentOverrides.TMPDIR).toBe("/sandbox-second");
  });

  test("uses captured temp roots for unsandboxed tracking files", async () => {
    const bash = await createBashShellProvider("/bin/sh", {
      skipSnapshot: true,
      childEnvironment: {},
    });
    const powershell = createPowerShellProvider("pwsh");

    const bashPlan = await bash.prepareExecCommand("printf ok", {
      id: "bash",
      tempRoot: "/captured/bash",
      useSandbox: false,
    });
    const powershellPlan = await powershell.prepareExecCommand("Write-Output ok", {
      id: "powershell",
      tempRoot: "/captured/powershell",
      useSandbox: false,
    });

    expect(bashPlan.cwdFilePath).toBe("/captured/bash/agenc-bash-cwd");
    expect(powershellPlan.cwdFilePath).toBe(
      "/captured/powershell/agenc-pwd-ps-powershell",
    );
  });
});
