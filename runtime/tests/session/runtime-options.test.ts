import { describe, expect, test } from "vitest";

import {
  AgentRuntimeOptionsError,
  getSessionCoworkMemoryExtraGuidelines,
  getSessionCoworkMemoryPathOverride,
  getSessionRemoteMemoryRoot,
  isSessionRemoteMode,
  resolveAutomationAgentRuntimeOptions,
  resolveAgentRuntimeOptions,
  resolveCommandExecutionAuthority,
  resolveSessionTempRoot,
  runWithAgentRuntimeOptions,
  validateAgentRuntimeOptions,
} from "../../src/session/runtime-options.js";

describe("agent runtime options", () => {
  test("normalizes supported environment values and typed overrides once", () => {
    const result = resolveAgentRuntimeOptions(
      {
        AGENC_SHELL: "/bin/zsh",
        AGENC_SHELL_PREFIX: 'env "MODE=safe" runner',
        AGENC_TMPDIR: "/var/tmp/agenc",
        AGENC_PLUGIN_CACHE_DIR: "/var/cache/agenc-plugins",
        AGENC_COWORK_MEMORY_PATH_OVERRIDE: "/mnt/cowork/memory",
        AGENC_COWORK_MEMORY_EXTRA_GUIDELINES: "Keep workspace facts scoped.",
        AGENC_ALLOW_UNTRUSTED_HOOKS: "0",
        AGENC_USE_DATA_STDIN: "1",
      },
      { simpleMode: true },
    );

    expect(result).toEqual({
      simpleMode: true,
      stdinDataMode: true,
      remoteMode: false,
      posixShellPath: "/bin/zsh",
      commandWrapperArgv: ["env", "MODE=safe", "runner"],
      sessionTempRoot: "/var/tmp/agenc",
      pluginStorageRoot: "/var/cache/agenc-plugins",
      coworkMemoryPathOverride: "/mnt/cowork/memory",
      coworkMemoryExtraGuidelines: "Keep workspace facts scoped.",
      allowUntrustedHooks: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.commandWrapperArgv)).toBe(true);
  });

  test("captures one immutable shell and wrapper authority", () => {
    const runtimeOptions = resolveAgentRuntimeOptions({
      AGENC_SHELL: "/bin/zsh",
      AGENC_SHELL_PREFIX: 'env "MODE=safe" runner',
    });
    const authority = resolveCommandExecutionAuthority(
      runtimeOptions,
      "/bin/zsh",
      { PATH: "/usr/bin", SECRET: undefined },
    );

    expect(authority).toEqual({
      path: "/bin/zsh",
      commandWrapperArgv: ["env", "MODE=safe", "runner"],
      childEnvironment: { PATH: "/usr/bin", SECRET: undefined },
    });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.commandWrapperArgv)).toBe(true);
    expect(Object.isFrozen(authority.childEnvironment)).toBe(true);
  });

  test("generic ingress ignores automation hook authority in the environment", () => {
    expect(
      resolveAgentRuntimeOptions({
        AGENC_ALLOW_UNTRUSTED_HOOKS: "true",
      }).allowUntrustedHooks,
    ).toBe(false);
    expect(() =>
      resolveAgentRuntimeOptions({
        AGENC_ALLOW_UNTRUSTED_HOOKS: "not-a-boolean",
      }),
    ).not.toThrow();
  });

  test("automation ingress captures hook authority and preserves overrides", () => {
    expect(
      resolveAutomationAgentRuntimeOptions({
        AGENC_ALLOW_UNTRUSTED_HOOKS: "true",
      }).allowUntrustedHooks,
    ).toBe(true);
    expect(
      resolveAutomationAgentRuntimeOptions(
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
      resolveAutomationAgentRuntimeOptions({
        AGENC_ALLOW_UNTRUSTED_HOOKS: "not-a-boolean",
      }),
    ).toThrow("AGENC_ALLOW_UNTRUSTED_HOOKS must be one of");
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
    [{ AGENC_SIMPLE: "1" }, "AGENC_SIMPLE was removed; use --bare"],
    [{ AGENC_SIMPLE: "0" }, "AGENC_SIMPLE was removed; use --bare"],
    [{ AGENC_BARE: "0" }, "AGENC_BARE was removed; use --bare"],
    [
      { AGENC_PLUGIN_SEED_DIR: "/opt/agenc/seed" },
      "AGENC_PLUGIN_SEED_DIR was removed; copy required versioned packages",
    ],
    [
      { AGENC_PLUGIN_USE_ZIP_CACHE: "0" },
      "AGENC_PLUGIN_USE_ZIP_CACHE was removed; remove it",
    ],
    [
      { AGENC_PLUGIN_SEED_DIR: "" },
      "AGENC_PLUGIN_SEED_DIR was removed",
    ],
    [
      { AGENC_PLUGIN_USE_ZIP_CACHE: "" },
      "AGENC_PLUGIN_USE_ZIP_CACHE was removed",
    ],
  ])("rejects invalid or obsolete boundary input", (env, message) => {
    expect(() => resolveAgentRuntimeOptions(env)).toThrow(message);
  });

  test("wire validation is strict and preserves explicit values", () => {
    expect(
      validateAgentRuntimeOptions({
        simpleMode: false,
        stdinDataMode: false,
        remoteMode: false,
        allowUntrustedHooks: true,
      }),
    ).toMatchObject({
      simpleMode: false,
      stdinDataMode: false,
      remoteMode: false,
      allowUntrustedHooks: true,
    });

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
  });

  test("isolates concurrent client temp roots from the daemon environment", async () => {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = "/daemon-global-tmp";
    try {
      const optionsA = resolveAgentRuntimeOptions({ AGENC_TMPDIR: "/client-a" });
      const optionsB = resolveAgentRuntimeOptions({ AGENC_TMPDIR: "/client-b" });
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

      expect(rootA).toBe("/client-a");
      expect(rootB).toBe("/client-b");
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

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
