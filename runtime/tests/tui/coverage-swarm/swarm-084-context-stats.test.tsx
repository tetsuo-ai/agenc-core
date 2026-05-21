import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { saveCurrentProjectConfig } from "src/utils/config.js";
import { createRoot, Text } from "src/tui/ink.js";
import {
  createStatsStore,
  StatsProvider,
  useCounter,
  useGauge,
  useSet,
  useStats,
  useTimer,
  type StatsStore,
} from "src/tui/context/stats.js";

vi.mock("src/utils/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("src/utils/config.js")>();
  return {
    ...actual,
    saveCurrentProjectConfig: vi.fn(),
  };
});

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
} {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough();

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  Object.assign(stdout, {
    columns: 120,
    isTTY: true,
    rows: 24,
  });

  return { stdin, stdout };
}

async function sleep(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void): Promise<void> {
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < 1_000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep();
    }
  }

  throw lastError;
}

function OutsideStatsProbe(): React.ReactNode {
  useStats();
  return <Text>outside</Text>;
}

type HookSnapshot = {
  readonly stable: boolean | null;
  readonly tick: number;
};

function HookProbe({
  snapshots,
}: {
  readonly snapshots: HookSnapshot[];
}): React.ReactNode {
  const [tick, setTick] = React.useState(0);
  const count = useCounter("counter.metric");
  const gauge = useGauge("gauge.metric");
  const timer = useTimer("timer.metric");
  const addToSet = useSet("set.metric");
  const previous = React.useRef<{
    readonly addToSet: typeof addToSet;
    readonly count: typeof count;
    readonly gauge: typeof gauge;
    readonly timer: typeof timer;
  } | null>(null);

  React.useEffect(() => {
    snapshots.push({
      stable:
        previous.current === null
          ? null
          : previous.current.count === count &&
            previous.current.gauge === gauge &&
            previous.current.timer === timer &&
            previous.current.addToSet === addToSet,
      tick,
    });
    previous.current = { addToSet, count, gauge, timer };
    if (tick === 0) {
      setTick(1);
    }
  }, [addToSet, count, gauge, snapshots, tick, timer]);

  React.useEffect(() => {
    if (tick !== 1) return;
    count(2);
    gauge(7);
    timer(13);
    addToSet("agent");
  }, [addToSet, count, gauge, tick, timer]);

  return <Text>{String(tick)}</Text>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(saveCurrentProjectConfig).mockClear();
});

describe("stats context coverage swarm row 084", () => {
  test("keeps an unsampled overflow observation out of reservoir percentiles", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.999_999);
    const store = createStatsStore();

    for (let i = 0; i < 1_024; i += 1) {
      store.observe("latency", 100);
    }
    store.observe("latency", 1);

    expect(store.getAll()).toMatchObject({
      latency_avg: (1_024 * 100 + 1) / 1_025,
      latency_count: 1_025,
      latency_max: 100,
      latency_min: 1,
      latency_p50: 100,
      latency_p95: 100,
      latency_p99: 100,
    });
    expect(random).toHaveBeenCalledTimes(1);
  });

  test("uses an internal store, skips empty exit flushes, and removes the listener", async () => {
    const before = new Set(process.listeners("exit"));
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    let exitListener: NodeJS.ExitListener | undefined;
    try {
      root.render(
        <StatsProvider>
          <Text>empty</Text>
        </StatsProvider>,
      );

      await waitFor(() => {
        exitListener = process
          .listeners("exit")
          .find((listener) => !before.has(listener)) as
          | NodeJS.ExitListener
          | undefined;
        expect(exitListener).toBeDefined();
      });

      exitListener?.(0);
      expect(saveCurrentProjectConfig).not.toHaveBeenCalled();

      root.unmount();
      await waitFor(() => {
        expect(process.listeners("exit")).not.toContain(exitListener);
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  test("memoizes metric hook callbacks across rerenders and delegates updates", async () => {
    const store: StatsStore = {
      add: vi.fn(),
      getAll: vi.fn(() => ({})),
      increment: vi.fn(),
      observe: vi.fn(),
      set: vi.fn(),
    };
    const snapshots: HookSnapshot[] = [];
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <StatsProvider store={store}>
          <HookProbe snapshots={snapshots} />
        </StatsProvider>,
      );

      await waitFor(() => {
        expect(snapshots).toContainEqual({ stable: true, tick: 1 });
      });

      expect(store.increment).toHaveBeenCalledWith("counter.metric", 2);
      expect(store.set).toHaveBeenCalledWith("gauge.metric", 7);
      expect(store.observe).toHaveBeenCalledWith("timer.metric", 13);
      expect(store.add).toHaveBeenCalledWith("set.metric", "agent");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  test("reports missing provider usage through the renderer error path", async () => {
    const { stdin, stdout } = createStreams();
    const stderr = new PassThrough();
    let stderrOutput = "";
    stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });
    const root = await createRoot({
      patchConsole: false,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(<OutsideStatsProbe />);
      await waitFor(() => {
        expect(stderrOutput).toContain(
          "useStats must be used within a StatsProvider",
        );
      });
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      stderr.end();
    }
  });
});
