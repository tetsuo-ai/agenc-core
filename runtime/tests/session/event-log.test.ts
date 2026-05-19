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
