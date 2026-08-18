import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  resolveTrustedWindowsSystemExecutable,
  resolveTrustedWindowsSystemPaths,
  WINDOWS_SYSTEM_ROOT_NAMESPACE,
  type WindowsSystemExecutableFilesystem,
  type WindowsSystemExecutableIdentity,
} from "../../src/utils/windows-system-path.js";

function executableIdentity(
  dev: bigint,
  ino: bigint,
): WindowsSystemExecutableIdentity {
  return {
    dev,
    ino,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

describe("trusted Windows system paths", () => {
  it("keeps native-Node supervised-process source imports resolvable", () => {
    const supervisedProcessUrl = new URL(
      "../../src/utils/supervisedProcess.ts",
      import.meta.url,
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const sourceModule = await import(${JSON.stringify(supervisedProcessUrl)}); process.stdout.write(typeof sourceModule.runSupervisedProcess);`,
      ],
      {
        cwd: new URL("../../", import.meta.url),
        encoding: "utf8",
        env: process.env,
        timeout: 10_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("function");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("keeps GLOBALROOT fields out of Windows child-process callsites", () => {
    for (const relativePath of [
      "../../src/agents/jobs/csv-output-writer-anchor.ts",
      "../../src/agents/workflow-private-path.ts",
      "../../src/bin/update-cli.ts",
      "../../src/utils/supervisedProcess.ts",
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source, relativePath).not.toContain("namespaceSystemRoot");
      expect(source, relativePath).not.toMatch(
        /(?:execFileSync|spawnSync|spawn)\(\s*namespace[A-Za-z0-9_$]*/u,
      );
    }
  });

  it("derives spawn-compatible paths from GLOBALROOT without caller environment", () => {
    const canonicalize = vi.fn(() => String.raw`C:\Windows`);

    expect(resolveTrustedWindowsSystemPaths(canonicalize)).toEqual({
      systemRoot: String.raw`C:\Windows`,
      system32: String.raw`C:\Windows\System32`,
      powerShellRoot: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0`,
      namespaceSystemRoot: String.raw`\\?\GLOBALROOT\SystemRoot`,
    });
    expect(canonicalize).toHaveBeenCalledExactlyOnceWith(
      WINDOWS_SYSTEM_ROOT_NAMESPACE,
    );
  });

  it.each([
    String.raw`\\server\share\Windows`,
    String.raw`\\?\GLOBALROOT\SystemRoot`,
    String.raw`Windows`,
    String.raw`C:\Windows\..\attacker`,
  ])("fails closed when native resolution returns %s", (resolved) => {
    expect(() => resolveTrustedWindowsSystemPaths(() => resolved)).toThrow(
      /canonical local DOS path/u,
    );
  });

  it("opens both spellings and returns only the identity-proved DOS path", () => {
    const paths = resolveTrustedWindowsSystemPaths(
      () => String.raw`C:\Windows`,
    );
    const identity = executableIdentity(17n, 29n);
    const close = vi.fn();
    const filesystem: WindowsSystemExecutableFilesystem = {
      lstat: vi.fn(() => identity),
      open: vi.fn((path) => path.startsWith("C:") ? 12 : 11),
      fstat: vi.fn(() => identity),
      close,
    };

    expect(
      resolveTrustedWindowsSystemExecutable(
        paths,
        ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
        filesystem,
      ),
    ).toBe(
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(filesystem.open).toHaveBeenNthCalledWith(
      1,
      String.raw`\\?\GLOBALROOT\SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(filesystem.open).toHaveBeenNthCalledWith(
      2,
      String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    );
    expect(close.mock.calls).toEqual([[12], [11]]);
  });

  it("rejects a DOS-to-GLOBALROOT identity mismatch and closes both handles", () => {
    const paths = resolveTrustedWindowsSystemPaths(
      () => String.raw`C:\Windows`,
    );
    const trusted = executableIdentity(17n, 29n);
    const replaced = executableIdentity(17n, 31n);
    const close = vi.fn();
    const filesystem: WindowsSystemExecutableFilesystem = {
      lstat: vi.fn((path) => path.startsWith("C:") ? replaced : trusted),
      open: vi.fn((path) => path.startsWith("C:") ? 12 : 11),
      fstat: vi.fn((descriptor) => descriptor === 12 ? replaced : trusted),
      close,
    };

    expect(() =>
      resolveTrustedWindowsSystemExecutable(
        paths,
        ["System32", "taskkill.exe"],
        filesystem,
      ),
    ).toThrow(/identity mismatch/u);
    expect(close.mock.calls).toEqual([[12], [11]]);
  });

  it("rejects a path replacement after open and closes both handles", () => {
    const paths = resolveTrustedWindowsSystemPaths(
      () => String.raw`C:\Windows`,
    );
    const trusted = executableIdentity(17n, 29n);
    const replaced = executableIdentity(17n, 31n);
    const close = vi.fn();
    const filesystem: WindowsSystemExecutableFilesystem = {
      lstat: vi.fn()
        .mockReturnValueOnce(trusted)
        .mockReturnValueOnce(trusted)
        .mockReturnValueOnce(trusted)
        .mockReturnValueOnce(replaced),
      open: vi.fn()
        .mockReturnValueOnce(11)
        .mockReturnValueOnce(12),
      fstat: () => trusted,
      close,
    };

    expect(() =>
      resolveTrustedWindowsSystemExecutable(
        paths,
        ["System32", "taskkill.exe"],
        filesystem,
      ),
    ).toThrow(/identity mismatch/u);
    expect(close.mock.calls).toEqual([[12], [11]]);
  });

  it.each(["GLOBALROOT", "DOS"] as const)(
    "rejects a symbolic-link %s spelling before opening descriptors",
    (spelling) => {
      const paths = resolveTrustedWindowsSystemPaths(
        () => String.raw`C:\Windows`,
      );
      const trusted = executableIdentity(17n, 29n);
      const linked = {
        ...trusted,
        isSymbolicLink: () => true,
      };
      const open = vi.fn();
      const filesystem: WindowsSystemExecutableFilesystem = {
        lstat: vi.fn()
          .mockReturnValueOnce(spelling === "GLOBALROOT" ? linked : trusted)
          .mockReturnValueOnce(spelling === "DOS" ? linked : trusted),
        open,
        fstat: () => trusted,
        close: vi.fn(),
      };

      expect(() =>
        resolveTrustedWindowsSystemExecutable(
          paths,
          ["System32", "tar.exe"],
          filesystem,
        ),
      ).toThrow(/not a regular non-link file/u);
      expect(open).not.toHaveBeenCalled();
    },
  );

  it.each(["GLOBALROOT", "DOS"] as const)(
    "rejects a non-file %s descriptor and closes both handles",
    (spelling) => {
      const paths = resolveTrustedWindowsSystemPaths(
        () => String.raw`C:\Windows`,
      );
      const trusted = executableIdentity(17n, 29n);
      const nonFile = {
        ...trusted,
        isFile: () => false,
      };
      const close = vi.fn();
      const filesystem: WindowsSystemExecutableFilesystem = {
        lstat: () => trusted,
        open: vi.fn()
          .mockReturnValueOnce(11)
          .mockReturnValueOnce(12),
        fstat: vi.fn()
          .mockReturnValueOnce(spelling === "GLOBALROOT" ? nonFile : trusted)
          .mockReturnValueOnce(spelling === "DOS" ? nonFile : trusted),
        close,
      };

      expect(() =>
        resolveTrustedWindowsSystemExecutable(
          paths,
          ["System32", "tar.exe"],
          filesystem,
        ),
      ).toThrow(/not a regular non-link file/u);
      expect(close.mock.calls).toEqual([[12], [11]]);
    },
  );

  it("closes the namespace descriptor when opening the DOS spelling fails", () => {
    const paths = resolveTrustedWindowsSystemPaths(
      () => String.raw`C:\Windows`,
    );
    const trusted = executableIdentity(17n, 29n);
    const close = vi.fn();
    const filesystem: WindowsSystemExecutableFilesystem = {
      lstat: () => trusted,
      open: vi.fn()
        .mockReturnValueOnce(11)
        .mockImplementationOnce(() => {
          throw new Error("injected DOS open failure");
        }),
      fstat: () => trusted,
      close,
    };

    expect(() =>
      resolveTrustedWindowsSystemExecutable(
        paths,
        ["System32", "tar.exe"],
        filesystem,
      ),
    ).toThrow(/injected DOS open failure/u);
    expect(close).toHaveBeenCalledExactlyOnceWith(11);
  });

  it.each([
    [],
    [".."],
    ["nested\\tool.exe"],
    ["nested/tool.exe"],
    ["tool.exe:stream"],
    ["tool.exe."],
    ["tool.exe "],
    ["tool\u0001.exe"],
    ["CON"],
    ["nul.exe"],
    ["COM9.log"],
  ].map((segments) => [segments] as const))(
    "rejects unsafe executable segments %j",
    (segments) => {
    const paths = resolveTrustedWindowsSystemPaths(
      () => String.raw`C:\Windows`,
    );
    const open = vi.fn();
    expect(() =>
      resolveTrustedWindowsSystemExecutable(paths, segments, {
        lstat: vi.fn(),
        open,
        fstat: vi.fn(),
        close: vi.fn(),
      }),
    ).toThrow(/segments are invalid/u);
    expect(open).not.toHaveBeenCalled();
    },
  );

  it("aggregates failures closing both verified executable descriptors", () => {
    const paths = resolveTrustedWindowsSystemPaths(
      () => String.raw`C:\Windows`,
    );
    const identity = executableIdentity(17n, 29n);
    const close = vi.fn((descriptor: number) => {
      throw new Error(`injected close failure ${descriptor}`);
    });
    let thrown: unknown;
    try {
      resolveTrustedWindowsSystemExecutable(
        paths,
        ["System32", "tar.exe"],
        {
          lstat: () => identity,
          open: vi.fn()
            .mockReturnValueOnce(11)
            .mockReturnValueOnce(12),
          fstat: () => identity,
          close,
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toHaveLength(2);
    expect(close.mock.calls).toEqual([[12], [11]]);
  });

  it.each([
    [0n, 29n],
    [-1n, 29n],
    [0xffff_ffff_ffff_ffffn, 29n],
    [17n, 0n],
    [17n, -1n],
    [17n, 0xffff_ffff_ffff_ffffn],
  ])(
    "rejects unavailable executable identity dev=%s ino=%s",
    (dev, ino) => {
      const paths = resolveTrustedWindowsSystemPaths(
        () => String.raw`C:\Windows`,
      );
      const identity = executableIdentity(dev, ino);
      const filesystem: WindowsSystemExecutableFilesystem = {
        lstat: () => identity,
        open: vi.fn()
          .mockReturnValueOnce(11)
          .mockReturnValueOnce(12),
        fstat: () => identity,
        close: vi.fn(),
      };
      expect(() =>
        resolveTrustedWindowsSystemExecutable(
          paths,
          ["System32", "tar.exe"],
          filesystem,
        ),
      ).toThrow(/identity is unavailable/u);
    },
  );
});
