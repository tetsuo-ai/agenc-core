import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import Text from "../ink/components/Text.js";
import { createRoot } from "../ink/root.js";
import {
  AppStateProvider,
  getDefaultAppState,
  useAppState,
  useAppStateStore,
  type AppState,
} from "../state/AppState.js";
import {
  getNext,
  type Notification,
  useNotifications,
} from "./notifications.js";

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));
vi.mock("../context/mailbox.js", () => ({
  MailboxProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../hooks/useEffectEventCompat.js", () => ({
  useEffectEventCompat: (callback: unknown) => callback,
}));
vi.mock("../hooks/useSettingsChange.js", () => ({
  useSettingsChange: () => {},
}));
vi.mock("../../bootstrap/state.js", () => ({
  flushInteractionTime: () => {},
  getActiveTimeCounter: () => ({ activeMs: 0, totalMs: 0 }),
  getIsNonInteractiveSession: () => false,
  markScrollActivity: () => {},
  updateLastInteractionTime: () => {},
}));
vi.mock("../../services/PromptSuggestion/promptSuggestion.js", () => ({
  shouldEnablePromptSuggestion: () => false,
}));
vi.mock("../../tools/Tool.js", () => ({
  buildTool: (tool: unknown) => tool,
  getEmptyToolPermissionContext: () => ({
    mode: "default",
    additionalDirectories: [],
    alwaysAllowRules: [],
    alwaysDenyRules: [],
    isBypassPermissionsModeAvailable: false,
  }),
}));
vi.mock("../../utils/agentSwarmsEnabled.js", () => ({
  isAgentSwarmsEnabled: () => false,
}));
vi.mock("../../utils/commitAttribution.js", () => ({
  createEmptyAttributionState: () => ({}),
}));
vi.mock("../../utils/debug.js", () => ({
  logForDebugging: () => {},
}));
vi.mock("../../utils/log.js", () => ({
  logError: () => {},
}));
vi.mock("../../utils/permissions/permissionSetup.js", () => ({
  createDisabledBypassPermissionsContext: (context: unknown) => context,
  isBypassPermissionsModeDisabled: () => false,
}));
vi.mock("../../utils/settings/applySettingsChange.js", () => ({
  applySettingsChange: () => {},
}));
vi.mock("../../utils/settings/settings.js", () => ({
  getInitialSettings: () => ({}),
}));
vi.mock("../../utils/teammate.js", () => ({
  isPlanModeRequired: () => false,
  isTeammate: () => false,
}));
vi.mock("../../utils/thinking.js", () => ({
  shouldEnableThinkingByDefault: () => false,
}));

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type NotificationApi = ReturnType<typeof useNotifications>;

type NotificationSnapshot = {
  current: string | null;
  currentText: string | null;
  queue: string[];
  queueTexts: Array<string | null>;
};

function createTestStreams(): {
  stdout: PassThrough;
  stdin: TestStdin;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number }).columns = 120;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  stdout.resume();

  return { stdout, stdin };
}

function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for notifications context state"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function notificationText(
  notification: Notification | null | undefined,
): string | null {
  if (!notification) return null;
  if ("text" in notification) return notification.text;
  return "jsx";
}

function snapshotNotifications(
  notifications: AppState["notifications"],
): NotificationSnapshot {
  return {
    current: notifications.current?.key ?? null,
    currentText: notificationText(notifications.current),
    queue: notifications.queue.map((notification) => notification.key),
    queueTexts: notifications.queue.map(notificationText),
  };
}

function textNotification(
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

function appendText(
  accumulator: Notification,
  incoming: Notification,
): Notification {
  return {
    ...incoming,
    text: `${notificationText(accumulator) ?? ""}${notificationText(incoming) ?? ""}`,
  } as Notification;
}

function createInitialState(
  notifications: AppState["notifications"] = { current: null, queue: [] },
): AppState {
  return {
    ...getDefaultAppState(),
    notifications,
  };
}

async function renderNotificationsHarness(
  initialState = createInitialState(),
): Promise<{
  api: () => NotificationApi;
  dispose: () => Promise<void>;
  snapshots: NotificationSnapshot[];
  state: () => AppState["notifications"];
}> {
  let api: NotificationApi | undefined;
  let store: ReturnType<typeof useAppStateStore> | undefined;
  const snapshots: NotificationSnapshot[] = [];
  const { stdout, stdin } = createTestStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  function Probe(): React.ReactNode {
    api = useNotifications();
    store = useAppStateStore();
    const notifications = useAppState((state) => state.notifications);

    React.useEffect(() => {
      snapshots.push(snapshotNotifications(notifications));
    }, [notifications]);

    return <Text>notifications</Text>;
  }

  root.render(
    <AppStateProvider initialState={initialState}>
      <Probe />
    </AppStateProvider>,
  );

  await waitForCondition(() => api !== undefined && store !== undefined);

  return {
    api: () => {
      if (!api) throw new Error("notifications hook did not render");
      return api;
    },
    dispose: async () => {
      if (api && store) {
        for (let i = 0; i < 20; i += 1) {
          const { current, queue } = store.getState().notifications;
          if (!current && queue.length === 0) break;
          if (current) {
            api.removeNotification(current.key);
          } else {
            for (const notification of queue) {
              api.removeNotification(notification.key);
            }
          }
        }
      }
      root.unmount();
      stdin.end();
      stdout.end();
      await Promise.resolve();
    },
    snapshots,
    state: () => {
      if (!store) throw new Error("app state store did not render");
      return store.getState().notifications;
    },
  };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("notification context", () => {
  test("starts with provider defaults and ranks queued notifications by priority", async () => {
    const defaultState = getDefaultAppState();
    expect(defaultState.notifications).toEqual({
      current: null,
      queue: [],
    });
    expect(getNext([])).toBeUndefined();

    const low = textNotification("low", "Low", { priority: "low" });
    const high = textNotification("high", "High", { priority: "high" });
    const immediate = textNotification("immediate", "Immediate", {
      priority: "immediate",
    });
    const queue = [low, high, immediate];

    expect(getNext(queue)).toBe(immediate);
    expect(queue).toEqual([low, high, immediate]);

    const harness = await renderNotificationsHarness(defaultState);
    try {
      expect(snapshotNotifications(harness.state())).toEqual({
        current: null,
        currentText: null,
        queue: [],
        queueTexts: [],
      });
      expect(harness.snapshots.at(-1)).toEqual({
        current: null,
        currentText: null,
        queue: [],
        queueTexts: [],
      });
    } finally {
      await harness.dispose();
    }
  });

  test("adds, folds, deduplicates, invalidates, and removes notifications", async () => {
    const harness = await renderNotificationsHarness();
    vi.useFakeTimers();

    try {
      harness.api().addNotification(textNotification("active", "one"));
      expect(snapshotNotifications(harness.state())).toEqual({
        current: "active",
        currentText: "one",
        queue: [],
        queueTexts: [],
      });

      harness.api().addNotification(
        textNotification("queued", "queued-one", { priority: "low" }),
      );
      harness.api().addNotification(
        textNotification("urgent", "urgent", { priority: "high" }),
      );
      expect(snapshotNotifications(harness.state())).toMatchObject({
        current: "active",
        currentText: "one",
        queue: ["queued", "urgent"],
        queueTexts: ["queued-one", "urgent"],
      });

      harness.api().addNotification(
        textNotification("active", "ignored-active"),
      );
      harness.api().addNotification(
        textNotification("queued", "ignored-queued", { priority: "low" }),
      );
      expect(snapshotNotifications(harness.state())).toMatchObject({
        current: "active",
        currentText: "one",
        queue: ["queued", "urgent"],
        queueTexts: ["queued-one", "urgent"],
      });

      harness.api().addNotification(
        textNotification("active", "+folded", { fold: appendText }),
      );
      harness.api().addNotification(
        textNotification("queued", "+folded", {
          fold: appendText,
          priority: "low",
        }),
      );
      expect(snapshotNotifications(harness.state())).toMatchObject({
        current: "active",
        currentText: "one+folded",
        queue: ["queued", "urgent"],
        queueTexts: ["queued-one+folded", "urgent"],
      });

      harness.api().removeNotification("active");
      expect(snapshotNotifications(harness.state())).toMatchObject({
        current: "urgent",
        currentText: "urgent",
        queue: ["queued"],
        queueTexts: ["queued-one+folded"],
      });

      harness.api().addNotification(
        textNotification("clear-queued", "clear queued", {
          invalidates: ["queued"],
        }),
      );
      expect(snapshotNotifications(harness.state())).toMatchObject({
        current: "urgent",
        queue: ["clear-queued"],
      });

      harness.api().addNotification(
        textNotification("clear-current", "clear current", {
          invalidates: ["urgent"],
        }),
      );
      expect(snapshotNotifications(harness.state())).toMatchObject({
        current: "clear-queued",
        currentText: "clear queued",
        queue: ["clear-current"],
        queueTexts: ["clear current"],
      });

      const beforeMissingRemove = harness.state();
      harness.api().removeNotification("missing");
      expect(harness.state()).toBe(beforeMissingRemove);
    } finally {
      await harness.dispose();
    }
  });

  test("auto-dismisses with default and per-notification timers", async () => {
    const harness = await renderNotificationsHarness();
    vi.useFakeTimers();

    try {
      harness.api().addNotification(
        textNotification("default-timeout", "Default", {
          timeoutMs: undefined,
        }),
      );
      harness.api().addNotification(
        textNotification("short-timeout", "Short", { timeoutMs: 25 }),
      );

      await vi.advanceTimersByTimeAsync(7_999);
      expect(snapshotNotifications(harness.state())).toMatchObject({
        current: "default-timeout",
        queue: ["short-timeout"],
      });

      await vi.advanceTimersByTimeAsync(1);
      expect(snapshotNotifications(harness.state())).toMatchObject({
        current: "short-timeout",
        currentText: "Short",
        queue: [],
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(snapshotNotifications(harness.state())).toEqual({
        current: null,
        currentText: null,
        queue: [],
        queueTexts: [],
      });
    } finally {
      await harness.dispose();
    }
  });

  test("shows immediate notifications now and resumes queued work after dismissal", async () => {
    const harness = await renderNotificationsHarness();
    vi.useFakeTimers();

    try {
      harness.api().addNotification(
        textNotification("normal", "Normal", { priority: "medium" }),
      );
      harness.api().addNotification(
        textNotification("queued", "Queued", { priority: "low" }),
      );
      harness.api().addNotification(
        textNotification("immediate", "Immediate", {
          invalidates: ["queued"],
          priority: "immediate",
          timeoutMs: 50,
        }),
      );

      expect(snapshotNotifications(harness.state())).toEqual({
        current: "immediate",
        currentText: "Immediate",
        queue: ["normal"],
        queueTexts: ["Normal"],
      });

      await vi.advanceTimersByTimeAsync(49);
      expect(snapshotNotifications(harness.state())).toMatchObject({
        current: "immediate",
        queue: ["normal"],
      });

      await vi.advanceTimersByTimeAsync(1);
      expect(snapshotNotifications(harness.state())).toEqual({
        current: "normal",
        currentText: "Normal",
        queue: [],
        queueTexts: [],
      });
    } finally {
      await harness.dispose();
    }
  });

  test("cleans up removed notification timers before an id is reused", async () => {
    const harness = await renderNotificationsHarness();
    vi.useFakeTimers();

    try {
      harness.api().addNotification(
        textNotification("reused", "old", { timeoutMs: 100 }),
      );
      harness.api().removeNotification("reused");
      harness.api().addNotification(
        textNotification("reused", "new", { timeoutMs: 1_000 }),
      );

      await vi.advanceTimersByTimeAsync(100);
      expect(snapshotNotifications(harness.state())).toEqual({
        current: "reused",
        currentText: "new",
        queue: [],
        queueTexts: [],
      });
    } finally {
      await harness.dispose();
    }
  });

  test("throws the AppState provider error outside the provider", async () => {
    const { stdout, stdin } = createTestStreams();
    const stderr = new PassThrough();
    let stderrOutput = "";
    stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString();
    });
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      patchConsole: false,
    });

    function OutsideProviderProbe(): React.ReactNode {
      useNotifications();
      return <Text>outside</Text>;
    }

    try {
      root.render(<OutsideProviderProbe />);
      await waitForCondition(() =>
        stderrOutput.includes(
          "useAppState/useSetAppState cannot be called outside of an <AppStateProvider />",
        ),
      );
      expect(stderrOutput).toContain(
        "useAppState/useSetAppState cannot be called outside of an <AppStateProvider />",
      );
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      stderr.end();
    }
  });
});
