import { describe, expect, test, vi } from "vitest";

import {
  AUTONOMOUS_SUBMIT_SOURCE,
  AUTONOMOUS_TICK_TAG,
  AutonomousKeepaliveScheduler,
  createAutonomousTickMessage,
  isAutonomousModeEnabled,
} from "./autonomous-mode.js";

describe("autonomous mode helpers", () => {
  test("requires explicit autonomous mode and suppresses plan mode", () => {
    expect(
      isAutonomousModeEnabled({
        enabled: true,
        permissionContext: "bypassPermissions",
      }),
    ).toBe(true);
    expect(
      isAutonomousModeEnabled({
        enabled: false,
        permissionContext: "bypassPermissions",
      }),
    ).toBe(false);
    expect(
      isAutonomousModeEnabled({ enabled: true, permissionContext: "plan" }),
    ).toBe(false);
    expect(
      isAutonomousModeEnabled({ enabled: true, permissionContext: null }),
    ).toBe(true);
  });

  test("creates tick prompts with the expected XML tag", () => {
    const tick = createAutonomousTickMessage(new Date("2026-04-27T12:00:00Z"));
    expect(tick.startsWith(`<${AUTONOMOUS_TICK_TAG}>`)).toBe(true);
    expect(tick.endsWith(`</${AUTONOMOUS_TICK_TAG}>`)).toBe(true);
  });

  test("scheduler submits a tick only while active", async () => {
    const callbacks: Array<() => void> = [];
    const submitTick = vi.fn(async (_message: string) => {});
    const scheduler = new AutonomousKeepaliveScheduler({
      isActive: () => true,
      submitTick,
      now: () => new Date("2026-04-27T12:00:00Z"),
      setTimeoutFn: ((callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length as never;
      }) as never,
      clearTimeoutFn: vi.fn() as never,
    });

    scheduler.scheduleNext();
    expect(scheduler.isScheduled()).toBe(true);
    callbacks[0]?.();
    await Promise.resolve();

    expect(submitTick).toHaveBeenCalledTimes(1);
    expect(submitTick.mock.calls[0]?.[0]).toContain(
      `<${AUTONOMOUS_TICK_TAG}>`,
    );
  });

  test("scheduler does not submit when mode is inactive at fire time", async () => {
    const callbacks: Array<() => void> = [];
    const submitTick = vi.fn(async (_message: string) => {});
    let active = true;
    const scheduler = new AutonomousKeepaliveScheduler({
      isActive: () => active,
      submitTick,
      setTimeoutFn: ((callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length as never;
      }) as never,
      clearTimeoutFn: vi.fn() as never,
    });

    scheduler.scheduleNext();
    active = false;
    callbacks[0]?.();
    await Promise.resolve();

    expect(submitTick).not.toHaveBeenCalled();
  });

  test("scheduler blocks ticks while context is blocked", async () => {
    const callbacks: Array<() => void> = [];
    const clearTimeoutFn = vi.fn();
    const submitTick = vi.fn(async (_message: string) => {});
    const scheduler = new AutonomousKeepaliveScheduler({
      isActive: () => true,
      submitTick,
      setTimeoutFn: ((callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length as never;
      }) as never,
      clearTimeoutFn: clearTimeoutFn as never,
    });

    scheduler.scheduleNext();
    scheduler.setContextBlocked(true);
    expect(scheduler.isActive()).toBe(false);
    expect(scheduler.isScheduled()).toBe(false);
    expect(clearTimeoutFn).toHaveBeenCalledTimes(1);

    scheduler.scheduleNext();
    expect(callbacks).toHaveLength(1);

    scheduler.setContextBlocked(false);
    scheduler.scheduleNext();
    expect(callbacks).toHaveLength(2);
  });

  test("scheduler uses the autonomous submit source", () => {
    expect(AUTONOMOUS_SUBMIT_SOURCE).toBe("autonomous_tick");
  });
});
