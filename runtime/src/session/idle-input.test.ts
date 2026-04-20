/**
 * T9 audit: `Session.idlePendingInput` merge into the mailbox.
 *
 * Replaces the old `AsyncLock<unknown[]>` slot with direct routing
 * through `session.mailbox` using an `InterAgentCommunication`
 * envelope tagged `metadata.source = "idle"` + `triggerTurn = false`.
 */

import { describe, expect, it } from "vitest";
import { AsyncQueue } from "../utils/async-queue.js";
import {
  MAILBOX_SOURCE_IDLE_INPUT,
  Session,
  type Event,
  type SessionOpts,
} from "./session.js";

function buildSession(): Session {
  const eventQueue = new AsyncQueue<Event>();
  // The session places almost no demands on services here — only the
  // mailbox + event log paths are exercised. Cast through `unknown`
  // to skirt the otherwise-heavy SessionServices interface.
  const services = {
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
  } as unknown as SessionOpts["services"];
  const opts: SessionOpts = {
    conversationId: "conv-test",
    initialState: {
      sessionConfiguration: {} as SessionOpts["initialState"]["sessionConfiguration"],
      history: [],
    },
    features: {} as SessionOpts["features"],
    services,
    jsRepl: { id: "repl-test" },
    eventQueue,
  };
  return new Session(opts);
}

describe("Session idle-input → mailbox merge", () => {
  it("does not expose the old idlePendingInput field", () => {
    const session = buildSession();
    // Type assertion: the legacy AsyncLock field is gone.
    expect((session as unknown as { idlePendingInput?: unknown }).idlePendingInput).toBeUndefined();
  });

  it("enqueueIdleInput + drainIdleInput round-trip preserves payload and order", () => {
    const session = buildSession();
    const a = { role: "user", content: "first" };
    const b = { role: "user", content: "second" };
    session.enqueueIdleInput(a);
    session.enqueueIdleInput(b);
    const drained = session.drainIdleInput();
    expect(drained).toEqual([a, b]);
  });

  it("idle envelopes carry triggerTurn=false and direction='down' with metadata.source='idle'", () => {
    const session = buildSession();
    session.enqueueIdleInput("payload-1");
    // Peek the raw mailbox (tests should never rely on this in prod).
    const raw = session.mailbox.drain();
    expect(raw).toHaveLength(1);
    const env = raw[0]!;
    expect(env.triggerTurn).toBe(false);
    expect(env.direction).toBe("down");
    expect(env.metadata?.source).toBe(MAILBOX_SOURCE_IDLE_INPUT);
    expect(env.metadata?.payload).toBe("payload-1");
  });

  it("drainIdleInput preserves non-idle messages on the mailbox", () => {
    const session = buildSession();
    session.enqueueIdleInput("idle-1");
    // Send a non-idle peer message directly.
    session.mailbox.send({
      author: "peer",
      recipient: "conv-test",
      content: "peer-traffic",
      triggerTurn: true,
    });
    session.enqueueIdleInput("idle-2");

    const idle = session.drainIdleInput();
    expect(idle).toEqual(["idle-1", "idle-2"]);

    // Non-idle traffic must still be pending on the mailbox.
    const rest = session.mailbox.drain();
    expect(rest).toHaveLength(1);
    expect(rest[0]!.author).toBe("peer");
    expect(rest[0]!.content).toBe("peer-traffic");
  });

  it("drainIdleInput returns [] when no idle input queued", () => {
    const session = buildSession();
    expect(session.drainIdleInput()).toEqual([]);
  });
});
