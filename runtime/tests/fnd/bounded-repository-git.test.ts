import { chmodSync, renameSync, writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BoundedRepositoryGit,
  BoundedRepositoryGitError,
  classifyGitProcessState,
  createBoundedGitWallContract,
  createHermeticGitEnvironment,
  gitProcessFailure,
  MAX_GIT_INVOCATION_ARGUMENT_BYTES,
  MAX_GIT_INVOCATION_UTF16_CODE_UNITS,
  resolveBoundedGitExecutable,
  type BoundedRepositoryGitOptions,
  type HermeticGitEnvironmentOptions,
  type ResolveGitExecutableOptions,
  validateGitPathExtensions,
  validateWindowsGitProcessHandoff,
} from "../helpers/bounded-repository-git.js";
import {
  assertGitExecutableIdentity,
  BoundedGitDiscoveryError,
  createGitWallDeadline,
  remainingGitWallMs,
  resolveGitExecutableBeforeDeadline,
} from "../helpers/bounded-repository-git-discovery.js";

const GIT_DISCOVERY_WALL_MS = 10_000;
const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map(async (root) => {
      await rm(root, { force: true, recursive: true });
      temporaryRoots.delete(root);
    }),
  );
});

describe("bounded repository Git supervision", () => {
  it.skipIf(process.platform === "win32")(
    "disables optional maintenance for every bounded Git transaction",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenc-git-maintenance-test-"));
      temporaryRoots.add(root);
      const executableDirectory = join(root, "bin");
      const repositoryRoot = join(root, "repository");
      const controlRoot = join(root, "control");
      const invocationPath = join(root, "invocation.json");
      await Promise.all([
        mkdir(executableDirectory),
        mkdir(repositoryRoot),
        mkdir(controlRoot),
      ]);
      const executablePath = join(executableDirectory, "git");
      const shim =
        `#!${process.execPath}\n` +
        `require("node:fs").writeFileSync(${JSON.stringify(invocationPath)}, ` +
        "JSON.stringify(process.argv.slice(2)));\n";
      await writeFile(
        executablePath,
        shim,
        "utf8",
      );
      await chmod(executablePath, 0o755);

      const originalPath = process.env.PATH;
      let git: BoundedRepositoryGit;
      try {
        process.env.PATH = executableDirectory;
        git = new BoundedRepositoryGit({
          allocationRoot: root,
          repositoryRoot,
          controlRoot,
          maxOutputBytes: 4_096,
          maxWallMs: GIT_DISCOVERY_WALL_MS,
        });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }

      await git.initialize();
      const args = JSON.parse(
        await readFile(invocationPath, "utf8"),
      ) as string[];
      const legacyGc = args.indexOf("gc.auto=0");
      expect(args[legacyGc - 1]).toBe("-c");
      expect(legacyGc).toBeLessThan(args.indexOf("init"));
      const maintenance = args.indexOf("maintenance.auto=false");
      expect(args[maintenance - 1]).toBe("-c");
      expect(maintenance).toBeLessThan(args.indexOf("init"));
    },
  );

  it("normalizes safe PATHEXT values and rejects path traversal", () => {
    expect(validateGitPathExtensions(".EXE;.com;.EXE")).toEqual([
      ".exe",
      ".com",
    ]);
    for (const value of [
      ".EXE/../../cmd",
      ".EXE\\..\\cmd",
      "EXE",
      ".",
      ".EXE;",
      ".K",
      ".ſ",
    ]) {
      expect(() => validateGitPathExtensions(value)).toThrow(
        BoundedGitDiscoveryError,
      );
    }
  });

  it("resolves an executable under the bounded discovery wall", async () => {
    const program = await resolveBoundedGitExecutable({
      pathValue: process.env.PATH,
      pathExtValue: process.env.PATHEXT,
      wallMs: GIT_DISCOVERY_WALL_MS,
    });

    expect(isAbsolute(program)).toBe(true);
  });

  it("snapshots exported Git options without invoking accessors", async () => {
    const allocationRoot = join(tmpdir(), "agenc-git-option-test");
    const runnerOptions: BoundedRepositoryGitOptions = {
      allocationRoot,
      repositoryRoot: join(allocationRoot, "repository"),
      controlRoot: join(allocationRoot, "control"),
      maxOutputBytes: 4_096,
      maxWallMs: GIT_DISCOVERY_WALL_MS,
    };
    let getterCalls = 0;
    const runnerAccessor = Object.defineProperties(
      {},
      {
        allocationRoot: {
          get() {
            getterCalls += 1;
            return runnerOptions.allocationRoot;
          },
        },
        repositoryRoot: { value: runnerOptions.repositoryRoot },
        controlRoot: { value: runnerOptions.controlRoot },
        maxOutputBytes: { value: runnerOptions.maxOutputBytes },
        maxWallMs: { value: runnerOptions.maxWallMs },
      },
    ) as BoundedRepositoryGitOptions;
    expect(() => new BoundedRepositoryGit(runnerAccessor)).toThrow();
    expect(getterCalls).toBe(0);
    expect(
      () =>
        new BoundedRepositoryGit(
          new Proxy(runnerOptions, {}) as BoundedRepositoryGitOptions,
        ),
    ).toThrow();
    expect(
      () =>
        new BoundedRepositoryGit({
          ...runnerOptions,
          unsupported: true,
        } as BoundedRepositoryGitOptions),
    ).toThrow();

    const discoveryOptions: ResolveGitExecutableOptions = {
      pathValue: process.env.PATH,
      pathExtValue: process.env.PATHEXT,
      wallMs: GIT_DISCOVERY_WALL_MS,
    };
    const discoveryAccessor = Object.defineProperties(
      {},
      {
        pathValue: { value: discoveryOptions.pathValue },
        pathExtValue: { value: discoveryOptions.pathExtValue },
        wallMs: {
          get() {
            getterCalls += 1;
            return discoveryOptions.wallMs;
          },
        },
      },
    ) as ResolveGitExecutableOptions;
    await expect(
      resolveBoundedGitExecutable(discoveryAccessor),
    ).rejects.toBeInstanceOf(BoundedGitDiscoveryError);
    expect(getterCalls).toBe(0);
    await expect(
      resolveBoundedGitExecutable(
        new Proxy(discoveryOptions, {}) as ResolveGitExecutableOptions,
      ),
    ).rejects.toBeInstanceOf(BoundedGitDiscoveryError);
    await expect(
      resolveBoundedGitExecutable({
        ...discoveryOptions,
        unsupported: true,
      } as ResolveGitExecutableOptions),
    ).rejects.toBeInstanceOf(BoundedGitDiscoveryError);

    const environmentOptions: HermeticGitEnvironmentOptions = {
      allocationRoot,
      controlRoot: runnerOptions.controlRoot,
      hostEnvironment: { PATH: process.env.PATH },
    };
    const environmentAccessor = Object.defineProperties(
      {},
      {
        allocationRoot: {
          get() {
            getterCalls += 1;
            return environmentOptions.allocationRoot;
          },
        },
        controlRoot: { value: environmentOptions.controlRoot },
        hostEnvironment: { value: environmentOptions.hostEnvironment },
      },
    ) as HermeticGitEnvironmentOptions;
    expect(() => createHermeticGitEnvironment(environmentAccessor)).toThrow();
    expect(getterCalls).toBe(0);
    expect(() =>
      createHermeticGitEnvironment(
        new Proxy(environmentOptions, {}) as HermeticGitEnvironmentOptions,
      ),
    ).toThrow();
    expect(() =>
      createHermeticGitEnvironment({
        ...environmentOptions,
        unsupported: true,
      } as HermeticGitEnvironmentOptions),
    ).toThrow();

    const hostAccessor = Object.defineProperty({}, "PATH", {
      get() {
        getterCalls += 1;
        return process.env.PATH;
      },
    });
    expect(() =>
      createHermeticGitEnvironment({
        ...environmentOptions,
        hostEnvironment: hostAccessor,
      }),
    ).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("rejects an expired discovery deadline synchronously", () => {
    expect(() =>
      remainingGitWallMs({ expiresAt: performance.now() - 1 }),
    ).toThrow(/wall deadline/u);
  });

  it("checks the deadline before synchronous discovery preflight", async () => {
    await expect(
      resolveGitExecutableBeforeDeadline(
        undefined,
        undefined,
        Object.freeze({ expiresAt: performance.now() - 1 }),
      ),
    ).rejects.toMatchObject({ kind: "deadline" });
  });

  it("rejects a pathname replacement during final executable revalidation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-git-identity-test-"));
    temporaryRoots.add(root);
    const executableName = process.platform === "win32" ? "git.exe" : "git";
    const executablePath = join(root, executableName);
    await writeFile(executablePath, "original executable\n", "utf8");
    await chmod(executablePath, 0o755);

    const executable = await resolveGitExecutableBeforeDeadline(
      root,
      process.platform === "win32" ? ".EXE" : undefined,
      createGitWallDeadline(GIT_DISCOVERY_WALL_MS),
    );
    await rename(executablePath, `${executablePath}.original`);
    await writeFile(executablePath, "replacement executable\n", "utf8");
    await chmod(executablePath, 0o755);

    await expect(
      assertGitExecutableIdentity(
        executable,
        createGitWallDeadline(GIT_DISCOVERY_WALL_MS),
      ),
    ).rejects.toMatchObject({
      kind: "discovery",
      message: "cached Git executable identity changed",
    });
  });

  it.skipIf(process.platform === "win32")(
    "revalidates the executable immediately before supervisor handoff",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenc-git-handoff-test-"));
      temporaryRoots.add(root);
      const executableDirectory = join(root, "bin");
      const repositoryRoot = join(root, "repository");
      const controlRoot = join(root, "control");
      await Promise.all([
        mkdir(executableDirectory),
        mkdir(repositoryRoot),
        mkdir(controlRoot),
      ]);
      const executablePath = join(executableDirectory, "git");
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(executablePath, 0o755);

      const originalPath = process.env.PATH;
      let git: BoundedRepositoryGit;
      try {
        process.env.PATH = executableDirectory;
        git = new BoundedRepositoryGit({
          allocationRoot: root,
          repositoryRoot,
          controlRoot,
          maxOutputBytes: 4_096,
          maxWallMs: GIT_DISCOVERY_WALL_MS,
        });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }

      const byteLength = Buffer.byteLength.bind(Buffer);
      let executablePathChecks = 0;
      const byteLengthSpy = vi
        .spyOn(Buffer, "byteLength")
        .mockImplementation((value, encoding) => {
          const length = byteLength(value, encoding);
          // Discovery performs the first candidate-path check. The runner's
          // post-discovery program bound is the final synchronous checkpoint
          // where the replacement can be installed before revalidation.
          if (value === executablePath && ++executablePathChecks === 2) {
            renameSync(executablePath, `${executablePath}.original`);
            writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
            chmodSync(executablePath, 0o755);
          }
          return length;
        });
      try {
        await expect(git.initialize()).rejects.toMatchObject({
          kind: "discovery",
          message: "cached Git executable identity changed",
          wallContract: {
            targetCommandDeadlineMs: GIT_DISCOVERY_WALL_MS,
          },
        });
      } finally {
        byteLengthSpy.mockRestore();
      }
    },
  );

  it("forwards only bounded allowlisted environment state", () => {
    const environment = createHermeticGitEnvironment({
      allocationRoot: "/bounded/allocation",
      controlRoot: "/bounded/allocation/control",
      hostEnvironment: {
        PATH: "/usr/bin",
        PATHEXT: ".EXE",
        AGENC_PRIVATE_TEST_VALUE: "must-not-leak",
      },
    });

    expect(environment.PATH).toBe("/usr/bin");
    expect(environment.PATHEXT).toBe(".EXE");
    expect(environment.AGENC_PRIVATE_TEST_VALUE).toBeUndefined();
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(environment.GIT_TEMPLATE_DIR).toBe(
      join("/bounded/allocation/control", "templates"),
    );
    expect(environment.TMPDIR).toBe("/bounded/allocation");
    expect(Object.isFrozen(environment)).toBe(true);
  });

  it("rejects aggregate-oversized strings before linear launch scans", async () => {
    const allocationRoot = join(tmpdir(), "agenc-git-scan-test");
    const git = new BoundedRepositoryGit({
      allocationRoot,
      repositoryRoot: join(allocationRoot, "repository"),
      controlRoot: join(allocationRoot, "control"),
      maxOutputBytes: 4_096,
      maxWallMs: GIT_DISCOVERY_WALL_MS,
    });
    const oversizedArgument = "a".repeat(4_097);
    const oversizedEnvironmentValue = "b".repeat(7_000);
    const oversizedCommandArgument = "c".repeat(32_767);
    const oversized = new Set([
      oversizedArgument,
      oversizedEnvironmentValue,
      oversizedCommandArgument,
    ]);
    const charCodeAt = String.prototype.charCodeAt;
    const scanned = new Set<string>();
    const charCodeAtSpy = vi
      .spyOn(String.prototype, "charCodeAt")
      .mockImplementation(function (this: string, index) {
        const value = String(this);
        if (oversized.has(value)) scanned.add(value);
        return Reflect.apply(charCodeAt, value, [index]) as number;
      });
    const byteLengthSpy = vi.spyOn(Buffer, "byteLength");
    try {
      await expect(git.add([oversizedArgument])).rejects.toBeInstanceOf(
        BoundedRepositoryGitError,
      );
      expect(() =>
        createHermeticGitEnvironment({
          allocationRoot,
          controlRoot: join(allocationRoot, "control"),
          hostEnvironment: { PATH: oversizedEnvironmentValue },
        }),
      ).toThrow();
      expect(() =>
        validateWindowsGitProcessHandoff(
          "git",
          [oversizedCommandArgument],
          Object.freeze({ PATH: "C:\\Windows\\System32" }),
        ),
      ).toThrowError(/command-line limit/u);

      expect(scanned.size).toBe(0);
      expect(
        byteLengthSpy.mock.calls.some(
          ([value]) => typeof value === "string" && oversized.has(value),
        ),
      ).toBe(false);
    } finally {
      charCodeAtSpy.mockRestore();
      byteLengthSpy.mockRestore();
    }
  });

  it("enforces the exact fixed-plus-dynamic Git-add argument boundary", () => {
    const allocationRoot = join(tmpdir(), "agenc-git-admission-test");
    const git = new BoundedRepositoryGit({
      allocationRoot,
      repositoryRoot: join(allocationRoot, "repository"),
      controlRoot: join(allocationRoot, "control"),
      maxOutputBytes: 4_096,
      maxWallMs: GIT_DISCOVERY_WALL_MS,
    });
    const baseline = git.validateAddInvocation([""]);
    const availableAsciiCodeUnits = Math.min(
      MAX_GIT_INVOCATION_ARGUMENT_BYTES - baseline.utf8Bytes,
      MAX_GIT_INVOCATION_UTF16_CODE_UNITS - baseline.utf16CodeUnits,
    );
    expect(availableAsciiCodeUnits).toBeGreaterThan(1);

    const below = git.validateAddInvocation([
      "x".repeat(availableAsciiCodeUnits - 1),
    ]);
    const at = git.validateAddInvocation(["x".repeat(availableAsciiCodeUnits)]);
    expect(Math.max(below.utf8Bytes, below.utf16CodeUnits)).toBeLessThan(4_096);
    expect(Math.max(at.utf8Bytes, at.utf16CodeUnits)).toBe(4_096);
    expect(() =>
      git.validateAddInvocation(["x".repeat(availableAsciiCodeUnits + 1)]),
    ).toThrowError(/Git invocation arguments exceed/u);
  });

  it("enforces the exact fixed-plus-dynamic Git-commit argument boundary", () => {
    const allocationRoot = join(tmpdir(), "agenc-git-commit-admission-test");
    const git = new BoundedRepositoryGit({
      allocationRoot,
      repositoryRoot: join(allocationRoot, "repository"),
      controlRoot: join(allocationRoot, "control"),
      maxOutputBytes: 4_096,
      maxWallMs: GIT_DISCOVERY_WALL_MS,
    });
    const baseline = git.validateCommitInvocation("");
    const availableAsciiCodeUnits = Math.min(
      MAX_GIT_INVOCATION_ARGUMENT_BYTES - baseline.utf8Bytes,
      MAX_GIT_INVOCATION_UTF16_CODE_UNITS - baseline.utf16CodeUnits,
    );
    expect(availableAsciiCodeUnits).toBeGreaterThan(1);

    const below = git.validateCommitInvocation(
      "m".repeat(availableAsciiCodeUnits - 1),
    );
    const at = git.validateCommitInvocation(
      "m".repeat(availableAsciiCodeUnits),
    );
    expect(Math.max(below.utf8Bytes, below.utf16CodeUnits)).toBeLessThan(4_096);
    expect(Math.max(at.utf8Bytes, at.utf16CodeUnits)).toBe(4_096);
    expect(() =>
      git.validateCommitInvocation("m".repeat(availableAsciiCodeUnits + 1)),
    ).toThrowError(/Git invocation arguments exceed/u);
  });

  it("publishes the truthful per-command wall contract", () => {
    const wallContract = createBoundedGitWallContract(250);

    expect(wallContract).toEqual({
      targetCommandDeadlineMs: 250,
      appliesPerGitCommand: true,
      synchronousContainmentSetup: "supervisor_owned_outside_target_deadline",
      terminationAndSurvivorProof: "supervisor_owned_outside_target_deadline",
      totalMethodReturnDeadlineMs: null,
    });
    expect(Object.isFrozen(wallContract)).toBe(true);
  });

  it("bounds the final serialized Windows broker handoff", () => {
    const wallContract = createBoundedGitWallContract(250);
    const footprint = validateWindowsGitProcessHandoff(
      "C:\\Program Files\\Git\\cmd\\git.exe",
      ["-c", "core.hooksPath=C:\\bounded path\\hooks", "status"],
      Object.freeze({
        PATH: "C:\\Windows\\System32",
        TMPDIR: "C:\\bounded path",
      }),
      wallContract,
    );

    expect(footprint.commandLineCodeUnits).toBeLessThanOrEqual(32_767);
    expect(footprint.brokerEnvironmentCodeUnits).toBeLessThanOrEqual(32_767);
    expect(Object.isFrozen(footprint)).toBe(true);

    expect(() =>
      validateWindowsGitProcessHandoff(
        "git",
        ["x".repeat(24_500)],
        Object.freeze({ PATH: "C:\\Windows\\System32" }),
        wallContract,
      ),
    ).toThrowError(/CreateProcess environment limit/u);

    try {
      validateWindowsGitProcessHandoff(
        "git",
        ["x".repeat(32_767)],
        Object.freeze({ PATH: "C:\\Windows\\System32" }),
        wallContract,
      );
      throw new Error("expected oversized command to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(BoundedRepositoryGitError);
      expect(error).toMatchObject({
        wallContract,
        message: expect.stringMatching(/command-line limit/u),
      });
    }
  });

  it("distinguishes ambiguous mutation failure from read failure", () => {
    const result = {
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stopReason: "timeout" as const,
      forced: true,
      backstopExpired: false,
    };

    const wallContract = createBoundedGitWallContract(250);
    const mutation = gitProcessFailure(
      "mutate repository",
      result,
      true,
      wallContract,
    );
    const read = gitProcessFailure("read repository", result, false);
    expect(mutation).toBeInstanceOf(BoundedRepositoryGitError);
    expect(mutation.mutationOutcome).toBe("unknown");
    expect(mutation.wallContract).toBe(wallContract);
    expect(read.mutationOutcome).toBe("not_applicable");
  });

  it("treats spawn errors without terminal proof as survivors unproven", () => {
    const spawnError = {
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stopReason: "spawn_error" as const,
      forced: false,
      backstopExpired: false,
      error: new Error("spawn failed"),
    };
    const unclassifiedError = {
      ...spawnError,
      stopReason: undefined,
    };
    const terminalError = {
      ...unclassifiedError,
      exitCode: 1,
    };

    expect(classifyGitProcessState(spawnError)).toBe("survivors_unproven");
    expect(classifyGitProcessState(unclassifiedError)).toBe(
      "survivors_unproven",
    );
    expect(classifyGitProcessState(terminalError)).toBe("cleanup_proven");
    expect(gitProcessFailure("initialize", spawnError, true)).toMatchObject({
      kind: "survivors_unproven",
      mutationOutcome: "unknown",
      processState: "survivors_unproven",
    });
  });
});
