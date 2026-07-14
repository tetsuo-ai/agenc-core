import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import { RolloutStore } from "../session/rollout-store.js";
import { FileThreadStore } from "../thread-store/store.js";
import {
  AgenCDaemonSessionManager,
  AgenCSessionLifecycleError,
  DEFAULT_AGENC_DAEMON_AGENT_ID,
} from "./session-lifecycle.js";

const workspaces = createTempWorkspaceFixture(
  "agenc-session-lifecycle-workspace-",
);

afterEach(async () => {
  await workspaces.cleanup();
});

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
    const firstAgentCwd = await workspaces.create();
    const secondAgentCwd = await workspaces.create();
    const thirdAgentCwd = await workspaces.create();

    await expect(
      manager.createSession({
        agentId: "agent_1",
        cwd: firstAgentCwd,
        initialPrompt: "inspect",
        metadata: { origin: "test" },
      }),
    ).resolves.toEqual({
      sessionId: "session_1",
      agentId: "agent_1",
      status: "idle",
      createdAt: "2026-05-01T10:00:00.000Z",
      cwd: firstAgentCwd,
      metadata: { origin: "test" },
    });
    await manager.createSession({ agentId: "agent_2", cwd: secondAgentCwd });
    await manager.createSession({ agentId: "agent_1", cwd: thirdAgentCwd });

    await expect(
      manager.listSessions({ agentId: "agent_1", limit: 1 }),
    ).resolves.toEqual({
      sessions: [
        {
          sessionId: "session_1",
          agentId: "agent_1",
          status: "idle",
          createdAt: "2026-05-01T10:00:00.000Z",
          cwd: firstAgentCwd,
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
    await manager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });

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
    await manager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
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
    await manager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });

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

  it("lists stored on-disk threads after manager recreation", async () => {
    const { cwd, home, restoreEnv } = createThreadStoreTestDirs();
    const rollout = openRollout(cwd, "stored-session");
    const threadStore = new FileThreadStore({ cwd, agencHome: home });
    try {
      threadStore.createThread({
        threadId: "stored-session",
        rolloutStore: rollout,
        source: "cli_main",
        cwd,
        model: "grok-4",
        modelProvider: "xai",
      });
      threadStore.shutdownThread("stored-session");

      const recreated = new AgenCDaemonSessionManager({
        threadStore,
        createAttachmentId: sequence(["attachment-stored"]),
        now: sequence(["2026-05-01T10:31:00.000Z"]),
      });
      await expect(recreated.listSessions()).resolves.toMatchObject({
        sessions: [
          {
            sessionId: "stored-session",
            agentId: DEFAULT_AGENC_DAEMON_AGENT_ID,
            status: "waiting",
            cwd,
            metadata: {
              source: "cli_main",
              model: "grok-4",
              modelProvider: "xai",
              recovered: true,
            },
          },
        ],
      });
      await expect(recreated.countSessions()).resolves.toEqual({
        active: 1,
        closed: 0,
        total: 1,
      });
      await expect(
        recreated.attachSession({
          sessionId: "stored-session",
          clientId: "tui_1",
        }),
      ).resolves.toEqual({
        sessionId: "stored-session",
        attachmentId: "attachment-stored",
        clientId: "tui_1",
        attachedAt: "2026-05-01T10:31:00.000Z",
        activeAttachmentIds: ["attachment-stored"],
      });
    } finally {
      threadStore.close();
      rollout.close();
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("persists termination of stored on-disk threads after manager recreation", async () => {
    const { cwd, home, restoreEnv } = createThreadStoreTestDirs();
    const rollout = openRollout(cwd, "stored-close");
    const threadStore = new FileThreadStore({ cwd, agencHome: home });
    try {
      threadStore.createThread({
        threadId: "stored-close",
        rolloutStore: rollout,
        source: "cli_main",
        cwd,
      });
      threadStore.shutdownThread("stored-close");

      const manager = new AgenCDaemonSessionManager({
        threadStore,
        now: sequence(["2026-05-01T10:32:00.000Z"]),
      });
      await expect(
        manager.terminateSession({
          sessionId: "stored-close",
          reason: "closed by operator",
        }),
      ).resolves.toMatchObject({
        sessionId: "stored-close",
        terminated: true,
        status: "closed",
        reason: "closed by operator",
      });

      const recreated = new AgenCDaemonSessionManager({ threadStore });
      await expect(recreated.listSessions()).resolves.toEqual({ sessions: [] });
      await expect(recreated.countSessions()).resolves.toEqual({
        active: 0,
        closed: 0,
        total: 0,
      });
      await expect(recreated.getSession("stored-close")).resolves.toBeNull();
    } finally {
      threadStore.close();
      rollout.close();
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function createThreadStoreTestDirs(): {
  readonly cwd: string;
  readonly home: string;
  readonly restoreEnv: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), "agenc-session-lifecycle-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "agenc-session-lifecycle-home-"));
  const previous = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  return {
    cwd,
    home,
    restoreEnv: () => {
      if (previous === undefined) delete process.env.AGENC_HOME;
      else process.env.AGENC_HOME = previous;
    },
  };
}

function openRollout(cwd: string, sessionId: string): RolloutStore {
  const rollout = new RolloutStore({
    cwd,
    sessionId,
    agencVersion: "0.2.0",
  });
  rollout.open({
    sessionId,
    timestamp: "2026-05-01T10:30:00.000Z",
    cwd,
    originator: "session-lifecycle-test",
    agencVersion: "0.2.0",
    model: "grok-4",
    modelProvider: "xai",
  });
  return rollout;
}
