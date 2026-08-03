import { execFileSync } from "node:child_process";
import { win32 } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import {
  assertWindowsPrivatePathSecurity,
  WindowsPrivatePathSecurityError,
} from "../../src/agents/workflow-private-path.js";

const execFileSyncMock = vi.mocked(execFileSync);
const windowsSystemRoot = String.raw`\\?\GLOBALROOT\SystemRoot`;

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
    expect(executable).toBe(
      win32.join(
        workingDirectory,
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
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
    expect(script).toContain("FileAttributes]::ReparsePoint");
    expect(script).toContain("$drive.DriveFormat -ne 'NTFS'");
    expect(script).toContain("$acl.SetAccessRuleProtection($true, $false)");
    expect(script).toContain("FileSystemRights]::FullControl");
    expect(script).toContain("$rule.IdentityReference.Value -ne $sid.Value");

    expect(options).toMatchObject({
      cwd: workingDirectory,
      encoding: "buffer",
      env: {
        AGENC_WORKFLOW_PRIVATE_INITIALIZE: "1",
        AGENC_WORKFLOW_PRIVATE_PATH: String.raw`C:\private\output.spool`,
        AGENC_WORKFLOW_PRIVATE_ROLE: "file",
        PATH: workingDirectory,
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
});
