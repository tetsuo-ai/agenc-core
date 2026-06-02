import { afterEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "src/session/event-log";
import type { Session } from "src/session/session";
import { reconnectWithBackoff } from "src/recovery/reconnection";

function mkSession(log: EventLog): Session {
  let i = 0;
  return {
    eventLog: log,
    nextInternalSubId: () => `s-${++i}`,
  } as unknown as Session;
}

/**
 * Wrap a real AbortSignal so we can count how many live "abort" listeners
 * remain attached. `sleep()` is private, so we exercise it via the public
 * reconnectWithBackoff, which calls sleep(delay, opts.signal) once per
 * transient retry — exactly the reconnect-storm path the finding describes.
 */
function trackedSignal(): {
  readonly signal: AbortSignal;
  abortListenerCount: () => number;
} {
  const inner = new AbortController().signal;
  let count = 0;
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "addEventListener") {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          opts?: AddEventListenerOptions | boolean,
        ) => {
          if (type === "abort") count += 1;
          return target.addEventListener(
            type,
            listener,
            opts as AddEventListenerOptions,
          );
        };
      }
      if (prop === "removeEventListener") {
        return (
          type: string,
          listener: EventListenerOrEventListenerObject,
          opts?: EventListenerOptions | boolean,
        ) => {
          if (type === "abort") count -= 1;
          return target.removeEventListener(
            type,
            listener,
            opts as EventListenerOptions,
          );
        };
      }
      // Read accessors (e.g. `aborted`, `reason`) and methods against the real
      // target — native AbortSignal getters touch internal slots and throw if
      // invoked with the proxy as receiver.
      void receiver;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    signal: proxy as AbortSignal,
    abortListenerCount: () => count,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("gaphunt3 #45: sleep() detaches its abort listener on the normal timeout path", () => {
  it("leaves zero abort listeners on the signal after a reconnect storm", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const log = new EventLog();
    const session = mkSession(log);
    const { signal, abortListenerCount } = trackedSignal();

    let calls = 0;
    const promise = reconnectWithBackoff<string>({
      session,
      signal,
      // Bound the storm: 4 attempts => 3 transient retries => 3 sleeps, each
      // registering one abort listener on the long-lived turn signal.
      maxAttempts: 4,
      attempt: async () => {
        calls += 1;
        if (calls < 4) throw new Error("ECONNRESET");
        return "recovered";
      },
      isTransient: () => true,
    });

    // Drain each backoff sleep so every sleep() resolves via its timer (the
    // normal, non-aborted path — the path the leak lives on).
    await vi.runAllTimersAsync();

    const out = await promise;
    expect(out.kind).toBe("ok");
    expect(calls).toBe(4);

    // Three sleeps happened, each on the SAME signal. With the fix each sleep
    // removes its onAbort listener when the timer fires, so the net live
    // listener count is 0. Before the fix `{ once: true }` never auto-removes
    // on the timeout path, leaving one dead closure per sleep (count === 3).
    expect(abortListenerCount()).toBe(0);
  });

  it("removes the listener even for a single normal sleep", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const log = new EventLog();
    const session = mkSession(log);
    const { signal, abortListenerCount } = trackedSignal();

    let calls = 0;
    const promise = reconnectWithBackoff<string>({
      session,
      signal,
      maxAttempts: 2,
      attempt: async () => {
        calls += 1;
        if (calls < 2) throw new Error("stream_idle");
        return "ok";
      },
      isTransient: () => true,
    });

    await vi.runAllTimersAsync();
    const out = await promise;
    expect(out.kind).toBe("ok");

    // Exactly one sleep on the signal; after its timer fires the listener must
    // be gone. Before the fix it stays attached (count === 1).
    expect(abortListenerCount()).toBe(0);
  });
});
