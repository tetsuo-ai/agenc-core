/**
 * Wave 2-B: KeybindingProvider unit tests.
 *
 * Each test mounts the provider inside an Ink root fed by a PassThrough
 * stdin. Keypresses are delivered by emitting `InputEvent`s directly on
 * the provider's `stdinContext` seam — no real terminal required.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import { EventEmitter } from "../ink/events/emitter.js";
import { InputEvent } from "../ink/events/input-event.js";
import {
  KeybindingProvider,
  useKeybinding,
  useSetKeybindingContext,
} from "./KeybindingContext.js";

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

async function mount(
  element: React.ReactElement,
): Promise<{ unmount: () => void; stdout: PassThrough }> {
  const { stdout, stdin } = createStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  root.render(element);
  // Allow React commit + effects to flush.
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

function Harness({
  emitter,
  children,
  onWarning,
}: {
  emitter: EventEmitter;
  children: React.ReactNode;
  onWarning?: (warn: { command: string; keySequence: string }) => void;
}): React.ReactElement {
  return (
    <KeybindingProvider
      stdinContext={{ internal_eventEmitter: emitter }}
      onWarning={onWarning}
    >
      {children}
    </KeybindingProvider>
  );
}

function CancelHandler({ onFire }: { onFire: () => void }): null {
  useKeybinding("chat:cancel", onFire, "chat");
  return null;
}

function SubmitHandler({ onFire }: { onFire: () => void }): null {
  useKeybinding("chat:submit", onFire, "chat");
  return null;
}

function ExternalEditorHandler({ onFire }: { onFire: () => void }): null {
  useKeybinding("chat:externalEditor", onFire, "chat");
  return null;
}

function ModalSwitcher(): null {
  const setCtx = useSetKeybindingContext();
  React.useEffect(() => {
    setCtx("modal");
  }, [setCtx]);
  return null;
}

function TranscriptSwitcher(): null {
  const setCtx = useSetKeybindingContext();
  React.useEffect(() => {
    setCtx("transcript");
  }, [setCtx]);
  return null;
}

function InterruptHandler({ onFire }: { onFire: () => void }): null {
  useKeybinding("app:interrupt", onFire, "global");
  return null;
}

function ExitHandler({ onFire }: { onFire: () => void }): null {
  useKeybinding("app:exit", onFire, "global");
  return null;
}

function TranscriptHalfPageDownHandler({
  onFire,
}: {
  onFire: () => void;
}): null {
  useKeybinding("scroll:halfPageDown", onFire, "transcript");
  return null;
}

function TranscriptFullPageDownHandler({
  onFire,
}: {
  onFire: () => void;
}): null {
  useKeybinding("scroll:fullPageDown", onFire, "transcript");
  return null;
}

describe("KeybindingProvider", () => {
  beforeEach(() => {
    // Ensure fake timers are off before each test so mount's setTimeout
    // resolves in real time.
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("fires a registered handler when the matching chord arrives", async () => {
    const emitter = new EventEmitter();
    const fired = vi.fn();
    const { unmount } = await mount(
      <Harness emitter={emitter}>
        <CancelHandler onFire={fired} />
      </Harness>,
    );
    // Escape key (name=escape) -> chat:cancel.
    emitter.emit("input", makeParsedKeyEvent({ name: "escape" }));
    expect(fired).toHaveBeenCalledTimes(1);
    unmount();
  });

  test("fires every subscriber when multiple handlers are registered for one command", async () => {
    const emitter = new EventEmitter();
    const a = vi.fn();
    const b = vi.fn();
    const { unmount } = await mount(
      <Harness emitter={emitter}>
        <CancelHandler onFire={a} />
        <CancelHandler onFire={b} />
      </Harness>,
    );
    emitter.emit("input", makeParsedKeyEvent({ name: "escape" }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unmount();
  });

  test("removes handlers on unmount so later keypresses no longer fire them", async () => {
    const emitter = new EventEmitter();
    const fired = vi.fn();
    const { unmount } = await mount(
      <Harness emitter={emitter}>
        <CancelHandler onFire={fired} />
      </Harness>,
    );
    emitter.emit("input", makeParsedKeyEvent({ name: "escape" }));
    expect(fired).toHaveBeenCalledTimes(1);
    unmount();
    // Allow unmount effects to flush.
    await new Promise((r) => setTimeout(r, 20));
    emitter.emit("input", makeParsedKeyEvent({ name: "escape" }));
    expect(fired).toHaveBeenCalledTimes(1);
  });

  test("Ctrl+C fires app:interrupt immediately without a double-press warning", async () => {
    const emitter = new EventEmitter();
    const fired = vi.fn();
    const warned = vi.fn();
    const { unmount } = await mount(
      <Harness emitter={emitter} onWarning={warned}>
        <InterruptHandler onFire={fired} />
      </Harness>,
    );
    emitter.emit(
      "input",
      makeParsedKeyEvent({ name: "c", ctrl: true, sequence: "c" }),
    );
    expect(fired).toHaveBeenCalledTimes(1);
    expect(warned).not.toHaveBeenCalled();
    unmount();
  });

  test("first Ctrl+D emits a warning but does not fire app:exit", async () => {
    const emitter = new EventEmitter();
    const fired = vi.fn();
    const warned = vi.fn();
    const { unmount } = await mount(
      <Harness emitter={emitter} onWarning={warned}>
        <ExitHandler onFire={fired} />
      </Harness>,
    );
    emitter.emit(
      "input",
      makeParsedKeyEvent({ name: "d", ctrl: true, sequence: "d" }),
    );
    expect(fired).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned).toHaveBeenCalledWith(
      expect.objectContaining({ command: "app:exit", keySequence: "ctrl+d" }),
    );
    unmount();
  });

  test("double-press Ctrl+D within the window fires app:exit exactly once", async () => {
    const emitter = new EventEmitter();
    const fired = vi.fn();
    const { unmount } = await mount(
      <Harness emitter={emitter}>
        <ExitHandler onFire={fired} />
      </Harness>,
    );
    emitter.emit(
      "input",
      makeParsedKeyEvent({ name: "d", ctrl: true, sequence: "d" }),
    );
    emitter.emit(
      "input",
      makeParsedKeyEvent({ name: "d", ctrl: true, sequence: "d" }),
    );
    expect(fired).toHaveBeenCalledTimes(1);
    unmount();
  });

  test("fires a multi-chord binding when both chords arrive in order", async () => {
    const emitter = new EventEmitter();
    const fired = vi.fn();
    const { unmount } = await mount(
      <Harness emitter={emitter}>
        <ExternalEditorHandler onFire={fired} />
      </Harness>,
    );
    emitter.emit(
      "input",
      makeParsedKeyEvent({ name: "x", ctrl: true, sequence: "x" }),
    );
    emitter.emit(
      "input",
      makeParsedKeyEvent({ name: "e", ctrl: true, sequence: "e" }),
    );
    expect(fired).toHaveBeenCalledTimes(1);
    unmount();
  });

  test("multi-chord buffer resets when the second chord does not match", async () => {
    const emitter = new EventEmitter();
    const externalEditor = vi.fn();
    const cancel = vi.fn();
    const { unmount } = await mount(
      <Harness emitter={emitter}>
        <ExternalEditorHandler onFire={externalEditor} />
        <CancelHandler onFire={cancel} />
      </Harness>,
    );
    // Prefix for ctrl+x ctrl+e, then an unrelated key that is a direct
    // binding (escape -> chat:cancel). The buffer should clear and the
    // escape handler should fire.
    emitter.emit(
      "input",
      makeParsedKeyEvent({ name: "x", ctrl: true, sequence: "x" }),
    );
    emitter.emit("input", makeParsedKeyEvent({ name: "escape" }));
    expect(externalEditor).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    unmount();
  });

  test("modal context suspends chat bindings so chat handlers do not fire", async () => {
    const emitter = new EventEmitter();
    const chatSubmit = vi.fn();
    const { unmount } = await mount(
      <Harness emitter={emitter}>
        <SubmitHandler onFire={chatSubmit} />
        <ModalSwitcher />
      </Harness>,
    );
    // Allow the effect in ModalSwitcher to run.
    await new Promise((r) => setTimeout(r, 20));
    // Enter key -> chat:submit (chat map) OR modal:confirm (modal map).
    // In modal context, chat:submit handler must NOT fire.
    emitter.emit("input", makeParsedKeyEvent({ name: "return" }));
    expect(chatSubmit).not.toHaveBeenCalled();
    unmount();
  });

  test("transcript context owns copy-mode pager keys before global exits", async () => {
    const emitter = new EventEmitter();
    const halfPageDown = vi.fn();
    const exit = vi.fn();
    const warned = vi.fn();
    const { unmount } = await mount(
      <Harness emitter={emitter} onWarning={warned}>
        <TranscriptHalfPageDownHandler onFire={halfPageDown} />
        <ExitHandler onFire={exit} />
        <TranscriptSwitcher />
      </Harness>,
    );

    await new Promise((r) => setTimeout(r, 20));
    emitter.emit(
      "input",
      makeParsedKeyEvent({ name: "d", ctrl: true, sequence: "d" }),
    );

    expect(halfPageDown).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
    unmount();
  });

  test("normalizes space into a transcript pager binding", async () => {
    const emitter = new EventEmitter();
    const fullPageDown = vi.fn();
    const { unmount } = await mount(
      <Harness emitter={emitter}>
        <TranscriptFullPageDownHandler onFire={fullPageDown} />
        <TranscriptSwitcher />
      </Harness>,
    );

    await new Promise((r) => setTimeout(r, 20));
    emitter.emit("input", makeParsedKeyEvent({ name: "space", sequence: " " }));

    expect(fullPageDown).toHaveBeenCalledTimes(1);
    unmount();
  });
});

/**
 * Helper: build a ParsedKey-shaped InputEvent the provider accepts. The
 * real `parse-keypress.ts` emits this shape; we construct it directly so
 * tests don't have to round-trip through raw stdin bytes.
 */
function makeParsedKeyEvent(opts: {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  option?: boolean;
  super?: boolean;
  sequence?: string;
}): InputEvent {
  const parsedKey = {
    kind: "key" as const,
    name: opts.name ?? "",
    fn: false,
    ctrl: !!opts.ctrl,
    meta: !!opts.meta,
    shift: !!opts.shift,
    option: !!opts.option,
    super: !!opts.super,
    sequence: opts.sequence ?? "",
    raw: opts.sequence ?? "",
  };
  // The provider internally calls `new InputEvent(parsedKey)` which only
  // reads these fields. We go direct here rather than through the
  // partial-Key helper exposed by KeybindingContext.tsx because some
  // tests need to set `sequence` (required for ctrl+<letter> chords).
  return new InputEvent(parsedKey as never);
}
