/**
 * Wave 5-A: InteractiveHandler tests.
 *
 * Exercises:
 *   - I-44 stale-turn drop (immediate deny + warning, no modal mount)
 *   - Classifier grace race: fast-allow → bypass, unavailable → modal,
 *     timeout → modal
 *   - Modal wiring: 'allow' path claims the resolver payload
 *   - Unmount → abort claim
 *   - `resolveWithGrace` pure helper
 *
 * The classifier module is mocked per test via `vi.mock` so we can steer
 * its behavior deterministically without touching the real stub's
 * session-level warning sink.
 */

import { PassThrough } from "node:stream";
import React, { type ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import { EventEmitter } from "../ink/events/emitter.js";
import { InputEvent } from "../ink/events/input-event.js";
import { KeybindingProvider } from "../keybindings/KeybindingContext.js";
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
// Classifier mock. `vi.mock` hoists the factory above the import, so the
// `classifyYoloAction` symbol imported by InteractiveHandler is the mock
// regardless of when the handler module first loads.
// ─────────────────────────────────────────────────────────────────────

vi.mock("../../permissions/classifier.js", () => ({
  classifyYoloAction: vi.fn(),
}));

// Re-import the mocked symbol after the `vi.mock` factory registers.
import { classifyYoloAction } from "../../permissions/classifier.js";

type MockedClassify = ReturnType<typeof vi.fn>;

function mockedClassifier(): MockedClassify {
  return classifyYoloAction as unknown as MockedClassify;
}

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
  emitted: Array<{ kind: string; [k: string]: unknown }>;
  abortController: AbortController;
}

function createSession(opts?: { currentTurnId?: string | null }): FakeSession {
  const abortController = new AbortController();
  const emitted: Array<{ kind: string; [k: string]: unknown }> = [];
  const currentTurnId = opts?.currentTurnId ?? "turn-1";
  const session: FakeSession = {
    abortController,
    cwd: "/tmp/agenc-test",
    emitted,
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
  beforeEach(() => {
    vi.useRealTimers();
    mockedClassifier().mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("stale turnId: immediately resolves with deny + emits stale warning, no modal mount", async () => {
    // Classifier must not be invoked on the stale path.
    mockedClassifier().mockImplementation(() => {
      throw new Error("classifier must not be called on stale path");
    });

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
    expect(session.emitted.some((e) => e.kind === "warning:stale_pending_dropped"))
      .toBe(true);
    expect(overlay.pushed).toHaveLength(0);
  });

  test("current turnId: proceeds to grace race", async () => {
    mockedClassifier().mockResolvedValue({
      shouldBlock: false,
      reason: "ok",
      unavailable: false,
      model: "mocked",
      usage: null,
      durationMs: 1,
      stage: "fast",
    });

    const { resolver, payloads } = createResolver();
    const session = createSession({ currentTurnId: "turn-1" });
    const request = makeRequest(resolver, { turnId: "turn-1" });

    const outcome = await resolveWithGrace(request, session);

    expect(outcome).toEqual({
      bypassedModal: true,
      reason: "classifier_auto_approved",
    });
    expect(payloads[0]).toMatchObject({
      behavior: "allow",
      source: "classifier_auto_approved",
    });
  });

  test("grace window: classifier returns allow <200ms → auto-approve", async () => {
    // Classifier resolves nearly-instantly; the race must pick its
    // result before the 200 ms grace timer fires.
    mockedClassifier().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return {
        shouldBlock: false,
        reason: "allowlist",
        unavailable: false,
        model: "mocked",
        usage: null,
        durationMs: 5,
        stage: "fast",
      };
    });

    const { resolver, payloads } = createResolver();
    const session = createSession({ currentTurnId: "turn-1" });
    const request = makeRequest(resolver, { turnId: "turn-1" });

    const outcome = await resolveWithGrace(request, session);

    expect(outcome.bypassedModal).toBe(true);
    if (outcome.bypassedModal) {
      expect(outcome.reason).toBe("classifier_auto_approved");
    }
    expect(payloads[0]).toMatchObject({
      behavior: "allow",
      source: "classifier_auto_approved",
    });
    expect(session.emitted.some((e) => e.kind === "warning:classifier_auto_approved"))
      .toBe(true);
  });

  test("grace window: classifier returns unavailable → modal shows (T11 stub behavior)", async () => {
    mockedClassifier().mockResolvedValue({
      shouldBlock: false,
      reason: "classifier_stubbed_t13",
      unavailable: true,
      model: "stub",
      usage: null,
      durationMs: 0,
      stage: "fast",
    });

    const { resolver, payloads, isClaimed } = createResolver();
    const session = createSession({ currentTurnId: "turn-1" });
    const request = makeRequest(resolver, { turnId: "turn-1" });

    const outcome = await resolveWithGrace(request, session);

    expect(outcome).toEqual({ bypassedModal: false });
    expect(isClaimed()).toBe(false);
    expect(payloads).toHaveLength(0);
  });

  test("grace window: timeout at 200ms → modal shows", async () => {
    // Classifier never resolves within the grace window. Use a short
    // grace for the test so we don't actually block for 200ms.
    mockedClassifier().mockImplementation(
      () => new Promise(() => undefined),
    );

    const { resolver, isClaimed } = createResolver();
    const session = createSession({ currentTurnId: "turn-1" });
    const request = makeRequest(resolver, { turnId: "turn-1" });

    const outcome = await resolveWithGrace(request, session, { graceMs: 30 });

    expect(outcome).toEqual({ bypassedModal: false });
    expect(isClaimed()).toBe(false);
  });

  test("modal resolution via 'allow' claims ReviewDecision payload", async () => {
    // Force the classifier to return unavailable so the handler mounts
    // the modal.
    mockedClassifier().mockResolvedValue({
      shouldBlock: false,
      reason: "classifier_stubbed_t13",
      unavailable: true,
      model: "stub",
      usage: null,
      durationMs: 0,
      stage: "fast",
    });

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

  test("unmount before resolution → auto-abort claim", async () => {
    // Classifier never resolves, so the handler hangs before the modal
    // mounts. Unmounting the handler must claim 'abort' to unstick the
    // evaluator's awaiter.
    mockedClassifier().mockImplementation(
      () => new Promise(() => undefined),
    );

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

  test("resolveWithGrace: returns bypassedModal:true when classifier allows", async () => {
    mockedClassifier().mockResolvedValue({
      shouldBlock: false,
      reason: "allowlist",
      unavailable: false,
      model: "mocked",
      usage: null,
      durationMs: 1,
      stage: "fast",
    });

    const { resolver, payloads } = createResolver();
    const session = createSession({ currentTurnId: "turn-1" });
    const request = makeRequest(resolver, { turnId: "turn-1" });

    const outcome = await resolveWithGrace(request, session, { graceMs: 200 });

    expect(outcome).toEqual({
      bypassedModal: true,
      reason: "classifier_auto_approved",
    });
    expect(payloads[0]).toMatchObject({ behavior: "allow" });
  });
});
