/**
 * Regression: `broadcastSessionEvent` must NOT create-and-pin a buffer-only
 * route for a session that is terminated (or unknown to the session manager).
 *
 * Such a route can never gain an attached client to drain its buffer
 * (`attachSession` throws SESSION_CLOSED for a closed session), and
 * `deleteRouteIfEmpty` never removes a route that still holds buffered events.
 * Before the fix, a single late event for a dead session pinned its route in
 * `state.sessions` forever, leaking memory unbounded on a long-lived daemon.
 *
 * Routes are private, so the leak is observed behaviorally: if a buffer-only
 * route survives for `session_1`, then a LATER attachment to `session_1`
 * replays the stale buffered event. With the fix no route is created, so the
 * later attachment replays nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import type {
  JsonObject,
  SessionAttachResult,
  SessionDetachResult,
  SessionSummary,
  SessionTerminateResult,
} from "./protocol/index.js";

const workspaces = createTempWorkspaceFixture(
  "agenc-client-multiplexer-route-leak-workspace-",
);

afterEach(async () => {
  await workspaces.cleanup();
});

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("test sequence exhausted");
    index += 1;
    return value;
  };
}

/**
 * Minimal session-manager stand-in exposing only the surface the multiplexer
 * consumes. `setStatus(null)` models an unknown session, `"closed"` a
 * terminated one, and any open status a live one. This lets a single sessionId
 * transition closed -> live deterministically so a leaked buffer-only route is
 * observable via replay on a later attach.
 */
class FakeSessionManager {
  #status: SessionSummary["status"] | null;
  #attachmentIds: () => string;

  constructor(initial: SessionSummary["status"] | null) {
    this.#status = initial;
    this.#attachmentIds = sequence(["attachment_1", "attachment_2"]);
  }

  setStatus(status: SessionSummary["status"] | null): void {
    this.#status = status;
  }

  async getSession(sessionId: string): Promise<SessionSummary | null> {
    if (this.#status === null) return null;
    return {
      sessionId,
      agentId: "agent_1",
      status: this.#status,
      createdAt: "2026-05-01T10:00:00.000Z",
    };
  }

  async attachSession(params: {
    sessionId: string;
    clientId?: string;
  }): Promise<SessionAttachResult> {
    const attachmentId = this.#attachmentIds();
    return {
      sessionId: params.sessionId,
      attachmentId,
      attachedAt: "2026-05-01T10:00:00.000Z",
      activeAttachmentIds: [attachmentId],
    };
  }

  async detachSession(params: {
    sessionId: string;
  }): Promise<SessionDetachResult> {
    return {
      sessionId: params.sessionId,
      detached: true,
      remainingAttachmentIds: [],
    };
  }

  async terminateSession(params: {
    sessionId: string;
  }): Promise<SessionTerminateResult> {
    return {
      sessionId: params.sessionId,
      terminated: true,
      status: "closed",
      closedAt: "2026-05-01T10:00:00.000Z",
    };
  }
}

function multiplexerWith(
  fake: FakeSessionManager,
): AgenCDaemonClientMultiplexer {
  return new AgenCDaemonClientMultiplexer({
    sessionManager: fake as unknown as AgenCDaemonSessionManager,
  });
}

const lateEvent: JsonObject = {
  type: "session.delta",
  sessionId: "session_1",
  sequence: 99,
  text: "trailing-event-after-terminate",
};

describe("client multiplexer dead-session route leak", () => {
  it("does not pin a buffer-only route for a TERMINATED session", async () => {
    const fake = new FakeSessionManager("closed");
    const multiplexer = multiplexerWith(fake);

    // A trailing event arrives for an already-closed session with no attached
    // client. The fix must drop it rather than create-and-buffer a route.
    await expect(
      multiplexer.broadcastSessionEvent("session_1", lateEvent),
    ).resolves.toEqual({
      sessionId: "session_1",
      deliveredClientIds: [],
      failed: [],
    });

    // Session id is later reused as a live session and a client attaches.
    // If the dead-session route had been pinned with the buffered late event,
    // the new client would replay it. With the fix there is no route, so the
    // client receives nothing.
    fake.setStatus("idle");
    const received: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "client_1",
      send: (message) => received.push(message),
    });
    await multiplexer.attachClientToSession("session_1", "client_1");

    expect(received).toEqual([]);
  });

  it("does not pin a buffer-only route for an UNKNOWN session", async () => {
    const fake = new FakeSessionManager(null);
    const multiplexer = multiplexerWith(fake);

    await expect(
      multiplexer.broadcastSessionEvent("session_1", lateEvent),
    ).resolves.toEqual({
      sessionId: "session_1",
      deliveredClientIds: [],
      failed: [],
    });

    fake.setStatus("idle");
    const received: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "client_1",
      send: (message) => received.push(message),
    });
    await multiplexer.attachClientToSession("session_1", "client_1");

    expect(received).toEqual([]);
  });

  it("still buffers and replays events for a LIVE session before its first attach", async () => {
    // Guards against over-correcting the fix: the intentional buffer-before-
    // attach path for a live session must keep working (mirrors the contract
    // test, using the real session manager).
    const sessionManager = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1"]),
      now: sequence([
        "2026-05-01T10:00:00.000Z",
        "2026-05-01T10:00:01.000Z",
        "2026-05-01T10:00:02.000Z",
      ]),
    });
    const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager });

    await sessionManager.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });

    const liveEvent: JsonObject = {
      type: "session.delta",
      sessionId: "session_1",
      sequence: 1,
      text: "buffered-while-live",
    };
    await multiplexer.broadcastSessionEvent("session_1", liveEvent);

    const received: JsonObject[] = [];
    await multiplexer.registerClient({
      clientId: "client_1",
      send: (message) => received.push(message),
    });
    await multiplexer.attachClientToSession("session_1", "client_1");

    expect(received).toEqual([liveEvent]);
  });

  it("only consults the session manager when no route exists yet", async () => {
    // The liveness probe must be confined to the route-creation case: once a
    // route already exists (session was attached at least once) buffering for a
    // transiently-detached client must not depend on `getSession`.
    const fake = new FakeSessionManager("idle");
    const getSession = vi.spyOn(fake, "getSession");
    const multiplexer = multiplexerWith(fake);

    // Attach then disconnect so a route exists with zero active clients.
    await multiplexer.registerClient({ clientId: "client_1", send: () => {} });
    await multiplexer.attachClientToSession("session_1", "client_1");
    await multiplexer.disconnectClient("client_1");

    getSession.mockClear();
    await multiplexer.broadcastSessionEvent("session_1", lateEvent);

    expect(getSession).not.toHaveBeenCalled();
  });
});
