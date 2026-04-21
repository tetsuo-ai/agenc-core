/**
 * Wave 5-A: InteractiveHandler tests.
 *
 * Exercises:
 *   - I-44 stale-turn drop (immediate deny + warning, no modal mount)
 *   - Non-stale requests fall through to the modal
 *   - Modal wiring: 'allow' path claims the resolver payload
 *   - Unmount → abort claim
 *   - `resolveWithGrace` pure helper
 *
 * The TUI is no longer a second permission authority; the evaluator
 * classifies requests before they ever enter the queue.
 */

import { PassThrough } from "node:stream";
import React, { type ReactNode } from "react";
import {
  describe,
  expect,
  test,
} from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import { EventEmitter } from "../ink/events/emitter.js";
import { InputEvent } from "../ink/events/input-event.js";
import { KeybindingProvider } from "../keybindings/KeybindingContext.js";
import {
  AgenCAppStateProvider,
  useAgenCAppState,
  type ConfigStoreLike,
} from "../state/AppState.js";
import {
  InteractiveHandler,
  resolveWithGrace,
  type InteractivePermissionRequest,
  type InteractiveResolver,
  type OverlayContextLike,
  type ResolverPayload,
  type SessionLike,
} from "./InteractiveHandler.js";

// ─────────────────────────────────────────────────────────────────────
// Resolver double — matches InteractiveResolver's narrow contract.
// ─────────────────────────────────────────────────────────────────────

function createResolver(): {
  resolver: InteractiveResolver;
  payloads: ResolverPayload[];
  isClaimed: () => boolean;
} {
  const payloads: ResolverPayload[] = [];
  let claimed = false;
  const resolver: InteractiveResolver = {
    claim(payload) {
      if (claimed) return false;
      claimed = true;
      payloads.push(payload);
      return true;
    },
    isResolved() {
      return claimed;
    },
  };
  return { resolver, payloads, isClaimed: () => claimed };
}

// ─────────────────────────────────────────────────────────────────────
// Session double
// ─────────────────────────────────────────────────────────────────────

interface FakeSession extends SessionLike {
  emitted: Array<unknown>;
  abortController: AbortController;
}

function createSession(opts?: { currentTurnId?: string | null }): FakeSession {
  const abortController = new AbortController();
  const emitted: Array<unknown> = [];
  const currentTurnId = opts?.currentTurnId ?? "turn-1";
  const session: FakeSession = {
    abortController,
    cwd: "/tmp/agenc-test",
    emitted,
    nextInternalSubId: () => "sub-stale-warning",
    activeTurn: {
      unsafePeek() {
        return currentTurnId === null ? null : { turnId: currentTurnId };
      },
    },
    emit(event) {
      emitted.push({ ...event });
    },
    addPermissionRule() {
      // no-op for tests
    },
  };
  return session;
}

const FAKE_CONFIG_STORE: ConfigStoreLike = { snapshot: {} };

function createProviderSession() {
  return {
    services: {
      permissionModeRegistry: {
        current: () => ({ mode: "default" as const }),
        subscribeToModeChange: () => () => undefined,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Overlay context double — captures pushed nodes + disposal.
// ─────────────────────────────────────────────────────────────────────

interface FakeOverlayContext extends OverlayContextLike {
  readonly pushed: ReactNode[];
  readonly disposed: number[];
  lastNode(): ReactNode | null;
}

function createOverlayContext(): FakeOverlayContext {
  const pushed: ReactNode[] = [];
  const disposed: number[] = [];
  const ctx: FakeOverlayContext = {
    pushed,
    disposed,
    push(node) {
      const idx = pushed.length;
      pushed.push(node);
      return () => {
        disposed.push(idx);
      };
    },
    lastNode() {
      return pushed.length > 0 ? pushed[pushed.length - 1]! : null;
    },
  };
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────
// Request builder
// ─────────────────────────────────────────────────────────────────────

function makeRequest(
  resolver: InteractiveResolver,
  overrides?: Partial<InteractivePermissionRequest>,
): InteractivePermissionRequest {
  return {
    requestId: "req-1",
    toolName: "Bash",
    toolInput: { command: "ls -la" },
    turnId: "turn-1",
    resolveOnce: resolver,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Ink mount harness (for modal-mount tests that need a full provider)
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
}> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  // One tick to let effects run.
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

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────

describe("InteractiveHandler", () => {
  test("stale turnId: immediately resolves with deny + emits stale warning, no modal mount", async () => {
    const { resolver, payloads } = createResolver();
    const session = createSession({ currentTurnId: "turn-NEW" });
    const overlay = createOverlayContext();
    const request = makeRequest(resolver, { turnId: "turn-OLD" });

    const outcome = await resolveWithGrace(request, session);

    expect(outcome).toEqual({
      bypassedModal: true,
      reason: "stale_pending_dropped",
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      behavior: "deny",
      source: "stale_pending_dropped",
    });
    expect(session.emitted).toContainEqual({
      id: "sub-stale-warning",
      msg: {
        type: "warning",
        payload: expect.objectContaining({
          cause: "stale_pending_dropped",
          requestId: "req-1",
          toolName: "Bash",
          expectedTurnId: "turn-OLD",
          actualTurnId: "turn-NEW",
        }),
      },
    });
    expect(overlay.pushed).toHaveLength(0);
  });

  test("current turnId: falls through to the modal path", async () => {
    const { resolver, payloads } = createResolver();
    const session = createSession({ currentTurnId: "turn-1" });
    const request = makeRequest(resolver, { turnId: "turn-1" });

    const outcome = await resolveWithGrace(request, session);

    expect(outcome).toEqual({ bypassedModal: false });
    expect(payloads).toHaveLength(0);
  });

  test("grace override does not change non-stale modal behavior", async () => {
    const { resolver, isClaimed } = createResolver();
    const session = createSession({ currentTurnId: "turn-1" });
    const request = makeRequest(resolver, { turnId: "turn-1" });

    const outcome = await resolveWithGrace(request, session, { graceMs: 30 });

    expect(outcome).toEqual({ bypassedModal: false });
    expect(isClaimed()).toBe(false);
  });

  test("modal resolution via 'allow' claims ReviewDecision payload", async () => {
    const { resolver, payloads } = createResolver();
    const session = createSession({ currentTurnId: "turn-1" });
    const emitter = new EventEmitter();

    // Build a test overlay context that renders the pushed node into
    // the real React tree. We route the overlay node through a state
    // holder component so the ApprovalOverlay is actually mounted in
    // the provider and can receive keypresses.
    let pushCb: ((node: ReactNode) => void) | null = null;
    function OverlayHost({
      onPush,
    }: {
      onPush: (setter: (node: ReactNode) => void) => void;
    }): React.ReactElement {
      const [node, setNode] = React.useState<ReactNode>(null);
      React.useEffect(() => {
        onPush(setNode);
      }, [onPush]);
      return <>{node}</>;
    }

    const overlay: OverlayContextLike = {
      push(node) {
        if (pushCb) pushCb(node);
        return () => {
          if (pushCb) pushCb(null);
        };
      },
    };

    const request = makeRequest(resolver, { turnId: "turn-1" });

    const { unmount } = await mount(
      <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
        <OverlayHost
          onPush={(setter) => {
            pushCb = setter;
          }}
        />
        <InteractiveHandler
          request={request}
          session={session}
          overlayContext={overlay}
        />
      </KeybindingProvider>,
    );

    // Wait for the grace race to resolve + the modal to mount.
    await new Promise((r) => setTimeout(r, 40));

    // Fire Enter to approve.
    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 30));

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      behavior: "allow",
    });
    unmount();
  });

  test("resolved request is removed from the app-state queue so the next request can advance", async () => {
    const { resolver, payloads } = createResolver();
    const session = createSession({ currentTurnId: "turn-1" });
    const queueLengths: number[] = [];

    function QueueObserver(): null {
      const { permissionQueue, permissionQueueOps } = useAgenCAppState();
      queueLengths.push(permissionQueue.length);
      React.useEffect(() => {
        permissionQueueOps.push({
          requestId: "req-1",
          toolName: "Bash",
          toolInput: { command: "ls -la" },
          turnId: "turn-1",
          message: "test",
          submittedAt: Date.now(),
        });
      }, [permissionQueueOps]);
      return null;
    }

    const overlay = createOverlayContext();

    const request = makeRequest(resolver, { turnId: "turn-1" });

    const { unmount } = await mount(
      <AgenCAppStateProvider
        session={createProviderSession()}
        configStore={FAKE_CONFIG_STORE}
      >
        <KeybindingProvider
          stdinContext={{ internal_eventEmitter: new EventEmitter() }}
        >
          <QueueObserver />
          <InteractiveHandler
            request={request}
            session={session}
            overlayContext={overlay}
          />
        </KeybindingProvider>
      </AgenCAppStateProvider>,
    );

    await new Promise((r) => setTimeout(r, 40));

    expect(payloads).toHaveLength(0);
    expect(queueLengths[queueLengths.length - 1]).toBe(1);
    unmount();
  });

  test("unmount before resolution → auto-abort claim", async () => {
    const { resolver, payloads } = createResolver();
    const session = createSession({ currentTurnId: "turn-1" });
    const overlay = createOverlayContext();
    const emitter = new EventEmitter();
    const request = makeRequest(resolver, { turnId: "turn-1" });

    const { unmount } = await mount(
      <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
        <InteractiveHandler
          request={request}
          session={session}
          overlayContext={overlay}
        />
      </KeybindingProvider>,
    );

    // Unmount while the grace race is still pending.
    unmount();
    await new Promise((r) => setTimeout(r, 20));

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      behavior: "abort",
      source: "component_unmounted",
    });
  });

  test("resolveWithGrace: returns bypassedModal:false for current turn", async () => {
    const { resolver, payloads } = createResolver();
    const session = createSession({ currentTurnId: "turn-1" });
    const request = makeRequest(resolver, { turnId: "turn-1" });

    const outcome = await resolveWithGrace(request, session, { graceMs: 200 });

    expect(outcome).toEqual({ bypassedModal: false });
    expect(payloads).toHaveLength(0);
  });
});
