/**
 * Wave 4-B Splash tests.
 *
 * We mount Splash inside a test Ink root so it can pick up the
 * StdinContext Ink provides, then fire synthetic input events through
 * the internal EventEmitter to drive the dismiss path.
 */

import { PassThrough } from "node:stream";
import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createRoot } from "../ink/root.js";
import instances from "../ink/instances.js";
import type { DOMElement } from "../ink/dom.js";
import StdinContext from "../ink/components/StdinContext.js";
import { EventEmitter } from "../ink/events/emitter.js";
import { InputEvent } from "../ink/events/input-event.js";
import { Splash, __resetSplashForTests } from "./Splash.js";

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

function getRoot(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream) as
    | { rootNode?: DOMElement }
    | undefined;
  if (!instance?.rootNode) throw new Error("Ink instance root missing");
  return instance.rootNode;
}

function makeKeyEvent(name: string): InputEvent {
  const parsedKey = {
    kind: "key" as const,
    name,
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: name,
    raw: name,
  };
  return new InputEvent(parsedKey as never);
}

describe("Splash", () => {
  afterEach(() => {
    __resetSplashForTests();
    vi.useRealTimers();
  });

  test("renders the default title and status text", async () => {
    const { stdout, unmount } = await mount(<Splash />);
    const text = collectText(getRoot(stdout));
    expect(text).toContain("AgenC");
    expect(text).toContain("press any key to continue");
    unmount();
  });

  test("any keystroke fires onDismiss", async () => {
    const onDismiss = vi.fn();
    const emitter = new EventEmitter();
    const stdinCtx = {
      stdin: process.stdin,
      setRawMode() {},
      isRawModeSupported: false,
      internal_exitOnCtrlC: false,
      internal_eventEmitter: emitter,
      internal_querier: null,
    };
    const { stdout, unmount } = await mount(
      <StdinContext.Provider value={stdinCtx}>
        <Splash onDismiss={onDismiss} />
      </StdinContext.Provider>,
    );
    // Before any key, the splash content is on screen.
    expect(collectText(getRoot(stdout))).toContain("AgenC");
    emitter.emit("input", makeKeyEvent("a"));
    // Give React a microtask to flush the state update.
    await new Promise((r) => setTimeout(r, 20));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // The parent owns unmounting. Splash itself should remain rendered
    // until its owner removes it from the tree.
    expect(collectText(getRoot(stdout))).toContain("press any key to continue");
    unmount();
  });

});
