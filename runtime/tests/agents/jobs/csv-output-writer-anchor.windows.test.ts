import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveTrustedWindowsSystemExecutableMock,
  resolveTrustedWindowsSystemPathsMock,
} = vi.hoisted(() => ({
  resolveTrustedWindowsSystemExecutableMock: vi.fn(),
  resolveTrustedWindowsSystemPathsMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));
vi.mock("../../../src/utils/windows-system-path.js", () => ({
  resolveTrustedWindowsSystemExecutable:
    resolveTrustedWindowsSystemExecutableMock,
  resolveTrustedWindowsSystemPaths: resolveTrustedWindowsSystemPathsMock,
}));

import { assertWindowsCsvMutationBoundary } from "../../../src/agents/jobs/csv-output-writer-anchor.js";

const execFileSyncMock = vi.mocked(execFileSync);

function withWindowsPlatform(run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor === undefined) {
    throw new Error("process.platform descriptor is unavailable");
  }
  Object.defineProperty(process, "platform", {
    ...descriptor,
    value: "win32",
  });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

describe("Windows CSV mutation boundary", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(Buffer.from("OK"));
    resolveTrustedWindowsSystemExecutableMock.mockReset();
    resolveTrustedWindowsSystemExecutableMock.mockReturnValue(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    resolveTrustedWindowsSystemPathsMock.mockReset();
    resolveTrustedWindowsSystemPathsMock.mockReturnValue({
      systemRoot: String.raw`C:\Windows`,
      system32: String.raw`C:\Windows\System32`,
      powerShellRoot: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0`,
      namespaceSystemRoot: String.raw`\\?\GLOBALROOT\SystemRoot`,
    });
  });

  it("launches a bounded .NET-only ACL probe with lossless path transport", () => {
    const parentPath = String.raw`C:\private dir\雪-💾-[x]\output`;
    withWindowsPlatform(() => {
      assertWindowsCsvMutationBoundary(parentPath);
    });

    expect(execFileSyncMock).toHaveBeenCalledOnce();
    const [executable, arguments_, options] = execFileSyncMock.mock.calls[0]!;
    expect(executable).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(arguments_.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    const command = Buffer.from(String(arguments_[4]), "base64").toString(
      "utf16le",
    );
    expect(command).toContain(
      "$entries = [string[]]$transport.Split([char]10)",
    );
    expect(command).toContain("[System.Convert]::FromBase64String");
    expect(command).toContain("$pathCharacters = [char[]]::new");
    expect(command).toContain("$decodedPath = [string]::new($pathCharacters)");
    expect(command).toContain("[System.IO.File]::GetAttributes($full)");
    expect(command).toContain(
      "[System.IO.Directory]::GetAccessControl($full, $aclSections)",
    );
    expect(command).toContain(
      "$bytes = $acl.GetSecurityDescriptorBinaryForm()",
    );
    expect(command).not.toMatch(
      /\.GetSecurityDescriptorBinaryForm\([^)]*,\s*0\)/u,
    );
    expect(command).not.toMatch(
      /\b(?:ConvertFrom-Json|ForEach-Object|Get-Item|Get-Acl|Set-Acl|Import-Module)\b/u,
    );
    expect(options).toMatchObject({
      cwd: String.raw`C:\Windows\System32`,
      maxBuffer: 1_048_576,
      timeout: 30_000,
      env: {
        PATH: String.raw`C:\Windows\System32`,
        SYSTEMDRIVE: "",
        SYSTEMROOT: String.raw`C:\Windows`,
        WINDIR: String.raw`C:\Windows`,
      },
      windowsHide: true,
    });
    expect(resolveTrustedWindowsSystemPathsMock).toHaveBeenCalledOnce();
    expect(
      resolveTrustedWindowsSystemExecutableMock,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        namespaceSystemRoot: String.raw`\\?\GLOBALROOT\SystemRoot`,
        systemRoot: String.raw`C:\Windows`,
      }),
      ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    );
    const pathTransport = String(options.env?.AGENC_CSV_PATHS);
    expect(
      pathTransport.split("\n").map((entry) => {
        const separator = entry.indexOf(":");
        const role = entry.slice(0, separator);
        const encodedPath = entry.slice(separator + 1);
        expect(Buffer.from(encodedPath, "base64").toString("base64")).toBe(
          encodedPath,
        );
        return {
          path: Buffer.from(encodedPath, "base64").toString("utf16le"),
          role,
        };
      }),
    ).toEqual([
      { path: parentPath, role: "leafDirectory" },
      {
        path: String.raw`C:\private dir\雪-💾-[x]`,
        role: "ancestorDirectory",
      },
      { path: String.raw`C:\private dir`, role: "ancestorDirectory" },
      { path: "C:\\", role: "ancestorDirectory" },
    ]);
    expect(options.env).not.toHaveProperty("AGENC_CSV_PATHS_JSON");
  });

  it("rejects an oversized path transport before launching PowerShell", () => {
    withWindowsPlatform(() => {
      expect(() =>
        assertWindowsCsvMutationBoundary(`C:\\${"x".repeat(7_000)}`),
      ).toThrow(/path transport exceeds/u);
    });

    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
