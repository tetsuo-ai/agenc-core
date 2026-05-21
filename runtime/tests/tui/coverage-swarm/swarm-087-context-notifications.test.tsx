import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { Notification } from "src/tui/context/notifications.js";

type RuntimeState = {
  notifications: {
    current: Notification | null;
    queue: Notification[];
  };
};

const harness = vi.hoisted(() => {
  type MutableRuntimeState = {
    notifications: {
      current: unknown | null;
      queue: unknown[];
    };
  };

  const state = (notifications: MutableRuntimeState["notifications"]) => ({
    notifications,
  });

  const h = {
    logError: vi.fn(),
    setAppState: undefined as unknown as ReturnType<typeof vi.fn>,
    state: state({ current: null, queue: [] }),
    store: undefined as unknown as { getState: ReturnType<typeof vi.fn> },
    reset(notifications: MutableRuntimeState["notifications"] = {
      current: null,
      queue: [],
    }) {
      h.state = state(notifications);
      h.logError.mockClear();
      h.setAppState.mockClear();
      h.store.getState.mockClear();
    },
  };

  h.setAppState = vi.fn(
    (updater: (prev: MutableRuntimeState) => MutableRuntimeState) => {
      const previous = h.state;
      const next = updater(previous);
      if (!Object.is(next, previous)) {
        h.state = next;
      }
    },
  );
  h.store = {
    getState: vi.fn(() => h.state),
  };

  return h;
});

vi.mock("src/tui/state/AppState.js", () => ({
  useAppStateStore: () => harness.store,
  useSetAppState: () => harness.setAppState,
}));

vi.mock("src/utils/log.js", () => ({
  logError: harness.logError,
}));

import { createRoot } from "src/tui/ink/root.js";
import { getNext, useNotifications } from "src/tui/context/notifications.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type NotificationApi = ReturnType<typeof useNotifications>;

function createStreams(): {
  stdin: TestStdin;
  stdout: PassThrough;
} {
  const stdin = new PassThrough() as TestStdin;
  const stdout = new PassThrough();

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  Object.assign(stdout, {
    columns: 120,
    rows: 24,
    isTTY: true,
  });
  stdout.resume();

  return { stdin, stdout };
}

function notification(
  key: string,
  text: string,
  overrides: Partial<Notification> = {},
): Notification {
  return {
    key,
    text,
    priority: "medium",
    timeoutMs: 1_000,
    ...overrides,
  } as Notification;
}

function snapshot() {
  return {
    current: harness.state.notifications.current?.key ?? null,
    queue: harness.state.notifications.queue.map(
      notification => notification.key,
    ),
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 1_000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

async function renderNotificationsHarness(
  notifications: RuntimeState["notifications"] = { current: null, queue: [] },
): Promise<{
  api: () => NotificationApi;
  dispose: () => Promise<void>;
}> {
  harness.reset(notifications);

  let api: NotificationApi | undefined;
  const { stdin, stdout } = createStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  function Probe(): React.ReactNode {
    api = useNotifications();
    return null;
  }

  root.render(<Probe />);
  await waitFor(() => {
    expect(api).toBeDefined();
  });

  return {
    api: () => {
      if (!api) throw new Error("notifications hook did not render");
      return api;
    },
    dispose: async () => {
      if (api) {
        for (let i = 0; i < 20; i += 1) {
          const { current, queue } = harness.state.notifications;
          if (!current && queue.length === 0) break;
          if (current) {
            api.removeNotification(current.key);
            continue;
          }
          for (const queued of queue) {
            api.removeNotification(queued.key);
          }
        }
      }

      root.unmount();
      stdin.end();
      stdout.end();
      await Promise.resolve();
    },
  };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  harness.reset();
});

describe("notification context coverage swarm row 087", () => {
  test("processes an initial queue on mount and preserves equal-priority order", async () => {
    const medium = notification("medium", "Medium");
    const high = notification("high", "High", { priority: "high" });
    const peer = notification("peer", "Peer");

    expect(getNext([medium, peer])).toBe(medium);

    const rendered = await renderNotificationsHarness({
      current: null,
      queue: [medium, high, peer],
    });

    try {
      await waitFor(() => {
        expect(snapshot()).toEqual({
          current: "high",
          queue: ["medium", "peer"],
        });
      });
    } finally {
      await rendered.dispose();
    }
  });

  test("ignores stale normal-notification timeout callbacks", async () => {
    const rendered = await renderNotificationsHarness();
    vi.useFakeTimers();

    try {
      rendered
        .api()
        .addNotification(notification("stale", "Stale", { timeoutMs: 25 }));
      expect(snapshot()).toEqual({ current: "stale", queue: [] });

      harness.state = {
        notifications: {
          current: notification("newer", "Newer"),
          queue: [],
        },
      };

      await vi.advanceTimersByTimeAsync(25);
      expect(snapshot()).toEqual({ current: "newer", queue: [] });
    } finally {
      await rendered.dispose();
    }
  });

  test("drops superseded immediate notifications and ignores stale immediate timers", async () => {
    const rendered = await renderNotificationsHarness({
      current: notification("old-immediate", "Old", {
        priority: "immediate",
      }),
      queue: [
        notification("drop", "Drop"),
        notification("keep", "Keep", { priority: "low" }),
      ],
    });
    vi.useFakeTimers();

    try {
      rendered.api().addNotification(
        notification("now", "Now", {
          invalidates: ["drop"],
          priority: "immediate",
          timeoutMs: 25,
        }),
      );

      expect(snapshot()).toEqual({ current: "now", queue: ["keep"] });

      harness.state = {
        notifications: {
          current: notification("manual", "Manual"),
          queue: harness.state.notifications.queue,
        },
      };

      await vi.advanceTimersByTimeAsync(25);
      expect(snapshot()).toEqual({ current: "manual", queue: ["keep"] });

      rendered.api().removeNotification("keep");
      expect(snapshot()).toEqual({ current: "manual", queue: [] });
    } finally {
      await rendered.dispose();
    }
  });

  test("logs fold failures and leaves the active notification intact", async () => {
    const rendered = await renderNotificationsHarness();

    try {
      rendered.api().addNotification(notification("fold", "First"));
      const before = harness.state;
      const foldError = new Error("fold failed");

      rendered.api().addNotification(
        notification("fold", "Second", {
          fold: () => {
            throw foldError;
          },
        }),
      );

      expect(harness.logError).toHaveBeenCalledWith(foldError);
      expect(harness.state).toBe(before);
      expect(snapshot()).toEqual({ current: "fold", queue: [] });
    } finally {
      await rendered.dispose();
    }
  });
});
