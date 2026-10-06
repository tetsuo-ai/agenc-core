import { describe, expect, it, vi } from "vitest";
import { notificationFromDaemonEvent } from "../../src/app-server/background-agent-runner/daemon-events.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";
import type { AgenCDaemonTuiClient } from "../../src/tui/daemon-session.js";
import { adaptTranscriptEvents, type SessionTranscriptEvent } from "../../src/tui/session-transcript.js";
import { createDaemonTuiSessionFixture } from "../helpers/daemon-tui-session.js";

const sessionId = "attached-session";
const agentId = "attached-agent";
const turnId = "attached-turn";

function attachedSession() {
  const listeners = new Set<(event: JsonObject) => void>();
  const client = {
    request: vi.fn(async () => ({})),
    subscribeToSessionEvents: (_id: string, listener: (event: JsonObject) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  } as unknown as AgenCDaemonTuiClient;
  const session = createDaemonTuiSessionFixture({
    baseSession: { conversationId: agentId, services: {} },
    client, sessionId, conversationId: agentId, clientId: "attaching-client",
    transcriptSnapshot: {
      schemaVersion: 2, sessionId, runId: agentId, historyEpoch: "initial",
      asOfSequence: 10, messages: [], activeTurn: { turnId },
    },
  });
  const events = [...session.getInitialTranscriptEvents()] as SessionTranscriptEvent[];
  const unsubscribe = session.subscribeToEvents((event) => events.push(event as SessionTranscriptEvent));
  let sequence = 10;
  const emit = (type: string, payload: JsonObject, owner = agentId) => {
    const notification = notificationFromDaemonEvent(sessionId, owner, {
      id: `event:${++sequence}`, eventId: `event:${sequence}`, sequence,
      runId: agentId, type, payload,
    } as never);
    for (const listener of listeners) listener(notification as unknown as JsonObject);
  };
  return { session, client, events, emit, unsubscribe };
}

describe("daemon TUI attached during an active turn", () => {
  it.each([
    ["turn_complete", { turnId, lastAgentMessage: "Finished" }],
    ["turn_aborted", { turnId, reason: "interrupted" }],
    ["turn_failed", { turnId, code: "provider_error", message: "Provider failed" }],
  ] as const)("clears both busy inputs on canonical %s without a submission RPC", (type, payload) => {
    const attached = attachedSession();
    try {
      expect(adaptTranscriptEvents(attached.events).isStreaming).toBe(true);
      expect(attached.session.activeTurn?.unsafePeek()).toEqual({ turnId });
      attached.emit(type, payload);
      expect(attached.session.activeTurn?.unsafePeek()).toBeNull();
      expect(adaptTranscriptEvents(attached.events).isStreaming).toBe(false);
      expect(attached.events).toContainEqual(expect.objectContaining({ type, payload: expect.objectContaining(payload) }));
      expect(attached.client.request).not.toHaveBeenCalled();
    } finally { attached.unsubscribe(); }
  });

  it("preserves a successor against stale terminals and finishes the successor", () => {
    const attached = attachedSession();
    try {
      attached.emit("turn_started", { turnId: "successor" });
      attached.emit("turn_complete", { turnId });
      expect(attached.session.activeTurn?.unsafePeek()).toEqual({ turnId: "successor" });
      expect(adaptTranscriptEvents(attached.events).isStreaming).toBe(true);
      attached.emit("turn_complete", { turnId: "successor" });
      expect(attached.session.activeTurn?.unsafePeek()).toBeNull();
      expect(adaptTranscriptEvents(attached.events).isStreaming).toBe(false);
    } finally { attached.unsubscribe(); }
  });

  it.each([
    ["turn_started", { turnId }],
    ["turn_complete", { turnId }],
    ["turn_aborted", { turnId, reason: "child interrupted" }],
    ["agent_status", { turnId, status: "error", message: "child failed" }],
  ] as const)("does not let a child %s with the parent's turn ID change the parent", (type, payload) => {
    const attached = attachedSession();
    try {
      attached.emit(type, payload, "child-agent");
      expect(attached.session.activeTurn?.unsafePeek()).toEqual({ turnId });
      expect(adaptTranscriptEvents(attached.events).isStreaming).toBe(true);
      attached.emit("turn_complete", { turnId });
      expect(adaptTranscriptEvents(attached.events).isStreaming).toBe(false);
    } finally { attached.unsubscribe(); }
  });
});
