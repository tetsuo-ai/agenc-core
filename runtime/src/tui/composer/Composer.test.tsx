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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import { charInCellAt } from "../ink/screen.js";
import StdinContext from "../ink/components/StdinContext.js";
import { EventEmitter } from "../ink/events/emitter.js";
import { InputEvent } from "../ink/events/input-event.js";
import {
  KeybindingProvider,
  useSetKeybindingContext,
} from "../keybindings/KeybindingContext.js";
import { AgenCAppStateProvider, useAgenCAppState } from "../state/AppState.js";
import { Composer, validateMentionPath } from "./Composer.js";
import { PasteStore } from "./paste-store.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: (mode: boolean) => void;
  ref: () => void;
  unref: () => void;
};

function createStreams(columns = 80): { stdout: PassThrough; stdin: TestStdin } {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => undefined;
  stdin.ref = () => undefined;
  stdin.unref = () => undefined;
  (stdout as unknown as { columns: number }).columns = columns;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;
  return { stdout, stdin };
}

async function mount(
  element: React.ReactElement,
  options: { readonly columns?: number } = {},
): Promise<{
  unmount: () => void;
  stdout: PassThrough;
}> {
  const { stdout, stdin } = createStreams(options.columns);
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
  isPasted?: boolean;
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
    isPasted: opts.isPasted ?? false,
  };
  return new InputEvent(parsedKey as never);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function typeText(
  emitter: EventEmitter,
  text: string,
  delayMs = 15,
): Promise<void> {
  for (const ch of text) {
    emitter.emit("input", makeKeyEvent({ name: ch, sequence: ch }));
    await sleep(delayMs);
  }
}

function renderedTextOf(stdout: PassThrough): string {
  // The Ink root writes rendered frames to stdout. Collect whatever has
  // been flushed so tests can assert on the visible buffer.
  const chunks: Buffer[] = [];
  stdout.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  return Buffer.concat(chunks).toString("utf8");
}

function latestFrameText(stdout: PassThrough): string {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { frontFrame?: { screen?: { width: number; height: number } } }
    | undefined;
  const screen = instance?.frontFrame?.screen;
  if (!screen) {
    return "";
  }
  const rows: string[] = [];
  for (let y = 0; y < screen.height; y += 1) {
    let row = "";
    for (let x = 0; x < screen.width; x += 1) {
      row += charInCellAt(screen as never, x, y) ?? " ";
    }
    rows.push(row.replace(/\s+$/u, ""));
  }
  return rows.join("\n");
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

function ModalContextProbe({
  onReady,
}: {
  readonly onReady: (setContext: (ctx: "chat" | "modal") => void) => void;
}): null {
  const setContext = useSetKeybindingContext();
  React.useEffect(() => {
    setContext("modal");
    onReady((ctx) => setContext(ctx));
  }, [onReady, setContext]);
  return null;
}

describe("Composer", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "agenc-composer-"));
  });

  afterEach(() => {
    // Nothing to tear down — each test uses its own tmp HOME.
  });

  test("keeps the right border flush with the rendered frame edge", async () => {
    const emitter = new EventEmitter();
    const { unmount, stdout } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={() => undefined}
          pasteStore={new PasteStore()}
        />,
      ),
    );
    const rows = latestFrameText(stdout)
      .split("\n")
      .filter((row) => row.trim().length > 0);

    expect(rows[0]?.trimEnd().endsWith("╮")).toBe(true);
    expect(rows[1]?.trimEnd().endsWith("│")).toBe(true);
    expect(rows[2]?.trimEnd().endsWith("│")).toBe(true);
    expect(rows[3]?.trimEnd().endsWith("╯")).toBe(true);

    unmount();
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

    await typeText(emitter, "hi");
    emitter.emit("input", makeKeyEvent({ name: "backspace" }));
    await sleep(20);
    emitter.emit("input", makeKeyEvent({ name: "!", sequence: "!" }));
    await sleep(25);

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await sleep(25);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("h!");
    unmount();
  });

  test("Ctrl+R enters reverse history search and Enter accepts the previewed match", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const { stdout, unmount } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          pasteStore={new PasteStore()}
        />
      ),
    );

    for (const text of ["first draft", "second draft"]) {
      await typeText(emitter, text);
      emitter.emit("input", makeKeyEvent({ name: "return" }));
      await sleep(20);
    }

    await typeText(emitter, "scratch");
    emitter.emit("input", makeKeyEvent({ name: "r", sequence: "r", ctrl: true }));
    await sleep(20);
    expect(latestFrameText(stdout)).toContain("reverse-i-search:");

    await typeText(emitter, "first");
    await sleep(20);
    const searchingFrame = latestFrameText(stdout);
    expect(searchingFrame).toContain("reverse-i-search: first");
    expect(searchingFrame).toContain("first draft");

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));
    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onSubmit.mock.calls.map((call) => call[0])).toEqual([
      "first draft",
      "second draft",
      "first draft",
    ]);
    unmount();
  });

  test("Escape cancels reverse history search and restores the in-progress draft", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const { stdout, unmount } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          pasteStore={new PasteStore()}
        />
      ),
    );

    for (const text of ["alpha note", "beta note"]) {
      await typeText(emitter, text);
      emitter.emit("input", makeKeyEvent({ name: "return" }));
      await sleep(20);
    }

    await typeText(emitter, "live draft");
    emitter.emit("input", makeKeyEvent({ name: "r", sequence: "r", ctrl: true }));
    await sleep(20);
    await typeText(emitter, "beta");
    await sleep(20);
    expect(latestFrameText(stdout)).toContain("beta note");

    emitter.emit("input", makeKeyEvent({ name: "escape" }));
    await new Promise((r) => setTimeout(r, 20));
    const canceledFrame = latestFrameText(stdout);
    expect(canceledFrame).not.toContain("reverse-i-search:");
    expect(canceledFrame).toContain("live draft");

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 20));

    expect(onSubmit.mock.calls.map((call) => call[0])).toEqual([
      "alpha note",
      "beta note",
      "live draft",
    ]);
    unmount();
  });

  test("ignores printable input while inputLocked is true", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const { stdout, unmount } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          inputLocked
          pasteStore={new PasteStore()}
        />
      ),
    );

    await typeText(emitter, "ct");
    await sleep(25);

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 25));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(latestFrameText(stdout)).not.toContain("ct");
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

  test("renders wrapped input cleanly after backspacing a long draft", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const { unmount, stdout } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          pasteStore={new PasteStore()}
        />,
      ),
      { columns: 30 },
    );

    await typeText(emitter, "abcdefghijklmnopqrstuvwxyz123456");
    await sleep(25);

    let frame = latestFrameText(stdout);
    expect(frame).toContain("abcdefghijklmnopqr");
    expect(frame).toContain("xyz123456");

    for (let i = 0; i < 18; i += 1) {
      emitter.emit("input", makeKeyEvent({ name: "backspace" }));
    }
    await new Promise((r) => setTimeout(r, 25));

    frame = latestFrameText(stdout);
    expect(frame).toContain("abcdefghijklmn");
    expect(frame).not.toContain("uvwxyz123456");
    unmount();
  });

  test("renders early typed characters as a single contiguous draft line", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const { unmount, stdout } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          pasteStore={new PasteStore()}
        />,
      ),
      { columns: 80 },
    );

    await typeText(emitter, "cat");
    await sleep(25);

    const frame = latestFrameText(stdout);
    expect(frame).toContain("cat");
    expect(frame.match(/cat/g)).toHaveLength(1);
    unmount();
  });

  test("does not classify ordinary multi-character input chunks as paste", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const { unmount, stdout } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          pasteStore={new PasteStore()}
        />,
      ),
    );

    emitter.emit(
      "input",
      makeKeyEvent({ sequence: "it's not empty at all", isPasted: false }),
    );
    await new Promise((r) => setTimeout(r, 25));

    const frame = latestFrameText(stdout);
    expect(frame).toContain("it's not empty at all");
    expect(frame).not.toContain("Paste in progress");
    unmount();
  });

  test("honors bracketed paste events without misclassifying normal typing", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const { unmount, stdout } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          pasteStore={new PasteStore()}
        />,
      ),
    );

    emitter.emit(
      "input",
      makeKeyEvent({ sequence: "alpha\nbeta", isPasted: true }),
    );
    await new Promise((r) => setTimeout(r, 25));
    expect(latestFrameText(stdout)).toContain("Paste in progress");

    await new Promise((r) => setTimeout(r, 650));
    await new Promise((r) => setTimeout(r, 25));

    const frame = latestFrameText(stdout);
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta");
    expect(frame).not.toContain("Paste in progress");
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  test("Enter first accepts an exact slash command, then the next Enter submits it", async () => {
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

    await typeText(emitter, "/help");
    await sleep(25);

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await sleep(25);
    expect(onSubmit).not.toHaveBeenCalled();

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await sleep(25);
    expect(onSubmit).toHaveBeenCalledWith("/help");
    unmount();
  });

  test("Enter still waits on partial slash input until the command is completed", async () => {
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

    await typeText(emitter, "/h");
    await sleep(25);

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 25));
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  test("shows @ file suggestions and inserts the selected mention", async () => {
    mkdirSync(join(tmpHome, "src"));
    writeFileSync(join(tmpHome, "src", "alpha.ts"), "export const alpha = 1;\n");
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const { stdout, unmount } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          pasteStore={new PasteStore()}
        />,
      ),
    );

    await typeText(emitter, "@alp");
    await sleep(150);

    expect(latestFrameText(stdout)).toContain("src/alpha.ts");

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await sleep(40);
    expect(onSubmit).not.toHaveBeenCalled();

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await sleep(40);
    expect(onSubmit).toHaveBeenCalledWith("@src/alpha.ts ");
    unmount();
  });

  test("ignores printable input while a modal owns the keybinding context", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    let setContext: ((ctx: "chat" | "modal") => void) | null = null;
    const { unmount } = await mount(
      withInputProviders(
        emitter,
        <>
          <ModalContextProbe
            onReady={(next) => {
              setContext = next;
            }}
          />
          <Composer
            session={{ cwd: tmpHome, home: tmpHome }}
            onSubmit={onSubmit}
            pasteStore={new PasteStore()}
          />
        </>,
      ),
    );
    await new Promise((r) => setTimeout(r, 25));

    emitter.emit("input", makeKeyEvent({ name: "x", sequence: "x" }));
    await new Promise((r) => setTimeout(r, 25));

    setContext?.("chat");
    await new Promise((r) => setTimeout(r, 25));

    emitter.emit("input", makeKeyEvent({ name: "return" }));
    await new Promise((r) => setTimeout(r, 25));

    expect(onSubmit).not.toHaveBeenCalled();
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

    await typeText(emitter, "hi");
    await sleep(25);

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

  test("rapid non-bracketed printable bursts are routed through paste buffering", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    const { unmount, stdout } = await mount(
      withInputProviders(
        emitter,
        <Composer
          session={{ cwd: tmpHome, home: tmpHome }}
          onSubmit={onSubmit}
          pasteStore={new PasteStore()}
        />,
      ),
    );

    emitter.emit("input", makeKeyEvent({ name: "a", sequence: "a" }));
    emitter.emit("input", makeKeyEvent({ name: "b", sequence: "b" }));
    await sleep(25);
    expect(latestFrameText(stdout)).toContain("Paste in progress");

    await sleep(650);
    expect(latestFrameText(stdout)).toContain("ab");
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });
});
