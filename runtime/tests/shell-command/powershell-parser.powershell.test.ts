import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import {
  clearPowerShellParserCacheForTests,
  parsePowerShellScriptWithNativeAst,
} from "./powershell-parser.js";

function findPowerShellExecutable(): string | null {
  for (const candidate of ["pwsh", "powershell"]) {
    const result = spawnSync(
      candidate,
      ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion"],
      {
        encoding: "utf8",
        timeout: 1_000,
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
