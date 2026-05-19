import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import {
  clearPowerShellParserCacheForTests,
  parsePowerShellScriptWithNativeAst,
} from "./powershell-parser.js";

function findPowerShellExecutable(): string | null {
  for (const candidate of ["pwsh", "powershell"]) {
    const result = spawnSync(candidate, ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion"], {
      encoding: "utf8",
      timeout: 1_000,
    });
    if (result.status === 0) return candidate;
  }
  return null;
}

describe("parsePowerShellScriptWithNativeAst", () => {
  afterEach(() => {
    clearPowerShellParserCacheForTests();
  });

  test("returns a failed outcome when the platform executable is unavailable", () => {
    const outcome = parsePowerShellScriptWithNativeAst(
      "__agenc_missing_powershell_executable__",
      "Get-ChildItem",
      { timeoutMs: 250 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("failed");
      expect(outcome.diagnostics.length).toBeGreaterThan(0);
    }
  });

  test("uses the native AST parser when PowerShell is present", () => {
    const executable = findPowerShellExecutable();
    if (executable === null) {
      expect(executable).toBeNull();
      return;
    }

    const outcome = parsePowerShellScriptWithNativeAst(
      executable,
      "Get-ChildItem . | Select-Object Name",
    );
    expect(outcome).toEqual({
      ok: true,
      commands: [["Get-ChildItem", "."], ["Select-Object", "Name"]],
    });

    const second = parsePowerShellScriptWithNativeAst(
      executable,
      "Write-Output foo | Measure-Object",
    );
    expect(second).toEqual({
      ok: true,
      commands: [["Write-Output", "foo"], ["Measure-Object"]],
    });
  });
});
