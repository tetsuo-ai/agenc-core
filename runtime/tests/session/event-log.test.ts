import { describe, expect, test } from "vitest";
import {
  EventLog,
  emitDeprecationNotice,
  emitError,
  emitWarning,
  isKnownEventType,
  isDurableEvent,
  KNOWN_EVENT_TYPES,
  ROLLOUT_SCHEMA_VERSION,
  usageToTokenCountEvent,
} from "./event-log.js";
import type { EventMsg } from "./event-log.js";

describe("EventLog", () => {
  test("emit assigns monotonic seq (I-27)", () => {
    const log = new EventLog();
    const a = log.emit({
      id: "1",
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });
    const b = log.emit({
      id: "2",
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });
    const c = log.emit({
      id: "3",
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(c.seq).toBe(3);
  });

  test("assigns unique canonical eventIds while preserving reusable envelope ids", () => {
    const log = new EventLog();
    const first = log.emit({
      id: "reused-sub-id",
      msg: { type: "warning", payload: { cause: "x", message: "first" } },
    });
    const second = log.emit({
      id: "reused-sub-id",
      msg: { type: "warning", payload: { cause: "x", message: "second" } },
    });

    expect(first).toMatchObject({
      eventId: "event:1",
      id: "reused-sub-id",
      seq: 1,
    });
    expect(second).toMatchObject({
      eventId: "event:2",
      id: "reused-sub-id",
      seq: 2,
    });
  });

  test("preserves explicit eventIds and rejects reuse without consuming a sequence", () => {
    const log = new EventLog();
    const first = log.emit({
      eventId: "effect-intent:run-1:step-1",
      id: "turn-sub-id",
      msg: { type: "warning", payload: { cause: "x", message: "first" } },
    });

    expect(first).toMatchObject({
      eventId: "effect-intent:run-1:step-1",
      id: "turn-sub-id",
      seq: 1,
    });
    expect(() =>
      log.emit({
        eventId: "effect-intent:run-1:step-1",
        id: "another-envelope",
        msg: {
          type: "warning",
          payload: { cause: "x", message: "conflict" },
        },
      }),
    ).toThrow("eventId already allocated: effect-intent:run-1:step-1");
    expect(
      log.emit({
        id: "after-conflict",
        msg: { type: "warning", payload: { cause: "x", message: "next" } },
      }),
    ).toMatchObject({ eventId: "event:2", seq: 2 });
  });

  test("continues default event identity after a recovered sequence floor", () => {
    const log = new EventLog();
    log.seedLastSeq(41);
    expect(
      log.emit({
        id: "restored-sub-id",
        msg: { type: "warning", payload: { cause: "x", message: "next" } },
      }),
    ).toMatchObject({ eventId: "event:42", seq: 42 });
  });

  test("restores canonical identities and rejects reuse after resume", () => {
    const log = new EventLog();
    log.seedCanonicalHistory([
      {
        eventId: "durable-id",
        id: "reusable-correlation",
        seq: 7,
        msg: { type: "warning", payload: { cause: "test", message: "old" } },
      },
    ]);

    expect(log.lastSeq).toBe(7);
    expect(() =>
      log.emit({
        eventId: "durable-id",
        id: "different-correlation",
        msg: { type: "warning", payload: { cause: "test", message: "new" } },
      }),
    ).toThrow(/eventId already allocated/);
  });

  test("fails closed when resumed history already reuses a canonical identity", () => {
    const log = new EventLog();
    expect(() =>
      log.seedCanonicalHistory([
        {
          eventId: "duplicate",
          id: "first",
          seq: 1,
          msg: { type: "warning", payload: { cause: "test", message: "first" } },
        },
        {
          eventId: "duplicate",
          id: "second",
          seq: 2,
          msg: { type: "warning", payload: { cause: "test", message: "second" } },
        },
      ]),
    ).toThrow(/canonical rollout reuses eventId/);
  });

  test("fails closed on conflicting resumed sequence coordinates", () => {
    const event = (eventId: string, id: string, seq: number) => ({
      eventId,
      id,
      seq,
      msg: { type: "warning" as const, payload: { cause: "test", message: id } },
    });

    expect(() =>
      new EventLog().seedCanonicalHistory([
        event("first", "first", 1),
        event("second", "second", 1),
      ]),
    ).toThrow(/canonical rollout reuses sequence/);
    expect(() =>
      new EventLog().seedCanonicalHistory([event("event:9", "wrong", 1)]),
    ).toThrow(/eventId event:9 conflicts with sequence 1/);
  });

  test("prevents explicit identities from claiming a future default slot", () => {
    const log = new EventLog();
    expect(() =>
      log.emit({
        eventId: "event:2",
        id: "future-claim",
        msg: { type: "warning", payload: { cause: "x", message: "bad" } },
      }),
    ).toThrow("eventId event:2 is reserved for sequence 2");
    expect(
      log.emit({
        id: "first-real-event",
        msg: { type: "warning", payload: { cause: "x", message: "good" } },
      }),
    ).toMatchObject({ eventId: "event:1", seq: 1 });
  });

  test("subscribe receives events in order", () => {
    const log = new EventLog();
    const seen: number[] = [];
    log.subscribe((e) => seen.push(e.seq!));
    for (let i = 0; i < 5; i += 1) {
      log.emit({
        id: String(i),
        msg: { type: "warning", payload: { cause: "x", message: "y" } },
      });
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  test("stamp reserves a sequence without publishing until publish", () => {
    const log = new EventLog();
    const seen: number[] = [];
    log.subscribe((event) => seen.push(event.seq!));

    const stamped = log.stamp({
      id: "durable-1",
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });

    expect(stamped.seq).toBe(1);
    expect(seen).toEqual([]);
    log.publish(stamped);
    expect(seen).toEqual([1]);
  });

  test("re-entrant publication preserves monotonic listener order", () => {
    const log = new EventLog();
    const seen: number[] = [];
    let nested = false;
    log.subscribe((event) => {
      if (!nested) {
        nested = true;
        log.emit({
          id: "nested",
          msg: { type: "warning", payload: { cause: "x", message: "nested" } },
        });
      }
      void event;
    });
    log.subscribe((event) => seen.push(event.seq!));

    log.emit({
      id: "outer",
      msg: { type: "warning", payload: { cause: "x", message: "outer" } },
    });

    expect(seen).toEqual([1, 2]);
  });

  test("re-entrant compatibility callbacks preserve publication order", () => {
    const log = new EventLog();
    const seen: string[] = [];
    let nested = false;
    log.subscribe((event) => {
      seen.push(`listener:${event.seq}`);
      if (!nested) {
        nested = true;
        const stamped = log.stamp({
          id: "nested",
          msg: { type: "warning", payload: { cause: "x", message: "nested" } },
        });
        log.publish(stamped, (published) => {
          seen.push(`compat:${published.seq}`);
        });
      }
    });

    const stamped = log.stamp({
      id: "outer",
      msg: { type: "warning", payload: { cause: "x", message: "outer" } },
    });
    log.publish(stamped, (published) => {
      seen.push(`compat:${published.seq}`);
    });

    expect(seen).toEqual([
      "listener:1",
      "compat:1",
      "listener:2",
      "compat:2",
    ]);
  });

  test("an owning emitter can converge legacy EventLog producers", () => {
    const log = new EventLog();
    const delegated: string[] = [];
    log.setEmitDelegate((event) => {
      delegated.push(event.id);
      return log.publish(log.stamp(event));
    });

    const result = log.emit({
      id: "legacy-producer",
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });

    expect(delegated).toEqual(["legacy-producer"]);
    expect(result.seq).toBe(1);
  });

  test("listener throw doesn't break other listeners (I-43)", () => {
    const log = new EventLog();
    let bGotEvent = false;
    log.subscribe(() => {
      throw new Error("boom");
    });
    log.subscribe(() => {
      bGotEvent = true;
    });
    log.emit({
      id: "1",
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });
    expect(bGotEvent).toBe(true);
  });

  test("close stops further emit", () => {
    const log = new EventLog();
    log.close();
    const result = log.emit({
      id: "1",
      msg: { type: "warning", payload: { cause: "x", message: "y" } },
    });
    expect(log.isClosed).toBe(true);
    // Closed log returns event unchanged (no seq assigned).
    expect(result.seq).toBeUndefined();
  });
});

describe("I-8 emitError helper", () => {
  test("emitError writes typed error event", () => {
    const log = new EventLog();
    let captured;
    log.subscribe((e) => (captured = e));
    emitError(log, "sub-1", {
      cause: "provider_401",
      message: "bearer invalid",
      turnId: "turn-42",
    });
    expect(captured).toMatchObject({
      id: "sub-1",
      msg: {
        type: "error",
        payload: {
          cause: "provider_401",
          message: "bearer invalid",
          turnId: "turn-42",
        },
      },
    });
  });

  test("emitError with streamError flag → stream_error", () => {
    const log = new EventLog();
    let captured;
    log.subscribe((e) => (captured = e));
    emitError(log, "sub-1", {
      cause: "network",
      message: "ECONNRESET",
      streamError: true,
      provider: "grok",
      status: 502,
    });
    expect(captured).toMatchObject({
      msg: {
        type: "stream_error",
        payload: { cause: "network", provider: "grok", status: 502 },
      },
    });
  });

  test("emitWarning writes warning event", () => {
    const log = new EventLog();
    let captured;
    log.subscribe((e) => (captured = e));
    emitWarning(log, "sub-1", "config_reload_requested", "next turn");
    expect(captured).toMatchObject({
      msg: {
        type: "warning",
        payload: {
          cause: "config_reload_requested",
          message: "next turn",
        },
      },
    });
  });
});

describe("I-26 forward-compat + schema version", () => {
  test("KNOWN_EVENT_TYPES contains all known variants", () => {
    expect(KNOWN_EVENT_TYPES.size).toBeGreaterThanOrEqual(24);
    expect(isKnownEventType("entered_review_mode")).toBe(true);
  });

  test("isKnownEventType detects known + unknown", () => {
    expect(isKnownEventType("agent_message")).toBe(true);
    expect(isKnownEventType("protocol_claim")).toBe(true);
    expect(isKnownEventType("protocol_settle")).toBe(true);
    expect(isKnownEventType("protocol_slash")).toBe(true);
    expect(isKnownEventType("protocol_stake")).toBe(true);
    expect(isKnownEventType("future_variant")).toBe(false);
  });

  test("ROLLOUT_SCHEMA_VERSION is exported (I-49)", () => {
    expect(ROLLOUT_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe("deprecation_notice emit helper", () => {
  test("emitDeprecationNotice writes a structured event", () => {
    const log = new EventLog();
    let captured: unknown;
    log.subscribe((e) => (captured = e));
    emitDeprecationNotice(log, "sub-7", {
      subject: "grok-4.20-beta-0309-reasoning",
      reason: "legacy catalog id",
      replacement: "grok-4.20-0309-reasoning",
      deprecated_since: "2026-04",
    });
    expect(captured).toMatchObject({
      id: "sub-7",
      msg: {
        type: "deprecation_notice",
        payload: {
          subject: "grok-4.20-beta-0309-reasoning",
          reason: "legacy catalog id",
          replacement: "grok-4.20-0309-reasoning",
          deprecated_since: "2026-04",
        },
      },
    });
  });
});

describe("I-4 durable event classification", () => {
  test("turn_complete, turn_aborted, error, context_compacted are durable", () => {
    expect(
      isDurableEvent({
        id: "1",
        msg: {
          type: "turn_complete",
          payload: { turnId: "t", lastAgentMessage: "x" },
        },
      }),
    ).toBe(true);
    expect(
      isDurableEvent({
        id: "1",
        msg: { type: "turn_aborted", payload: { reason: "user_interrupt" } },
      }),
    ).toBe(true);
    expect(
      isDurableEvent({
        id: "1",
        msg: { type: "error", payload: { cause: "x", message: "y" } },
      }),
    ).toBe(true);
    expect(
      isDurableEvent({
        id: "1",
        msg: { type: "context_compacted", payload: {} },
      }),
    ).toBe(true);
  });

  test("agent_message_delta is not durable", () => {
    expect(
      isDurableEvent({
        id: "1",
        msg: { type: "agent_message_delta", payload: { delta: "x" } },
      }),
    ).toBe(false);
  });

  test("protocol events are durable on-chain transcript records", () => {
    const event: EventMsg = {
      type: "protocol_slash",
      payload: {
        taskPda: "task-47",
        slashedAgent: "worker/zk-prover",
        reason: "public input mismatch",
        stakeDeltaLamports: -800_000_000,
        reputationDelta: -12,
        signature: "fM91",
      },
    };

    expect(isDurableEvent({ id: "slash", msg: event })).toBe(true);
  });

  test("effect intent, result, and unknown-outcome records are durable", () => {
    const base = {
      runId: "run-1",
      stepId: "tool:turn-1:call-1",
      callId: "call-1",
      toolName: "system.write",
      recoveryCategory: "side-effecting" as const,
      recordedAt: "2026-07-18T00:00:00.000Z",
    };
    expect(isDurableEvent({
      id: "effect-intent-id",
      msg: {
        type: "effect_intent",
        payload: { ...base, intentDigest: "a".repeat(64), attempt: 1 },
      },
    })).toBe(true);
    expect(isDurableEvent({
      id: "effect-result-id",
      msg: {
        type: "effect_result",
        payload: { ...base, intentEventSeq: 7, outcome: "committed" },
      },
    })).toBe(true);
    expect(isDurableEvent({
      id: "effect-unknown-id",
      msg: {
        type: "effect_unknown_outcome",
        payload: {
          ...base,
          intentEventSeq: 7,
          outcome: "unknown_outcome",
          reason: "lost_acknowledgement",
          requiresReview: true,
        },
      },
    })).toBe(true);
  });

  test("permission requests and decisions are durable audit boundaries", () => {
    expect(isDurableEvent({
      id: "permission-request",
      msg: {
        type: "request_permissions",
        payload: {
          callId: "call-1",
          toolName: "Bash",
          permissions: ["tool.use"],
          turnId: "turn-1",
        },
      },
    })).toBe(true);
    expect(isDurableEvent({
      id: "permission-decision",
      msg: {
        type: "permission_decision",
        payload: {
          runId: "run-1",
          callId: "call-1",
          toolName: "Bash",
          turnId: "turn-1",
          requestEventId: "event:7",
          requestEventSeq: 7,
          decision: "approved",
          recordedAt: "2026-07-18T00:00:00.000Z",
        },
      },
    })).toBe(true);
  });
});

describe("usageToTokenCountEvent", () => {
  test("preserves cache, reasoning, and web search usage extras", () => {
    expect(
      usageToTokenCountEvent({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 4,
        reasoningOutputTokens: 2,
        webSearchRequests: 1,
      }),
    ).toEqual({
      type: "token_count",
      payload: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 4,
        reasoningOutputTokens: 2,
        webSearchRequests: 1,
      },
    });
  });
});
