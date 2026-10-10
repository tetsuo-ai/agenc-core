import { afterEach, expect, test, vi } from "vitest";
import { runAdmittedToolCall, flushOneShotEffectJournal } from "../../src/budget/admitted-tool-call.js";
import { withOneShotFastMode } from "../../src/one-shot-fast-mode.js";
import type { Session } from "../../src/session/session.js";
import type { Event } from "../../src/session/event-log.js";
import { confirmedNoEffectDisposition } from "../../src/tools/system/exec-command.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  let seq = 0;
  const events: Event[] = [];
  const session = { conversationId: "one-shot", services: { admissionRequired: false },
    rolloutStore: { recordEffectEvent: vi.fn() },
    emit: (event: Event) => { const stamped = { ...event, seq: ++seq }; events.push(stamped); return stamped; },
  } as unknown as Session;
  return { session, events };
}

test("journals actual tool intervals only at final flush without executing a second time", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-08T20:00:00Z"));
  const { session, events } = fixture();
  const invoke = vi.fn(async (context) => { context.crossEffectBoundary(); vi.advanceTimersByTime(37); return { content: "done" }; });
  const result = await withOneShotFastMode(() => runAdmittedToolCall({ session, turnId: "turn", callId: "call",
    tool: { name: "read", description: "", inputSchema: { type: "object" }, recoveryCategory: "read-only", execute: vi.fn() },
    args: {}, invoke }));
  expect(result.content).toBe("done"); expect(events).toHaveLength(0);
  vi.advanceTimersByTime(5000);
  flushOneShotEffectJournal(session); flushOneShotEffectJournal(session);
  expect(invoke).toHaveBeenCalledOnce();
  expect(events.map(event => event.msg.type)).toEqual(["effect_intent", "effect_result"]);
  expect(events[0]?.msg).toMatchObject({ payload: { recordedAt: "2026-10-08T20:00:00.000Z" } });
  expect(events[1]?.msg).toMatchObject({ payload: { recordedAt: "2026-10-08T20:00:00.037Z", outcome: "committed" } });
});

test("final effect journal preserves authoritative no-effect proof and marks unobserved errors unknown", async () => {
  const { session, events } = fixture();
  const tool = { name: "write", description: "", inputSchema: { type: "object" }, recoveryCategory: "side-effecting" as const, execute: vi.fn() };
  await withOneShotFastMode(() => runAdmittedToolCall({ session, turnId: "turn", callId: "refused", tool, args: {},
    invoke: async context => { context.crossEffectBoundary(); return { content: "invalid", isError: true,
      effectDisposition: confirmedNoEffectDisposition("fixture:refused", "input refused") }; } }));
  await expect(withOneShotFastMode(() => runAdmittedToolCall({ session, turnId: "turn", callId: "unknown", tool, args: {},
    invoke: async context => { context.crossEffectBoundary(); throw new Error("unknown"); } }))).rejects.toThrow("unknown");
  flushOneShotEffectJournal(session);
  expect(events[1]?.msg).toMatchObject({ type: "effect_result", payload: { outcome: "failed", effectBoundary: "crossed",
    noEffectEvidence: { evidenceRef: "fixture:refused" } } });
  expect(events[3]?.msg.type).toBe("effect_unknown_outcome");
});
