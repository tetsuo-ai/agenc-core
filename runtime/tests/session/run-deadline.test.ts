import { afterEach, describe, expect, test } from "vitest";

import { classifyCLI } from "../../src/bin/route.js";
import { readRunDeadlineFlags } from "../../src/bin/startup-selection.js";
import type { LLMMessage } from "../../src/llm/types.js";
import {
  DeadlineFlagError,
  RunDeadlineReachedError,
  armRunDeadline,
  inDeadlineReserve,
  isDeadlineAbort,
  parseDeadlineFlag,
  parseDeadlineReserveFlag,
  projectToolResultTimeRemaining,
  resolveDeadlineReserveMs,
  setRunDeadlineClockForTests,
  stampToolResultRemaining,
} from "../../src/session/run-deadline.js";
import {
  AgentRuntimeOptionsError,
  resolveAgentRuntimeOptions,
  validateAgentRuntimeOptions,
} from "../../src/session/runtime-options.js";
import { createFakeRunDeadlineClock } from "../helpers/fake-run-deadline-clock.js";

/** Run deadline inputs and helpers (#2503). */

afterEach(() => {
  setRunDeadlineClockForTests(null);
});

const MINUTE = 60_000;

function deadlineSession(at: number, reserveMs: number) {
  return { services: { runtimeOptions: { deadlineAt: at, deadlineReserveMs: reserveMs } } };
}

describe("--deadline and --deadline-reserve values", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");

  test("accepts +seconds and ISO 8601 instants with a zone", () => {
    expect(parseDeadlineFlag("+120", now)).toBe(now + 120_000);
    expect(parseDeadlineFlag("+1.5", now)).toBe(now + 1_500);
    expect(parseDeadlineFlag("+90s", now)).toBe(now + 90_000);
    expect(parseDeadlineFlag("2026-09-15T20:00:00Z", now)).toBe(now + 8 * 60 * MINUTE);
    // Offsets are honoured: 14:00+02:00 is 12:00Z.
    expect(parseDeadlineFlag("2026-09-15T14:00:00+02:00", now - 1)).toBe(now);
  });

  test("refuses zone-less, malformed, and past values", () => {
    for (const bad of ["tomorrow", "120", "2026-09-15T20:00:00", "+", "+-5"]) {
      expect(() => parseDeadlineFlag(bad, now), bad).toThrow(DeadlineFlagError);
    }
    expect(() => parseDeadlineFlag("+0", now)).toThrow(/not in the future/);
    expect(() => parseDeadlineFlag("2026-09-15T11:00:00Z", now)).toThrow(/not in the future/);
  });

  test("reserve flag is a positive number of seconds", () => {
    expect(parseDeadlineReserveFlag("90")).toBe(90_000);
    expect(parseDeadlineReserveFlag("30s")).toBe(30_000);
    expect(() => parseDeadlineReserveFlag("0")).toThrow(DeadlineFlagError);
    expect(() => parseDeadlineReserveFlag("soon")).toThrow(DeadlineFlagError);
  });

  test("the default reserve is 10 % of the budget, clamped to 5-30 min, at most half", () => {
    expect(resolveDeadlineReserveMs(8 * 60 * MINUTE)).toBe(30 * MINUTE);
    expect(resolveDeadlineReserveMs(60 * MINUTE)).toBe(6 * MINUTE);
    expect(resolveDeadlineReserveMs(20 * MINUTE)).toBe(5 * MINUTE);
    expect(resolveDeadlineReserveMs(2 * MINUTE)).toBe(MINUTE);
    expect(resolveDeadlineReserveMs(60 * MINUTE, 90_000)).toBe(90_000);
    expect(resolveDeadlineReserveMs(60 * MINUTE, 10 * 60 * MINUTE)).toBe(30 * MINUTE);
  });

  test("print mode resolves both flags once into runtime options", () => {
    expect(readRunDeadlineFlags(["node", "agenc", "-p", "--deadline", "+600", "work"], now))
      .toEqual({ deadlineAt: now + 10 * MINUTE, deadlineReserveMs: 5 * MINUTE });
    expect(readRunDeadlineFlags(
      ["node", "agenc", "-p", "--deadline=+600", "--deadline-reserve", "120", "work"],
      now,
    )).toEqual({ deadlineAt: now + 10 * MINUTE, deadlineReserveMs: 2 * MINUTE });
    expect(readRunDeadlineFlags(["node", "agenc", "-p", "work"], now)).toEqual({});
  });
});

describe("routing", () => {
  const route = (args: readonly string[], isTTY = true) =>
    classifyCLI({ argv: ["node", "agenc", ...args], isTTY, isStdoutTTY: isTTY });

  test("print mode accepts a deadline and keeps it out of the prompt", () => {
    const plan = route(["-p", "--deadline", "+600", "--deadline-reserve", "60", "fix the bug"]);
    expect(plan).toMatchObject({ kind: "oneShotCLI", userMessage: "fix the bug" });
  });

  test("an interactive session refuses a deadline", () => {
    expect(route(["--deadline", "+600"])).toMatchObject({
      kind: "errorAndExit",
      exitCode: 2,
      message: expect.stringContaining("applies to print mode"),
    });
  });

  test("malformed values and a reserve without a deadline are usage errors", () => {
    expect(route(["-p", "--deadline", "later", "x"])).toMatchObject({
      kind: "errorAndExit",
      exitCode: 2,
      message: expect.stringContaining("+<seconds> or an ISO 8601 instant"),
    });
    expect(route(["-p", "--deadline"])).toMatchObject({ kind: "errorAndExit", exitCode: 2 });
    expect(route(["-p", "--deadline-reserve", "60", "x"])).toMatchObject({
      kind: "errorAndExit",
      message: "agenc --deadline-reserve requires --deadline",
    });
  });
});

describe("runtime options carry the deadline", () => {
  const base = resolveAgentRuntimeOptions({});

  test("validated on the daemon wire", () => {
    const wire = { ...base, deadlineAt: 1_900_000_000_000, deadlineReserveMs: 300_000 };
    expect(validateAgentRuntimeOptions(wire)).toMatchObject({
      deadlineAt: 1_900_000_000_000,
      deadlineReserveMs: 300_000,
    });
    expect(validateAgentRuntimeOptions({ ...base })).not.toHaveProperty("deadlineAt");
    expect(() => validateAgentRuntimeOptions({ ...base, deadlineAt: 1.5 }))
      .toThrow(AgentRuntimeOptionsError);
    expect(() => validateAgentRuntimeOptions({ ...base, deadlineAt: "soon" }))
      .toThrow(AgentRuntimeOptionsError);
    expect(() => validateAgentRuntimeOptions({ ...base, deadlineReserveMs: 5_000 }))
      .toThrow(/requires runtimeOptions.deadlineAt/);
  });
});

describe("deadline clock, abort, and tool-result stamps", () => {
  test("the reserve begins when the remaining time reaches it", () => {
    const clock = createFakeRunDeadlineClock();
    setRunDeadlineClockForTests(clock);
    const session = deadlineSession(clock.now() + 10 * MINUTE, 2 * MINUTE);
    expect(inDeadlineReserve(session)).toBe(false);
    clock.advance(8 * MINUTE - 1);
    expect(inDeadlineReserve(session)).toBe(false);
    clock.advance(1);
    expect(inDeadlineReserve(session)).toBe(true);
    expect(inDeadlineReserve({ services: { runtimeOptions: {} } })).toBe(false);
  });

  test("armRunDeadline aborts with the deadline reason and can be disposed", () => {
    const clock = createFakeRunDeadlineClock();
    setRunDeadlineClockForTests(clock);
    const controller = new AbortController();
    armRunDeadline(deadlineSession(clock.now() + MINUTE, 1), controller);
    clock.advance(MINUTE - 1);
    expect(controller.signal.aborted).toBe(false);
    clock.advance(1);
    expect(controller.signal.reason).toBeInstanceOf(RunDeadlineReachedError);
    expect(isDeadlineAbort(controller.signal)).toBe(true);

    const disposed = new AbortController();
    const dispose = armRunDeadline(deadlineSession(clock.now() + MINUTE, 1), disposed);
    dispose();
    clock.advance(2 * MINUTE);
    expect(disposed.signal.aborted).toBe(false);

    const past = new AbortController();
    armRunDeadline(deadlineSession(clock.now() - 1, 1), past);
    expect(isDeadlineAbort(past.signal)).toBe(true);
  });

  test("the client backstop's string reason counts; an ordinary interrupt does not", () => {
    const backstop = new AbortController();
    backstop.abort("deadline_reached");
    expect(isDeadlineAbort(backstop.signal)).toBe(true);
    const interrupt = new AbortController();
    interrupt.abort("interrupted");
    expect(isDeadlineAbort(interrupt.signal)).toBe(false);
    expect(isDeadlineAbort(new AbortController().signal)).toBe(false);
  });

  test("tool results carry the stamp in the projection only", () => {
    const clock = createFakeRunDeadlineClock();
    setRunDeadlineClockForTests(clock);
    const session = deadlineSession(clock.now() + 10 * MINUTE, MINUTE);
    stampToolResultRemaining(session, "call-string");
    clock.advance(MINUTE);
    stampToolResultRemaining(session, "call-parts");
    const durable: LLMMessage[] = [
      { role: "user", content: "go" },
      { role: "tool", toolCallId: "call-string", content: "ok" },
      { role: "tool", toolCallId: "call-parts", content: [{ type: "text", text: "ok" }] },
      { role: "tool", toolCallId: "call-unstamped", content: "ok" },
    ];
    const snapshot = JSON.stringify(durable);

    const projected = projectToolResultTimeRemaining(durable, session);

    expect(projected[1]?.content).toBe("ok\n\n[time_remaining_sec=600]");
    expect(projected[2]?.content).toEqual([
      { type: "text", text: "ok" },
      { type: "text", text: "[time_remaining_sec=540]" },
    ]);
    expect(projected[3]).toBe(durable[3]);
    expect(JSON.stringify(durable)).toBe(snapshot);
    // The stamp is fixed: a later projection renders the same bytes.
    clock.advance(MINUTE);
    expect(projectToolResultTimeRemaining(durable, session)).toEqual(projected);
  });
});
