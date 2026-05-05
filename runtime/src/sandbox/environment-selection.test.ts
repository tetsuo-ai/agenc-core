import { describe, expect, test } from "vitest";

import {
  ResolvedTurnEnvironments,
  defaultThreadEnvironmentSelections,
  resolveEnvironmentSelections,
  type EnvironmentHandle,
  type EnvironmentManagerLike,
  type ExecutorFileSystem,
} from "./environment-selection.js";

class TestEnvironment implements EnvironmentHandle {
  constructor(private readonly fileSystem: ExecutorFileSystem) {}

  getFileSystem(): ExecutorFileSystem {
    return this.fileSystem;
  }
}

class TestEnvironmentManager implements EnvironmentManagerLike<TestEnvironment> {
  constructor(
    private readonly defaultId: string | null,
    private readonly environments: ReadonlyMap<string, TestEnvironment>,
  ) {}

  defaultEnvironmentId(): string | null {
    return this.defaultId;
  }

  getEnvironment(environmentId: string): TestEnvironment | null {
    return this.environments.get(environmentId) ?? null;
  }
}

describe("environment selection", () => {
  test("default selections use the manager default id", () => {
    const manager = new TestEnvironmentManager(
      "remote",
      new Map([["remote", new TestEnvironment({ name: "remote-fs" })]]),
    );

    expect(defaultThreadEnvironmentSelections(manager, "/workspace")).toEqual([
      { environment_id: "remote", cwd: "/workspace" },
    ]);
  });

  test("default selections are empty when the manager has no default", () => {
    const manager = new TestEnvironmentManager(null, new Map());

    expect(defaultThreadEnvironmentSelections(manager, "/workspace")).toEqual([]);
  });

  test("rejects duplicate environment ids before resolving handles", () => {
    const manager = new TestEnvironmentManager(
      "local",
      new Map([["local", new TestEnvironment({ name: "local-fs" })]]),
    );

    expect(() =>
      resolveEnvironmentSelections(manager, [
        { environment_id: "local", cwd: "/workspace" },
        { environment_id: "local", cwd: "/workspace/other" },
      ]),
    ).toThrow(/duplicate turn environment id/u);
  });

  test("rejects unknown environment ids", () => {
    const manager = new TestEnvironmentManager("local", new Map());

    expect(() =>
      resolveEnvironmentSelections(manager, [
        { environment_id: "missing", cwd: "/workspace" },
      ]),
    ).toThrow(/unknown turn environment id/u);
  });

  test("uses the first resolved environment as primary", () => {
    const localFileSystem = { name: "local-fs" };
    const remoteFileSystem = { name: "remote-fs" };
    const manager = new TestEnvironmentManager(
      "local",
      new Map([
        ["local", new TestEnvironment(localFileSystem)],
        ["remote", new TestEnvironment(remoteFileSystem)],
      ]),
    );

    const resolved = resolveEnvironmentSelections(
      manager,
      [
        { environment_id: "remote", cwd: "/remote" },
        { environment_id: "local", cwd: "/local" },
      ],
      { defaultShell: "zsh" },
    );

    expect(resolved).toBeInstanceOf(ResolvedTurnEnvironments);
    expect(resolved.primaryTurnEnvironment()).toMatchObject({
      environment_id: "remote",
      cwd: "/remote",
      shell: "zsh",
    });
    expect(resolved.primaryFileSystem()).toBe(remoteFileSystem);
    expect(resolved.toSelections()).toEqual([
      { environment_id: "remote", cwd: "/remote" },
      { environment_id: "local", cwd: "/local" },
    ]);
  });
});

