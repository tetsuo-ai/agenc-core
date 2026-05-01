import { describe, expect, it } from "vitest";
import {
  AgenCDaemonSessionManager,
  AgenCSessionLifecycleError,
} from "./session-lifecycle.js";

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

describe("AgenC daemon session lifecycle", () => {
  it("creates server-owned sessions keyed by sessionId and lists them by agent", async () => {
    const manager = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1", "session_2", "session_3"]),
      now: sequence([
        "2026-05-01T10:00:00.000Z",
        "2026-05-01T10:01:00.000Z",
        "2026-05-01T10:02:00.000Z",
      ]),
    });

    await expect(
      manager.createSession({
        agentId: "agent_1",
        cwd: "/workspace/a",
        initialPrompt: "inspect",
        metadata: { origin: "test" },
      }),
    ).resolves.toEqual({
      sessionId: "session_1",
      agentId: "agent_1",
      status: "idle",
      createdAt: "2026-05-01T10:00:00.000Z",
      cwd: "/workspace/a",
      metadata: { origin: "test" },
    });
    await manager.createSession({ agentId: "agent_2" });
    await manager.createSession({ agentId: "agent_1" });

    await expect(
      manager.listSessions({ agentId: "agent_1", limit: 1 }),
    ).resolves.toEqual({
      sessions: [
        {
          sessionId: "session_1",
          agentId: "agent_1",
          status: "idle",
          createdAt: "2026-05-01T10:00:00.000Z",
          cwd: "/workspace/a",
          metadata: { origin: "test" },
        },
      ],
      nextCursor: "1",
    });

    await expect(
      manager.listSessions({ agentId: "agent_1", cursor: "1" }),
    ).resolves.toMatchObject({
      sessions: [
        {
          sessionId: "session_3",
          agentId: "agent_1",
        },
      ],
    });
  });

  it("attaches and detaches clients without terminating the session", async () => {
    const manager = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1", "attachment_2"]),
      now: sequence([
        "2026-05-01T10:00:00.000Z",
        "2026-05-01T10:00:01.000Z",
        "2026-05-01T10:00:02.000Z",
      ]),
    });
    await manager.createSession({ agentId: "agent_1" });

    await expect(
      manager.attachSession({ sessionId: "session_1", clientId: "tui_1" }),
    ).resolves.toEqual({
      sessionId: "session_1",
      attachmentId: "attachment_1",
      clientId: "tui_1",
      attachedAt: "2026-05-01T10:00:01.000Z",
      activeAttachmentIds: ["attachment_1"],
    });

    await expect(
      manager.attachSession({ sessionId: "session_1", clientId: "tui_1" }),
    ).resolves.toMatchObject({
      attachmentId: "attachment_1",
      activeAttachmentIds: ["attachment_1"],
    });

    await expect(
      manager.attachSession({ sessionId: "session_1", clientId: "tui_2" }),
    ).resolves.toMatchObject({
      attachmentId: "attachment_2",
      activeAttachmentIds: ["attachment_1", "attachment_2"],
    });

    await expect(
      manager.detachSession({ sessionId: "session_1", clientId: "tui_1" }),
    ).resolves.toEqual({
      sessionId: "session_1",
      attachmentId: "attachment_1",
      detached: true,
      remainingAttachmentIds: ["attachment_2"],
    });
    await expect(manager.getSession("session_1")).resolves.toMatchObject({
      sessionId: "session_1",
      status: "idle",
      activeAttachmentIds: ["attachment_2"],
    });

    await expect(
      manager.detachSession({
        sessionId: "session_1",
        attachmentId: "attachment_missing",
      }),
    ).resolves.toEqual({
      sessionId: "session_1",
      detached: false,
      remainingAttachmentIds: ["attachment_2"],
    });
  });

  it("terminates sessions, clears attachments, and rejects later attach", async () => {
    const manager = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1"]),
      now: sequence([
        "2026-05-01T10:00:00.000Z",
        "2026-05-01T10:00:01.000Z",
        "2026-05-01T10:00:02.000Z",
      ]),
    });
    await manager.createSession({ agentId: "agent_1" });
    await manager.attachSession({ sessionId: "session_1", clientId: "tui_1" });

    await expect(
      manager.terminateSession({
        sessionId: "session_1",
        reason: "user requested stop",
      }),
    ).resolves.toEqual({
      sessionId: "session_1",
      terminated: true,
      status: "closed",
      closedAt: "2026-05-01T10:00:02.000Z",
      reason: "user requested stop",
    });
    await expect(manager.getSession("session_1")).resolves.toMatchObject({
      sessionId: "session_1",
      status: "closed",
      closedAt: "2026-05-01T10:00:02.000Z",
    });

    await expect(
      manager.attachSession({ sessionId: "session_1", clientId: "tui_2" }),
    ).rejects.toMatchObject({
      code: "SESSION_CLOSED",
    });
    await expect(
      manager.terminateSession({ sessionId: "session_1" }),
    ).resolves.toMatchObject({
      terminated: false,
      status: "closed",
    });
  });

  it("reports lifecycle errors without mutating unrelated sessions", async () => {
    const manager = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T10:00:00.000Z"]),
    });
    await manager.createSession({ agentId: "agent_1" });

    await expect(
      manager.attachSession({ sessionId: "session_missing" }),
    ).rejects.toBeInstanceOf(AgenCSessionLifecycleError);
    await expect(
      manager.detachSession({ sessionId: "session_1" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      manager.listSessions({ cursor: "not-a-number" }),
    ).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
    await expect(manager.listSessions()).resolves.toMatchObject({
      sessions: [{ sessionId: "session_1", status: "idle" }],
    });
  });
});
