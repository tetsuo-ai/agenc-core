import { describe, expect, it } from "vitest";
import { AgenCDaemonReattachResolver } from "./reattach.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("test sequence exhausted");
    }
    index += 1;
    return value;
  };
}

function createHarness(): {
  readonly manager: AgenCDaemonSessionManager;
  readonly resolver: AgenCDaemonReattachResolver;
} {
  const manager = new AgenCDaemonSessionManager({
    createSessionId: sequence([
      "session_old",
      "session_other",
      "session_new",
      "session_closed",
    ]),
    createAttachmentId: sequence([
      "attachment_1",
      "attachment_2",
      "attachment_3",
      "attachment_4",
    ]),
    now: sequence([
      "2026-05-01T10:00:00.000Z",
      "2026-05-01T10:01:00.000Z",
      "2026-05-01T10:02:00.000Z",
      "2026-05-01T10:03:00.000Z",
      "2026-05-01T10:04:00.000Z",
      "2026-05-01T10:05:00.000Z",
    ]),
  });
  const resolver = new AgenCDaemonReattachResolver({
    sessionManager: manager,
  });
  return { manager, resolver };
}

describe("AgenC daemon reattach behavior", () => {
  it("attaches a new agenc client to the newest active session for the current cwd", async () => {
    const { manager, resolver } = createHarness();
    await manager.createSession({
      agentId: "agent_default",
      cwd: "/workspace/project",
    });
    await manager.createSession({
      agentId: "agent_other",
      cwd: "/workspace/other",
    });
    await manager.createSession({
      agentId: "agent_default",
      cwd: "/workspace/project/.",
    });

    await expect(
      resolver.attachCurrentCwd({
        cwd: "/workspace/project",
        clientId: "tui_1",
      }),
    ).resolves.toEqual({
      reattached: true,
      mode: "cwd",
      session: {
        sessionId: "session_new",
        agentId: "agent_default",
        status: "idle",
        createdAt: "2026-05-01T10:02:00.000Z",
        cwd: "/workspace/project/.",
        activeAttachmentIds: ["attachment_1"],
      },
      attachment: {
        sessionId: "session_new",
        attachmentId: "attachment_1",
        clientId: "tui_1",
        attachedAt: "2026-05-01T10:03:00.000Z",
        activeAttachmentIds: ["attachment_1"],
      },
    });
  });

  it("ignores closed sessions when reattaching by cwd", async () => {
    const { manager, resolver } = createHarness();
    await manager.createSession({
      agentId: "agent_default",
      cwd: "/workspace/project",
    });
    await manager.createSession({
      agentId: "agent_other",
      cwd: "/workspace/other",
    });
    await manager.createSession({
      agentId: "agent_default",
      cwd: "/workspace/project",
    });
    await manager.terminateSession({
      sessionId: "session_new",
      reason: "finished",
    });

    await expect(
      resolver.attachCurrentCwd({
        cwd: "/workspace/project",
        clientId: "tui_1",
      }),
    ).resolves.toMatchObject({
      reattached: true,
      mode: "cwd",
      session: {
        sessionId: "session_old",
        activeAttachmentIds: ["attachment_1"],
      },
    });
  });

  it("allows explicit agent attach for a non-default agent outside the current cwd", async () => {
    const { manager, resolver } = createHarness();
    await manager.createSession({
      agentId: "agent_default",
      cwd: "/workspace/project",
    });
    await manager.createSession({
      agentId: "agent_background",
      cwd: "/workspace/background",
    });

    await expect(
      resolver.attachAgent({
        agentId: "agent_background",
        clientId: "tui_1",
        preferCwd: "/workspace/project",
      }),
    ).resolves.toMatchObject({
      reattached: true,
      mode: "agent",
      session: {
        sessionId: "session_other",
        agentId: "agent_background",
        cwd: "/workspace/background",
        activeAttachmentIds: ["attachment_1"],
      },
      attachment: {
        sessionId: "session_other",
        attachmentId: "attachment_1",
        clientId: "tui_1",
      },
    });
  });

  it("returns an explicit miss instead of creating a replacement session", async () => {
    const { resolver } = createHarness();

    await expect(
      resolver.attachCurrentCwd({
        cwd: "/workspace/missing",
        clientId: "tui_1",
      }),
    ).resolves.toEqual({
      reattached: false,
      mode: "cwd",
      reason: "NO_ACTIVE_SESSION_FOR_CWD",
      cwd: "/workspace/missing",
    });

    await expect(
      resolver.attachAgent({
        agentId: "agent_missing",
        clientId: "tui_1",
      }),
    ).resolves.toEqual({
      reattached: false,
      mode: "agent",
      reason: "NO_ACTIVE_SESSION_FOR_AGENT",
      agentId: "agent_missing",
    });
  });
});
