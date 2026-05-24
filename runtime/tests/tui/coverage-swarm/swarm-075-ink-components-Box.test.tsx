import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

import Box from "../../../src/tui/ink/components/Box.js";
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
  await waitForCondition(() => ref.current !== null, "Box did not mount");
  if (!ref.current) throw new Error("Box ref was not attached");
  return ref.current;
}

describe("Box coverage swarm row 075", () => {
  test("forwards defaults, event handlers, attributes, and children to ink-box", async () => {
    await withRoot(async root => {
      const boxRef = React.createRef<DOMElement>();
      const handlers = {
        onBlur: vi.fn(),
        onBlurCapture: vi.fn(),
        onClick: vi.fn(),
        onFocus: vi.fn(),
        onFocusCapture: vi.fn(),
        onKeyDown: vi.fn(),
        onKeyDownCapture: vi.fn(),
        onMouseEnter: vi.fn(),
        onMouseLeave: vi.fn(),
      };

      root.render(
        <Box ref={boxRef} autoFocus tabIndex={3} {...handlers}>
          <Text>content</Text>
        </Box>,
      );

      const box = await requireRef(boxRef);

      expect(box.nodeName).toBe("ink-box");
      expect(box.attributes).toMatchObject({
        autoFocus: true,
        tabIndex: 3,
      });
      expect(box.style).toMatchObject({
        flexDirection: "row",
        flexGrow: 0,
        flexShrink: 1,
        flexWrap: "nowrap",
        overflowX: "visible",
        overflowY: "visible",
      });
      expect(box._eventHandlers).toMatchObject(handlers);
      expect(box.childNodes.some(child => child.nodeName === "ink-text")).toBe(true);
    });
  });

  test("normalizes explicit flex props and overflow fallback precedence", async () => {
    await withRoot(async root => {
      const commonOverflowRef = React.createRef<DOMElement>();
      const axisOverflowRef = React.createRef<DOMElement>();

      root.render(
        <>
          <Box
            ref={commonOverflowRef}
            flexDirection="column"
            flexGrow={2}
            flexShrink={0}
            flexWrap="wrap"
            overflow="hidden"
          >
            <Text>common</Text>
          </Box>
          <Box
            ref={axisOverflowRef}
            columnGap={2}
            gap={1}
            margin={1}
            marginBottom={2}
            marginLeft={3}
            marginRight={4}
            marginTop={5}
            marginX={6}
            marginY={7}
            overflow="hidden"
            overflowX="scroll"
            overflowY="visible"
            padding={1}
            paddingBottom={2}
            paddingLeft={3}
            paddingRight={4}
            paddingTop={5}
            paddingX={6}
            paddingY={7}
            rowGap={3}
          >
            <Text>axis</Text>
          </Box>
        </>,
      );

      const commonOverflowBox = await requireRef(commonOverflowRef);
      const axisOverflowBox = await requireRef(axisOverflowRef);

      expect(commonOverflowBox.style).toMatchObject({
        flexDirection: "column",
        flexGrow: 2,
        flexShrink: 0,
        flexWrap: "wrap",
        overflow: "hidden",
        overflowX: "hidden",
        overflowY: "hidden",
      });
      expect(axisOverflowBox.style).toMatchObject({
        columnGap: 2,
        gap: 1,
        margin: 1,
        marginBottom: 2,
        marginLeft: 3,
        marginRight: 4,
        marginTop: 5,
        marginX: 6,
        marginY: 7,
        overflow: "hidden",
        overflowX: "scroll",
        overflowY: "visible",
        padding: 1,
        paddingBottom: 2,
        paddingLeft: 3,
        paddingRight: 4,
        paddingTop: 5,
        paddingX: 6,
        paddingY: 7,
        rowGap: 3,
      });
    });
  });

  test("updates mounted box attributes, handlers, and overflow style across rerenders", async () => {
    await withRoot(async root => {
      const boxRef = React.createRef<DOMElement>();
      const firstClick = vi.fn();
      const secondClick = vi.fn();

      root.render(
        <Box ref={boxRef} tabIndex={1} onClick={firstClick} overflow="hidden">
          <Text>stable</Text>
        </Box>,
      );

      const firstBox = await requireRef(boxRef);
      expect(firstBox.attributes.tabIndex).toBe(1);
      expect(firstBox._eventHandlers?.onClick).toBe(firstClick);

      root.render(
        <Box ref={boxRef} tabIndex={2} onClick={secondClick} overflowX="scroll">
          <Text>stable</Text>
        </Box>,
      );

      await waitForCondition(
        () =>
          boxRef.current?._eventHandlers?.onClick === secondClick &&
          boxRef.current.attributes.tabIndex === 2,
        "Box did not update in place",
      );

      expect(boxRef.current).toBe(firstBox);
      expect(boxRef.current?._eventHandlers?.onClick).toBe(secondClick);
      expect(boxRef.current?.style.overflow).toBeUndefined();
      expect(boxRef.current?.style).toMatchObject({
        flexDirection: "row",
        flexGrow: 0,
        flexShrink: 1,
        flexWrap: "nowrap",
        overflowX: "scroll",
        overflowY: "visible",
      });
    });
  });
});
