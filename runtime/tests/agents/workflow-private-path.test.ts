import { execFileSync } from "node:child_process";
import { win32 } from "node:path";
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
vi.mock("../../src/utils/windows-system-path.js", () => ({
  resolveTrustedWindowsSystemExecutable:
    resolveTrustedWindowsSystemExecutableMock,
  resolveTrustedWindowsSystemPaths: resolveTrustedWindowsSystemPathsMock,
}));

import {
  assertWindowsPrivatePathSecurity,
  WindowsPrivatePathSecurityError,
} from "../../src/agents/workflow-private-path.js";

const execFileSyncMock = vi.mocked(execFileSync);
const windowsSystemRoot = String.raw`C:\Windows`;
const windowsPowerShell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

function withWindowsPlatform(run: () => void): void {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  if (platformDescriptor === undefined) {
    throw new Error("process.platform descriptor is unavailable");
  }
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "win32",
  });
  try {
    run();
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
}

describe("Windows workflow private paths", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    resolveTrustedWindowsSystemExecutableMock.mockReset();
    resolveTrustedWindowsSystemExecutableMock.mockReturnValue(
      windowsPowerShell,
    );
    resolveTrustedWindowsSystemPathsMock.mockReset();
    resolveTrustedWindowsSystemPathsMock.mockReturnValue({
      systemRoot: String.raw`C:\Windows`,
      system32: String.raw`C:\Windows\System32`,
      powerShellRoot: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0`,
      namespaceSystemRoot: String.raw`\\?\GLOBALROOT\SystemRoot`,
    });
  });

  it("executes the protected owner-only NTFS ACL contract", () => {
    execFileSyncMock.mockImplementation(() => Buffer.from("OK"));

    withWindowsPlatform(() => {
      assertWindowsPrivatePathSecurity(
        String.raw`C:\private\output.spool`,
        "file",
        true,
      );
    });

    expect(execFileSyncMock).toHaveBeenCalledOnce();
    const [executable, arguments_, options] = execFileSyncMock.mock.calls[0]!;
    const workingDirectory = win32.join(windowsSystemRoot, "System32");
    expect(executable).toBe(windowsPowerShell);
    expect(resolveTrustedWindowsSystemPathsMock).toHaveBeenCalledOnce();
    expect(
      resolveTrustedWindowsSystemExecutableMock,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        namespaceSystemRoot: String.raw`\\?\GLOBALROOT\SystemRoot`,
        systemRoot: windowsSystemRoot,
      }),
      ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    );
    expect(arguments_.slice(0, 4)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);

    const encodedCommand = arguments_[4];
    expect(typeof encodedCommand).toBe("string");
    const script = Buffer.from(String(encodedCommand), "base64").toString(
      "utf16le",
    );
    expect(script).toContain("[System.IO.File]::GetAttributes($target)");
    expect(script).toContain("FileAttributes]::ReparsePoint");
    expect(script).toContain("path role does not match its type");
    expect(script).toContain("$drive.DriveFormat -ne 'NTFS'");
    expect(script).toContain("$acl.SetAccessRuleProtection($true, $false)");
    expect(script).toContain(
      "[System.IO.Directory]::SetAccessControl($target, $acl)",
    );
    expect(script).toContain(
      "[System.IO.File]::SetAccessControl($target, $acl)",
    );
    expect(script).toContain(
      "[System.IO.Directory]::GetAccessControl($target, $aclSections)",
    );
    expect(script).toContain(
      "[System.IO.File]::GetAccessControl($target, $aclSections)",
    );
    expect(script).toContain("FileSystemRights]::FullControl");
    expect(script).toContain("$rule.IdentityReference.Value -ne $sid.Value");
    expect(script).not.toMatch(
      /\.GetSecurityDescriptorBinaryForm\([^)]*,\s*0\)/u,
    );
    expect(script).not.toMatch(
      /\b(?:ConvertFrom-Json|ForEach-Object|Get-Item|Get-Acl|Set-Acl|Import-Module)\b/u,
    );

    expect(options).toMatchObject({
      cwd: workingDirectory,
      encoding: "buffer",
      maxBuffer: 1_048_576,
      timeout: 30_000,
      env: {
        AGENC_WORKFLOW_PRIVATE_INITIALIZE: "1",
        AGENC_WORKFLOW_PRIVATE_PATH: String.raw`C:\private\output.spool`,
        AGENC_WORKFLOW_PRIVATE_ROLE: "file",
        PATH: workingDirectory,
        SYSTEMDRIVE: "",
        SYSTEMROOT: windowsSystemRoot,
      },
      windowsHide: true,
    });
  });

  it("fails closed on an invalid verifier response or PowerShell error", () => {
    execFileSyncMock.mockImplementationOnce(() => Buffer.from("unexpected"));
    withWindowsPlatform(() => {
      expect(() =>
        assertWindowsPrivatePathSecurity(
          String.raw`C:\private\spool`,
          "directory",
          false,
        ),
      ).toThrow(WindowsPrivatePathSecurityError);
    });

    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("reparse points are unsupported");
    });
    withWindowsPlatform(() => {
      expect(() =>
        assertWindowsPrivatePathSecurity(
          String.raw`C:\private\spool-reparse`,
          "directory",
          false,
        ),
      ).toThrow(WindowsPrivatePathSecurityError);
    });
  });

  it("normalizes trusted-system path resolution failures", () => {
    resolveTrustedWindowsSystemPathsMock.mockImplementationOnce(() => {
      throw new Error("SystemRoot namespace is unavailable");
    });

    withWindowsPlatform(() => {
      expect(() =>
        assertWindowsPrivatePathSecurity(
          String.raw`C:\private\spool`,
          "directory",
          false,
        ),
      ).toThrow(WindowsPrivatePathSecurityError);
    });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("normalizes trusted executable identity mismatches before launch", () => {
    resolveTrustedWindowsSystemExecutableMock.mockImplementationOnce(() => {
      throw new Error("trusted Windows system executable identity mismatch");
    });

    withWindowsPlatform(() => {
      expect(() =>
        assertWindowsPrivatePathSecurity(
          String.raw`C:\private\spool`,
          "directory",
          false,
        ),
      ).toThrow(WindowsPrivatePathSecurityError);
    });
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
