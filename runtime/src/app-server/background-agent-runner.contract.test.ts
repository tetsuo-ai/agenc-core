import { describe, expect, it, vi } from "vitest";
import {
  AgenCDelegateBackgroundAgentRunner,
  type AgenCBootstrapFunction,
  type AgenCDelegateFunction,
  type AgenCEnsureAgentControlFunction,
} from "./background-agent-runner.js";
import type { AgentThread } from "../agents/thread.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "../permissions/types.js";

describe("AgenC delegate background-agent runner", () => {
  it("starts agent.create through the async delegate path and keeps it alive", async () => {
    const shutdown = vi.fn(async () => {});
    const permissionUpdates: ToolPermissionContext[] = [];
    const permissionModeRegistry = {
      current: () => createEmptyToolPermissionContext(),
      update: vi.fn(async (context: ToolPermissionContext) => {
        permissionUpdates.push(context);
      }),
    };
    const session = { conversationId: "parent-session", permissionModeRegistry };
    const control = { shutdown: vi.fn(async () => {}) };
    const registry = {};
    const thread = {
      threadId: "agent_live",
      agentPath: "/root/agent_live",
      join: vi.fn(() => new Promise(() => {})),
    } as AgentThread;
    const bootstrap = vi.fn(async () => ({
      session,
      shutdown,
    })) as unknown as AgenCBootstrapFunction;
    const ensureAgentControl = vi.fn(() => ({
      control,
      registry,
    })) as unknown as AgenCEnsureAgentControlFunction;
    const delegateFn = vi.fn(async () => ({
      kind: "async_launched",
      thread,
    })) as unknown as AgenCDelegateFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap,
      delegateFn,
      ensureAgentControl,
      argv: ["/usr/bin/node", "/opt/agenc/bin/agenc.js"],
      env: { AGENC_HOME: "/tmp/agenc-home" },
      now: () => "2026-05-01T12:00:00.500Z",
    });

    await expect(
      runner.startAgent({
        objective: "compile the daemon",
        cwd: "/workspace",
        model: "grok-4",
        metadata: { ticket: "F-06a" },
        unattendedAllow: ["FileRead", "system.grep"],
        unattendedDeny: ["exec_command"],
      }),
    ).resolves.toEqual({
      agentId: "agent_live",
      agentPath: "/root/agent_live",
      startedAt: "2026-05-01T12:00:00.500Z",
      status: "running",
    });

    expect(bootstrap).toHaveBeenCalledWith({
      env: { AGENC_HOME: "/tmp/agenc-home" },
      argv: [
        "/usr/bin/node",
        "/opt/agenc/bin/agenc.js",
        "--model",
        "grok-4",
        "--autonomous",
      ],
      cwd: "/workspace",
    });
    expect(ensureAgentControl).toHaveBeenCalledWith(session);
    expect(delegateFn).toHaveBeenCalledWith({
      parent: session,
      parentPath: "/root",
      control,
      registry,
      taskPrompt: "compile the daemon",
      runInBackground: true,
      isolation: "cwd",
      model: "grok-4",
    });
    expect(permissionModeRegistry.update).toHaveBeenCalledTimes(1);
    expect(permissionUpdates[0]?.alwaysAllowRules.session).toEqual([
      "FileRead",
      "system.grep",
    ]);
    expect(permissionUpdates[0]?.alwaysDenyRules.session).toEqual([
      "exec_command",
    ]);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("shuts down the bootstrap when delegate rejects the background start", async () => {
    const shutdown = vi.fn(async () => {});
    const bootstrap = vi.fn(async () => ({
      session: {
        permissionModeRegistry: {
          current: () => createEmptyToolPermissionContext(),
          update: vi.fn(async () => {}),
        },
      },
      shutdown,
    })) as unknown as AgenCBootstrapFunction;
    const ensureAgentControl = vi.fn(() => ({
      control: {},
      registry: {},
    })) as unknown as AgenCEnsureAgentControlFunction;
    const delegateFn = vi.fn(async () => ({
      kind: "rejected",
      reason: "not enough slots",
    })) as unknown as AgenCDelegateFunction;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap,
      delegateFn,
      ensureAgentControl,
    });

    await expect(
      runner.startAgent({
        objective: "compile the daemon",
        unattendedAllow: ["FileRead"],
        unattendedDeny: [],
      }),
    ).rejects.toThrow("not enough slots");
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("releases retained bootstrap state when the background thread finishes", async () => {
    const shutdown = vi.fn(async () => {});
    const session = {
      permissionModeRegistry: {
        current: () => createEmptyToolPermissionContext(),
        update: vi.fn(async () => {}),
      },
    };
    const control = { shutdown: vi.fn(async () => {}) };
    let finishThread!: () => void;
    const thread = {
      threadId: "agent_done",
      agentPath: "/root/agent_done",
      join: vi.fn(
        () =>
          new Promise((resolve) => {
            finishThread = () => resolve({} as never);
          }),
      ),
    } as AgentThread;
    const runner = new AgenCDelegateBackgroundAgentRunner({
      bootstrap: vi.fn(async () => ({
        session,
        shutdown,
      })) as unknown as AgenCBootstrapFunction,
      ensureAgentControl: vi.fn(() => ({
        control,
        registry: {},
      })) as unknown as AgenCEnsureAgentControlFunction,
      delegateFn: vi.fn(async () => ({
        kind: "async_launched",
        thread,
      })) as unknown as AgenCDelegateFunction,
    });

    await runner.startAgent({
      objective: "compile the daemon",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    expect(shutdown).not.toHaveBeenCalled();

    finishThread();
    await new Promise((resolve) => setImmediate(resolve));

    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
