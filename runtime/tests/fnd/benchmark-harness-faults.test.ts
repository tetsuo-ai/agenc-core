import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

import { publishBenchmarkArtifacts } from "../../benchmarks/fnd/artifact-output.mjs";
import { readBoundedRegularFile } from "../../benchmarks/fnd/bounded-file.mjs";
import {
  BENCHMARK_WORKER_COMPLETION_PREFIX,
  normalizeResourceUsageMaxRssBytes,
  summarizeSamples,
} from "../../benchmarks/fnd/contract.mjs";
import {
  assertBenchmarkWorkerEnvironment,
  assertNoBenchmarkExecArguments,
  assertNoUnsafeBenchmarkEnvironment,
  createBenchmarkWorkerEnvironment,
  removeDarwinInjectedBenchmarkEnvironment,
  removeWindowsInjectedBenchmarkEnvironment,
} from "../../benchmarks/fnd/environment.mjs";
import {
  assertNoBenchmarkControlsAtOrAbove,
  cleanupOwnedTemporaryRoot,
  retainedOwnedTemporaryRootPath,
  validateOwnedTemporaryRootPath,
  withOwnedTemporaryRoot,
} from "../../benchmarks/fnd/isolation.mjs";
import { PRODUCTION_MODULE_RECORD_PREFIX } from "../../benchmarks/fnd/module-closure.mjs";
import {
  assertBindingsStable,
  bindProductionModuleClosures,
  captureBenchmarkProvenance,
  collectNormalizedFileBindings,
  createBenchmarkSubprocessEnvironment,
  createSanitizedGitEnvironment,
  METADATA_COMMAND_SETTLEMENT_TIMEOUT_MS,
  METADATA_COMMAND_WORKER_OVERHEAD_MS,
  resolveBenchmarkGitExecutable,
  resolveBenchmarkNpmCliPath,
  runBoundedCommandText,
  verifyBenchmarkCapture,
  verifyCheckedBenchmarkProvenance,
} from "../../benchmarks/fnd/provenance.mjs";
import {
  CHILD_TERMINATION_SETTLEMENT_TIMEOUT_MS,
  runBoundedChild,
} from "../../benchmarks/fnd/supervisor.mjs";

const RUNTIME_ROOT = join(import.meta.dirname, "../..");
const RUNNER_PATH = join(RUNTIME_ROOT, "benchmarks/fnd/run-baselines.mjs");
const CASE_WORKER_PATH = join(RUNTIME_ROOT, "benchmarks/fnd/case-worker.mjs");
const NPM_CLI_BOUNDARY_PROBE_TIMEOUT_MS = 15_000;
const MODULE_TRACKER_PATH = join(
  RUNTIME_ROOT,
  "benchmarks/fnd/module-closure.mjs",
);
const FIXTURE_PRODUCTION_SOURCE = [
  'import { dependency } from "./dependency.js";',
  "export const value = dependency;",
  "",
].join("\n");

describe("FND benchmark harness fault contracts", () => {
  test("pins median and median absolute deviation semantics independently", () => {
    expect(summarizeSamples([9, 1, 5, 3, 7])).toEqual({
      madMs: 2,
      maxMs: 9,
      medianMs: 5,
      minMs: 1,
      sampleCount: 5,
      samplesMs: [9, 1, 5, 3, 7],
    });
    expect(summarizeSamples([1, 3, 9, 11])).toMatchObject({
      madMs: 4,
      medianMs: 6,
    });
  });

  test("normalizes the worker process high-water RSS from KiB to bytes", () => {
    expect(normalizeResourceUsageMaxRssBytes(42)).toBe(43_008);
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => normalizeResourceUsageMaxRssBytes(invalid)).toThrow();
    }
  });

  test("rejects all nonempty ambient Node and tsx namespace entries", () => {
    for (const name of [
      "NODE_OPTIONS",
      "NODE_ENV",
      "NODE_FUTURE_RUNTIME_CONTROL",
      "node_options",
      "NoDe_FuTuRe_RuNtImE_CoNtRoL",
      "TSX_TSCONFIG_PATH",
      "tsx_future_loader_control",
    ]) {
      expect(() =>
        assertNoUnsafeBenchmarkEnvironment({ [name]: "nonempty" }),
      ).toThrow(name);
    }
    expect(() => assertNoUnsafeBenchmarkEnvironment({})).not.toThrow();
    expect(() =>
      assertNoUnsafeBenchmarkEnvironment({
        node_future_runtime_control: "",
        TSX_FUTURE_LOADER_CONTROL: "",
      }),
    ).not.toThrow();
  });

  test("binds all worker state directories to its supervisor-owned root", async () => {
    await withOwnedTemporaryRoot(async (ownedRoot) => {
      const ambientTemporaryRoot = join(tmpdir(), "agenc-fnd-shared-ambient");
      const hostEnvironment: Record<string, string> = {
        AGENC_HOME: ambientTemporaryRoot,
        AGENC_PRIVATE_TOKEN: "must-not-cross-the-worker-boundary",
        HOME: "/private/home",
        PATH: "/unbound/path",
        TEMP: ambientTemporaryRoot,
        TMP: ambientTemporaryRoot,
        TMPDIR: ambientTemporaryRoot,
      };
      if (process.platform === "win32") {
        hostEnvironment.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
      }
      expect(() =>
        createBenchmarkWorkerEnvironment(hostEnvironment, process.platform),
      ).toThrow(/require an owned temporary root/u);
      const workerEnvironment = createBenchmarkWorkerEnvironment(
        hostEnvironment,
        process.platform,
        ownedRoot,
      );
      expect(workerEnvironment).not.toHaveProperty("AGENC_PRIVATE_TOKEN");
      expect(workerEnvironment).not.toHaveProperty("HOME");
      expect(workerEnvironment).not.toHaveProperty("PATH");
      expect(() =>
        assertBenchmarkWorkerEnvironment(workerEnvironment, process.platform),
      ).toThrow(/require an owned temporary root/u);
      for (const name of ["AGENC_HOME", "TEMP", "TMP", "TMPDIR"]) {
        expect(workerEnvironment[name]).toBe(ownedRoot);
        expect(workerEnvironment[name]).not.toBe(ambientTemporaryRoot);
      }
      expect(() =>
        assertBenchmarkWorkerEnvironment(
          workerEnvironment,
          process.platform,
          ownedRoot,
        ),
      ).not.toThrow();

      const darwinWorkerEnvironment = createBenchmarkWorkerEnvironment(
        hostEnvironment,
        "darwin",
        ownedRoot,
      );
      const darwinEnvironment = {
        ...darwinWorkerEnvironment,
        __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
      };
      removeDarwinInjectedBenchmarkEnvironment(darwinEnvironment, "darwin");
      expect(darwinEnvironment).not.toHaveProperty("__CF_USER_TEXT_ENCODING");
      expect(() =>
        assertBenchmarkWorkerEnvironment(
          darwinEnvironment,
          "darwin",
          ownedRoot,
        ),
      ).not.toThrow();
      const legacyDarwinEnvironment = {
        ...darwinWorkerEnvironment,
        __CF_USER_TEXT_ENCODING: "0x1F5:0:0",
      };
      removeDarwinInjectedBenchmarkEnvironment(
        legacyDarwinEnvironment,
        "darwin",
      );
      expect(legacyDarwinEnvironment).not.toHaveProperty(
        "__CF_USER_TEXT_ENCODING",
      );
      expect(() =>
        removeDarwinInjectedBenchmarkEnvironment(
          { __CF_USER_TEXT_ENCODING: "host-controlled" },
          "darwin",
        ),
      ).toThrow(/injected an invalid __CF_USER_TEXT_ENCODING value/u);

      const windowsEnvironment = {
        ...createBenchmarkWorkerEnvironment(
          { SystemRoot: "C:\\Windows" },
          "win32",
          ownedRoot,
        ),
        HOMEDRIVE: "C:",
        HOMEPATH: "\\Users\\runner",
        LOGONSERVER: "\\\\RUNNER",
        PATH: "C:\\host-path",
        SYSTEMDRIVE: "C:",
        USERDOMAIN: "RUNNER",
        USERNAME: "runner",
        USERPROFILE: "C:\\Users\\runner",
        WINDIR: "C:\\Windows",
      };
      removeWindowsInjectedBenchmarkEnvironment(windowsEnvironment, "win32");
      expect(() =>
        assertBenchmarkWorkerEnvironment(
          windowsEnvironment,
          "win32",
          ownedRoot,
        ),
      ).not.toThrow();
      const unexpectedWindowsEnvironment = {
        ...windowsEnvironment,
        AGENC_PRIVATE_TOKEN: "must-not-cross-the-worker-boundary",
      };
      removeWindowsInjectedBenchmarkEnvironment(
        unexpectedWindowsEnvironment,
        "win32",
      );
      expect(() =>
        assertBenchmarkWorkerEnvironment(
          unexpectedWindowsEnvironment,
          "win32",
          ownedRoot,
        ),
      ).toThrow(/unexpected environment: AGENC_PRIVATE_TOKEN/u);

      expect(() =>
        assertBenchmarkWorkerEnvironment(
          { ...workerEnvironment, TEMP: ambientTemporaryRoot },
          process.platform,
          ownedRoot,
        ),
      ).toThrow(/owned root for TEMP/u);
    });
  });

  test("never treats the temporary namespace itself as an owned root", () => {
    const dangerousTemporaryDirectory = join(
      tmpdir(),
      "agenc-fnd-bench-namespace",
    );
    expect(() =>
      validateOwnedTemporaryRootPath(
        dangerousTemporaryDirectory,
        dangerousTemporaryDirectory,
      ),
    ).toThrow(/outside the owned namespace/u);
  });

  test("refuses to delete a directory swapped over an owned root", async () => {
    let movedOwnedRoot: string | undefined;
    let replacementRoot: string | undefined;
    try {
      await expect(
        withOwnedTemporaryRoot(async (ownedRoot) => {
          movedOwnedRoot = `${ownedRoot}-moved`;
          replacementRoot = ownedRoot;
          renameSync(ownedRoot, movedOwnedRoot);
          mkdirSync(replacementRoot);
          writeFileSync(join(replacementRoot, "replacement"), "preserve\n");
        }),
      ).rejects.toThrow(/identity changed; refusing recursive cleanup/u);
      expect(readFileSync(join(replacementRoot!, "replacement"), "utf8")).toBe(
        "preserve\n",
      );
      expect(existsSync(movedOwnedRoot!)).toBe(true);
    } finally {
      if (replacementRoot !== undefined && existsSync(replacementRoot)) {
        rmSync(replacementRoot, { force: true, recursive: true });
      }
      if (movedOwnedRoot !== undefined && existsSync(movedOwnedRoot)) {
        rmSync(movedOwnedRoot, { force: true, recursive: true });
      }
    }
  });

  if (process.platform === "win32") {
    test("revalidates identity across bounded Windows directory-lock retries", async () => {
      let delayedChild: ReturnType<typeof spawn> | undefined;
      let delayedRoot: string | undefined;
      await withOwnedTemporaryRoot(async (ownedRoot) => {
        delayedRoot = ownedRoot;
        delayedChild = spawn(
          process.execPath,
          ["-e", "process.stdout.write('ready'); setTimeout(() => {}, 2250)"],
          {
            cwd: ownedRoot,
            env: process.env,
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
          },
        );
        const [ready] = await once(delayedChild.stdout!, "data");
        expect(String(ready)).toBe("ready");
      });
      expect(delayedRoot).toBeDefined();
      expect(existsSync(delayedRoot!)).toBe(false);
      if (
        delayedChild!.exitCode === null &&
        delayedChild!.signalCode === null
      ) {
        await once(delayedChild!, "close");
      }

      let swappedChild: ReturnType<typeof spawn> | undefined;
      let swappedRoot: string | undefined;
      let movedRoot: string | undefined;
      try {
        await expect(
          withOwnedTemporaryRoot(async (ownedRoot) => {
            swappedRoot = ownedRoot;
            movedRoot = `${ownedRoot}-moved`;
            const swapSource = [
              'const fs = require("node:fs");',
              'const path = require("node:path");',
              "const [root, moved] = process.argv.slice(1);",
              "process.stdout.write('ready');",
              "setTimeout(() => {",
              "  process.chdir(path.dirname(root));",
              "  fs.renameSync(root, moved);",
              "  fs.mkdirSync(root);",
              "  fs.writeFileSync(path.join(root, 'replacement'), 'preserve\\n');",
              "}, 75);",
            ].join("\n");
            swappedChild = spawn(
              process.execPath,
              ["-e", swapSource, ownedRoot, movedRoot],
              {
                cwd: ownedRoot,
                env: process.env,
                stdio: ["ignore", "pipe", "ignore"],
                windowsHide: true,
              },
            );
            const [ready] = await once(swappedChild.stdout!, "data");
            expect(String(ready)).toBe("ready");
          }),
        ).rejects.toThrow(/identity changed; refusing recursive cleanup/u);
        expect(readFileSync(join(swappedRoot!, "replacement"), "utf8")).toBe(
          "preserve\n",
        );
        expect(existsSync(movedRoot!)).toBe(true);
      } finally {
        if (
          swappedChild !== undefined &&
          swappedChild.exitCode === null &&
          swappedChild.signalCode === null
        ) {
          await once(swappedChild, "close");
        }
        if (swappedRoot !== undefined && existsSync(swappedRoot)) {
          rmSync(swappedRoot, { force: true, recursive: true });
        }
        if (movedRoot !== undefined && existsSync(movedRoot)) {
          rmSync(movedRoot, { force: true, recursive: true });
        }
      }

      let lockedChild: ReturnType<typeof spawn> | undefined;
      let lockedRoot: string | undefined;
      try {
        await expect(
          withOwnedTemporaryRoot(async (ownedRoot) => {
            lockedRoot = ownedRoot;
            lockedChild = spawn(
              process.execPath,
              [
                "-e",
                "process.stdout.write('ready'); setInterval(() => {}, 1000)",
              ],
              {
                cwd: ownedRoot,
                env: process.env,
                stdio: ["ignore", "pipe", "ignore"],
                windowsHide: true,
              },
            );
            const [ready] = await once(lockedChild.stdout!, "data");
            expect(String(ready)).toBe("ready");
          }),
        ).rejects.toMatchObject({ code: "EPERM" });
        expect(lockedRoot).toBeDefined();
        expect(existsSync(lockedRoot!)).toBe(true);
      } finally {
        if (
          lockedChild !== undefined &&
          lockedChild.exitCode === null &&
          lockedChild.signalCode === null
        ) {
          lockedChild.kill("SIGKILL");
          await once(lockedChild, "close");
        }
        if (lockedRoot !== undefined && existsSync(lockedRoot)) {
          cleanupOwnedTemporaryRoot(lockedRoot);
        }
      }
    }, 15_000);
  }

  test("matches the minimal Windows worker allowlist case-insensitively", () => {
    const ownedRoot = join(tmpdir(), "agenc-fnd-windows-owned-root");
    const workerEnvironment = createBenchmarkWorkerEnvironment(
      {
        cOmSpEc: "C:\\Windows\\System32\\cmd.exe",
        sYsTeMrOoT: "C:\\Windows",
        TEMP: "C:\\shared-ambient-temp",
        wInDiR: "C:\\Windows",
      },
      "win32",
      ownedRoot,
    );
    expect(workerEnvironment.SystemRoot).toBe("C:\\Windows");
    expect(workerEnvironment).not.toHaveProperty("WINDIR");
    expect(workerEnvironment).not.toHaveProperty("ComSpec");

    const mixedCaseEnvironment = {
      aGeNc_HoMe: ownedRoot,
      lAnG: "C",
      lC_aLl: "C",
      sYsTeMrOoT: "C:\\Windows",
      tEmP: ownedRoot,
      tMp: ownedRoot,
      tMpDiR: ownedRoot,
      tSx_DiSaBlE_CaChE: "1",
      tZ: "UTC",
    };
    expect(() =>
      assertBenchmarkWorkerEnvironment(
        mixedCaseEnvironment,
        "win32",
        ownedRoot,
      ),
    ).not.toThrow();
    expect(() =>
      assertBenchmarkWorkerEnvironment(
        { ...mixedCaseEnvironment, PaTh: "C:\\unbound" },
        "win32",
        ownedRoot,
      ),
    ).toThrow(/unexpected environment: PaTh/u);
    expect(() =>
      assertBenchmarkWorkerEnvironment(
        { ...mixedCaseEnvironment, SYSTEMROOT: "C:\\duplicate" },
        "win32",
        ownedRoot,
      ),
    ).toThrow(/repeats a case-insensitive name/u);
  });

  test("requires empty Node execArgv", () => {
    expect(() => assertNoBenchmarkExecArguments([])).not.toThrow();
    for (const execArguments of [
      ["--import", "no-op.mjs"],
      ["--require", "no-op.cjs"],
      ["--loader", "no-op-loader.mjs"],
      ["--conditions=agenc-fnd-test"],
      ["--no-warnings"],
    ]) {
      expect(() => assertNoBenchmarkExecArguments(execArguments)).toThrow(
        /requires empty Node execArgv/u,
      );
    }
  });

  test("fails the runner closed for direct Node execution arguments", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agenc-fnd-exec-argv-"));
    try {
      const modulePath = join(temporaryRoot, "no-op.mjs");
      const commonJsPath = join(temporaryRoot, "no-op.cjs");
      writeFileSync(modulePath, "export {};\n", "utf8");
      writeFileSync(commonJsPath, "module.exports = {};\n", "utf8");
      const moduleUrl = pathToFileURL(modulePath).href;
      for (const execArguments of [
        ["--import", moduleUrl],
        ["--require", commonJsPath],
        ["--loader", moduleUrl],
        ["--conditions=agenc-fnd-test"],
        ["--no-warnings"],
      ]) {
        const result = spawnSync(
          process.execPath,
          [...execArguments, RUNNER_PATH, "--plan"],
          {
            cwd: RUNTIME_ROOT,
            encoding: "utf8",
            env: createCleanRunnerEnvironment(),
            maxBuffer: 2_097_152,
            timeout: 5_000,
            windowsHide: true,
          },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/requires empty Node execArgv/u);
      }
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("detects a visible NODE_OPTIONS override after inert preload initialization", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agenc-fnd-preload-"));
    try {
      const preloadPath = join(temporaryRoot, "preload.mjs");
      writeFileSync(preloadPath, "export {};\n", "utf8");
      const result = spawnSync(process.execPath, [RUNNER_PATH, "--plan"], {
        cwd: RUNTIME_ROOT,
        encoding: "utf8",
        env: {
          ...createCleanRunnerEnvironment(),
          NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
        },
        maxBuffer: 2_097_152,
        timeout: 5_000,
        windowsHide: true,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unsafe benchmark.*NODE_OPTIONS/u);
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("publishes baseline artifacts exclusively and cleans a partial pair", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-fnd-artifact-pair-"));
    const jsonPath = join(root, "baseline.json");
    const markdownPath = join(root, "baseline.md");
    try {
      writeFileSync(jsonPath, "reviewed-json", "utf8");
      expect(() =>
        publishBenchmarkArtifacts({
          json: "new-json",
          jsonPath,
          markdown: "new-markdown",
          markdownPath,
        }),
      ).toThrow(/without replacing existing files/u);
      expect(readFileSync(jsonPath, "utf8")).toBe("reviewed-json");
      expect(existsSync(markdownPath)).toBe(false);

      rmSync(jsonPath);
      writeFileSync(markdownPath, "reviewed-markdown", "utf8");
      expect(() =>
        publishBenchmarkArtifacts({
          json: "partial-json",
          jsonPath,
          markdown: "new-markdown",
          markdownPath,
        }),
      ).toThrow(/without replacing existing files/u);
      expect(existsSync(jsonPath)).toBe(false);
      expect(readFileSync(markdownPath, "utf8")).toBe("reviewed-markdown");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("binds bounded file reads to one descriptor and rejects oversize", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-fnd-bound-read-"));
    const targetPath = join(root, "target.txt");
    const displacedPath = join(root, "displaced.txt");
    const maximumBytes = 64;
    let closeCount = 0;
    try {
      writeFileSync(targetPath, "reviewed\n", "utf8");
      let readAllocation: Buffer | undefined;
      const boundedBytes = readBoundedRegularFile(
        targetPath,
        maximumBytes,
        "allocation probe",
        {
          readSync(
            descriptor: number,
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
          ) {
            readAllocation ??= buffer;
            return readSync(descriptor, buffer, offset, length, position);
          },
        },
      );
      expect(boundedBytes.toString("utf8")).toBe("reviewed\n");
      expect(readAllocation).toBeDefined();
      expect(boundedBytes.buffer).toBe(readAllocation!.buffer);

      expect(() =>
        readBoundedRegularFile(targetPath, maximumBytes, "replacement probe", {
          closeSync(descriptor: number) {
            closeCount += 1;
            closeSync(descriptor);
          },
          openSync(path: string, flags: number) {
            renameSync(targetPath, displacedPath);
            writeFileSync(targetPath, "replacement\n", "utf8");
            return openSync(path, flags);
          },
        }),
      ).toThrow(/changed while it was opened/u);
      expect(closeCount).toBe(1);
      expect(readFileSync(targetPath, "utf8")).toBe("replacement\n");

      writeFileSync(targetPath, "x".repeat(maximumBytes + 1), "utf8");
      expect(() =>
        readBoundedRegularFile(targetPath, maximumBytes, "oversize probe"),
      ).toThrow(/exceeds 64 bytes/u);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("never removes a replacement swapped over its first artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-fnd-artifact-swap-"));
    const jsonPath = join(root, "baseline.json");
    const movedJsonPath = join(root, "created-json");
    const markdownPath = join(root, "baseline.md");
    let injected = false;
    try {
      expect(() =>
        publishBenchmarkArtifacts(
          {
            json: "created-by-publisher",
            jsonPath,
            markdown: "markdown",
            markdownPath,
          },
          {
            openSync(path: string, flags: string, mode: number) {
              if (path === markdownPath && !injected) {
                injected = true;
                renameSync(jsonPath, movedJsonPath);
                writeFileSync(jsonPath, "replacement", "utf8");
                throw new Error("injected second-artifact failure");
              }
              return openSync(path, flags, mode);
            },
          },
        ),
      ).toThrow(/cleanup was incomplete/u);
      expect(readFileSync(jsonPath, "utf8")).toBe("replacement");
      expect(readFileSync(movedJsonPath, "utf8")).toBe("created-by-publisher");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reports an owned-artifact cleanup failure without deleting it", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-fnd-artifact-cleanup-"));
    const jsonPath = join(root, "baseline.json");
    const markdownPath = join(root, "baseline.md");
    try {
      writeFileSync(markdownPath, "existing", "utf8");
      expect(() =>
        publishBenchmarkArtifacts(
          {
            json: "created-json",
            jsonPath,
            markdown: "markdown",
            markdownPath,
          },
          {
            unlinkSync(path: string) {
              if (path === jsonPath) {
                throw new Error("injected owned-output cleanup failure");
              }
              rmSync(path);
            },
          },
        ),
      ).toThrow(/cleanup was incomplete/u);
      expect(readFileSync(jsonPath, "utf8")).toBe("created-json");
      expect(readFileSync(markdownPath, "utf8")).toBe("existing");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("handles identity, write, and sync failures after exclusive creation", () => {
    for (const operation of [
      "fstatSync",
      "writeFileSync",
      "fsyncSync",
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `agenc-fnd-${operation}-`));
      const jsonPath = join(root, "baseline.json");
      const markdownPath = join(root, "baseline.md");
      let closeCount = 0;
      try {
        expect(() =>
          publishBenchmarkArtifacts(
            {
              json: "json",
              jsonPath,
              markdown: "markdown",
              markdownPath,
            },
            {
              closeSync(descriptor: number) {
                closeCount += 1;
                closeSync(descriptor);
              },
              [operation]() {
                throw new Error(`injected ${operation} failure`);
              },
            },
          ),
        ).toThrow();
        expect(existsSync(jsonPath)).toBe(operation === "fstatSync");
        expect(existsSync(markdownPath)).toBe(false);
        expect(closeCount).toBe(1);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    }
  });

  test("removes every ambient Git override before provenance commands", () => {
    const ambientEnvironment: Record<string, string> = {
      AWS_SECRET_ACCESS_KEY: "must-not-cross-the-subprocess-boundary",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/unbound/hooks",
      GIT_DIR: "/unbound/repository",
      HOME: "/private/home",
      git_index_file: "/unbound/index",
      PATH: "/known/path",
      XAI_API_KEY: "must-not-cross-the-subprocess-boundary",
    };
    if (process.platform === "win32") {
      ambientEnvironment.sYsTeMrOoT = "C:\\Windows";
    }
    const subprocessEnvironment = createBenchmarkSubprocessEnvironment(
      ambientEnvironment,
      process.platform,
    );
    const sanitized = createSanitizedGitEnvironment(ambientEnvironment);
    for (const environment of [subprocessEnvironment, sanitized]) {
      expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(environment).not.toHaveProperty("HOME");
      expect(environment).not.toHaveProperty("XAI_API_KEY");
    }
    expect(sanitized.PATH).toBe("/known/path");
    expect(
      Object.keys(sanitized).filter((name) =>
        name.toUpperCase().startsWith("GIT_"),
      ),
    ).toEqual([
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_NO_REPLACE_OBJECTS",
    ]);
    expect(sanitized.GIT_NO_REPLACE_OBJECTS).toBe("1");
  });

  test("resolves Windows Git from bounded PATH in directory order", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-fnd-git-path-"));
    const firstDirectory = join(root, "first directory");
    const secondDirectory = join(root, "second-directory");
    const firstExe = join(firstDirectory, "git.exe");
    const firstCom = join(firstDirectory, "git.com");
    const secondCom = join(secondDirectory, "git.com");
    try {
      mkdirSync(firstDirectory);
      mkdirSync(secondDirectory);
      writeFileSync(firstExe, "first exe\n", "utf8");
      writeFileSync(secondCom, "second com\n", "utf8");
      const environment = {
        Path: `"${firstDirectory}";${secondDirectory}`,
      };
      expect(resolveBenchmarkGitExecutable(environment, "win32")).toBe(
        realpathSync(firstExe),
      );

      writeFileSync(firstCom, "first com\n", "utf8");
      expect(resolveBenchmarkGitExecutable(environment, "win32")).toBe(
        realpathSync(firstCom),
      );
      expect(resolveBenchmarkGitExecutable({}, "linux")).toBe("git");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects malformed or unbounded Windows Git search paths", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-fnd-git-path-invalid-"));
    try {
      expect(() => resolveBenchmarkGitExecutable({}, "win32")).toThrow(
        /PATH is malformed/u,
      );
      expect(() =>
        resolveBenchmarkGitExecutable({ PATH: `"${root}` }, "win32"),
      ).toThrow(/unmatched quote/u);
      const excessiveEntries = Array.from({ length: 513 }, (_, index) =>
        join(root, String(index)),
      ).join(";");
      expect(() =>
        resolveBenchmarkGitExecutable({ PATH: excessiveEntries }, "win32"),
      ).toThrow(/too many entries/u);
      expect(() =>
        resolveBenchmarkGitExecutable({ PATH: root }, "win32"),
      ).toThrow(/could not resolve a regular Git executable/u);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("ignores ambient npm CLI injection at the metadata boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-fnd-hostile-npm-"));
    const hostileNpmCliPath = join(root, "hostile-npm-cli.cjs");
    const executionMarkerPath = join(root, "executed");
    const fakeExecutablePath = join(root, "bin", "node");
    const fakeNpmCliPath = join(
      root,
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    const previousNpmExecPath = process.env.npm_execpath;
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "lib", "node_modules", "npm", "bin"), {
      recursive: true,
    });
    writeFileSync(fakeExecutablePath, "fixture Node executable\n", "utf8");
    writeFileSync(fakeNpmCliPath, "fixture npm CLI\n", "utf8");
    writeFileSync(
      hostileNpmCliPath,
      `require("node:fs").writeFileSync(${JSON.stringify(executionMarkerPath)}, "executed");\n`,
      "utf8",
    );
    process.env.npm_execpath = hostileNpmCliPath;
    try {
      expect(resolveBenchmarkNpmCliPath(fakeExecutablePath)).toBe(
        realpathSync(fakeNpmCliPath),
      );
      const npmCliPath = resolveBenchmarkNpmCliPath();
      expect(npmCliPath).not.toBe(hostileNpmCliPath);
      expect(
        runBoundedCommandText(process.execPath, [npmCliPath, "--version"], {
          cwd: RUNTIME_ROOT,
          label: "npm CLI boundary probe",
          maxOutputBytes: 65_536,
          timeoutMs: NPM_CLI_BOUNDARY_PROBE_TIMEOUT_MS,
        }),
      ).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/u);
      expect(existsSync(executionMarkerPath)).toBe(false);
    } finally {
      if (previousNpmExecPath === undefined) {
        delete process.env.npm_execpath;
      } else {
        process.env.npm_execpath = previousNpmExecPath;
      }
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects host ignore and Git controls inside the fixture namespace", async () => {
    await withOwnedTemporaryRoot(async (temporaryRoot) => {
      const fixtureRoot = join(temporaryRoot, "fixture");
      mkdirSync(fixtureRoot);
      const ignorePath = join(temporaryRoot, ".ignore");
      writeFileSync(ignorePath, "*.txt\n", "utf8");
      expect(() => assertNoBenchmarkControlsAtOrAbove(fixtureRoot)).toThrow(
        /inherits host \.ignore control state/u,
      );
      rmSync(ignorePath);

      mkdirSync(join(temporaryRoot, ".git"));
      expect(() => assertNoBenchmarkControlsAtOrAbove(fixtureRoot)).toThrow(
        /inherits host \.git control state/u,
      );
    });
  });

  test("cleans a parent-owned root when a child times out before its start record", async () => {
    let temporaryRoot: string | undefined;
    await expect(
      withOwnedTemporaryRoot(async (ownedRoot) => {
        temporaryRoot = ownedRoot;
        const result = await runBoundedChild({
          args: ["-e", "setInterval(() => {}, 1_000)"],
          command: process.execPath,
          cwd: RUNTIME_ROOT,
          env: process.env,
          maxOutputBytes: 1_024,
          timeoutMs: 100,
        });
        expect(result.timedOut).toBe(true);
        throw new Error("worker did not emit a start record");
      }),
    ).rejects.toThrow(/did not emit a start record/u);
    expect(temporaryRoot).toBeDefined();
    expect(existsSync(temporaryRoot!)).toBe(false);
  });

  test("kills output overflow and still removes the owned root", async () => {
    let temporaryRoot: string | undefined;
    await expect(
      withOwnedTemporaryRoot(async (ownedRoot) => {
        temporaryRoot = ownedRoot;
        await runBoundedChild({
          args: ["-e", 'process.stdout.write("x".repeat(4_096))'],
          command: process.execPath,
          cwd: RUNTIME_ROOT,
          env: process.env,
          maxOutputBytes: 64,
          timeoutMs: 1_000,
        });
      }),
    ).rejects.toThrow(/bounded output ceiling/u);
    expect(temporaryRoot).toBeDefined();
    expect(existsSync(temporaryRoot!)).toBe(false);
  });

  test("holds an authenticated completed worker until contained teardown", async () => {
    await withOwnedTemporaryRoot(async (ownedRoot) => {
      const completionNonce = "a".repeat(64);
      const result = await runBoundedChild({
        args: [
          CASE_WORKER_PATH,
          "--case",
          "patch_delete_parser_historical_comparison",
          "--point",
          "0",
          "--temporary-root",
          ownedRoot,
          "--completion-nonce",
          completionNonce,
        ],
        command: process.execPath,
        cwd: RUNTIME_ROOT,
        env: createBenchmarkWorkerEnvironment(
          process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
            : {},
          process.platform,
          ownedRoot,
        ),
        expectedCompletionRecord: `${BENCHMARK_WORKER_COMPLETION_PREFIX}${completionNonce}`,
        maxOutputBytes: 1_048_576,
        timeoutMs: 10_000,
      });
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed" });
    });
  });

  test("contains an ignored-stdio descendant after normal target exit", async () => {
    let descendantPid: number | undefined;
    let temporaryRoot: string | undefined;
    const detached = process.platform !== "darwin";
    const missingCompletionRecord = `${BENCHMARK_WORKER_COMPLETION_PREFIX}${"b".repeat(64)}`;
    const expectedContainmentError =
      process.platform === "win32"
        ? /before authenticated benchmark completion/u
        : /residual_process/u;
    const parentSource = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
      `  detached: ${JSON.stringify(detached)},`,
      '  stdio: "ignore",',
      "});",
      "child.unref();",
      'writeFileSync("descendant.pid", String(child.pid));',
    ].join("\n");
    try {
      await withOwnedTemporaryRoot(async (ownedRoot) => {
        temporaryRoot = ownedRoot;
        try {
          await expect(
            runBoundedChild({
              args: ["-e", parentSource],
              command: process.execPath,
              cwd: ownedRoot,
              env: process.env,
              expectedCompletionRecord: missingCompletionRecord,
              maxOutputBytes: 4_096,
              timeoutMs: 5_000,
            }),
          ).rejects.toThrow(expectedContainmentError);
        } finally {
          const descendantPidPath = join(ownedRoot, "descendant.pid");
          if (existsSync(descendantPidPath)) {
            descendantPid = Number(readFileSync(descendantPidPath));
          }
        }
      });
      expect(temporaryRoot).toBeDefined();
      expect(existsSync(temporaryRoot!)).toBe(false);
      expect(descendantPid).toBeDefined();
      await expectProcessToExit(descendantPid!, 1_000);
    } finally {
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Best-effort cleanup after a failed normal-exit containment assertion.
        }
      }
      if (temporaryRoot !== undefined && existsSync(temporaryRoot)) {
        rmSync(temporaryRoot, { force: true, recursive: true });
      }
    }
  });

  test("keeps standalone settlement alive through descendant cleanup", async () => {
    const probeRoot = mkdtempSync(
      join(tmpdir(), "agenc-fnd-standalone-settle-"),
    );
    const controlPath = join(probeRoot, "control.txt");
    let descendantPid: number | undefined;
    let ownedRoot: string | undefined;
    const supervisorUrl = pathToFileURL(
      join(RUNTIME_ROOT, "benchmarks/fnd/supervisor.mjs"),
    ).href;
    const isolationUrl = pathToFileURL(
      join(RUNTIME_ROOT, "benchmarks/fnd/isolation.mjs"),
    ).href;
    const probeSource = String.raw`
      import { appendFileSync } from "node:fs";
      const [controlPath, supervisorUrl, isolationUrl] = process.argv.slice(1);
      const { runBoundedChild } = await import(supervisorUrl);
      const { withOwnedTemporaryRoot } = await import(isolationUrl);
      const missingCompletionRecord = "AGENC_FND_BENCH_COMPLETE ${"c".repeat(64)}";
      try {
        await withOwnedTemporaryRoot(async (ownedRoot) => {
          appendFileSync(controlPath, "ROOT " + ownedRoot + ";");
          const parentSource = [
            'const { appendFileSync } = require("node:fs");',
            'const { spawn } = require("node:child_process");',
            'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
            '  detached: process.platform !== "darwin",',
            '  stdio: "ignore",',
            '});',
            'child.unref();',
            'appendFileSync(process.argv[1], "PID " + child.pid + ";");',
          ].join("\n");
          await runBoundedChild({
            args: ["-e", parentSource, controlPath],
            command: process.execPath,
            cwd: ownedRoot,
            env: process.env,
            expectedCompletionRecord: missingCompletionRecord,
            maxOutputBytes: 4_096,
            timeoutMs: 5_000,
          });
        });
        throw new Error("standalone containment probe unexpectedly succeeded");
      } catch (error) {
        if (!/(?:residual_process|before authenticated benchmark completion)/u.test(error.message)) {
          throw error;
        }
      }
      process.stdout.write("standalone settlement complete\n");
    `;
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          probeSource,
          controlPath,
          supervisorUrl,
          isolationUrl,
        ],
        {
          cwd: RUNTIME_ROOT,
          encoding: "utf8",
          env: process.env,
          maxBuffer: 65_536,
          timeout: 10_000,
          windowsHide: true,
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("standalone settlement complete\n");
      const control = readFileSync(controlPath, "utf8");
      ownedRoot = /ROOT ([^;]+);/u.exec(control)?.[1];
      descendantPid = Number(/PID (\d+);/u.exec(control)?.[1]);
      expect(ownedRoot).toBeDefined();
      expect(existsSync(ownedRoot!)).toBe(false);
      expect(descendantPid).toBeGreaterThan(1);
      await expectProcessToExit(descendantPid, 1_000);
    } finally {
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Best-effort cleanup for a failed standalone regression.
        }
      }
      if (ownedRoot !== undefined && existsSync(ownedRoot)) {
        rmSync(ownedRoot, { force: true, recursive: true });
      }
      rmSync(probeRoot, { force: true, recursive: true });
    }
  });

  test("terminates ignored-stdio descendants before parent-owned cleanup", async () => {
    let temporaryRoot: string | undefined;
    let descendantPid: number | undefined;
    const grandchildSource = "setInterval(() => {}, 1_000);";
    const parentSource = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { cwd: process.cwd(), stdio: "ignore" });`,
      "process.stderr.write(`DESCENDANT_PID ${child.pid}\\n`);",
      "setInterval(() => {}, 1_000);",
    ].join("\n");
    const startedAt = Date.now();
    try {
      await withOwnedTemporaryRoot(async (ownedRoot) => {
        temporaryRoot = ownedRoot;
        const result = await runBoundedChild({
          args: ["-e", parentSource],
          command: process.execPath,
          cwd: ownedRoot,
          env: process.env,
          maxOutputBytes: 4_096,
          timeoutMs: 1_000,
        });
        expect(result.timedOut).toBe(true);
        const match = /DESCENDANT_PID (\d+)/u.exec(result.stderr);
        expect(match).not.toBeNull();
        descendantPid = Number(match![1]);
      });
      expect(Date.now() - startedAt).toBeLessThan(
        1_000 + CHILD_TERMINATION_SETTLEMENT_TIMEOUT_MS + 1_000,
      );
      expect(temporaryRoot).toBeDefined();
      expect(existsSync(temporaryRoot!)).toBe(false);
      expect(descendantPid).toBeDefined();
      await expectProcessToExit(descendantPid!, 1_000);
    } finally {
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Best-effort test cleanup after a failed containment assertion.
        }
      }
      if (temporaryRoot !== undefined && existsSync(temporaryRoot)) {
        rmSync(temporaryRoot, { force: true, recursive: true });
      }
    }
  });

  test("propagates an injected process-tree kill failure", async () => {
    let terminationAttempts = 0;
    const processTreeController = {
      isAlive(child: {
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      }) {
        return child.exitCode === null && child.signalCode === null;
      },
      terminate(child: { kill(signal: NodeJS.Signals): boolean }) {
        terminationAttempts += 1;
        child.kill("SIGKILL");
        throw new Error("injected process-tree kill failure");
      },
    };
    await expect(
      runBoundedChild({
        args: ["-e", "setInterval(() => {}, 1_000)"],
        command: process.execPath,
        cwd: RUNTIME_ROOT,
        env: process.env,
        maxOutputBytes: 1_024,
        processTreeController,
        timeoutMs: 100,
      }),
    ).rejects.toThrow(/injected process-tree kill failure/u);
    expect(terminationAttempts).toBeGreaterThan(0);
  });

  test("retains the owned root when process-tree settlement is unproven", async () => {
    let childPid: number | undefined;
    let retainedRoot: string | undefined;
    let rejection: unknown;
    const processTreeController = {
      isAlive() {
        throw new Error("injected liveness proof failure");
      },
      terminate(child: { readonly pid?: number }) {
        childPid = child.pid;
        throw new Error("injected process-tree kill failure");
      },
    };
    try {
      await withOwnedTemporaryRoot(async (ownedRoot) => {
        retainedRoot = ownedRoot;
        await runBoundedChild({
          args: ["-e", "setInterval(() => {}, 1_000)"],
          command: process.execPath,
          cwd: ownedRoot,
          env: process.env,
          maxOutputBytes: 1_024,
          processTreeController,
          timeoutMs: 100,
        });
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({
      message: expect.stringMatching(/process tree did not terminate/u),
    });
    expect(retainedOwnedTemporaryRootPath(rejection)).toBe(retainedRoot);
    expect(rejection).toMatchObject({
      message: expect.stringContaining(retainedRoot!),
    });
    expect(retainedRoot).toBeDefined();
    expect(existsSync(retainedRoot!)).toBe(true);
    try {
      if (childPid !== undefined && processIsAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
        await expectProcessToExit(childPid, 1_000);
      }
    } finally {
      cleanupOwnedTemporaryRoot(retainedRoot!);
    }
    expect(existsSync(retainedRoot!)).toBe(false);
  });

  test("retains the owned root on a production containment result error", async () => {
    let retainedRoot: string | undefined;
    let rejection: unknown;
    try {
      try {
        await withOwnedTemporaryRoot(async (ownedRoot) => {
          retainedRoot = ownedRoot;
          await runBoundedChild({
            args: ["--injected"],
            command: process.execPath,
            cwd: ownedRoot,
            env: process.env,
            maxOutputBytes: 1_024,
            productionContainmentRunner: async () => ({
              backstopExpired: false,
              error: new Error("injected cleanup proof failure"),
              exitCode: null,
              forced: true,
              signal: "SIGKILL" as const,
              stderr: Buffer.alloc(0),
              stdout: Buffer.alloc(0),
              stopReason: "spawn_error" as const,
            }),
            timeoutMs: 100,
          });
        });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toMatchObject({
        message: expect.stringMatching(/injected cleanup proof failure/u),
      });
      expect(retainedOwnedTemporaryRootPath(rejection)).toBe(retainedRoot);
      expect(retainedRoot).toBeDefined();
      expect(existsSync(retainedRoot!)).toBe(true);
    } finally {
      if (retainedRoot !== undefined && existsSync(retainedRoot)) {
        cleanupOwnedTemporaryRoot(retainedRoot);
      }
    }
    if (retainedRoot !== undefined) {
      expect(existsSync(retainedRoot)).toBe(false);
    }
  });

  test("hard-kills a signal-resistant metadata process tree by its deadline", async () => {
    const probeRoot = mkdtempSync(
      join(tmpdir(), "agenc-fnd-metadata-deadline-"),
    );
    const descendantPath = join(probeRoot, "descendant.pid");
    let descendantPid: number | undefined;
    const detached = process.platform !== "darwin";
    const timeoutMs = 1_000;
    const source = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {',
      `  detached: ${JSON.stringify(detached)},`,
      '  stdio: "ignore",',
      "});",
      "child.unref();",
      "writeFileSync(process.argv[1], String(child.pid));",
      'process.on("SIGTERM", () => {});',
      "setTimeout(() => process.exit(0), 10_000);",
    ].join("\n");
    const startedAt = Date.now();
    try {
      expect(() =>
        runBoundedCommandText(
          process.execPath,
          ["-e", source, descendantPath],
          {
            cwd: probeRoot,
            label: "deadline probe",
            maxOutputBytes: 4_096,
            timeoutMs,
          },
        ),
      ).toThrow(new RegExp(`${timeoutMs} ms deadline`, "u"));
      expect(Date.now() - startedAt).toBeLessThan(
        timeoutMs +
          METADATA_COMMAND_SETTLEMENT_TIMEOUT_MS +
          METADATA_COMMAND_WORKER_OVERHEAD_MS,
      );
      descendantPid = Number(readFileSync(descendantPath, "utf8"));
      expect(descendantPid).toBeGreaterThan(1);
      await expectProcessToExit(descendantPid, 1_000);
    } finally {
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Best-effort cleanup for a failed containment regression.
        }
      }
      rmSync(probeRoot, { force: true, recursive: true });
    }
  });

  test("normalizes checkout line endings in harness evidence bindings", () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "agenc-fnd-binding-review-"),
    );
    const repositoryRoot = join(fixtureRoot, "repository");
    const outsideRoot = join(fixtureRoot, "outside");
    try {
      mkdirSync(repositoryRoot);
      mkdirSync(outsideRoot);
      const evidencePath = "evidence.mjs";
      writeFileSync(
        join(repositoryRoot, evidencePath),
        "one\r\ntwo\r\n",
        "utf8",
      );
      const bindings = collectNormalizedFileBindings(repositoryRoot, [
        evidencePath,
      ]);
      writeFileSync(join(repositoryRoot, evidencePath), "one\ntwo\n", "utf8");
      expect(() =>
        assertBindingsStable(repositoryRoot, bindings),
      ).not.toThrow();

      writeFileSync(join(outsideRoot, evidencePath), "outside\n", "utf8");
      symlinkSync(
        outsideRoot,
        join(repositoryRoot, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(() =>
        collectNormalizedFileBindings(repositoryRoot, [
          `linked/${evidencePath}`,
        ]),
      ).toThrow(/escapes the repository root/u);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  test("detects source and harness mutation across a capture", () => {
    const fixture = createProvenanceFixture();
    try {
      const options = provenanceOptions(fixture.repositoryRoot);
      const sourceCapture = captureBenchmarkProvenance(options);
      writeFileSync(fixture.sourcePath, "export const value = 2;\n", "utf8");
      expect(() => verifyBenchmarkCapture(sourceCapture)).toThrow(
        /complete production tree/u,
      );

      writeFileSync(fixture.sourcePath, FIXTURE_PRODUCTION_SOURCE, "utf8");
      const evidenceCapture = captureBenchmarkProvenance(options);
      writeFileSync(
        fixture.evidencePath,
        "export const harness = 2;\n",
        "utf8",
      );
      expect(() => verifyBenchmarkCapture(evidenceCapture)).toThrow(
        /evidence files changed/u,
      );
    } finally {
      rmSync(fixture.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects dirty, ordinary untracked, and ignored production dependencies", () => {
    const fixture = createProvenanceFixture();
    try {
      const options = provenanceOptions(fixture.repositoryRoot);
      writeFileSync(
        fixture.dependencyPath,
        "export const dependency = 2;\n",
        "utf8",
      );
      expect(() => captureBenchmarkProvenance(options)).toThrow(
        /complete production tree/u,
      );
      writeFileSync(
        fixture.dependencyPath,
        "export const dependency = 1;\n",
        "utf8",
      );

      const ordinaryUntrackedPath = join(
        fixture.repositoryRoot,
        "source",
        "ordinary-untracked.ts",
      );
      writeFileSync(ordinaryUntrackedPath, "export {};\n", "utf8");
      expect(() => captureBenchmarkProvenance(options)).toThrow(
        /contains untracked files/u,
      );
      rmSync(ordinaryUntrackedPath);

      const ignoredPath = join(fixture.repositoryRoot, "source", "ignored.ts");
      writeFileSync(ignoredPath, "export {};\n", "utf8");
      expect(() => captureBenchmarkProvenance(options)).toThrow(
        /contains untracked files/u,
      );
    } finally {
      rmSync(fixture.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("checks the loaded closure but ignores unrelated committed production changes", () => {
    const fixture = createProvenanceFixture();
    try {
      const options = provenanceOptions(fixture.repositoryRoot);
      const capture = captureBenchmarkProvenance(options);
      const productionModuleClosures = bindFixtureModuleClosures(
        capture,
        fixture,
      );
      const report = {
        evidenceBindings: capture.evidenceBindings,
        productionModuleClosures,
        productionTreeBinding: capture.productionTreeBinding,
        sourceRevision: capture.sourceRevision,
      };

      writeFileSync(
        fixture.unrelatedPath,
        "export const unrelated = 2;\n",
        "utf8",
      );
      commitFixtureChange(
        fixture.repositoryRoot,
        "source/unrelated.ts",
        "change unrelated production source",
      );
      expect(() =>
        verifyCheckedBenchmarkProvenance(report, options),
      ).not.toThrow();

      writeFileSync(
        fixture.dependencyPath,
        "export const dependency = 2;\n",
        "utf8",
      );
      commitFixtureChange(
        fixture.repositoryRoot,
        "source/dependency.ts",
        "change loaded dependency",
      );
      expect(() => verifyCheckedBenchmarkProvenance(report, options)).toThrow(
        /current production module closure.*stale/u,
      );
    } finally {
      rmSync(fixture.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("cannot hide production changes behind Git metadata overrides", () => {
    const fixture = createProvenanceFixture();
    const previousIndexFile = process.env.GIT_INDEX_FILE;
    try {
      const alternateIndexPath = join(
        fixture.repositoryRoot,
        "alternate-index",
      );
      copyFileSync(
        join(fixture.repositoryRoot, ".git", "index"),
        alternateIndexPath,
      );
      writeFileSync(
        fixture.dependencyPath,
        "export const dependency = 2;\n",
        "utf8",
      );
      runGit(fixture.repositoryRoot, ["add", "source/dependency.ts"]);
      writeFileSync(
        fixture.dependencyPath,
        "export const dependency = 1;\n",
        "utf8",
      );
      process.env.GIT_INDEX_FILE = alternateIndexPath;
      expect(() =>
        captureBenchmarkProvenance(provenanceOptions(fixture.repositoryRoot)),
      ).toThrow(/complete production tree/u);
    } finally {
      if (previousIndexFile === undefined) {
        delete process.env.GIT_INDEX_FILE;
      } else {
        process.env.GIT_INDEX_FILE = previousIndexFile;
      }
      rmSync(fixture.repositoryRoot, { force: true, recursive: true });
    }

    const replacementFixture = createProvenanceFixture();
    try {
      const originalRevision = readGitText(replacementFixture.repositoryRoot, [
        "rev-parse",
        "HEAD",
      ]);
      writeFileSync(
        replacementFixture.dependencyPath,
        "export const dependency = 2;\n",
        "utf8",
      );
      commitFixtureChange(
        replacementFixture.repositoryRoot,
        "source/dependency.ts",
        "create replacement production tree",
      );
      const replacementRevision = readGitText(
        replacementFixture.repositoryRoot,
        ["rev-parse", "HEAD"],
      );
      runGit(replacementFixture.repositoryRoot, [
        "replace",
        originalRevision,
        replacementRevision,
      ]);
      runGit(replacementFixture.repositoryRoot, [
        "reset",
        "--hard",
        originalRevision,
      ]);

      expect(readFileSync(replacementFixture.dependencyPath, "utf8")).toBe(
        "export const dependency = 2;\n",
      );
      expect(() =>
        captureBenchmarkProvenance(
          provenanceOptions(replacementFixture.repositoryRoot),
        ),
      ).toThrow(/complete production tree/u);
    } finally {
      rmSync(replacementFixture.repositoryRoot, {
        force: true,
        recursive: true,
      });
    }
  });

  test("ties a checked source revision to a real ancestor and its blobs", () => {
    const fixture = createProvenanceFixture();
    try {
      const options = provenanceOptions(fixture.repositoryRoot);
      const capture = captureBenchmarkProvenance(options);
      const productionModuleClosures = bindFixtureModuleClosures(
        capture,
        fixture,
      );
      expect(() =>
        verifyCheckedBenchmarkProvenance(
          {
            evidenceBindings: capture.evidenceBindings,
            productionModuleClosures,
            productionTreeBinding: capture.productionTreeBinding,
            sourceRevision: capture.sourceRevision,
          },
          options,
        ),
      ).not.toThrow();
      const wrongClosure = structuredClone(productionModuleClosures);
      wrongClosure[0]!.modules[0]!.sha256 = "0".repeat(64);
      expect(() =>
        verifyCheckedBenchmarkProvenance(
          {
            evidenceBindings: capture.evidenceBindings,
            productionModuleClosures: wrongClosure,
            productionTreeBinding: capture.productionTreeBinding,
            sourceRevision: capture.sourceRevision,
          },
          options,
        ),
      ).toThrow(/does not match its Git revision/u);
      expect(() =>
        verifyCheckedBenchmarkProvenance(
          {
            evidenceBindings: capture.evidenceBindings,
            productionModuleClosures,
            productionTreeBinding: capture.productionTreeBinding,
            sourceRevision: "0".repeat(40),
          },
          options,
        ),
      ).toThrow(/not a local Git commit/u);

      const wrongTree = structuredClone(capture.productionTreeBinding);
      wrongTree.gitObjectId = "0".repeat(40);
      expect(() =>
        verifyCheckedBenchmarkProvenance(
          {
            evidenceBindings: capture.evidenceBindings,
            productionModuleClosures,
            productionTreeBinding: wrongTree,
            sourceRevision: capture.sourceRevision,
          },
          options,
        ),
      ).toThrow(/tree binding/u);
    } finally {
      rmSync(fixture.repositoryRoot, { force: true, recursive: true });
    }
  });
});

function createCleanRunnerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    const normalizedName = name.toUpperCase();
    if (
      normalizedName.startsWith("NODE_") ||
      normalizedName.startsWith("TSX_")
    ) {
      delete environment[name];
    }
  }
  return environment;
}

function createProvenanceFixture(): {
  readonly dependencyPath: string;
  readonly evidencePath: string;
  readonly repositoryRoot: string;
  readonly sourcePath: string;
  readonly unrelatedPath: string;
} {
  const repositoryRoot = mkdtempSync(
    join(tmpdir(), "agenc-fnd-provenance-review-"),
  );
  const sourceRelativePath = "source/production.ts";
  const dependencyRelativePath = "source/dependency.ts";
  const unrelatedRelativePath = "source/unrelated.ts";
  const evidenceRelativePath = "harness/runner.mjs";
  const sourcePath = join(repositoryRoot, sourceRelativePath);
  const dependencyPath = join(repositoryRoot, dependencyRelativePath);
  const unrelatedPath = join(repositoryRoot, unrelatedRelativePath);
  const evidencePath = join(repositoryRoot, evidenceRelativePath);
  mkdirSync(join(repositoryRoot, "source"));
  mkdirSync(join(repositoryRoot, "harness"));
  writeFileSync(sourcePath, FIXTURE_PRODUCTION_SOURCE, "utf8");
  writeFileSync(dependencyPath, "export const dependency = 1;\n", "utf8");
  writeFileSync(unrelatedPath, "export const unrelated = 1;\n", "utf8");
  writeFileSync(evidencePath, "export const harness = 1;\n", "utf8");
  writeFileSync(
    join(repositoryRoot, ".gitignore"),
    "source/ignored.ts\n",
    "utf8",
  );
  runGit(repositoryRoot, ["init"]);
  runGit(repositoryRoot, [
    "add",
    ".gitignore",
    sourceRelativePath,
    dependencyRelativePath,
    unrelatedRelativePath,
  ]);
  runGit(repositoryRoot, [
    "-c",
    "user.name=AgenC Test",
    "-c",
    "user.email=test@agenc.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "test fixture",
  ]);
  return {
    dependencyPath,
    evidencePath,
    repositoryRoot,
    sourcePath,
    unrelatedPath,
  };
}

function provenanceOptions(repositoryRoot: string): {
  readonly evidencePaths: readonly string[];
  readonly productionTreePath: string;
  readonly repositoryRoot: string;
} {
  return {
    evidencePaths: ["harness/runner.mjs"],
    productionTreePath: "source",
    repositoryRoot,
  };
}

function bindFixtureModuleClosures(
  capture: ReturnType<typeof captureBenchmarkProvenance>,
  fixture: ReturnType<typeof createProvenanceFixture>,
): ReturnType<typeof bindProductionModuleClosures> {
  return bindProductionModuleClosures(capture, [
    {
      caseId: "fixture_case",
      paths: observeFixtureModulePaths(fixture),
    },
  ]);
}

function observeFixtureModulePaths(
  fixture: ReturnType<typeof createProvenanceFixture>,
): string[] {
  const repositoryAlias = `${fixture.repositoryRoot}-module-alias`;
  const probeSource = [
    'import { pathToFileURL } from "node:url";',
    "const trackerModule = await import(pathToFileURL(process.argv[1]).href);",
    "const tracker = trackerModule.registerProductionModuleTracker({",
    "  productionRoot: process.argv[3],",
    "  repositoryRoot: process.argv[2],",
    "  writeRecord(record) { process.stdout.write(record); },",
    "});",
    "await import(pathToFileURL(process.argv[4]).href);",
    "await new Promise(setImmediate);",
    "await tracker.close();",
  ].join("\n");
  const probeEnvironment: Record<string, string> = {
    LANG: "C",
    LC_ALL: "C",
    TSX_DISABLE_CACHE: "1",
    TZ: "UTC",
  };
  if (process.platform === "win32") {
    probeEnvironment.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    if (process.env.WINDIR !== undefined) {
      probeEnvironment.WINDIR = process.env.WINDIR;
    }
  }
  let output: string;
  try {
    symlinkSync(
      fixture.repositoryRoot,
      repositoryAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        probeSource,
        MODULE_TRACKER_PATH,
        repositoryAlias,
        join(repositoryAlias, "source"),
        join(repositoryAlias, "source/production.ts"),
      ],
      {
        cwd: fixture.repositoryRoot,
        encoding: "utf8",
        env: probeEnvironment,
        maxBuffer: 65_536,
        timeout: 5_000,
        windowsHide: true,
      },
    );
  } finally {
    rmSync(repositoryAlias, { force: true, recursive: true });
  }
  return output
    .trim()
    .split(/\r?\n/u)
    .map((line) => {
      expect(line).toMatch(
        new RegExp(`^${PRODUCTION_MODULE_RECORD_PREFIX}`, "u"),
      );
      return (
        JSON.parse(line.slice(PRODUCTION_MODULE_RECORD_PREFIX.length)) as {
          path: string;
        }
      ).path;
    })
    .sort();
}

function commitFixtureChange(
  repositoryRoot: string,
  path: string,
  message: string,
): void {
  runGit(repositoryRoot, ["add", path]);
  runGit(repositoryRoot, [
    "-c",
    "user.name=AgenC Test",
    "-c",
    "user.email=test@agenc.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ]);
}

async function expectProcessToExit(
  pid: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`descendant process ${pid} remained alive after containment`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function runGit(repositoryRoot: string, args: readonly string[]): void {
  execFileSync("git", args, {
    cwd: repositoryRoot,
    maxBuffer: 65_536,
    stdio: "ignore",
    timeout: 5_000,
    windowsHide: true,
  });
}

function readGitText(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 65_536,
    timeout: 5_000,
    windowsHide: true,
  }).trim();
}
