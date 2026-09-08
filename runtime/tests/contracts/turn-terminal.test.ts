import { describe, expect, it } from "vitest";
import { isDurableEvent, isKnownEventType } from "../../src/session/event-log.js";
import { isCanonicalEventPayload } from "../../src/state/recovery-journal-schema.js";
import {
  classifyTurnTerminal,
  createTurnFailedEvent,
  MAX_TURN_FAILURE_MESSAGE_LENGTH,
} from "../../src/contracts/turn-terminal.js";

describe("turn terminal classification", () => {
  it("recognizes failed turns as durable journal events", () => {
    const msg = createTurnFailedEvent({
      turnId: "turn-1", code: "provider_error", message: "provider disconnected",
    });
    expect(isKnownEventType(msg.type)).toBe(true);
    expect(isDurableEvent({ id: "failure-event", msg })).toBe(true);
    expect(isCanonicalEventPayload(msg.type, msg.payload)).toBe(true);
  });

  it.each([
    { turnId: "" },
    { code: "invalid code" },
    { message: "x".repeat(MAX_TURN_FAILURE_MESSAGE_LENGTH + 1) },
    { completedAt: -1 },
    { durationMs: Number.NaN },
  ])("rejects invalid durable failure fields %j", (fields) => {
    expect(isCanonicalEventPayload("turn_failed", {
      turnId: "turn-1", code: "provider_error", message: "failed", ...fields,
    })).toBe(false);
  });

  it.each(["stop_hook_threw", "compact_failed", "editor_policy", "background_agent_error"])(
    "keeps live %s errors non-terminal",
    (cause) => {
      expect(classifyTurnTerminal({
        type: "error",
        payload: { turnId: "turn-1", cause, message: "diagnostic" },
      })).toBeUndefined();
    },
  );

  it("keeps diagnostics open until the later successful completion", () => {
    const events = [
      { type: "error", payload: { cause: "stop_hook_threw", message: "hook failed" } },
      { type: "agent_message", payload: { message: "full answer" } },
      { type: "token_count", payload: { totalTokens: 42 } },
      { type: "turn_complete", payload: { turnId: "turn-1", lastAgentMessage: "full answer" } },
    ];
    expect(events.flatMap((event) => {
      const terminal = classifyTurnTerminal(event, { expectedTurnId: "turn-1" });
      return terminal === undefined ? [] : [terminal];
    })).toEqual([{ outcome: "completed", code: 0, turnId: "turn-1", message: "full answer" }]);
  });

  it("classifies an explicit failure without requiring another terminal event", () => {
    const event = createTurnFailedEvent({
      turnId: "turn-1", code: "provider_error", message: "provider disconnected",
      completedAt: 120, durationMs: 20,
    });
    expect(classifyTurnTerminal(event, { expectedTurnId: "turn-1" })).toEqual({
      outcome: "errored", code: 1, failureCode: "provider_error", turnId: "turn-1",
      message: "provider disconnected", completedAt: 120, durationMs: 20,
    });
  });

  it.each(["turn_complete", "turn_aborted", "turn_failed"])(
    "rejects mismatched %s turn identities",
    (type) => {
      const event = { type, payload: { turnId: "turn-2", code: "provider_error", message: "failed" } };
      expect(classifyTurnTerminal(event, { expectedTurnId: "turn-1" })).toBeUndefined();
      expect(classifyTurnTerminal({ ...event, turnId: "turn-1" })).toBeUndefined();
    },
  );

  it("preserves legacy unscoped aborts but requires scoped completion identities", () => {
    expect(classifyTurnTerminal({ type: "turn_aborted", payload: { reason: "cancelled" } }, {
      expectedTurnId: "turn-1",
    })).toEqual({ outcome: "aborted", code: 130, message: "cancelled" });
    expect(classifyTurnTerminal({ type: "turn_complete", payload: {} }, {
      expectedTurnId: "turn-1",
    })).toBeUndefined();
  });

  it.each(["background_agent_error", "review_task_failed"])("reads legacy %s only when journal compatibility is enabled", (cause) => {
    const event = { type: "error", payload: {
      turnId: "turn-1", cause, message: "legacy failure",
    } };
    expect(classifyTurnTerminal(event, { legacyJournal: true })).toMatchObject({
      outcome: "errored", code: 1, failureCode: cause, turnId: "turn-1",
    });
    expect(classifyTurnTerminal(event, { legacyJournal: true, expectedTurnId: "turn-2" })).toBeUndefined();
    expect(classifyTurnTerminal({ ...event, payload: { ...event.payload, turnId: undefined } }, {
      legacyJournal: true,
    })).toBeUndefined();
    expect(classifyTurnTerminal({ ...event, payload: { ...event.payload, cause: "stop_hook_threw" } }, {
      legacyJournal: true,
    })).toBeUndefined();
  });

  it.each([
    undefined, null, [], {},
    { turnId: "turn-1", code: "bad code", message: "failed" },
    { turnId: "turn-1", code: "provider_error", message: 1 },
    { turnId: "", code: "provider_error", message: "failed" },
  ])("rejects malformed failure payload %j", (payload) => {
    expect(classifyTurnTerminal({ type: "turn_failed", payload })).toBeUndefined();
  });

  it("bounds new journal and projected failure messages and drops invalid timing", () => {
    const payload = {
      turnId: "turn-1", code: "provider_error", message: "x".repeat(10_000),
      completedAt: Number.NaN, durationMs: -1,
    };
    const event = createTurnFailedEvent(payload);
    expect(event.payload.message).toHaveLength(MAX_TURN_FAILURE_MESSAGE_LENGTH);
    expect(event.payload).not.toHaveProperty("completedAt");
    expect(event.payload).not.toHaveProperty("durationMs");
    expect(classifyTurnTerminal({ type: "turn_failed", payload })?.message)
      .toHaveLength(MAX_TURN_FAILURE_MESSAGE_LENGTH);
    expect(() => createTurnFailedEvent({ ...payload, turnId: "" })).toThrow(TypeError);
    expect(() => createTurnFailedEvent({ ...payload, code: "bad code" })).toThrow(TypeError);
  });
});
