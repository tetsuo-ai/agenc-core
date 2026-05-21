import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

import { AlternateScreen } from "../../../src/tui/ink/components/AlternateScreen.js";
import { TerminalSizeContext } from "../../../src/tui/ink/components/TerminalSizeContext.js";
import Text from "../../../src/tui/ink/components/Text.js";
import type { DOMElement } from "../../../src/tui/ink/dom.js";
import {
  deleteInkInstance,
  getInkInstance,
  setInkInstance,
} from "../../../src/tui/ink/instances.js";
import { createRoot } from "../../../src/tui/ink/root.js";
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} from "../../../src/tui/ink/termio/dec.js";
import { TerminalWriteProvider } from "../../../src/tui/ink/useTerminalNotification.js";

type TestStdout = PassThrough & {
  columns: number;
  isTTY: boolean;
  rows: number;
};

type TestStdin = PassThrough & {
  isTTY: boolean;
};

type TestRoot = Awaited<ReturnType<typeof createRoot>>;

function createTestStreams(): {
  stdin: TestStdin;
  stdout: TestStdout;
} {
  const stdout = new PassThrough() as TestStdout;
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.isTTY = false;
  stdout.resume();

  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = false;

  return { stdin, stdout };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function withRoot(
  run: (root: TestRoot, stdout: TestStdout) => Promise<void> | void,
): Promise<void> {
  const { stdin, stdout } = createTestStreams();
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });

  try {
    await run(root, stdout);
  } finally {
    root.unmount();
    stdin.end();
    stdout.end();
    await sleep();
  }
}

function withProcessInk<T>(
  run: (ink: {
    clearTextSelection: ReturnType<typeof vi.fn>;
    setAltScreenActive: ReturnType<typeof vi.fn>;
  }) => T,
): T {
  const previousInk = getInkInstance(process.stdout);
  const ink = {
    clearTextSelection: vi.fn(),
    setAltScreenActive: vi.fn(),
  };

  setInkInstance(process.stdout, ink as never);
  try {
    return run(ink);
  } finally {
    deleteInkInstance(process.stdout);
    if (previousInk) {
      setInkInstance(process.stdout, previousInk);
    }
  }
}

function getRootNode(stdout: TestStdout): DOMElement {
  const instance = getInkInstance(stdout as unknown as NodeJS.WriteStream);
  if (!instance?.rootNode) {
    throw new Error("Ink root node not found");
  }
  return instance.rootNode;
}

function findAltScreenBox(node: DOMElement, height: number): DOMElement | undefined {
  if (
    node.nodeName === "ink-box" &&
    node.style.flexDirection === "column" &&
    node.style.flexShrink === 0 &&
    node.style.height === height &&
    node.style.width === "100%"
  ) {
    return node;
  }

  for (const child of node.childNodes) {
    if (child.nodeName === "#text") continue;
    const found = findAltScreenBox(child, height);
    if (found) return found;
  }

  return undefined;
}

describe("AlternateScreen coverage swarm row 173", () => {
  test("enters with default mouse tracking, constrains layout, and avoids stable rerender churn", async () => {
    const writeRaw = vi.fn();
    const child = <Text>stable child</Text>;

    await withRoot(async (root, stdout) => {
      withProcessInk(ink => {
        const element = (
          <TerminalWriteProvider value={writeRaw}>
            <TerminalSizeContext.Provider value={{ columns: 80, rows: 9 }}>
              <AlternateScreen>{child}</AlternateScreen>
            </TerminalSizeContext.Provider>
          </TerminalWriteProvider>
        );

        root.render(element);
        root.render(element);

        expect(writeRaw).toHaveBeenCalledTimes(1);
        expect(writeRaw).toHaveBeenCalledWith(
          `${ENTER_ALT_SCREEN}\x1B[2J\x1B[H${ENABLE_MOUSE_TRACKING}`,
        );
        expect(ink.setAltScreenActive).toHaveBeenCalledOnce();
        expect(ink.setAltScreenActive).toHaveBeenCalledWith(true, true);
        expect(findAltScreenBox(getRootNode(stdout), 9)).toBeDefined();
      });
    });

    expect(writeRaw.mock.calls.map(([value]) => value)).toEqual([
      `${ENTER_ALT_SCREEN}\x1B[2J\x1B[H${ENABLE_MOUSE_TRACKING}`,
      `${DISABLE_MOUSE_TRACKING}${EXIT_ALT_SCREEN}`,
    ]);
  });

  test("omits mouse tracking sequences when disabled and restores selection on cleanup", async () => {
    const writeRaw = vi.fn();

    await withRoot(async root => {
      withProcessInk(ink => {
        root.render(
          <TerminalWriteProvider value={writeRaw}>
            <TerminalSizeContext.Provider value={{ columns: 100, rows: 5 }}>
              <AlternateScreen mouseTracking={false}>
                <Text>mouse disabled</Text>
              </AlternateScreen>
            </TerminalSizeContext.Provider>
          </TerminalWriteProvider>,
        );

        expect(writeRaw).toHaveBeenCalledWith(`${ENTER_ALT_SCREEN}\x1B[2J\x1B[H`);
        expect(ink.setAltScreenActive).toHaveBeenCalledWith(true, false);
      });
    });

    expect(writeRaw.mock.calls.map(([value]) => value)).toEqual([
      `${ENTER_ALT_SCREEN}\x1B[2J\x1B[H`,
      EXIT_ALT_SCREEN,
    ]);
  });

  test("skips terminal side effects with a null write context and uses default row height", async () => {
    await withRoot(async (root, stdout) => {
      withProcessInk(ink => {
        root.render(
          <TerminalWriteProvider value={null}>
            <AlternateScreen>
              <Text>no writer</Text>
            </AlternateScreen>
          </TerminalWriteProvider>,
        );

        expect(ink.setAltScreenActive).not.toHaveBeenCalled();
        expect(ink.clearTextSelection).not.toHaveBeenCalled();
        expect(findAltScreenBox(getRootNode(stdout), 24)).toBeDefined();
      });
    });
  });
});
