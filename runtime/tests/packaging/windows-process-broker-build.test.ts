import * as fs from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  chmodSync: vi.fn(),
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
}));

import { __agencBuildConfigTest } from "../../build.config.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const systemRoot = join(tmpdir(), "compiler-system-root");
const programFiles = join(tmpdir(), "compiler-program-files");
const framework = resolve(systemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
const vswhere = resolve(programFiles, "Microsoft Visual Studio/Installer/vswhere.exe");
const roslyn = resolve(programFiles, "Microsoft Visual Studio/MSBuild/Current/Bin/Roslyn/csc.exe");
const candidates = new Set<string>();

function result(status: number, stdout = "", stderr = ""): SpawnSyncReturns<string> {
  return { pid: 1, status, signal: null, stdout, stderr, output: [null, stdout, stderr] };
}

beforeEach(() => {
  vi.resetAllMocks();
  candidates.clear();
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.stubEnv("SystemRoot", systemRoot);
  vi.stubEnv("ProgramFiles", programFiles);
  vi.stubEnv("ProgramFiles(x86)", programFiles);
  vi.mocked(fs.lstatSync).mockImplementation((path) => {
    if (!candidates.has(String(path))) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { isFile: () => true, isSymbolicLink: () => false } as fs.Stats;
  });
  vi.mocked(fs.existsSync).mockImplementation(path => String(path).endsWith("agenc-process-job-broker.exe"));
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("Windows process broker compiler compatibility", () => {
  it("builds with only the .NET Framework compiler and its supported options", () => {
    candidates.add(framework);
    vi.mocked(spawnSync).mockReturnValue(result(0));
    __agencBuildConfigTest.compileWindowsProcessBroker();
    expect(spawnSync).toHaveBeenCalledOnce();
    const [compiler, args, options] = vi.mocked(spawnSync).mock.calls[0];
    expect(compiler).toBe(framework);
    expect(args).toEqual([
      "/nologo", "/target:exe", "/optimize+", "/checked+",
      expect.stringMatching(/^\/out:.*agenc-process-job-broker\.exe$/u),
      expect.stringMatching(/native[/\\]agenc-process-job-broker\.cs$/u),
    ]);
    expect(options).toMatchObject({ windowsHide: true });
    expect(fs.chmodSync).toHaveBeenCalledOnce();
  });

  it("keeps deterministic and path-map options for the preferred Roslyn compiler", () => {
    for (const path of [framework, vswhere, roslyn]) candidates.add(path);
    vi.mocked(spawnSync).mockImplementation((command) => result(0, command === vswhere ? `${roslyn}\r\n` : ""));
    __agencBuildConfigTest.compileWindowsProcessBroker();
    expect(spawnSync).toHaveBeenCalledTimes(2);
    const [compiler, args] = vi.mocked(spawnSync).mock.calls[1];
    expect(compiler).toBe(roslyn);
    expect(args).toEqual(expect.arrayContaining([
      "/deterministic+", expect.stringMatching(/^\/pathmap:.+=\.$/u),
    ]));
    expect(fs.chmodSync).toHaveBeenCalledOnce();
  });

  it("falls back to Framework when the discovered Roslyn compiler fails", () => {
    for (const path of [framework, vswhere, roslyn]) candidates.add(path);
    vi.mocked(spawnSync).mockImplementation(command => {
      if (command === vswhere) return result(0, roslyn);
      return result(command === roslyn ? 1 : 0);
    });
    __agencBuildConfigTest.compileWindowsProcessBroker();
    expect(spawnSync).toHaveBeenCalledTimes(3);
    const [compiler, args] = vi.mocked(spawnSync).mock.calls[2];
    expect(compiler).toBe(framework);
    expect(args).not.toContain("/deterministic+");
    expect(args).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\/pathmap:/u)]));
  });

  it("reports compiler diagnostics from stdout as well as stderr", () => {
    candidates.add(framework);
    vi.mocked(spawnSync).mockReturnValue(result(1, "error CS1002: ; expected", "compiler stderr"));
    expect(() => __agencBuildConfigTest.compileWindowsProcessBroker()).toThrow(
      `${framework}: error CS1002: ; expected\ncompiler stderr`,
    );
    expect(fs.chmodSync).not.toHaveBeenCalled();
  });
});
