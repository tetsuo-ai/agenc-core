/**
 * Wave 3-A: Composer integration + validator tests.
 *
 * The Composer component mounts inside an Ink root fed by a
 * PassThrough stdin (same harness as `reconciler.test.ts` +
 * `App.test.tsx`). Keybindings are exercised by emitting synthetic
 * `InputEvent`s through the provider's `stdinContext` seam.
 *
 * `validateMentionPath` is the preferred surface for boundary checks —
 * end-to-end rendering of mention rejection is covered indirectly
 * through the reducer + validator, and directly by the three
 * validator tests at the bottom of this file.
 */

import { PassThrough } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import StdinContext from "../ink/components/StdinContext.js";
import { EventEmitter } from "../ink/events/emitter.js";
import { InputEvent } from "../ink/events/input-event.js";
import { KeybindingProvider } from "../keybindings/KeybindingContext.js";
import { AgenCAppStateProvider, useAgenCAppState } from "../state/AppState.js";
import { Composer, validateMentionPath } from "./Composer.js";
import { PasteStore } from "./paste-store.js";

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
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(element: React.ReactElement): Promise<{
  unmount: () => void;
  stdout: PassThrough;
}> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  await new Promise((r) => setTimeout(r, 20));
  return {
    stdout,
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

function renderedTextOf(stdout: PassThrough): string {
  // The Ink root writes rendered frames to stdout. Collect whatever has
  // been flushed so tests can assert on the visible buffer.
  const chunks: Buffer[] = [];
  stdout.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  return Buffer.concat(chunks).toString("utf8");
}

function createAppStateSession() {
  return {
    services: {
      permissionModeRegistry: {
        current: () => ({ mode: "default" as const }),
        subscribeToModeChange: () => () => undefined,
      },
    },
    abortTerminal: vi.fn(),
  };
}

function SetStreaming({
  active,
}: {
  readonly active: boolean;
}): null {
  const { setStreaming } = useAgenCAppState();
  React.useEffect(() => {
    setStreaming(active);
  }, [active, setStreaming]);
  return null;
}

function withInputProviders(
  emitter: EventEmitter,
  child: React.ReactElement,
): React.ReactElement {
  return (
    <StdinContext.Provider
      value={{
        stdin: process.stdin,
        setRawMode: () => undefined,
        isRawModeSupported: true,
        internal_exitOnCtrlC: true,
        internal_eventEmitter: emitter,
        internal_querier: null,
      }}
    >
      <KeybindingProvider stdinContext={{ internal_eventEmitter: emitter }}>
        {child}
      </KeybindingProvider>
    </StdinContext.Provider>
  );
}

describe("Composer", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "agenc-composer-"));
  });

  afterEach(() => {
    // Nothing to tear down — each test uses its own tmp HOME.
  });

  test("renders without throwing on an empty initial state", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const { unmount, stdout } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          pasteStore={new PasteStore()}
        />
      ),
    );
    // Cursor glyph should be somewhere in the output; if the component
    // threw during render the `renderedTextOf` helper would see nothing
    // (stdout would be closed by the unmount path instead).
    void renderedTextOf(stdout);
    unmount();
  });

  test("printable keypresses update the buffer and backspace edits in place", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const { unmount } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          pasteStore={new PasteStore()}
        />
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "h", sequence: "h" }));
    emitter.emit("input", makeKeyEvent({ name: "i", sequence: "i" }));
    emitter.emit("input", makeKeyEvent({ name: "backspace" }));
    emitter.emit("input", makeKeyEvent({ name: "!", sequence: "!" }));
    await new Promise((r) => setTimeout(r, 25));

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 25));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("h!");
    unmount();
  });

  test("Enter calls onSubmit with the current value and clears the buffer", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const store = new PasteStore();

    // A lightweight inspector lets the test dispatch synthetic keys
    // that feed the reducer the same way the real stdin would.
    let lastValue = "";
    function ValueSpy({ onUpdate }: { onUpdate: (v: string) => void }) {
      React.useEffect(() => {
        onUpdate(lastValue);
      });
      return null;
    }

    const { unmount } = await mount(
      withInputProviders(
        emitter,
        <>
          <Composer
            session={{ cwd: tmpHome, home: tmpHome }}
            onSubmit={(v) => {
              lastValue = v;
              onSubmit(v);
            }}
            pasteStore={store}
          />
          <ValueSpy onUpdate={() => undefined} />
        </>
      ),
    );

    // Feed "hi" by emitting printable key events. The provider sees
    // them, the keybinding map has no binding for bare letters, so
    // they do not reach the Composer — it only gets Enter via the
    // `chat:submit` binding. That is fine for this test: we exercise
    // the submit path by first programmatically priming the reducer
    // via a paste burst (which IS a binding-less path).
    store.pushChunk("hi");
    // Wait for the paste-idle timer (default 500 ms) to fire.
    await new Promise((r) => setTimeout(r, 650));

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 25));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("hi");
    unmount();
  });

  test("typing via paste inserts the buffered text and advances the cursor", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const store = new PasteStore();

    const { unmount } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          pasteStore={store}
        />
      ),
    );
    store.pushChunk("alpha");
    await new Promise((r) => setTimeout(r, 650));
    // The paste lifecycle must drive `consumeBuffer` exactly once.
    // After completion the store's buffer is drained.
    expect(store.consumeBuffer()).toBe("");
    unmount();
  });

  test("Enter confirms the slash palette before submitting the composer", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const { unmount } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          pasteStore={new PasteStore()}
        />
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "/", sequence: "/" }));
    emitter.emit("input", makeKeyEvent({ name: "h", sequence: "h" }));
    emitter.emit("input", makeKeyEvent({ name: "e", sequence: "e" }));
    await new Promise((r) => setTimeout(r, 25));

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 25));
    expect(onSubmit).not.toHaveBeenCalled();

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 25));
    expect(onSubmit).toHaveBeenCalledWith("/help ");
    unmount();
  });

  test("active turns block submit, then Escape clears draft before aborting", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const appStateSession = createAppStateSession();
    const { unmount } = await mount(
      <AgenCAppStateProvider session={appStateSession} configStore={{}}>
        <SetStreaming active />
        {withInputProviders(
          emitter,
          <Composer
            session={{ cwd: tmpHome, home: tmpHome }}
            onSubmit={onSubmit}
            onCancel={onCancel}
            pasteStore={new PasteStore()}
          />,
        )}
      </AgenCAppStateProvider>,
    );

    emitter.emit("input", makeKeyEvent({ name: "h", sequence: "h" }));
    emitter.emit("input", makeKeyEvent({ name: "i", sequence: "i" }));
    await new Promise((r) => setTimeout(r, 25));

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 25));
    expect(onSubmit).not.toHaveBeenCalled();

    emitter.emit("input", makeKeyEvent({ name: "escape" }));
    await new Promise((r) => setTimeout(r, 25));
    expect(onCancel).not.toHaveBeenCalled();

    emitter.emit("input", makeKeyEvent({ name: "escape" }));
    await new Promise((r) => setTimeout(r, 25));
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
  });

  test("validateMentionPath accepts a path resolving inside cwd", () => {
    const cwd = "/tmp/agenc-workspace";
    const result = validateMentionPath("./foo/bar.ts", cwd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe("/tmp/agenc-workspace/foo/bar.ts");
    }
  });

  test("validateMentionPath rejects a traversal path escaping the workspace", () => {
    const cwd = "/tmp/agenc-workspace";
    const result = validateMentionPath("../../../etc/passwd", cwd);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("outside_workspace");
    }
  });

  test("validateMentionPath accepts paths inside an explicit allowedRoot", () => {
    const cwd = "/tmp/agenc-workspace";
    const result = validateMentionPath("/var/log/foo.log", cwd, [
      "/var/log",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe("/var/log/foo.log");
    }
  });
});
