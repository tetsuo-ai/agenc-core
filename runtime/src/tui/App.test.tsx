/**
 * Wave 2 App component smoke tests.
 *
 * The TUI root is hosted inside an Ink root with a PassThrough stdin/
 * stdout so tests can mount/unmount without a real terminal.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test, vi } from "vitest";

import { createRoot } from "./ink/root.js";
import instances from "./ink/instances.js";
import { App } from "./App.js";
import type { ConfigStoreLike, SessionLike } from "./state/AppState.js";
import {
  AgenCAppStateProvider,
  useAgenCAppState,
} from "./state/AppState.js";
import {
  OverlayProvider,
  useOverlayStack,
} from "./overlay/OverlayProvider.js";
import type { PermissionMode } from "../permissions/types.js";

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
  stdin.setRawMode = vi.fn(() => undefined);
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(
  element: React.ReactElement,
): Promise<{ unmount: () => void; stdin: TestStdin }> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 20));
  return {
    stdin,
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

/** Minimum structural shape the App needs from a Session. */
function createFakeSession(
  initialMode: PermissionMode = "default",
): SessionLike & {
  __setMode: (m: PermissionMode) => void;
} {
  const listeners = new Set<
    (next: PermissionMode, previous: PermissionMode) => void
  >();
  let mode: PermissionMode = initialMode;
  return {
    services: {
      permissionModeRegistry: {
        current: () => ({ mode }),
        subscribeToModeChange: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
    },
    __setMode(next: PermissionMode) {
      const prev = mode;
      mode = next;
      for (const cb of Array.from(listeners)) cb(next, prev);
    },
  };
}

const FAKE_CONFIG_STORE: ConfigStoreLike = { snapshot: {} };

describe("App", () => {
  test("renders through createRoot without throwing", async () => {
    const session = createFakeSession("default");
    const { unmount } = await mount(
      <App
        session={session}
        configStore={FAKE_CONFIG_STORE}
        model="grok-code-fast-1"
      />,
    );
    unmount();
  });

  test("claims raw mode while the live App is mounted", async () => {
    const session = createFakeSession("default");
    const { stdin, unmount } = await mount(
      <App
        session={session}
        configStore={FAKE_CONFIG_STORE}
        model="grok-code-fast-1"
      />,
    );
    const setRawMode = vi.mocked(stdin.setRawMode);
    expect(setRawMode).toHaveBeenCalledWith(true);

    unmount();
    expect(setRawMode).toHaveBeenCalledWith(false);
  });

  test("AgenCAppStateProvider propagates mode changes to consumers", async () => {
    const session = createFakeSession("default");
    const observed = vi.fn();
    function Observer(): null {
      const { mode } = useAgenCAppState();
      observed(mode);
      return null;
    }
    const { unmount } = await mount(
      <AgenCAppStateProvider
        session={session}
        configStore={FAKE_CONFIG_STORE}
      >
        <Observer />
      </AgenCAppStateProvider>,
    );
    expect(observed).toHaveBeenCalledWith("default");
    session.__setMode("plan");
    await new Promise((r) => setTimeout(r, 20));
    const modesSeen = observed.mock.calls.map(
      (args: unknown[]) => args[0] as PermissionMode,
    );
    expect(modesSeen).toContain("plan");
    unmount();
  });

  test("permissionQueueOps.push re-renders consumers with the queued request", async () => {
    const session = createFakeSession("default");
    const queueSnapshots: number[] = [];
    function Consumer(): null {
      const { pendingRequests, permissionQueueOps } = useAgenCAppState();
      queueSnapshots.push(pendingRequests.length);
      React.useEffect(() => {
        // Push a synthetic pending request on mount so the consumer
        // observes a post-mount re-render from the queue mutation —
        // same intent as the old adjustPending test, now exercising
        // the real queue surface.
        permissionQueueOps.push({
          requestId: "req-1",
          toolName: "Bash",
          toolInput: { command: "ls" },
          turnId: "turn-1",
          message: "test",
          submittedAt: Date.now(),
        });
      }, [permissionQueueOps]);
      return null;
    }
    const { unmount } = await mount(
      <AgenCAppStateProvider
        session={session}
        configStore={FAKE_CONFIG_STORE}
      >
        <Consumer />
      </AgenCAppStateProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(queueSnapshots[0]).toBe(0);
    expect(queueSnapshots).toContain(1);
    unmount();
  });

  test("OverlayProvider exposes a push/pop stack to descendants", async () => {
    const snapshots: number[] = [];
    function Observer(): null {
      const { overlays, pushOverlay, popOverlay } = useOverlayStack();
      snapshots.push(overlays.length);
      React.useEffect(() => {
        const id = pushOverlay(<></>);
        // And pop it again so we can observe the full push/pop cycle.
        const t = setTimeout(() => popOverlay(id), 10);
        return () => clearTimeout(t);
      }, [pushOverlay, popOverlay]);
      return null;
    }
    const { unmount } = await mount(
      <OverlayProvider>
        <Observer />
      </OverlayProvider>,
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(snapshots[0]).toBe(0);
    expect(Math.max(...snapshots)).toBe(1);
    // Final state: back to empty after the pop.
    expect(snapshots[snapshots.length - 1]).toBe(0);
    unmount();
  });

  test("initialPrompt auto-submits once on mount", async () => {
    const submit = vi.fn(async () => undefined);
    const session = {
      ...createFakeSession("default"),
      submit,
    };

    const { unmount } = await mount(
      <App
        session={session}
        configStore={FAKE_CONFIG_STORE}
        initialPrompt="build a game"
      />,
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("build a game");
    unmount();
  });

  test("drops queued approvals without a live resolver and emits a session warning", async () => {
    const emit = vi.fn();
    const session = {
      ...createFakeSession("default"),
      emit,
      nextInternalSubId: () => "sub-approval-missing",
      permissionQueueOps: undefined as unknown,
    } as SessionLike & {
      permissionQueueOps?: {
        push(request: Record<string, unknown>): void;
      };
    };

    const { unmount } = await mount(
      <App session={session} configStore={FAKE_CONFIG_STORE} />,
    );

    expect(session.permissionQueueOps).toBeDefined();
    session.permissionQueueOps?.push({
      requestId: "req-missing-resolver",
      toolName: "Bash",
      toolInput: { command: "pwd" },
      turnId: "turn-1",
      message: "missing resolver",
      submittedAt: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(emit).toHaveBeenCalledWith({
      id: "sub-approval-missing",
      msg: {
        type: "warning",
        payload: expect.objectContaining({
          cause: "approval_resolver_missing",
          requestId: "req-missing-resolver",
          toolName: "Bash",
          turnId: "turn-1",
        }),
      },
    });
    unmount();
  });
});
