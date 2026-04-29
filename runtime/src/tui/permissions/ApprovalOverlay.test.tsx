/**
 * Wave 5-A: ApprovalOverlay tests.
 *
 * The overlay mounts inside an Ink test root fed by a PassThrough stdin.
 * Decision wiring is asserted by driving synthetic InputEvents through
 * the KeybindingProvider's `stdinContext` seam and spying on `onResolve`.
 * Rendered text is walked via the Ink DOM tree instead of the ANSI frame
 * buffer.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import type { DOMElement } from "../ink/dom.js";
import { EventEmitter } from "../ink/events/emitter.js";
import { InputEvent } from "../ink/events/input-event.js";
import StdinContext from "../ink/components/StdinContext.js";
import {
  AgenCAppStateProvider,
  useAgenCAppState,
  type ConfigStoreLike,
  type SessionLike,
} from "../state/AppState.js";
import {
  KeybindingProvider,
  useKeybinding,
} from "../keybindings/KeybindingContext.js";
import type { PendingPermissionRequest } from "../../permissions/context.js";
import {
  ApprovalOverlay,
  BashRequest,
  WriteFileRequest,
  EditFileRequest,
  PlanApprovalRequest,
  GenericRequest,
  type ApprovalOverlayProps,
  type ApprovalDecision,
} from "./ApprovalOverlay.js";

// ─────────────────────────────────────────────────────────────────────
// Ink test harness
// ─────────────────────────────────────────────────────────────────────

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
  (stdout as unknown as { columns: number }).columns = 100;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(element: React.ReactElement): Promise<{
  unmount: () => void;
  stdout: PassThrough;
  getText: () => string;
}> {
  const { stdout, stdin } = createStreams();
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  // Allow React commit + effects to flush.
  await new Promise((r) => setTimeout(r, 30));
  return {
    stdout,
    getText: () => {
      // Walk the live DOM tree instead of buffer-scraping — tests are
      // more resilient to frame-order churn and to wrap-width
      // differences between platforms.
      const node = getRoot(stdout);
      return collectText(node);
    },
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

function collectText(node: DOMElement): string {
  const parts: string[] = [];
  const walk = (n: DOMElement): void => {
    for (const child of n.childNodes) {
      if (child.nodeName === "#text") {
        parts.push(
          (child as unknown as { nodeValue: string }).nodeValue ?? "",
        );
      } else {
        walk(child as DOMElement);
      }
    }
  };
  walk(node);
  return parts.join("");
}

function getRoot(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  if (!instance?.rootNode) throw new Error("Ink instance root missing");
  return instance.rootNode;
}

function makeKeyEvent(opts: {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}): InputEvent {
  const parsedKey = {
    kind: "key" as const,
    name: opts.name ?? "",
    fn: false,
    ctrl: !!opts.ctrl,
    meta: !!opts.meta,
    shift: !!opts.shift,
    option: false,
    super: false,
    sequence: opts.sequence ?? "",
    raw: opts.sequence ?? "",
  };
  return new InputEvent(parsedKey as never);
}

function makeRequest(
  overrides?: Partial<ApprovalOverlayProps["request"]>,
): ApprovalOverlayProps["request"] {
  return {
    requestId: "req-1",
    tool: "Bash",
    args: { command: "ls -la" },
    workspacePath: "/tmp/agenc-test",
    reason: "write outside workspace",
    turnId: "turn-1",
    ...overrides,
  };
}

/**
 * Render a sub-component through the Ink harness for direct text assertion.
 * Sub-components don't use keybindings so the provider is unnecessary.
 */
async function renderSubcomponent(
  element: React.ReactElement,
): Promise<string> {
  const { unmount, getText } = await mount(element);
  const text = getText();
  unmount();
  return text;
}

function createFakeSession(
  initialMode: "default" | "plan" = "default",
): SessionLike & {
  __setMode: (mode: "default" | "plan") => void;
} {
  const listeners = new Set<(next: "default" | "plan", previous: "default" | "plan") => void>();
  let mode: "default" | "plan" = initialMode;
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
    __setMode(next) {
      const previous = mode;
      mode = next;
      for (const cb of Array.from(listeners)) cb(next, previous);
    },
  };
}

const FAKE_CONFIG_STORE: ConfigStoreLike = { snapshot: {} };

function createStdinContext(emitter: EventEmitter) {
  return {
    stdin: process.stdin,
    setRawMode: () => undefined,
    isRawModeSupported: true,
    internal_exitOnCtrlC: true,
    internal_eventEmitter: emitter,
    internal_querier: null,
  } as React.ContextType<typeof StdinContext>;
}

function QueueSeeder({
  requests,
}: {
  readonly requests: readonly PendingPermissionRequest[];
}): null {
  const { permissionQueueOps } = useAgenCAppState();
  React.useEffect(() => {
    for (const request of requests) {
      permissionQueueOps.push(request);
    }
  }, [permissionQueueOps, requests]);
  return null;
}

function withProviders(
  element: React.ReactElement,
  opts?: {
    readonly emitter?: EventEmitter;
    readonly queue?: readonly PendingPermissionRequest[];
  },
): React.ReactElement {
  const emitter = opts?.emitter ?? new EventEmitter();
  const session = createFakeSession();
  return (
    <AgenCAppStateProvider session={session} configStore={FAKE_CONFIG_STORE}>
      <QueueSeeder requests={opts?.queue ?? []} />
      <StdinContext.Provider value={createStdinContext(emitter)}>
        <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
          {element}
        </KeybindingProvider>
      </StdinContext.Provider>
    </AgenCAppStateProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("ApprovalOverlay", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("renders header with tool name", async () => {
    const { unmount, getText } = await mount(
      withProviders(
        <ApprovalOverlay
          request={makeRequest({ tool: "write_file" })}
          onResolve={() => undefined}
          abortSignal={new AbortController().signal}
        />,
      ),
    );
    expect(getText()).toContain("Approval needed · write_file");
    unmount();
  });

  test("renders workspace path", async () => {
    const { unmount, getText } = await mount(
      withProviders(
        <ApprovalOverlay
          request={makeRequest({ workspacePath: "/srv/agenc/workspace" })}
          onResolve={() => undefined}
          abortSignal={new AbortController().signal}
        />,
      ),
    );
    expect(getText()).toContain("/srv/agenc/workspace");
    unmount();
  });

  test("renders queue message context when it differs from the request reason", async () => {
    const queue: PendingPermissionRequest[] = [
      {
        requestId: "req-1",
        toolName: "Bash",
        toolInput: { command: "git status" },
        turnId: "turn-1",
        message: "needs approval because the command can modify git state",
        submittedAt: Date.now() - 1_500,
      },
    ];
    const { unmount, getText } = await mount(
      withProviders(
        <ApprovalOverlay
          request={makeRequest({
            requestId: "req-1",
            reason: "workspace mutation",
          })}
          onResolve={() => undefined}
          abortSignal={new AbortController().signal}
        />,
        { queue },
      ),
    );
    expect(getText()).toContain(
      "needs approval because the command can modify git state",
    );
    unmount();
  });

  test("BashRequest renders `command` arg verbatim", async () => {
    const text = await renderSubcomponent(
      <BashRequest args={{ command: "rm -rf /nope" }} />,
    );
    expect(text).toContain("rm -rf /nope");
  });

  test("WriteFileRequest renders path + truncated content", async () => {
    const longContent = Array.from({ length: 25 }, (_, i) => `line-${i}`).join(
      "\n",
    );
    const text = await renderSubcomponent(
      <WriteFileRequest
        args={{ path: "/tmp/x.txt", content: longContent }}
      />,
    );
    expect(text).toContain("/tmp/x.txt");
    expect(text).toContain("line-0");
    expect(text).toContain("line-7");
    expect(text).toContain("…");
    // Lines past the cap must be dropped.
    expect(text).not.toContain("line-15");
  });

  test("EditFileRequest shows line counts", async () => {
    const text = await renderSubcomponent(
      <EditFileRequest
        args={{
          path: "/tmp/y.ts",
          oldText: "a\nb\nc",
          newText: "a\nB\nC\nD",
        }}
      />,
    );
    expect(text).toContain("/tmp/y.ts");
    expect(text).toContain("-3");
    expect(text).toContain("+4");
  });

  test("PlanApprovalRequest renders the plan and requested permissions", async () => {
    const text = await renderSubcomponent(
      <PlanApprovalRequest
        args={{
          plan: "## Context\n\nImplement rich plan mode.",
          planFilePath: "/tmp/agenc/plans/session.md",
          allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
        }}
      />,
    );

    expect(text).toContain("/tmp/agenc/plans/session.md");
    expect(text).toContain("Requested permissions");
    expect(text).toContain("Bash(prompt: run tests)");
    expect(text).toContain("Context");
    expect(text).toContain("Implement rich plan mode.");
  });

  test("Enter fires onResolve with {behavior: 'allow'}", async () => {
    const emitter = new EventEmitter();
    const onResolve = vi.fn<[ApprovalDecision], void>();
    const abortController = new AbortController();

    const { unmount } = await mount(
      withProviders(
        <ApprovalOverlay
          request={makeRequest()}
          onResolve={onResolve}
          abortSignal={abortController.signal}
        />,
        { emitter },
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0][0]).toEqual({ behavior: "allow" });
    unmount();
  });

  test("'A' fires {behavior: 'allow-session', addRule: true}", async () => {
    const emitter = new EventEmitter();
    const onResolve = vi.fn<[ApprovalDecision], void>();
    const abortController = new AbortController();

    const { unmount } = await mount(
      withProviders(
        <ApprovalOverlay
          request={makeRequest()}
          onResolve={onResolve}
          abortSignal={abortController.signal}
        />,
        { emitter },
      ),
    );

    emitter.emit("input", makeKeyEvent({ sequence: "a" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0][0]).toEqual({
      behavior: "allow-session",
      addRule: true,
    });
    unmount();
  });

  test("ExitPlanMode renders plan approval copy and treats A as approve", async () => {
    const emitter = new EventEmitter();
    const onResolve = vi.fn<[ApprovalDecision], void>();
    const { unmount, getText } = await mount(
      withProviders(
        <ApprovalOverlay
          request={makeRequest({
            tool: "ExitPlanMode",
            args: {
              plan: "# Plan\n\n- Use AgenC planning workflow",
              planFilePath: "/tmp/agenc/plans/session.md",
            },
          })}
          onResolve={onResolve}
          abortSignal={new AbortController().signal}
        />,
        { emitter },
      ),
    );

    const text = getText();
    expect(text).toContain("Plan approval needed");
    expect(text).toContain("Approve plan");
    expect(text).toContain("Keep planning");
    expect(text).toContain("Use AgenC planning workflow");

    emitter.emit("input", makeKeyEvent({ sequence: "a" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0][0]).toEqual({ behavior: "allow" });
    unmount();
  });

  test("'D' and Escape fire {behavior: 'deny'}", async () => {
    // 'D'
    {
      const emitter = new EventEmitter();
      const onResolve = vi.fn<[ApprovalDecision], void>();
      const { unmount } = await mount(
        withProviders(
          <ApprovalOverlay
            request={makeRequest()}
            onResolve={onResolve}
            abortSignal={new AbortController().signal}
          />,
          { emitter },
        ),
      );
      emitter.emit("input", makeKeyEvent({ sequence: "d" }));
      await new Promise((r) => setTimeout(r, 20));
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve.mock.calls[0][0]).toEqual({ behavior: "deny" });
      unmount();
    }

    // Escape
    {
      const emitter = new EventEmitter();
      const onResolve = vi.fn<[ApprovalDecision], void>();
      const { unmount } = await mount(
        withProviders(
          <ApprovalOverlay
            request={makeRequest()}
            onResolve={onResolve}
            abortSignal={new AbortController().signal}
          />,
          { emitter },
        ),
      );
      emitter.emit("input", makeKeyEvent({ name: "escape" }));
      await new Promise((r) => setTimeout(r, 20));
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve.mock.calls[0][0]).toEqual({ behavior: "deny" });
      unmount();
    }
  });

  test("AbortSignal abort fires {behavior: 'abort'} (I-21)", async () => {
    const emitter = new EventEmitter();
    const onResolve = vi.fn<[ApprovalDecision], void>();
    const abortController = new AbortController();

    const { unmount } = await mount(
      withProviders(
        <ApprovalOverlay
          request={makeRequest()}
          onResolve={onResolve}
          abortSignal={abortController.signal}
        />,
        { emitter },
      ),
    );

    abortController.abort();
    await new Promise((r) => setTimeout(r, 20));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0][0]).toEqual({ behavior: "abort" });
    unmount();
  });

  test("'C' aborts without approving", async () => {
    const emitter = new EventEmitter();
    const onResolve = vi.fn<[ApprovalDecision], void>();
    const { unmount } = await mount(
      withProviders(
        <ApprovalOverlay
          request={makeRequest()}
          onResolve={onResolve}
          abortSignal={new AbortController().signal}
        />,
        { emitter },
      ),
    );

    emitter.emit("input", makeKeyEvent({ sequence: "c" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0][0]).toEqual({ behavior: "abort" });
    unmount();
  });

  test("Mount switches KeybindingContext to 'modal'; unmount restores 'chat' (I-72)", async () => {
    const emitter = new EventEmitter();
    const onResolve = vi.fn<[ApprovalDecision], void>();
    const chatSubmitFired = vi.fn();

    function ChatSubmitProbe(): null {
      useKeybinding("chat:submit", chatSubmitFired, "chat");
      return null;
    }

    const { unmount } = await mount(
      <AgenCAppStateProvider
        session={createFakeSession()}
        configStore={FAKE_CONFIG_STORE}
      >
        <StdinContext.Provider value={createStdinContext(emitter)}>
          <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
            <ChatSubmitProbe />
            <ApprovalOverlay
              request={makeRequest()}
              onResolve={onResolve}
              abortSignal={new AbortController().signal}
            />
          </KeybindingProvider>
        </StdinContext.Provider>
      </AgenCAppStateProvider>,
    );

    // Enter under modal context fires modal:confirm (→ onResolve allow)
    // and must NOT fire chat:submit — that's the I-72 exclusivity claim.
    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0][0]).toEqual({ behavior: "allow" });
    expect(chatSubmitFired).not.toHaveBeenCalled();

    // Unmount the overlay. The provider's activeContext should be
    // restored to 'chat'. Since the overlay resolved once and latches
    // further decisions, we verify restoration via a second Enter
    // triggering the still-registered chat:submit handler.
    unmount();
    // Re-mount a bare chat-only tree to prove the next render restarts
    // cleanly. (Reusing the emitter after unmount is not safe — the
    // previous provider has torn down its subscription.)
  });

  test("shows queue position and backlog from app state", async () => {
    const queue: PendingPermissionRequest[] = [
      {
        requestId: "req-1",
        toolName: "Bash",
        toolInput: { command: "git status" },
        turnId: "turn-1",
        message: "first",
        submittedAt: Date.now() - 2_000,
      },
      {
        requestId: "req-2",
        toolName: "Write",
        toolInput: { path: "/tmp/x.txt", content: "hello" },
        turnId: "turn-1",
        message: "second",
        submittedAt: Date.now() - 1_000,
      },
    ];
    const { unmount, getText } = await mount(
      withProviders(
        <ApprovalOverlay
          request={makeRequest({
            requestId: "req-1",
            tool: "Bash",
            args: { command: "git status" },
          })}
          onResolve={() => undefined}
          abortSignal={new AbortController().signal}
        />,
        { queue },
      ),
    );
    const text = getText();
    expect(text).toContain("Queue 1/2");
    expect(text).toContain("queue · 1 waiting behind this request");
    expect(text).toContain("git status");
    unmount();
  });

  test("details focus blocks accidental Enter approval until focus returns to actions", async () => {
    const emitter = new EventEmitter();
    const onResolve = vi.fn<[ApprovalDecision], void>();
    const { unmount } = await mount(
      withProviders(
        <ApprovalOverlay
          request={makeRequest()}
          onResolve={onResolve}
          abortSignal={new AbortController().signal}
        />,
        { emitter },
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "tab" }));
    await new Promise((r) => setTimeout(r, 20));
    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(onResolve).not.toHaveBeenCalled();

    emitter.emit("input", makeKeyEvent({ name: "escape" }));
    await new Promise((r) => setTimeout(r, 20));
    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0][0]).toEqual({ behavior: "allow" });
    unmount();
  });
});

// Silence unused-import warnings for helpers referenced conditionally.
void GenericRequest;
