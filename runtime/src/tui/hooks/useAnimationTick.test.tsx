/**
 * Wave 2 useAnimationTick hook tests.
 *
 * The hook subscribes to ClockContext. When no provider is present it
 * returns the idle snapshot. When a provider is present it re-reads on
 * each clock tick. We mount a minimal stand-in ClockProvider-equivalent
 * via a direct context value rather than pulling the real
 * ClockProvider, since the real one uses focus-aware intervals that are
 * awkward to drive in a unit test.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import {
  ClockContext,
  createClock,
  type Clock,
} from "../ink/components/ClockContext.js";
import { updateLastInteractionTime } from "../ink/vendored/state.js";
import { useAnimationTick } from "./useAnimationTick.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(element: React.ReactElement): Promise<{
  unmount: () => void;
}> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 20));
  return {
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Fake clock driver for tests: we build a real Clock via `createClock()`
 * but keep a direct reference to it so we can force ticks by invoking
 * the subscribed callbacks ourselves. This keeps the timing deterministic
 * without pulling in Vitest fake timers, which react-reconciler is
 * unfriendly with.
 */
function createControllableClock(): {
  clock: Clock;
  tick: () => void;
} {
  // Use a very long tick interval so the internal setInterval never
  // fires during the test window; we drive `tick()` by calling the
  // subscribe callbacks ourselves.
  const real = createClock(1_000_000);
  const callbacks = new Set<() => void>();
  const originalSubscribe = real.subscribe;
  const clock: Clock = {
    ...real,
    subscribe(cb, keepAlive) {
      callbacks.add(cb);
      const unsub = originalSubscribe.call(real, cb, keepAlive);
      return () => {
        callbacks.delete(cb);
        unsub();
      };
    },
  };
  return {
    clock,
    tick: () => {
      for (const cb of Array.from(callbacks)) cb();
    },
  };
}

describe("useAnimationTick", () => {
  test("starts at tick 0 before any clock tick is delivered", async () => {
    // Mount without a user-provided controllable clock. The Ink root
    // provides its own ClockProvider but the tick interval is very long
    // by default (single-frame intervals), so within the brief test
    // window no tick should have happened yet.
    let firstSnapshot: ReturnType<typeof useAnimationTick> | null = null;
    function Consumer(): null {
      const snap = useAnimationTick();
      if (firstSnapshot === null) firstSnapshot = snap;
      return null;
    }
    const { unmount } = await mount(<Consumer />);
    expect(firstSnapshot).not.toBeNull();
    expect(firstSnapshot!.tick).toBe(0);
    unmount();
  });

  test("increments tick on each clock tick under an fps cap of zero", async () => {
    const { clock, tick } = createControllableClock();
    const ticks: number[] = [];
    function Consumer(): null {
      const snap = useAnimationTick(0);
      ticks.push(snap.tick);
      return null;
    }
    const { unmount } = await mount(
      <ClockContext.Provider value={clock}>
        <Consumer />
      </ClockContext.Provider>,
    );
    tick();
    await waitForCondition(() => Math.max(...ticks) >= 1);
    tick();
    await waitForCondition(() => Math.max(...ticks) >= 2);
    // After two ticks the consumer should have re-rendered with
    // monotonically increasing tick counts.
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(2);
    unmount();
  });

  test("flips isIdle to false once the clock delivers a tick", async () => {
    const { clock, tick } = createControllableClock();
    let latest: ReturnType<typeof useAnimationTick> | null = null;
    function Consumer(): null {
      latest = useAnimationTick(0);
      return null;
    }
    const { unmount } = await mount(
      <ClockContext.Provider value={clock}>
        <Consumer />
      </ClockContext.Provider>,
    );
    updateLastInteractionTime(true);
    tick();
    await waitForCondition(() => latest?.isIdle === false);
    expect(latest!.isIdle).toBe(false);
    unmount();
  });
});
