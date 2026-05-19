import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { sourceUrl } from "../../helpers/source-path.ts";
import {
  applyBestEffortPreMainProcessHardening,
  applyPreMainProcessHardening,
  buildHardenedEnvironment,
  compileAndLoadNativeHardeningBinding,
  ProcessHardeningError,
  scrubDangerousEnvironment,
  type ProcessHardeningResult,
} from "./index.js";

const temporaryPaths: string[] = [];

afterEach(() => {
  while (temporaryPaths.length > 0) {
    const filePath = temporaryPaths.pop();
    if (filePath) rmSync(filePath, { recursive: true, force: true });
  }
});

describe("process hardening", () => {
  test("scrubs dangerous dynamic-loader and allocator environment keys", () => {
    const env = {
      PATH: "/usr/bin",
      LD_PRELOAD: "/tmp/inject.so",
      LD_AUDIT: "/tmp/audit.so",
      DYLD_INSERT_LIBRARIES: "/tmp/inject.dylib",
      MallocStackLogging: "1",
      MallocStackLoggingNoCompact: "1",
      MallocLogFile: "/tmp/malloc.log",
    };

    expect(scrubDangerousEnvironment(env)).toEqual([
      "DYLD_INSERT_LIBRARIES",
      "LD_AUDIT",
      "LD_PRELOAD",
      "MallocLogFile",
      "MallocStackLogging",
      "MallocStackLoggingNoCompact",
    ]);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("builds a hardened environment copy without mutating the input", () => {
    const env = {
      PATH: "/usr/bin",
      LD_PRELOAD: "/tmp/inject.so",
      AGENC_HOME: "/tmp/agenc",
    };

    expect(buildHardenedEnvironment(env)).toEqual({
      PATH: "/usr/bin",
      AGENC_HOME: "/tmp/agenc",
    });
    expect(env.LD_PRELOAD).toBe("/tmp/inject.so");
  });

  test("applies native hardening hooks when a binding is provided", () => {
    const calls: string[] = [];
    const env = { LD_AUDIT: "/tmp/audit.so" };
    const result = applyPreMainProcessHardening({
      env,
      platform: "linux",
      nativeBinding: {
        setCoreFileSizeLimitToZero() {
          calls.push("core");
        },
        disableProcessDumping() {
          calls.push("dumping");
        },
      },
    });

    expect(calls).toEqual(["core", "dumping"]);
    expect(env).toEqual({});
    expect(result.steps.map((step) => [step.operation, step.status])).toEqual([
      ["scrub_environment", "applied"],
      ["set_core_limit", "applied"],
      ["disable_process_dumping", "applied"],
    ]);
  });

  test("falls back to prlimit for Linux core limits when native loading is off", () => {
    const calls: unknown[][] = [];
    const fakeExecFileSync = ((file: string, args: readonly string[]) => {
      calls.push([file, args]);
      return Buffer.alloc(0);
    }) as never;

    const result = applyPreMainProcessHardening({
      env: {},
      platform: "linux",
      nativeMode: "off",
      execFileSync: fakeExecFileSync,
    });

    expect(calls).toEqual([[
      "prlimit",
      ["--pid", String(process.pid), "--core=0:0"],
    ]]);
    expect(step(result, "set_core_limit")?.status).toBe("applied");
    expect(step(result, "disable_process_dumping")?.status).toBe("unsupported");
  });

  test("defaults to fail-closed when trusted native hardening is unavailable", () => {
    const calls: string[] = [];
    const fakeExecFileSync = ((file: string) => {
      calls.push(file);
      return Buffer.alloc(0);
    }) as never;

    try {
      applyPreMainProcessHardening({
        env: {},
        platform: "darwin",
        execFileSync: fakeExecFileSync,
      });
      throw new Error("expected process hardening to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessHardeningError);
      const result = (error as ProcessHardeningError).result;
      expect(calls).toEqual([]);
      expect(step(result, "disable_process_dumping")?.status).toBe("failed");
      expect(step(result, "disable_process_dumping")?.error).toContain(
        "runtime native hardening build disabled",
      );
    }
  });

  test("offers an explicit best-effort hardening API for diagnostics", () => {
    const result = applyBestEffortPreMainProcessHardening({
      env: {},
      platform: "darwin",
    });

    expect(step(result, "set_core_limit")?.status).toBe("unsupported");
    expect(step(result, "disable_process_dumping")?.status).toBe("failed");
  });

  test("does not run the Linux prlimit fallback for other Unix platforms", () => {
    const calls: unknown[][] = [];
    const fakeExecFileSync = ((file: string, args: readonly string[]) => {
      calls.push([file, args]);
      return Buffer.alloc(0);
    }) as never;

    const result = applyPreMainProcessHardening({
      env: {},
      platform: "freebsd",
      nativeMode: "off",
      execFileSync: fakeExecFileSync,
    });

    expect(calls).toEqual([]);
    expect(step(result, "set_core_limit")?.status).toBe("unsupported");
    expect(step(result, "set_core_limit")?.method).toBe("prlimit");
  });

  test("reports prlimit failures when the Linux fallback cannot apply", () => {
    const fakeExecFileSync = (() => {
      throw new Error("missing prlimit");
    }) as never;

    const result = applyPreMainProcessHardening({
      env: {},
      platform: "linux",
      nativeMode: "off",
      execFileSync: fakeExecFileSync,
    });

    expect(step(result, "set_core_limit")?.status).toBe("failed");
    expect(step(result, "set_core_limit")?.error).toContain("missing prlimit");
  });

  test("strict mode preserves partial hardening results after native step failure", () => {
    const env = { LD_PRELOAD: "/tmp/inject.so" };

    expect(() => applyPreMainProcessHardening({
      env,
      platform: "linux",
      nativeMode: "required",
      nativeBinding: {
        setCoreFileSizeLimitToZero() {},
        disableProcessDumping() {
          throw new Error("ptrace denied");
        },
      },
    })).toThrowError(ProcessHardeningError);

    try {
      applyPreMainProcessHardening({
        env: { LD_PRELOAD: "/tmp/inject.so" },
        platform: "linux",
        nativeMode: "required",
        nativeBinding: {
          setCoreFileSizeLimitToZero() {},
          disableProcessDumping() {
            throw new Error("ptrace denied");
          },
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessHardeningError);
      const result = (error as ProcessHardeningError).result;
      expect(result.scrubbedEnvKeys).toEqual(["LD_PRELOAD"]);
      expect(result.steps.map((entry) => [entry.operation, entry.status])).toEqual([
        ["scrub_environment", "applied"],
        ["set_core_limit", "applied"],
        ["disable_process_dumping", "failed"],
      ]);
    }
  });

  test("strict mode preserves env scrub evidence after native compile failure", () => {
    const cacheDir = tempDir("agenc-hardening-failure-");
    const includeDir = tempNodeIncludeDir();
    const fakeExecFileSync = ((file: string) => {
      if (file === "cc") throw new Error("compiler failed");
      return Buffer.alloc(0);
    }) as never;

    try {
      applyPreMainProcessHardening({
        env: { LD_AUDIT: "/tmp/audit.so" },
        platform: "linux",
        nativeMode: "required",
        allowRuntimeNativeBuild: true,
        cacheDir,
        compiler: "cc",
        execFileSync: fakeExecFileSync,
        nodeIncludeDir: includeDir,
      });
      throw new Error("expected process hardening to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessHardeningError);
      const result = (error as ProcessHardeningError).result;
      expect(result.scrubbedEnvKeys).toEqual(["LD_AUDIT"]);
      expect(step(result, "set_core_limit")?.status).toBe("applied");
      expect(step(result, "disable_process_dumping")?.status).toBe("failed");
      expect(step(result, "disable_process_dumping")?.error).toContain("compiler failed");
    }
  });

  test("uses bundle-style linker arguments for macOS native addon builds", () => {
    const cacheDir = tempDir("agenc-hardening-darwin-");
    const includeDir = tempNodeIncludeDir();
    const calls: Array<{ file: string; args: string[] }> = [];
    const fakeExecFileSync = ((file: string, args: readonly string[]) => {
      const nextArgs = [...args];
      calls.push({ file, args: nextArgs });
      writeFileSync(outputPath(nextArgs), "not-a-real-addon");
      return Buffer.alloc(0);
    }) as never;

    expect(() => compileAndLoadNativeHardeningBinding({
      cacheDir,
      compiler: "cc",
      execFileSync: fakeExecFileSync,
      nodeIncludeDir: includeDir,
      platform: "darwin",
    })).toThrow();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "-fPIC",
    ]));
    expect(calls[0]?.args).not.toContain("-shared");
  });

  test("rebuilds stale native cache contents before loading", () => {
    const cacheDir = tempDir("agenc-hardening-stale-");
    const includeDir = tempNodeIncludeDir();
    const addonPath = path.join(cacheDir, "agenc-process-hardening.node");
    const manifestPath = path.join(cacheDir, "manifest.json");
    writeFileSync(addonPath, "stale-addon", { mode: 0o600 });
    writeFileSync(manifestPath, JSON.stringify({
      sourceHash: "stale",
      artifactHash: "stale",
      platform: process.platform,
      arch: process.arch,
      modules: process.versions.modules,
    }), { mode: 0o600 });
    const fakeExecFileSync = ((_file: string, args: readonly string[]) => {
      writeFileSync(outputPath([...args]), "rebuilt-addon");
      return Buffer.alloc(0);
    }) as never;

    expect(() => compileAndLoadNativeHardeningBinding({
      cacheDir,
      compiler: "cc",
      execFileSync: fakeExecFileSync,
      nodeIncludeDir: includeDir,
      platform: process.platform,
    })).toThrow();

    expect(readFileSync(addonPath, "utf8")).toBe("rebuilt-addon");
  });

  test("narrows native cache directory permissions before compiling", () => {
    const cacheDir = tempDir("agenc-hardening-perms-");
    const includeDir = tempNodeIncludeDir();
    chmodSync(cacheDir, 0o777);
    const fakeExecFileSync = ((_file: string, args: readonly string[]) => {
      writeFileSync(outputPath([...args]), "not-a-real-addon");
      return Buffer.alloc(0);
    }) as never;

    try {
      expect(() => compileAndLoadNativeHardeningBinding({
        cacheDir,
        compiler: "cc",
        execFileSync: fakeExecFileSync,
        nodeIncludeDir: includeDir,
        platform: process.platform,
      })).toThrow();
      expect(statSync(cacheDir).mode & 0o077).toBe(0);
    } finally {
      chmodSync(cacheDir, 0o700);
    }
  });

  const nativeBuildTest = process.platform === "linux" && hasNativeBuildTools()
    ? test
    : test.skip;

  nativeBuildTest("loads the native hardening path inside a spawned process", () => {

    const cacheDir = tempDir("agenc-hardening-test-");
    const moduleUrl = sourceUrl("sandbox/hardening/index.ts").href;
    const script = `
      import {
        applyPreMainProcessHardening,
        compileAndLoadNativeHardeningBinding,
      } from ${JSON.stringify(moduleUrl)};
      const nativeBinding = compileAndLoadNativeHardeningBinding({
        cacheDir: process.env.AGENC_HARDENING_CACHE,
      });
      const result = applyPreMainProcessHardening({
        nativeBinding,
      });
      const payload = {
        result,
        coreLimit: nativeBinding.getCoreFileSizeLimit?.(),
        dumpable: nativeBinding.getLinuxDumpable?.(),
      };
      process.stdout.write(JSON.stringify(payload));
    `;

    const child = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
    ], {
      cwd: repoRoot(),
      env: {
        ...process.env,
        AGENC_HARDENING_CACHE: cacheDir,
      },
      encoding: "utf8",
    });

    expect(child.status, child.stderr).toBe(0);
    const payload = JSON.parse(child.stdout) as {
      result: ProcessHardeningResult;
      coreLimit: number;
      dumpable: number;
    };
    expect(step(payload.result, "set_core_limit")?.status).toBe("applied");
    expect(step(payload.result, "disable_process_dumping")?.status).toBe("applied");
    expect(payload.coreLimit).toBe(0);
    expect(payload.dumpable).toBe(0);
  });

  nativeBuildTest("can compile through explicit runtime-build opt-in", () => {
    const cacheDir = tempDir("agenc-hardening-build-opt-in-");
    const moduleUrl = sourceUrl("sandbox/hardening/index.ts").href;
    const script = `
      import { applyPreMainProcessHardening } from ${JSON.stringify(moduleUrl)};
      const result = applyPreMainProcessHardening({
        allowRuntimeNativeBuild: true,
        cacheDir: process.env.AGENC_HARDENING_CACHE,
      });
      process.stdout.write(JSON.stringify(result));
    `;

    const child = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
    ], {
      cwd: repoRoot(),
      env: {
        ...process.env,
        AGENC_HARDENING_CACHE: cacheDir,
      },
      encoding: "utf8",
    });

    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout) as ProcessHardeningResult;
    expect(step(result, "set_core_limit")?.status).toBe("applied");
    expect(step(result, "disable_process_dumping")?.status).toBe("applied");
  });
});

function step(
  result: ProcessHardeningResult,
  operation: string,
) {
  return result.steps.find((entry) => entry.operation === operation);
}

function hasNativeBuildTools(): boolean {
  return existsSync("/usr/include/node/node_api.h") &&
    spawnSync("sh", ["-c", "command -v cc"], {
      stdio: "ignore",
    }).status === 0;
}

function tempNodeIncludeDir(): string {
  const includeDir = tempDir("agenc-node-include-");
  mkdirSync(includeDir, { recursive: true });
  writeFileSync(path.join(includeDir, "node_api.h"), "");
  return includeDir;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryPaths.push(dir);
  return dir;
}

function outputPath(args: string[]): string {
  const outputFlag = args.indexOf("-o");
  expect(outputFlag).toBeGreaterThanOrEqual(0);
  const filePath = args[outputFlag + 1];
  expect(filePath).toBeTruthy();
  return filePath;
}

function repoRoot(): string {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}
