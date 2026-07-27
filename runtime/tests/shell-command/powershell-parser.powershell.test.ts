import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import {
  clearPowerShellParserCacheForTests,
  parsePowerShellScriptWithNativeAst,
} from "./powershell-parser.js";

const CAPABILITY_STARTUP_TIMEOUT_MS = 10_000;

function findPowerShellExecutable(): string | null {
  for (const candidate of ["pwsh", "powershell"]) {
    const result = spawnSync(
      candidate,
      ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion"],
      {
        encoding: "utf8",
        timeout: CAPABILITY_STARTUP_TIMEOUT_MS,
      },
    );
    if (result.status === 0) return candidate;
  }
  return null;
}

describe("parsePowerShellScriptWithNativeAst capability", () => {
  afterEach(() => {
    clearPowerShellParserCacheForTests();
  });

  test("uses the native AST parser in the PowerShell capability lane", () => {
    const executable = findPowerShellExecutable();
    if (executable === null) {
      throw new Error("PowerShell capability lane requires pwsh or powershell");
    }

    const outcome = parsePowerShellScriptWithNativeAst(
      executable,
      "Get-ChildItem . | Select-Object Name",
      { timeoutMs: CAPABILITY_STARTUP_TIMEOUT_MS },
    );
    expect(outcome).toEqual({
      ok: true,
      commands: [["Get-ChildItem", "."], ["Select-Object", "Name"]],
    });

    const second = parsePowerShellScriptWithNativeAst(
      executable,
      "Write-Output foo | Measure-Object",
      { timeoutMs: CAPABILITY_STARTUP_TIMEOUT_MS },
    );
    expect(second).toEqual({
      ok: true,
      commands: [["Write-Output", "foo"], ["Measure-Object"]],
    });
  });
});
