/**
 * Wave 2 App component smoke tests.
 *
 * The TUI root is hosted inside an Ink root with a PassThrough stdin/
 * stdout so tests can mount/unmount without a real terminal.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test, vi } from "vitest";

import type { DOMElement } from "./ink/dom.js";
import { createRoot } from "./ink/root.js";
import instances from "./ink/instances.js";
import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from "./ink/termio/dec.js";
import { App, readPickerCommandIntent } from "./App.js";
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
): Promise<{ unmount: () => void; stdin: TestStdin; stdout: PassThrough }> {
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
    stdout,
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

function getRoot(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  if (!instance?.rootNode) throw new Error("Ink instance root missing");
  return instance.rootNode;
}

function collectText(node: DOMElement): string {
  const parts: string[] = [];
  const walk = (n: DOMElement): void => {
    for (const child of n.childNodes) {
      if (child.nodeName === "#text") {
        parts.push((child as unknown as { nodeValue: string }).nodeValue ?? "");
      } else {
        walk(child as DOMElement);
      }
    }
  };
  walk(node);
  return parts.join("");
}

function collectStream(stream: PassThrough): string {
  return stream.read()?.toString("utf8") ?? "";
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
  test("recognizes codex-style picker slash commands", () => {
    expect(readPickerCommandIntent("/model")).toEqual({ kind: "model" });
    expect(readPickerCommandIntent("/model-provider")).toEqual({
      kind: "model-provider",
    });
    expect(readPickerCommandIntent("/provider")).toEqual({
      kind: "model-provider",
    });
    expect(readPickerCommandIntent("/permissions")).toEqual({
      kind: "permissions",
      stage: "root",
    });
    expect(readPickerCommandIntent("/permissions mode")).toEqual({
      kind: "permissions",
      stage: "mode",
    });
    expect(readPickerCommandIntent("/config")).toEqual({
      kind: "config",
      stage: "root",
    });
    expect(readPickerCommandIntent("/config profile")).toEqual({
      kind: "config",
      stage: "profile",
    });
    expect(readPickerCommandIntent("/exit-worktree")).toEqual({
      kind: "exit-worktree",
    });
    expect(readPickerCommandIntent("/model gpt-5")).toBeNull();
  });

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

  test("mounts into the alternate screen and restores the main screen on unmount", async () => {
    const session = createFakeSession("default");
    const { stdout, unmount } = await mount(
      <App
        session={session}
        configStore={FAKE_CONFIG_STORE}
        model="grok-code-fast-1"
      />,
    );

    const mountedOutput = collectStream(stdout);
    expect(mountedOutput).toContain(ENTER_ALT_SCREEN);

    unmount();
    const unmountedOutput = collectStream(stdout);
    expect(unmountedOutput).toContain(EXIT_ALT_SCREEN);
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

  test("renders the mounted T12 cockpit chrome from the live App tree", async () => {
    const session = {
      ...createFakeSession("plan"),
      conversationId: "conv-1234567890",
    };
    const { stdout, unmount } = await mount(
      <App
        session={session}
        configStore={{
          snapshot: { statusLine: { items: ["model", "mode", "session"] } },
        }}
        model="grok-code-fast-1"
      />,
    );

    const text = collectText(getRoot(stdout));
    expect(text).toContain("AgenC");
    expect(text).toContain("press any key to continue");
    expect(text).toContain("MODEL");
    expect(text).toContain("grok-code-fast-1");
    expect(text).toContain("MODE");
    expect(text).toContain("plan");
    expect(text).toContain("SESSION");
    expect(text).toContain("34567890");
    unmount();
  });

  test("renders plan progress through the dedicated transcript block", async () => {
    const session = {
      ...createFakeSession("plan"),
      activeTurn: { unsafePeek: () => ({ turnId: "turn-1" }) },
      abortTerminal: () => undefined,
      initialTranscriptEvents: [
        { type: "turn_started", payload: { turnId: "turn-1" } },
        {
          type: "plan_started",
          payload: {
            turnId: "turn-1",
            planItemId: "plan-1",
            title: "audit tranche",
          },
        },
        {
          type: "plan_delta",
          payload: {
            turnId: "turn-1",
            planItemId: "plan-1",
            delta: "trace event flow",
          },
        },
        {
          type: "plan_item_completed",
          payload: {
            turnId: "turn-1",
            planItemId: "plan-1",
            finalText: "1. inspect\n2. patch",
          },
        },
        {
          type: "plan_exited",
          payload: {
            turnId: "turn-1",
          },
        },
      ],
    };

    const { stdout, unmount } = await mount(
      <App session={session} configStore={FAKE_CONFIG_STORE} />,
    );

    const text = collectText(getRoot(stdout));
    expect(text).toContain("audit tranche");
    expect(text).toContain("1. inspect");
    expect(text).toContain("✓ complete");
    expect(text).toContain("plan mode ended");
    expect(text).not.toContain("[plan]");
    unmount();
  });

  test("keeps the transcript pinned inside the fullscreen viewport", async () => {
    const transcript = Array.from({ length: 36 }, (_, index) => ({
      type: "agent_message" as const,
      payload: {
        message:
          index === 35
            ? "tail-marker-visible-in-viewport"
            : `history-line-${index + 1}`,
      },
    }));
    const session = {
      ...createFakeSession("default"),
      activeTurn: { unsafePeek: () => ({ turnId: "turn-1" }) },
      abortTerminal: () => undefined,
      initialTranscriptEvents: [
        { type: "turn_started", payload: { turnId: "turn-1" } },
        ...transcript,
      ],
    };

    const { stdout, unmount } = await mount(
      <App session={session} configStore={FAKE_CONFIG_STORE} />,
    );

    // Let the splash auto-dismiss so the steady-state fullscreen layout paints.
    await new Promise((r) => setTimeout(r, 1_300));
    const frame = collectStream(stdout);

    expect(frame).toContain("tail-marker-visible-in-viewport");
    expect(frame).toContain("Type");
    expect(frame).toContain("prompt");
    expect(frame).toContain("commands.");
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
