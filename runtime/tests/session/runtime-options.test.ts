import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  AgentRuntimeOptionsError,
  getSessionCoworkMemoryExtraGuidelines,
  getSessionCoworkMemoryPathOverride,
  getSessionRemoteMemoryRoot,
  isSessionRemoteMode,
  projectAgentRuntimeOptionsEnvironment,
  resolveAgentRuntimeOptions,
  resolveCommandExecutionAuthority,
  resolveSessionTempRoot,
  runWithAgentRuntimeOptions,
  validateAgentRuntimeOptions,
} from "../../src/session/runtime-options.js";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agenc-runtime-options-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("agent runtime options", () => {
  test("normalizes supported environment values and typed overrides once", () => {
    const sessionTempRoot = join(makeTemporaryDirectory(), "session-temp");
    const pluginStorageRoot = join(makeTemporaryDirectory(), "plugins");
    const result = resolveAgentRuntimeOptions(
      {
        AGENC_SHELL: "/bin/zsh",
        AGENC_SHELL_PREFIX: 'env "MODE=safe" runner',
        AGENC_TMPDIR: sessionTempRoot,
        AGENC_PLUGIN_CACHE_DIR: pluginStorageRoot,
        AGENC_COWORK_MEMORY_PATH_OVERRIDE: "/mnt/cowork/memory",
        AGENC_COWORK_MEMORY_EXTRA_GUIDELINES: "Keep workspace facts scoped.",
        AGENC_ALLOW_UNTRUSTED_HOOKS: "0",
        AGENC_USE_DATA_STDIN: "1",
      },
      { simpleMode: true },
    );

    expect(result).toEqual({
      simpleMode: true,
      dangerouslyBypassApprovalsAndSandbox: false,
      stdinDataMode: true,
      remoteMode: false,
      posixShellPath: "/bin/zsh",
      commandWrapperArgv: ["env", "MODE=safe", "runner"],
      sessionTempRoot,
      pluginStorageRoot,
      coworkMemoryPathOverride: "/mnt/cowork/memory",
      coworkMemoryExtraGuidelines: "Keep workspace facts scoped.",
      allowUntrustedHooks: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.commandWrapperArgv)).toBe(true);
  });

  test("captures one immutable shell and wrapper authority", () => {
    const sessionTempRoot = makeTemporaryDirectory();
    const runtimeOptions = resolveAgentRuntimeOptions(
      {
        AGENC_SHELL: "/bin/zsh",
        AGENC_SHELL_PREFIX: 'env "MODE=safe" runner',
      },
      { sessionTempRoot },
    );
    const authority = resolveCommandExecutionAuthority(
      runtimeOptions,
      "/bin/zsh",
      {
        PATH: "/usr/bin",
        SECRET: undefined,
        AGENC_TMPDIR: "/ambient/agenc",
        TMPDIR: "/ambient/posix",
        TEMP: "C:\\ambient\\temp",
        TMP: "C:\\ambient\\tmp",
      },
    );

    expect(authority).toEqual({
      path: "/bin/zsh",
      commandWrapperArgv: ["env", "MODE=safe", "runner"],
      childEnvironment: {
        PATH: "/usr/bin",
        AGENC_TMPDIR: sessionTempRoot,
        TMPDIR: sessionTempRoot,
        TEMP: sessionTempRoot,
        TMP: sessionTempRoot,
      },
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.commandWrapperArgv)).toBe(true);
    expect(Object.isFrozen(authority.childEnvironment)).toBe(true);
  });

  test("captures hook authority once and preserves typed overrides", () => {
    expect(
      resolveAgentRuntimeOptions({
        AGENC_ALLOW_UNTRUSTED_HOOKS: "true",
      }).allowUntrustedHooks,
    ).toBe(true);
    expect(
      resolveAgentRuntimeOptions(
        {
          AGENC_ALLOW_UNTRUSTED_HOOKS: "true",
        },
        {
          simpleMode: false,
          allowUntrustedHooks: false,
        },
      ),
    ).toMatchObject({
      simpleMode: false,
      stdinDataMode: false,
      remoteMode: false,
      allowUntrustedHooks: false,
    });
    expect(() =>
      resolveAgentRuntimeOptions({
        AGENC_ALLOW_UNTRUSTED_HOOKS: "not-a-boolean",
      }),
    ).toThrow("AGENC_ALLOW_UNTRUSTED_HOOKS must be one of");
  });

  test("round-trips child runtime authority through one environment projection", () => {
    const sessionTempRoot = join(makeTemporaryDirectory(), "child-temp");
    const pluginStorageRoot = join(makeTemporaryDirectory(), "child-plugins");
    const parent = resolveAgentRuntimeOptions(
      {},
      {
        simpleMode: true,
        remoteMode: true,
        remoteMemoryRoot: "/tmp/agenc-remote-memory",
        coworkMemoryPathOverride: "/tmp/agenc-cowork-memory",
        coworkMemoryExtraGuidelines: "Keep child memory scoped.",
        posixShellPath: "/bin/bash",
        commandWrapperArgv: ["env", "BOUND=1", "/bin/bash", "-c"],
        sessionTempRoot,
        pluginStorageRoot,
        allowUntrustedHooks: true,
      },
    );

    const projected = projectAgentRuntimeOptionsEnvironment(parent);
    const child = resolveAgentRuntimeOptions(projected, {
      simpleMode: parent.simpleMode,
    });

    expect(child).toEqual(parent);
    expect(projected).toMatchObject({
      AGENC_REMOTE: "1",
      AGENC_SHELL: "/bin/bash",
      AGENC_TMPDIR: sessionTempRoot,
      AGENC_PLUGIN_CACHE_DIR: pluginStorageRoot,
      AGENC_ALLOW_UNTRUSTED_HOOKS: "1",
    });
    expect(projected.AGENC_SHELL_PREFIX).toContain("BOUND\\=1");
    expect(Object.isFrozen(projected)).toBe(true);
  });

  test.each([
    [{ AGENC_SHELL: "bash" }, "AGENC_SHELL must be an absolute path"],
    [
      { AGENC_SHELL: "" },
      "AGENC_SHELL must name a bash or zsh executable",
    ],
    [
      { AGENC_SHELL: "/bin/fish" },
      "AGENC_SHELL must name a bash or zsh executable",
    ],
    [
      { AGENC_SHELL: "/tmp/bash-wrapper" },
      "AGENC_SHELL must name a bash or zsh executable",
    ],
    [
      { AGENC_SHELL_PREFIX: "env SAFE=1 && runner" },
      "without shell operators",
    ],
    [{ AGENC_TMPDIR: "relative" }, "AGENC_TMPDIR must be an absolute path"],
    [{ AGENC_TMPDIR: "" }, "AGENC_TMPDIR must be a non-empty absolute path"],
    [
      { AGENC_TMPDIR: " /absolute/temp" },
      "AGENC_TMPDIR must not contain surrounding whitespace",
    ],
    [
      { AGENC_PLUGIN_CACHE_DIR: "relative" },
      "AGENC_PLUGIN_CACHE_DIR must be an absolute path",
    ],
    [
      { AGENC_PLUGIN_CACHE_DIR: "" },
      "AGENC_PLUGIN_CACHE_DIR must be a non-empty absolute path",
    ],
    [
      { AGENC_PLUGIN_CACHE_DIR: "/absolute/plugins " },
      "AGENC_PLUGIN_CACHE_DIR must not contain surrounding whitespace",
    ],
    [{ AGENC_SIMPLE: "1" }, "AGENC_SIMPLE was removed; use --bare"],
    [{ AGENC_SIMPLE: "0" }, "AGENC_SIMPLE was removed; use --bare"],
    [{ AGENC_BARE: "0" }, "AGENC_BARE was removed; use --bare"],
  ])("rejects invalid or obsolete boundary input", (env, message) => {
    expect(() => resolveAgentRuntimeOptions(env)).toThrow(message);
  });

  test("wire validation is strict and preserves explicit values", () => {
    const pluginStorageRoot = join(makeTemporaryDirectory(), "wire-plugins");
    const validated = validateAgentRuntimeOptions({
      simpleMode: false,
      stdinDataMode: false,
      remoteMode: false,
      pluginStorageRoot,
      allowUntrustedHooks: true,
    });
    expect(validated).toMatchObject({
      simpleMode: false,
      dangerouslyBypassApprovalsAndSandbox: false,
      stdinDataMode: false,
      remoteMode: false,
      pluginStorageRoot,
      allowUntrustedHooks: true,
      sessionTempRoot: resolveAgentRuntimeOptions({}).sessionTempRoot,
    });
    expect(
      validateAgentRuntimeOptions({
        simpleMode: false,
        dangerouslyBypassApprovalsAndSandbox: true,
        stdinDataMode: false,
        remoteMode: false,
        pluginStorageRoot,
        allowUntrustedHooks: false,
      }).dangerouslyBypassApprovalsAndSandbox,
    ).toBe(true);
    expect(() =>
      validateAgentRuntimeOptions({
        simpleMode: false,
        dangerouslyBypassApprovalsAndSandbox: "yes",
        stdinDataMode: false,
        remoteMode: false,
        pluginStorageRoot,
        allowUntrustedHooks: false,
      }),
    ).toThrow(
      "runtimeOptions.dangerouslyBypassApprovalsAndSandbox must be boolean",
    );

    expect(() =>
      validateAgentRuntimeOptions({
        simpleMode: false,
        stdinDataMode: false,
        remoteMode: false,
        allowUntrustedHooks: false,
        typo: true,
      }),
    ).toThrow("runtimeOptions does not accept 'typo'");
    expect(() =>
      validateAgentRuntimeOptions({
        simpleMode: false,
        stdinDataMode: false,
        remoteMode: false,
        posixShellPath: "/bin/sh",
        pluginStorageRoot,
        allowUntrustedHooks: false,
      }),
    ).toThrow("runtimeOptions.posixShellPath must name a bash or zsh executable");
    expect(() =>
      validateAgentRuntimeOptions({
        simpleMode: false,
        stdinDataMode: false,
        remoteMode: false,
        pluginZipCache: false,
        allowUntrustedHooks: false,
      }),
    ).toThrow("runtimeOptions.pluginZipCache was removed");
    expect(() => validateAgentRuntimeOptions({})).toThrow(
      AgentRuntimeOptionsError,
    );
    expect(() =>
      validateAgentRuntimeOptions({
        simpleMode: false,
        stdinDataMode: false,
        remoteMode: false,
        allowUntrustedHooks: false,
      }),
    ).toThrow("runtimeOptions.pluginStorageRoot is required");
    expect(() =>
      resolveAgentRuntimeOptions({}, { sessionTempRoot: "" }),
    ).toThrow("runtimeOptions.sessionTempRoot must be a non-empty absolute path");
  });

  test("isolates concurrent client temp roots from the daemon environment", async () => {
    const base = makeTemporaryDirectory();
    const clientA = join(base, "client-a");
    const clientB = join(base, "client-b");
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = "/daemon-global-tmp";
    try {
      const optionsA = resolveAgentRuntimeOptions({ AGENC_TMPDIR: clientA });
      const optionsB = resolveAgentRuntimeOptions({ AGENC_TMPDIR: clientB });
      const [rootA, rootB] = await Promise.all([
        runWithAgentRuntimeOptions(optionsA, async () => {
          await Promise.resolve();
          return resolveSessionTempRoot();
        }),
        runWithAgentRuntimeOptions(optionsB, async () => {
          await Promise.resolve();
          return resolveSessionTempRoot();
        }),
      ]);

      expect(rootA).toBe(realpathSync(clientA));
      expect(rootB).toBe(realpathSync(clientB));
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

  test("establishes a missing temp root once with private permissions", () => {
    const root = join(makeTemporaryDirectory(), "missing", "session-root");

    const options = resolveAgentRuntimeOptions({ AGENC_TMPDIR: root });

    expect(options.sessionTempRoot).toBe(realpathSync(root));
    expect(lstatSync(root).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
    }
  });

  test("captures and establishes the sole plugin storage root at ingress", () => {
    const home = join(makeTemporaryDirectory(), "home");
    const configuredRoot = join(makeTemporaryDirectory(), "plugin-storage");

    const defaults = resolveAgentRuntimeOptions({ AGENC_HOME: home });
    const configured = resolveAgentRuntimeOptions({
      AGENC_HOME: home,
      AGENC_PLUGIN_CACHE_DIR: configuredRoot,
    });

    expect(defaults.pluginStorageRoot).toBe(realpathSync(join(home, "plugins")));
    expect(configured.pluginStorageRoot).toBe(realpathSync(configuredRoot));
    if (process.platform !== "win32") {
      expect(lstatSync(defaults.pluginStorageRoot).mode & 0o777).toBe(0o700);
      expect(lstatSync(configured.pluginStorageRoot).mode & 0o777).toBe(0o700);
    }
  });

  test.skipIf(process.platform === "win32")(
    "canonicalizes a symlinked temp root after validating its target",
    () => {
      const base = makeTemporaryDirectory();
      const target = join(base, "target");
      const link = join(base, "selected");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, link, "dir");

      const options = resolveAgentRuntimeOptions({ AGENC_TMPDIR: link });

      expect(options.sessionTempRoot).toBe(realpathSync(target));
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects a temp root that is not writable",
    () => {
      const root = makeTemporaryDirectory();
      chmodSync(root, 0o500);
      try {
        expect(() =>
          resolveAgentRuntimeOptions({ AGENC_TMPDIR: root }),
        ).toThrow("AGENC_TMPDIR must resolve to a writable directory");
      } finally {
        chmodSync(root, 0o700);
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects a plugin root that is not readable",
    () => {
      const root = makeTemporaryDirectory();
      chmodSync(root, 0o300);
      try {
        expect(() =>
          resolveAgentRuntimeOptions({ AGENC_PLUGIN_CACHE_DIR: root }),
        ).toThrow("AGENC_PLUGIN_CACHE_DIR must resolve to a writable directory");
      } finally {
        chmodSync(root, 0o700);
      }
    },
  );

  test("does not treat generic temp variables as session authority", () => {
    const baseline = resolveAgentRuntimeOptions({}).sessionTempRoot;
    const options = resolveAgentRuntimeOptions({
      TMPDIR: "/not-session-authority-a",
      TMP: "/not-session-authority-b",
      TEMP: "/not-session-authority-c",
    });

    expect(options.sessionTempRoot).toBe(baseline);
    expect(
      runWithAgentRuntimeOptions(options, () => resolveSessionTempRoot()),
    ).toBe(baseline);
  });

  test("isolates concurrent remote mode and memory roots", async () => {
    const optionsA = resolveAgentRuntimeOptions({
      AGENC_REMOTE: "1",
      AGENC_REMOTE_MEMORY_DIR: "/remote/client-a",
    });
    const optionsB = resolveAgentRuntimeOptions({ AGENC_REMOTE: "0" });

    const [remoteA, remoteB] = await Promise.all([
      runWithAgentRuntimeOptions(optionsA, async () => {
        await Promise.resolve();
        return [isSessionRemoteMode(), getSessionRemoteMemoryRoot()] as const;
      }),
      runWithAgentRuntimeOptions(optionsB, async () => {
        await Promise.resolve();
        return [isSessionRemoteMode(), getSessionRemoteMemoryRoot()] as const;
      }),
    ]);

    expect(remoteA).toEqual([true, "/remote/client-a"]);
    expect(remoteB).toEqual([false, undefined]);
  });

  test("isolates captured Cowork memory inputs from later daemon env changes", async () => {
    const optionsA = resolveAgentRuntimeOptions({
      AGENC_COWORK_MEMORY_PATH_OVERRIDE: "/remote/client-a/memory",
      AGENC_COWORK_MEMORY_EXTRA_GUIDELINES: "client A guidance",
    });
    const optionsB = resolveAgentRuntimeOptions({
      AGENC_COWORK_MEMORY_PATH_OVERRIDE: "/remote/client-b/memory",
      AGENC_COWORK_MEMORY_EXTRA_GUIDELINES: "client B guidance",
    });

    process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE = "/daemon/global/memory";
    process.env.AGENC_COWORK_MEMORY_EXTRA_GUIDELINES = "daemon guidance";
    const [capturedA, capturedB] = await Promise.all([
      runWithAgentRuntimeOptions(optionsA, async () => {
        await Promise.resolve();
        return [
          getSessionCoworkMemoryPathOverride(),
          getSessionCoworkMemoryExtraGuidelines(),
        ] as const;
      }),
      runWithAgentRuntimeOptions(optionsB, async () => {
        await Promise.resolve();
        return [
          getSessionCoworkMemoryPathOverride(),
          getSessionCoworkMemoryExtraGuidelines(),
        ] as const;
      }),
    ]);

    expect(capturedA).toEqual([
      "/remote/client-a/memory",
      "client A guidance",
    ]);
    expect(capturedB).toEqual([
      "/remote/client-b/memory",
      "client B guidance",
    ]);
  });
});
