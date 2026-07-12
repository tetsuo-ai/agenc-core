import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test } from "vitest";

import { Text } from "../../../src/tui/ink.js";
import type { DOMElement } from "../../../src/tui/ink/dom.js";
import instances from "../../../src/tui/ink/instances.js";
import { createRoot } from "../../../src/tui/ink/root.js";
import type { ScrollBoxHandle } from "../../../src/tui/ink/components/ScrollBox.js";
import { AppStateProvider, getDefaultAppState } from "../../../src/tui/state/AppState.js";
import { useModalOrTerminalSize, useModalScrollRef } from "../../../src/tui/context/modalContext.js";
import { TranscriptSurface } from "../../../src/tui/workbench/surfaces/TranscriptSurface.js";
import { WorkbenchLayout } from "../../../src/tui/workbench/WorkbenchLayout.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createTestStreams(columns = 120, rows = 30): {
  output: () => string;
  stdin: TestStdin;
  stdout: PassThrough;
} {
  let rendered = "";
  const stdout = new PassThrough();
  stdout.on("data", (chunk) => {
    rendered += chunk.toString();
  });
  (stdout as unknown as { columns: number }).columns = columns;
  (stdout as unknown as { rows: number }).rows = rows;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  const stdin = new PassThrough() as TestStdin;
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  return { output: () => rendered, stdin, stdout };
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream);
  if (!instance?.rootNode) throw new Error("Ink root node not found");
  return instance.rootNode;
}

function findScrollBox(node: DOMElement): DOMElement | null {
  if (
    node.nodeName === "ink-box" &&
    node.style.overflowX === "scroll" &&
    node.style.overflowY === "scroll"
  ) {
    return node;
  }

  for (const child of node.childNodes) {
    if (child.nodeName === "#text") continue;
    const found = findScrollBox(child);
    if (found) return found;
  }

  return null;
}

async function sleep(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function ModalProbe({
  expectedRef,
}: {
  readonly expectedRef: React.RefObject<ScrollBoxHandle | null>;
}): React.ReactElement {
  const size = useModalOrTerminalSize({ rows: -1, columns: -1 });
  const modalRef = useModalScrollRef();

  return (
    <Text>
      modal-size-{size.rows}x{size.columns}-ref-{modalRef === expectedRef ? "ok" : "missing"}
    </Text>
  );
}

describe("workbench transcript scroll ownership", () => {
  test("TranscriptSurface owns a sticky ScrollBox when given a scroll ref", async () => {
    const scrollRef = React.createRef<ScrollBoxHandle>();
    const { output, stdin, stdout } = createTestStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    let mounted = true;

    try {
      root.render(
        <TranscriptSurface scrollRef={scrollRef}>
          <Text>transcript-scroll-anchor</Text>
        </TranscriptSurface>,
      );

      await waitForCondition(
        () => scrollRef.current !== null && findScrollBox(getRootNode(stdout)) !== null,
        "TranscriptSurface did not attach its ScrollBox",
      );

      const scrollBox = findScrollBox(getRootNode(stdout));
      expect(scrollRef.current).not.toBeNull();
      expect(scrollBox).not.toBeNull();
      expect(scrollBox?.style.flexGrow).toBe(1);
      expect(scrollBox?.style.flexDirection).toBe("column");
      expect(scrollBox?.attributes.stickyScroll).toBe(true);
      // No standalone TRANSCRIPT header: the workbench status bar announces
      // the active surface, so the surface itself stays label-free.
      expect(output()).not.toContain("TRANSCRIPT");
      expect(output()).toContain("transcript-scroll-anchor");

      root.unmount();
      mounted = false;
      await sleep();
      expect(scrollRef.current).toBeNull();
    } finally {
      if (mounted) root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("TranscriptSurface keeps a bounded fallback viewport without a scroll ref", async () => {
    const { output, stdin, stdout } = createTestStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <TranscriptSurface>
          <Text>transcript-fallback-anchor</Text>
        </TranscriptSurface>,
      );

      await waitForCondition(
        () => output().includes("transcript-fallback-anchor"),
        "TranscriptSurface fallback body did not render",
      );

      expect(findScrollBox(getRootNode(stdout))).toBeNull();
      expect(output()).not.toContain("TRANSCRIPT");
      expect(output()).toContain("transcript-fallback-anchor");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("WorkbenchLayout wires its transcript scroll ref into the active surface", async () => {
    const scrollRef = React.createRef<ScrollBoxHandle>();
    const { output, stdin, stdout } = createTestStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    let mounted = true;

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              agentsVisible: false,
              explorerVisible: false,
              activeSurfaceMode: "transcript",
            },
          }}
        >
          <WorkbenchLayout
            transcript={<Text>workbench-scroll-anchor</Text>}
            composer={<Text>composer-anchor</Text>}
            scrollRef={scrollRef}
          />
        </AppStateProvider>,
      );

      await waitForCondition(
        () => scrollRef.current !== null && findScrollBox(getRootNode(stdout)) !== null,
        "WorkbenchLayout did not attach the transcript ScrollBox",
      );

      expect(scrollRef.current).not.toBeNull();
      expect(output()).toContain("TRANSCRIPT");
      expect(output()).toContain("workbench-scroll-anchor");
      expect(output()).toContain("composer-anchor");

      root.unmount();
      mounted = false;
      await sleep();
      expect(scrollRef.current).toBeNull();
    } finally {
      if (mounted) root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("WorkbenchLayout gives modal content the modal scroll owner and bounded size", async () => {
    const scrollRef = React.createRef<ScrollBoxHandle>();
    const modalScrollRef = React.createRef<ScrollBoxHandle>();
    const { output, stdin, stdout } = createTestStreams(100, 12);
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              agentsVisible: false,
              explorerVisible: false,
              activeSurfaceMode: "transcript",
            },
          }}
        >
          <WorkbenchLayout
            transcript={<Text>modal-transcript-anchor</Text>}
            composer={<Text>modal-composer-anchor</Text>}
            modal={<ModalProbe expectedRef={modalScrollRef} />}
            modalScrollRef={modalScrollRef}
            scrollRef={scrollRef}
          />
        </AppStateProvider>,
      );

      await waitForCondition(
        () => output().includes("modal-size-8x98-ref-ok"),
        "WorkbenchLayout modal context did not reach modal content",
      );

      expect(output()).toContain("modal-transcript-anchor");
      expect(output()).toContain("modal-composer-anchor");
      expect(output()).toContain("modal-size-8x98-ref-ok");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
