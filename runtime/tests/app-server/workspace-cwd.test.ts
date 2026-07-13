import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  requireAbsoluteWorkspaceCwd,
  resolveClientWorkspaceCwd,
  WorkspaceCwdError,
} from "../../src/app-server/workspace-cwd.js";
import {
  AgenCDaemonAgentLifecycleError,
  AgenCDaemonAgentManager,
} from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import type { AgenCBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";

describe("requireAbsoluteWorkspaceCwd (DAE-02)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "agenc-cwd-"));
    dirs.push(d);
    return d;
  }

  it("rejects missing, empty, and relative paths", () => {
    expect(() => requireAbsoluteWorkspaceCwd(undefined, "agent.create")).toThrow(
      WorkspaceCwdError,
    );
    expect(() => requireAbsoluteWorkspaceCwd("", "agent.create")).toThrow(
      /requires absolute cwd/,
    );
    expect(() =>
      requireAbsoluteWorkspaceCwd("relative/path", "agent.create"),
    ).toThrow(/must be an absolute path/);
  });

  it("rejects absolute paths that are not directories", () => {
    const dir = tempDir();
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    expect(() => requireAbsoluteWorkspaceCwd(file, "agent.create")).toThrow(
      /not an existing directory/,
    );
  });

  it("accepts an absolute existing directory", () => {
    const dir = tempDir();
    expect(requireAbsoluteWorkspaceCwd(dir, "agent.create")).toBe(dir);
  });

  it("resolveClientWorkspaceCwd uses client process base for relative paths", () => {
    const dir = tempDir();
    expect(resolveClientWorkspaceCwd(undefined, dir)).toBe(dir);
    expect(resolveClientWorkspaceCwd("child", dir)).toBe(join(dir, "child"));
  });
});

describe("createAgent/createSession require cwd", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it("agent.create fails closed without cwd even when defaultCwd option is set", async () => {
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async () => {
        throw new Error("startAgent should not run");
      },
    };
    const agents = new AgenCDaemonAgentManager({
      runner,
      defaultCwd: () => "/should/not/use",
    });
    await expect(
      agents.createAgent({ objective: "no cwd" } as never),
    ).rejects.toBeInstanceOf(AgenCDaemonAgentLifecycleError);
    await expect(
      agents.createAgent({ objective: "no cwd" } as never),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringMatching(/requires absolute cwd/i),
    });
  });

  it("session.create fails closed without cwd", async () => {
    const sessions = new AgenCDaemonSessionManager();
    await expect(sessions.createSession({} as never)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringMatching(/requires absolute cwd/i),
    });
  });

  it("agent.create accepts absolute cwd and ignores defaultCwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agenc-agent-cwd-"));
    dirs.push(dir);
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async (params) => ({
        agentId: "a1",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        cwd: params.cwd,
      }),
    };
    const agents = new AgenCDaemonAgentManager({
      runner,
      defaultCwd: () => "/wrong/default",
    });
    const created = await agents.createAgent({
      objective: "with cwd",
      cwd: dir,
    });
    expect(created.cwd).toBe(dir);
    expect(created.agentId).toBe("a1");
  });
});
