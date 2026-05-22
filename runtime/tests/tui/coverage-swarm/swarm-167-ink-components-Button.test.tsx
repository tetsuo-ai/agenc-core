import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

import Button from "../../../src/tui/ink/components/Button.js";
import type { ButtonState } from "../../../src/tui/ink/components/Button.js";
import Text from "../../../src/tui/ink/components/Text.js";
import type { DOMElement } from "../../../src/tui/ink/dom.js";
import { createRoot } from "../../../src/tui/ink/root.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

type TestRoot = Awaited<ReturnType<typeof createRoot>>;
type HandlerMap = NonNullable<DOMElement["_eventHandlers"]>;

function createTestStreams(): {
  stdin: TestStdin;
  stdout: PassThrough;
} {
  const stdout = new PassThrough();
  stdout.resume();
  (stdout as unknown as { columns: number }).columns = 80;
  (stdout as unknown as { rows: number }).rows = 24;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};

  return { stdin, stdout };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }

  throw new Error(message);
}

async function withRoot(
  run: (root: TestRoot) => Promise<void> | void,
): Promise<void> {
  const { stdin, stdout } = createTestStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  try {
    await run(root);
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
    await sleep();
  }
}

async function requireRef(
  ref: React.RefObject<DOMElement | null>,
): Promise<DOMElement> {
  await waitForCondition(() => ref.current !== null, "Button box did not mount");
  if (!ref.current) throw new Error("Button ref was not attached");
  return ref.current;
}

function handlersFor(box: DOMElement): HandlerMap {
  if (!box._eventHandlers) throw new Error("Button handlers were not attached");
  return box._eventHandlers;
}

describe("Button coverage swarm row 167", () => {
  test("forwards default tabIndex, style props, static children, and click activation", async () => {
    await withRoot(async root => {
      const buttonRef = React.createRef<DOMElement>();
      const onAction = vi.fn();

      root.render(
        <Button
          ref={buttonRef}
          borderColor="green"
          borderStyle="round"
          marginX={1}
          onAction={onAction}
          paddingX={2}
        >
          <Text>static child</Text>
        </Button>,
      );

      const box = await requireRef(buttonRef);
      const handlers = handlersFor(box);

      expect(box.nodeName).toBe("ink-box");
      expect(box.attributes).toMatchObject({
        tabIndex: 0,
      });
      expect(box.style).toMatchObject({
        borderColor: "green",
        borderStyle: "round",
        marginX: 1,
        paddingX: 2,
      });
      expect(box.childNodes.some(child => child.nodeName === "ink-text")).toBe(true);

      (handlers.onClick as (event: unknown) => void)({});

      expect(onAction).toHaveBeenCalledTimes(1);
    });
  });

  test("updates render-prop state for focus, hover, keyboard activation, and reset", async () => {
    await withRoot(async root => {
      const buttonRef = React.createRef<DOMElement>();
      const onAction = vi.fn();
      const states: ButtonState[] = [];

      root.render(
        <Button ref={buttonRef} autoFocus onAction={onAction} tabIndex={5}>
          {state => {
            states.push({ ...state });
            return (
              <Text>
                {state.focused ? "focused" : "blurred"}-
                {state.hovered ? "hovered" : "plain"}-
                {state.active ? "active" : "idle"}
              </Text>
            );
          }}
        </Button>,
      );

      const box = await requireRef(buttonRef);
      const handlers = handlersFor(box);

      expect(box.attributes).toMatchObject({
        autoFocus: true,
        tabIndex: 5,
      });

      (handlers.onMouseEnter as () => void)();
      await waitForCondition(
        () => states.some(state => state.hovered),
        "Button hover state did not render",
      );

      (handlers.onFocus as (event: unknown) => void)({});
      await waitForCondition(
        () => states.some(state => state.focused),
        "Button focus state did not render",
      );

      const ignoredPreventDefault = vi.fn();
      (handlers.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
        key: "escape",
        preventDefault: ignoredPreventDefault,
      });

      expect(ignoredPreventDefault).not.toHaveBeenCalled();
      expect(onAction).not.toHaveBeenCalled();

      const returnPreventDefault = vi.fn();
      (handlers.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
        key: "return",
        preventDefault: returnPreventDefault,
      });

      expect(returnPreventDefault).toHaveBeenCalledTimes(1);
      expect(onAction).toHaveBeenCalledTimes(1);
      await waitForCondition(
        () => states.some(state => state.active),
        "Button active state did not render",
      );
      await waitForCondition(
        () => states.at(-1)?.active === false,
        "Button active state did not reset",
      );

      const spacePreventDefault = vi.fn();
      (handlers.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
        key: " ",
        preventDefault: spacePreventDefault,
      });

      expect(spacePreventDefault).toHaveBeenCalledTimes(1);
      expect(onAction).toHaveBeenCalledTimes(2);

      (handlers.onBlur as (event: unknown) => void)({});
      (handlers.onMouseLeave as () => void)();

      await waitForCondition(
        () => states.at(-1)?.focused === false && states.at(-1)?.hovered === false,
        "Button blur and mouse leave state did not render",
      );
    });
  });
});
