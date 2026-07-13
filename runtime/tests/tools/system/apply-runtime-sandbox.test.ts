import { describe, expect, it } from "vitest";
import { applyRuntimeSandboxToSpawn } from "../../../src/tools/system/apply-runtime-sandbox.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("applyRuntimeSandboxToSpawn (TOOL-03/04)", () => {
  it("passes through when no runtime sandbox context is attached", () => {
    const result = applyRuntimeSandboxToSpawn({
      toolArgs: { command: "echo hi" },
      fallbackCwd: process.cwd(),
      program: "/bin/echo",
      args: ["hi"],
      cwd: process.cwd(),
      env: { PATH: "/usr/bin" },
    });
    expect(result.program).toBe("/bin/echo");
    expect(result.args).toEqual(["hi"]);
    expect(result.env.PATH).toBe("/usr/bin");
  });

  it("system.bash execute path applies sandbox helper before spawn", () => {
    const src = readFileSync(
      join(__dirname, "../../../src/tools/system/bash.ts"),
      "utf8",
    );
    expect(src).toMatch(/applyRuntimeSandboxToSpawn/);
    expect(src).toMatch(/withSandbox/);
  });

  it("PowerShell LIVE tool passes runtimeSandbox into execCommand", () => {
    const src = readFileSync(
      join(__dirname, "../../../src/bin/model-facing-tools.ts"),
      "utf8",
    );
    expect(src).toMatch(/runtimeSandboxForExec/);
    expect(src).toMatch(/runtimeSandbox/);
  });
});
