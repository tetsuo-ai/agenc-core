import { describe, expect, test, vi } from "vitest";

import { watchCompletionPipelineEventLog } from "../../src/tui/completion-pipeline-watcher.js";

type WatchRecord = {
  readonly close: ReturnType<typeof vi.fn>;
  readonly emit: (
    eventType: "change" | "rename",
    filename: string | Buffer | null,
  ) => void;
  readonly emitError: () => void;
};

type TimerRecord = {
  readonly callback: () => void;
  readonly delay: number;
  readonly token: ReturnType<typeof setTimeout>;
  readonly unref: ReturnType<typeof vi.fn>;
  cancelled: boolean;
};

function createWatcherHarness(
  options: { readonly initialWatchFailures?: number } = {},
) {
  const watchers: WatchRecord[] = [];
  const timers: TimerRecord[] = [];
  let watchFailuresRemaining = options.initialWatchFailures ?? 0;
  let nextTimerId = 1;

  const watchDirectory = vi.fn(
    (
      _directoryPath: string,
      _watchOptions: { readonly persistent: false },
      listener: (
        eventType: "change" | "rename",
        filename: string | Buffer | null,
      ) => void,
    ) => {
      if (watchFailuresRemaining > 0) {
        watchFailuresRemaining -= 1;
        throw new Error("watch unavailable");
      }
      let errorListener: (() => void) | undefined;
      const close = vi.fn();
      const watcher = {
        close,
        on: vi.fn((eventName: string, callback: () => void) => {
          if (eventName === "error") errorListener = callback;
          return watcher;
        }),
      };
      watchers.push({
        close,
        emit: listener,
        emitError: () => errorListener?.(),
      });
      return watcher;
    },
  );

  const scheduleTimeout = vi.fn((callback: () => void, delay: number) => {
    const unref = vi.fn();
    const token = { id: nextTimerId, unref } as unknown as ReturnType<
      typeof setTimeout
    >;
    nextTimerId += 1;
    timers.push({ callback, delay, token, unref, cancelled: false });
    return token;
  });
  const cancelTimeout = vi.fn((token: ReturnType<typeof setTimeout>) => {
    const timer = timers.find((candidate) => candidate.token === token);
    if (timer) timer.cancelled = true;
  });
  const pendingTimers = () => timers.filter((timer) => !timer.cancelled);

  return {
    watchers,
    watchDirectory,
    scheduleTimeout,
    cancelTimeout,
    pendingTimers,
  };
}

describe("completion pipeline event-log watcher", () => {
  test("filters directory events and reattaches after target renames and errors", () => {
    const harness = createWatcherHarness();
    const refresh = vi.fn(() => false);
    const dispose = watchCompletionPipelineEventLog({
      eventLogPath: "/tmp/agenc-completion/events.jsonl",
      refresh,
      watchDirectory: harness.watchDirectory as never,
      scheduleTimeout: harness.scheduleTimeout as never,
      cancelTimeout: harness.cancelTimeout,
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(harness.watchDirectory).toHaveBeenCalledWith(
      "/tmp/agenc-completion",
      { persistent: false },
      expect.any(Function),
    );
    expect(harness.pendingTimers().map(({ delay }) => delay)).toEqual([1_000]);
    expect(harness.pendingTimers()[0]?.unref).toHaveBeenCalledTimes(1);

    harness.watchers[0]?.emit("change", "other.jsonl");
    expect(refresh).toHaveBeenCalledTimes(1);

    harness.watchers[0]?.emit("rename", Buffer.from("events.jsonl"));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(harness.watchers[0]?.close).toHaveBeenCalledTimes(1);
    expect(harness.watchers).toHaveLength(2);
    expect(harness.pendingTimers()).toHaveLength(1);

    harness.watchers[1]?.emitError();
    expect(harness.watchers[1]?.close).toHaveBeenCalledTimes(1);
    expect(harness.watchers).toHaveLength(3);
    expect(harness.pendingTimers()).toHaveLength(1);

    dispose();
    expect(harness.watchers[2]?.close).toHaveBeenCalledTimes(1);
    expect(harness.pendingTimers()).toHaveLength(0);
  });

  test("polls after missed events and retries a watcher missing at startup", () => {
    const harness = createWatcherHarness({ initialWatchFailures: 1 });
    const refresh = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const dispose = watchCompletionPipelineEventLog({
      eventLogPath: "/missing-at-start/events.jsonl",
      refresh,
      watchDirectory: harness.watchDirectory as never,
      scheduleTimeout: harness.scheduleTimeout as never,
      cancelTimeout: harness.cancelTimeout,
    });

    expect(harness.watchers).toHaveLength(0);
    expect(harness.watchDirectory).toHaveBeenCalledTimes(1);
    expect(harness.pendingTimers().map(({ delay }) => delay)).toEqual([1_000]);

    const idlePoll = harness.pendingTimers()[0];
    expect(idlePoll).toBeDefined();
    idlePoll!.cancelled = true;
    idlePoll!.callback();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(harness.watchDirectory).toHaveBeenCalledTimes(2);
    expect(harness.watchers).toHaveLength(1);
    expect(harness.pendingTimers().map(({ delay }) => delay)).toEqual([250]);
    expect(harness.pendingTimers()[0]?.unref).toHaveBeenCalledTimes(1);

    dispose();
  });

  test("leaves no watcher or timer behind when the component remounts", () => {
    const harness = createWatcherHarness();
    const firstRefresh = vi.fn(() => false);
    const firstDispose = watchCompletionPipelineEventLog({
      eventLogPath: "/tmp/remount/events.jsonl",
      refresh: firstRefresh,
      watchDirectory: harness.watchDirectory as never,
      scheduleTimeout: harness.scheduleTimeout as never,
      cancelTimeout: harness.cancelTimeout,
    });

    firstDispose();
    firstDispose();
    harness.watchers[0]?.emit("change", "events.jsonl");
    expect(firstRefresh).toHaveBeenCalledTimes(1);
    expect(harness.pendingTimers()).toHaveLength(0);

    const secondRefresh = vi.fn(() => false);
    const secondDispose = watchCompletionPipelineEventLog({
      eventLogPath: "/tmp/remount/events.jsonl",
      refresh: secondRefresh,
      watchDirectory: harness.watchDirectory as never,
      scheduleTimeout: harness.scheduleTimeout as never,
      cancelTimeout: harness.cancelTimeout,
    });

    expect(harness.watchers).toHaveLength(2);
    expect(harness.watchers[0]?.close).toHaveBeenCalledTimes(1);
    expect(harness.pendingTimers()).toHaveLength(1);

    secondDispose();
    expect(harness.watchers[1]?.close).toHaveBeenCalledTimes(1);
    expect(harness.pendingTimers()).toHaveLength(0);
  });
});
