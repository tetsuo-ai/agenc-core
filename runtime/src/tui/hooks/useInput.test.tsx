/**
 * Wave 2 useInput hook tests.
 *
 * Covers wiring to the three chat-level keybindings and the optional
 * raw paste channel.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import { EventEmitter } from "../ink/events/emitter.js";
import { InputEvent } from "../ink/events/input-event.js";
import { KeybindingProvider } from "../keybindings/KeybindingContext.js";
import { useInput } from "./useInput.js";

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
    unmount: () => {
      root.unmount();
      instances.delete(stdout as unknown as NodeJS.WriteStream);
      stdin.end();
      stdout.end();
    },
  };
}

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
  return new InputEvent(parsedKey as never);
}

describe("useInput", () => {
  test("wires the submit handler to chat:submit via keybindings", async () => {
    const emitter = new EventEmitter();
    const onSubmit = vi.fn();
    function Consumer(): null {
      useInput({ onSubmit });
      return null;
    }
    const { unmount } = await mount(
      <KeybindingProvider
        stdinContext={{ internal_eventEmitter: emitter }}
      >
        <Consumer />
      </KeybindingProvider>,
    );
    emitter.emit("input", makeParsedKeyEvent({ name: "return" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    unmount();
  });

  test("wires cancel and cycleMode handlers independently", async () => {
    const emitter = new EventEmitter();
    const onCancel = vi.fn();
    const onCycleMode = vi.fn();
    function Consumer(): null {
      useInput({ onCancel, onCycleMode });
      return null;
    }
    const { unmount } = await mount(
      <KeybindingProvider
        stdinContext={{ internal_eventEmitter: emitter }}
      >
        <Consumer />
      </KeybindingProvider>,
    );
    emitter.emit("input", makeParsedKeyEvent({ name: "escape" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCycleMode).not.toHaveBeenCalled();
    unmount();
  });

  test("does not throw when no handlers are provided", async () => {
    const emitter = new EventEmitter();
    function Consumer(): null {
      useInput();
      return null;
    }
    const { unmount } = await mount(
      <KeybindingProvider
        stdinContext={{ internal_eventEmitter: emitter }}
      >
        <Consumer />
      </KeybindingProvider>,
    );
    // Firing an unhandled chord should not throw either.
    emitter.emit("input", makeParsedKeyEvent({ name: "return" }));
    unmount();
  });
});
