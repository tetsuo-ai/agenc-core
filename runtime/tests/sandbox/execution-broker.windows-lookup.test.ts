import { join } from "node:path";
import { expect, it, vi } from "vitest";

const virtualWindowsFiles = vi.hoisted(() => new Map<string, string>());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: ((path: string, ...rest: unknown[]) => virtualWindowsFiles.has(String(path))
      ? { isFile: () => true, mode: 0o755 }
      : actual.statSync(path, ...rest as [])) as typeof actual.statSync,
    realpathSync: ((path: string, ...rest: unknown[]) => virtualWindowsFiles.get(String(path))
      ?? actual.realpathSync(path, ...rest as [])) as typeof actual.realpathSync,
  };
});

import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";

it("uses the Windows launch cwd before PATH, including PATHEXT, through the broker", () => {
  const cwd = "/virtual-windows/launch";
  const pathDir = "/virtual-windows/path";
  const cwdProgram = join(cwd, "server.EXE");
  const pathProgram = join(pathDir, "server.EXE");
  virtualWindowsFiles.set(cwdProgram, cwdProgram);
  virtualWindowsFiles.set(pathProgram, pathProgram);
  const broker = new SandboxExecutionBroker({
    mode: "danger_full_access", cwd, platform: "win32", sessionTempRoot: "/virtual-windows/temp",
  });
  try {
    for (const program of ["server.EXE", "server"]) {
      const prepared = broker.prepareSpawn("mcp_stdio", {
        program, args: [], cwd, env: { PATH: pathDir, PATHEXT: ".EXE" },
      });
      expect(prepared.runSync(command => command.program)).toBe(cwdProgram);
    }
  } finally { virtualWindowsFiles.clear(); }
});
