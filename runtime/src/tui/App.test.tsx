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
import { InputEvent } from "./ink/events/input-event.js";
import { createRoot } from "./ink/root.js";
import instances from "./ink/instances.js";
import {
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} from "./ink/termio/dec.js";
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
import type { ToolPermissionContext } from "../permissions/types.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
  internal_eventEmitter: {
    emit: (eventName: string, payload: InputEvent) => void;
  };
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
  opts: { readonly exitOnCtrlC?: boolean } = {},
): Promise<{ unmount: () => void; stdin: TestStdin; stdout: PassThrough }> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: opts.exitOnCtrlC ?? true,
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

function makePermissionContext(mode: PermissionMode): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    isAutoModeAvailable: false,
    autoModeActive: false,
    hasExitedPlanModeInSession: false,
    bypassPermissionsAcceptedIn: [],
  };
}

function makeKeyEvent(opts: {
  sequence: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  option?: boolean;
  super?: boolean;
}): InputEvent {
  return new InputEvent({
    kind: "key" as const,
    name: opts.name ?? opts.sequence,
    fn: false,
    ctrl: opts.ctrl ?? false,
    meta: opts.meta ?? false,
    sequence: opts.sequence,
    raw: opts.sequence,
    shift: opts.shift ?? false,
    option: opts.option ?? false,
    super: opts.super ?? false,
    isPasted: false,
  });
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
  let ctx: ToolPermissionContext = makePermissionContext(initialMode);
  return {
    services: {
      permissionModeRegistry: {
        current: () => ctx,
        update: async (next: ToolPermissionContext) => {
          const prev = ctx.mode;
          ctx = next;
          for (const cb of Array.from(listeners)) cb(next.mode, prev);
        },
        subscribeToModeChange: (cb) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
    },
    __setMode(next: PermissionMode) {
      const prev = ctx.mode;
      ctx = makePermissionContext(next);
      for (const cb of Array.from(listeners)) cb(next, prev);
    },
  };
}

function createConfigStore(
  initialConfig: unknown = {},
): ConfigStoreLike & {
  readonly setConfig: (next: unknown) => void;
  readonly subscriberCount: () => number;
} {
  let config = initialConfig;
  const listeners = new Set<(next: unknown) => void>();
  return {
    current: () => config as never,
    subscribe: (listener: (next: unknown) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setConfig(next: unknown) {
      config = next;
      for (const listener of Array.from(listeners)) {
        listener(next);
      }
    },
    subscriberCount: () => listeners.size,
  };
}

function createMethodBackedConfigStore(
  initialConfig: unknown = {},
): ConfigStoreLike & {
  readonly setConfig: (next: unknown) => void;
  readonly subscriberCount: () => number;
} {
  class MethodBackedConfigStore {
    private config = initialConfig;
    private readonly listeners = new Set<(next: unknown) => void>();

    current(): unknown {
      return this.config;
    }

    subscribe(listener: (next: unknown) => void): () => void {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }

    setConfig(next: unknown): void {
      this.config = next;
      for (const listener of Array.from(this.listeners)) {
        listener(next);
      }
    }

    subscriberCount(): number {
      return this.listeners.size;
    }
  }

  return new MethodBackedConfigStore() as never;
}

const FAKE_CONFIG_STORE: ConfigStoreLike = { current: () => ({}) as never };

describe("App", () => {
  test("recognizes AgenC-style picker slash commands", () => {
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

  test("honors AGENC_DISABLE_MOUSE while keeping alternate screen active", async () => {
    const previous = process.env.AGENC_DISABLE_MOUSE;
    process.env.AGENC_DISABLE_MOUSE = "1";
    const session = createFakeSession("default");

    try {
      const { stdout, unmount } = await mount(
        <App
          session={session}
          configStore={FAKE_CONFIG_STORE}
          model="grok-code-fast-1"
        />,
      );

      const mountedOutput = collectStream(stdout);
      expect(mountedOutput).toContain(ENTER_ALT_SCREEN);
      expect(mountedOutput).not.toContain(ENABLE_MOUSE_TRACKING);

      unmount();
    } finally {
      if (previous === undefined) {
        delete process.env.AGENC_DISABLE_MOUSE;
      } else {
        process.env.AGENC_DISABLE_MOUSE = previous;
      }
    }
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

  test("Shift+Tab cycles permission mode through the live registry", async () => {
    const session = createFakeSession("default");
    const { stdin, stdout, unmount } = await mount(
      <App session={session} configStore={FAKE_CONFIG_STORE} />,
    );

    stdin.write("\u001B[Z");
    await new Promise((r) => setTimeout(r, 20));

    expect(session.services.permissionModeRegistry.current().mode).toBe(
      "acceptEdits",
    );
    expect(collectText(getRoot(stdout))).toContain("accept");
    unmount();
  });

  test("Ctrl+C interrupts the active turn through the turn-local abort path", async () => {
    const abortTurnIfActive = vi.fn(async () => true);
    const abortTerminal = vi.fn();
    const session = {
      ...createFakeSession("default"),
      activeTurn: { unsafePeek: () => ({ turnId: "turn-live" }) },
      abortTurnIfActive,
      abortTerminal,
      initialTranscriptEvents: [
        { type: "turn_started", payload: { turnId: "turn-live" } },
      ],
    };
    const { stdin, unmount } = await mount(
      <App session={session} configStore={FAKE_CONFIG_STORE} />,
      { exitOnCtrlC: false },
    );

    stdin.write("\x03");
    await new Promise((r) => setTimeout(r, 30));

    expect(abortTurnIfActive).toHaveBeenCalledWith("turn-live", "interrupted");
    expect(abortTerminal).not.toHaveBeenCalled();
    unmount();
  });

  test("Ctrl+O opens transcript mode and Ctrl+E exposes hidden lifecycle rows", async () => {
    const session = {
      ...createFakeSession("default"),
      activeTurn: { unsafePeek: () => null },
      abortTerminal: () => undefined,
      initialTranscriptEvents: [
        { type: "turn_started", payload: { turnId: "turn-transcript" } },
        { type: "user_message", payload: { message: "hi" } },
        {
          type: "warning",
          payload: {
            cause: "memory_extract_timeout",
            message:
              "memory_extract_timeout: extraction did not finish within 30000ms",
          },
        },
        { type: "agent_message", payload: { message: "hello" } },
      ],
    };
    const { stdin, stdout, unmount } = await mount(
      <App session={session} configStore={FAKE_CONFIG_STORE} />,
      { exitOnCtrlC: false },
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(collectText(getRoot(stdout))).toContain("AgenC to do anything");
    expect(collectText(getRoot(stdout))).not.toContain("memory_extract_timeout");

    stdin.write("\x0f");
    await new Promise((r) => setTimeout(r, 30));
    let text = collectText(getRoot(stdout));
    expect(text).toContain("Transcript mode");
    expect(text).not.toContain("AgenC to do anything");
    expect(text).not.toContain("memory_extract_timeout");

    stdin.write("\x05");
    await new Promise((r) => setTimeout(r, 30));
    text = collectText(getRoot(stdout));
    expect(text).toContain("memory_extract_timeout");

    stdin.write("q");
    await new Promise((r) => setTimeout(r, 30));
    text = collectText(getRoot(stdout));
    expect(text).toContain("AgenC to do anything");
    expect(text).not.toContain("Transcript mode");
    unmount();
  });

  test("renders live AgenC agent statuses above the composer", async () => {
    const base = createFakeSession("default");
    const thread = {
      threadId: "agent-thread-1",
      agentPath: "/root/scout",
      kind: "agent",
      status: () => ({
        status: "running",
        turnId: "turn-child",
        startedAtMs: 1,
      }),
      subscribeStatus: () => () => undefined,
    };
    const session = {
      ...base,
      services: {
        ...base.services,
        threadManager: {
          listThreadIds: () => ["agent-thread-1"],
          getThread: () => thread,
          subscribeThreadCreated: () => () => undefined,
          state: {
            control: {
              getLive: () => ({
                role: { name: "explorer" },
                nickname: "scout",
                metadata: {
                  agentRole: "explorer",
                  agentNickname: "scout",
                },
                tokenUsage: {
                  totalTokens: 12,
                },
                configSnapshot: { model: "gpt-5" },
              }),
            },
          },
        },
      },
    } as unknown as SessionLike;
    const { stdout, unmount } = await mount(
      <App session={session} configStore={FAKE_CONFIG_STORE} />,
      { exitOnCtrlC: false },
    );

    await new Promise((r) => setTimeout(r, 30));
    const text = collectText(getRoot(stdout));
    expect(text).toContain("main");
    expect(text).toContain("scout");
    expect(text).toContain("gpt-5");
    expect(text).toContain("12 tok");
    unmount();
  });

  test("Esc on an empty composer interrupts the active turn", async () => {
    const abortTurnIfActive = vi.fn(async () => true);
    const abortTerminal = vi.fn();
    const session = {
      ...createFakeSession("default"),
      activeTurn: { unsafePeek: () => ({ turnId: "turn-live" }) },
      abortTurnIfActive,
      abortTerminal,
      initialTranscriptEvents: [
        { type: "turn_started", payload: { turnId: "turn-live" } },
      ],
    };
    const { stdin, unmount } = await mount(
      <App session={session} configStore={FAKE_CONFIG_STORE} />,
    );

    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 90));

    expect(abortTurnIfActive).toHaveBeenCalledWith("turn-live", "interrupted");
    expect(abortTerminal).not.toHaveBeenCalled();
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

  test("initialUserMessages enqueue before startup auto-submit", async () => {
    const submit = vi.fn(async () => undefined);
    const enqueueIdleInput = vi.fn();
    const session = {
      ...createFakeSession("default"),
      submit,
      enqueueIdleInput,
    };
    const imageMessage = {
      role: "user" as const,
      content: [
        {
          type: "image_url" as const,
          image_url: { url: "data:image/png;base64,abc" },
        },
      ],
    };

    const { unmount } = await mount(
      <App
        session={session}
        configStore={FAKE_CONFIG_STORE}
        initialUserMessages={[imageMessage]}
      />,
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(enqueueIdleInput).toHaveBeenCalledWith(imageMessage);
    expect(submit).toHaveBeenCalledWith("");
    unmount();
  });

  test("renders AgenC-style prompt chrome with configurable status line", async () => {
    const session = {
      ...createFakeSession("plan"),
      conversationId: "conv-1234567890",
    };
    const configStore = createConfigStore({
      statusLine: { items: ["model", "mode", "session"] },
    });
    const { stdout, unmount } = await mount(
      <App
        session={session}
        configStore={configStore}
        model="grok-code-fast-1"
      />,
    );

    const text = collectText(getRoot(stdout));
    expect(text).toContain("model");
    expect(text).toContain("grok-code-fast-1");
    expect(text).toContain("mode");
    expect(text).toContain("plan");
    expect(text).toContain("session");
    expect(text).toContain("34567890");
    expect(text).not.toContain("AgenC cockpit");
    unmount();
  });

  test("subscribes to live ConfigStore updates for footer status-line items", async () => {
    const session = {
      ...createFakeSession("default"),
      conversationId: "conv-footer-live",
    };
    const configStore = createConfigStore({});
    const { stdout, unmount } = await mount(
      <App session={session} configStore={configStore} />,
    );

    expect(configStore.subscriberCount()).toBe(1);
    expect(collectText(getRoot(stdout))).not.toContain("session");

    configStore.setConfig({ statusLine: { items: ["session"] } });
    await new Promise((r) => setTimeout(r, 20));

    const text = collectText(getRoot(stdout));
    expect(text).toContain("session");
    expect(text).toContain("ter-live");

    unmount();
    expect(configStore.subscriberCount()).toBe(0);
  });

  test("renders the configurable status line beneath the composer chrome", async () => {
    const session = {
      ...createFakeSession("default"),
      conversationId: "conv-footer-order",
    };
    const configStore = createConfigStore({
      statusLine: { items: ["session"] },
    });
    const { stdout, unmount } = await mount(
      <App session={session} configStore={configStore} />,
    );

    const text = collectText(getRoot(stdout));
    expect(text.indexOf("commands.")).toBeLessThan(text.indexOf("session"));
    unmount();
  });

  test("supports real method-backed ConfigStore instances without losing `this`", async () => {
    const session = {
      ...createFakeSession("default"),
      conversationId: "conv-method-store",
    };
    const configStore = createMethodBackedConfigStore({
      statusLine: { items: ["session"] },
    });

    const { stdout, unmount } = await mount(
      <App session={session} configStore={configStore} />,
    );

    expect(collectText(getRoot(stdout))).toContain("session");
    expect(configStore.subscriberCount()).toBe(1);

    configStore.setConfig({});
    await new Promise((r) => setTimeout(r, 20));
    expect(collectText(getRoot(stdout))).not.toContain("session");

    unmount();
    expect(configStore.subscriberCount()).toBe(0);
  });

  test("surfaces active tool state through semantic transcript and prompt footer", async () => {
    const session = {
      ...createFakeSession("default"),
      activeTurn: { unsafePeek: () => ({ turnId: "turn-1" }) },
      abortTerminal: () => undefined,
      initialTranscriptEvents: [
        { type: "turn_started", payload: { turnId: "turn-1" } },
        {
          type: "tool_call_started",
          id: "tool-call-1",
          payload: {
            callId: "call-1",
            toolName: "Bash",
            args: "{\"cmd\":\"ls\"}",
          },
        },
      ],
    };

    const { stdout, unmount } = await mount(
      <App session={session} configStore={FAKE_CONFIG_STORE} />,
    );

    const text = collectText(getRoot(stdout));
    expect(text).toContain("Listing 1 directory");
    expect(text).toContain("ls");
    expect(text).toContain("Working (");
    expect(text).toContain("esc to interrupt");
    expect(text).not.toContain("/ using tool");
    unmount();
  });

  test("renders default model/mode/cwd status when config does not override it", async () => {
    const session = {
      ...createFakeSession("default"),
      model: "session-model-live",
    };
    const { stdout, unmount } = await mount(
      <App session={session} configStore={FAKE_CONFIG_STORE} />,
    );

    await new Promise((r) => setTimeout(r, 60));
    const text = collectText(getRoot(stdout));
    expect(text).toContain("model");
    expect(text).toContain("session-model-live");
    expect(text).toContain("mode");
    expect(text).toContain("cwd");
    expect(text).not.toContain("session ");
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
    expect(text).toContain("✔");
    expect(text).not.toContain("plan mode ended");
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

    await new Promise((r) => setTimeout(r, 50));
    const frame = collectStream(stdout);

    expect(frame).toContain("tail-marker-visible-in-viewport");
    expect(frame).toContain("AgenC");
    expect(frame).toContain("anything");
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

  test("AskUserQuestion renders its picker instead of the generic approval banner", async () => {
    const session = {
      ...createFakeSession("default"),
      cwd: "/tmp/agenc-workspace",
      activeTurn: { unsafePeek: () => ({ turnId: "turn-ask" }) },
    } as SessionLike & {
      services: SessionLike["services"] & {
        approvalResolver?: {
          request(ctx: Record<string, unknown>): Promise<{ readonly kind: string }>;
        };
      };
    };
    const { stdout, stdin, unmount } = await mount(
      <App session={session} configStore={FAKE_CONFIG_STORE} />,
    );
    await new Promise((r) => setTimeout(r, 30));

    const decision = session.services.approvalResolver?.request({
      callId: "ask-regression",
      toolName: "AskUserQuestion",
      turnId: "turn-ask",
      invocation: {
        payload: {
          kind: "function",
          arguments: JSON.stringify({
            questions: [
              {
                header: "Approach",
                question: "Which planner interview behavior should AgenC use?",
                options: [
                  {
                    label: "AgenC picker (Recommended)",
                    description: "Show multiple-choice questions in the TUI.",
                  },
                  {
                    label: "No picker",
                    description: "Keep plan mode approval-only.",
                  },
                ],
              },
            ],
          }),
        },
      },
    });

    await new Promise((r) => setTimeout(r, 80));
    const text = collectText(getRoot(stdout));

    expect(text).toContain("Answer questions");
    expect(text).toContain("Which planner interview behavior should AgenC use?");
    expect(text).toContain("AgenC picker (Recommended)");
    expect(text).not.toContain("Approval pending");
    expect(text.indexOf("Answer questions")).toBeLessThan(
      text.indexOf("Ask AgenC to do anything"),
    );

    stdin.write("\x1b");
    await expect(decision).resolves.toEqual({ kind: "denied" });
    unmount();
  });
});
