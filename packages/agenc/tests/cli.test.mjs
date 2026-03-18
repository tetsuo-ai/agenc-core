import assert from "node:assert/strict";
import test from "node:test";
import { runAgencRuntimeWrapper, runAgencWrapper } from "../lib/cli.js";

function createWritableCapture() {
  let buffer = "";
  return {
    stream: {
      write(chunk) {
        buffer += String(chunk);
      },
    },
    read() {
      return buffer;
    },
  };
}

test("runAgencWrapper dispatches runtime admin commands locally", async () => {
  const stdout = createWritableCapture();
  const describeRuntimeInstall = async () => ({
    runtimeHome: "/tmp/.agenc/runtime",
    installed: false,
    releaseDir: null,
    manifestSource: "embedded package manifest",
    selectedArtifact: null,
  });

  const code = await runAgencWrapper(
    {
      argv: ["runtime", "where"],
      stdout: stdout.stream,
      stderr: stdout.stream,
    },
    {
      describeRuntimeInstall,
      ensureRuntimeInstalled: async () => {
        throw new Error("should not be called");
      },
      uninstallRuntime: async () => {
        throw new Error("should not be called");
      },
      spawnInstalledRuntimeBin: async () => {
        throw new Error("should not be called");
      },
    },
  );

  assert.equal(code, 0);
  assert.match(stdout.read(), /"runtimeHome": "\/tmp\/\.agenc\/runtime"/u);
});

test("runAgencWrapper forwards product commands to the installed agenc bin", async () => {
  const calls = [];
  const code = await runAgencWrapper(
    {
      argv: ["status", "--json"],
    },
    {
      describeRuntimeInstall: async () => null,
      ensureRuntimeInstalled: async () => null,
      uninstallRuntime: async () => null,
      spawnInstalledRuntimeBin: async (binName, argv, options) => {
        calls.push({ binName, argv, options });
        return 0;
      },
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    {
      binName: "agenc",
      argv: ["status", "--json"],
      options: {
        env: process.env,
        cwd: process.cwd(),
        homeDir: undefined,
        packageRoot: undefined,
      },
    },
  ]);
});

test("runAgencWrapper uses force install semantics for runtime update", async () => {
  const calls = [];
  const code = await runAgencWrapper(
    {
      argv: ["runtime", "update"],
    },
    {
      describeRuntimeInstall: async () => null,
      ensureRuntimeInstalled: async (options) => {
        calls.push(options);
        return {
          selectedArtifact: { runtimeVersion: "0.1.0" },
          releaseDir: "/tmp/.agenc/runtime/releases/0.1.0/linux-x64",
        };
      },
      uninstallRuntime: async () => null,
      spawnInstalledRuntimeBin: async () => {
        throw new Error("should not be called");
      },
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    {
      env: process.env,
      cwd: process.cwd(),
      homeDir: undefined,
      packageRoot: undefined,
      force: true,
    },
  ]);
});

test("runAgencRuntimeWrapper forwards directly to the installed agenc-runtime bin", async () => {
  const calls = [];
  const code = await runAgencRuntimeWrapper(
    {
      argv: ["logs", "--tail", "10"],
    },
    {
      describeRuntimeInstall: async () => null,
      ensureRuntimeInstalled: async () => null,
      uninstallRuntime: async () => null,
      spawnInstalledRuntimeBin: async (binName, argv, options) => {
        calls.push({ binName, argv, options });
        return 0;
      },
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(calls, [
    {
      binName: "agenc-runtime",
      argv: ["logs", "--tail", "10"],
      options: {
        env: process.env,
        cwd: process.cwd(),
        homeDir: undefined,
        packageRoot: undefined,
      },
    },
  ]);
});
