import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

// Capture the REAL keybinding handlers ScrollKeybindingHandler registers so the
// test can fire the actual `scroll:pageUp` route (jumpBy -> scrollTo) the
// workbench transcript uses, instead of poking the ScrollBox handle directly.
// Everything else in ScrollKeybindingHandler — jumpBy, the stickiness break,
// the wheel/page math — runs unmocked against a REAL ScrollBox. This mirrors
// the live workbench path: PageUp while a turn streams.
const handlerHarness = vi.hoisted(() => ({
  bindings: [] as Array<Record<string, () => unknown>>,
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
  useKeybindings: (handlers: Record<string, () => unknown>) => {
    handlerHarness.bindings.push(handlers);
  },
}));

// ScrollKeybindingHandler also pulls in notifications + selection + clipboard.
// Stub them to no-ops; none participate in the PageUp -> indicator path under
// test (no selection active, no copy). This keeps the test focused on the
// scroll/stickiness/notify pipeline.
vi.mock("../../../src/tui/context/notifications.js", () => ({
  useNotifications: () => ({ addNotification: () => {}, removeNotification: () => {} }),
}));
vi.mock("../../../src/tui/hooks/useCopyOnSelect.js", () => ({
  useCopyOnSelect: () => {},
  useSelectionBgColor: () => {},
}));
vi.mock("../../../src/tui/ink/hooks/use-selection.js", () => ({
  useSelection: () => ({
    copySelection: () => "",
    copySelectionNoClear: () => "",
    clearSelection: () => {},
    hasSelection: () => false,
    getState: () => null,
    subscribe: () => () => {},
    shiftAnchor: () => {},
    shiftSelection: () => {},
    moveFocus: () => {},
    captureScrolledRows: () => {},
  }),
}));

import type { DOMElement } from "../../../src/tui/ink/dom.js";
import instances from "../../../src/tui/ink/instances.js";
import { createRoot } from "../../../src/tui/ink/root.js";
import type { ScrollBoxHandle } from "../../../src/tui/ink/components/ScrollBox.js";
import { TranscriptSurface } from "../../../src/tui/workbench/surfaces/TranscriptSurface.js";
import { ScrollKeybindingHandler } from "../../../src/tui/components/ScrollKeybindingHandler.js";
import { Box, Text } from "../../../src/tui/ink.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createTestStreams(columns = 120, rows = 12): {
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

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function indicatorCount(output: string): number | null {
  const stripped = stripAnsi(output);
  const matches = [...stripped.matchAll(/(\d+) ?lines? ?below/g)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : null;
}

function hasFollowHint(output: string): boolean {
  return stripAnsi(output).includes("Endtofollow") || stripAnsi(output).includes("End to follow");
}

// Grow the transcript imperatively to simulate streamed rows arriving while the
// turn is in flight. Lives INSIDE the ScrollBox, exactly like the workbench's
// <Messages> streamingText.
function StreamingTranscript({
  rowsRef,
}: {
  readonly rowsRef: React.MutableRefObject<{ setRows: (n: number) => void }>;
}): React.ReactElement {
  const [count, setCount] = React.useState(40);
  rowsRef.current.setRows = setCount;
  return (
    <Box flexDirection="column">
      {Array.from({ length: count }, (_, i) => (
        <Text key={i}>row {i}</Text>
      ))}
    </Box>
  );
}

// Pull the captured `scroll:pageUp` handler. ScrollKeybindingHandler registers
// two useKeybindings blocks; pageUp lives in the first.
function pageUpHandler(): () => unknown {
  for (const block of handlerHarness.bindings) {
    if (typeof block["scroll:pageUp"] === "function") return block["scroll:pageUp"];
  }
  throw new Error("scroll:pageUp keybinding was never registered");
}

describe("transcript indicator: real PageUp scroll path during a streaming turn", () => {
  test("PageUp mid-stream breaks sticky, shows the indicator, and tracks growing scrollHeight", async () => {
    handlerHarness.bindings.length = 0;
    const scrollRef = React.createRef<ScrollBoxHandle>();
    const rowsRef = {
      current: { setRows: (_n: number) => {} },
    } as React.MutableRefObject<{ setRows: (n: number) => void }>;
    // Short viewport so 40 rows overflow heavily.
    const { output, stdin, stdout } = createTestStreams(120, 12);
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      // Render the REAL ScrollKeybindingHandler (the workbench's scroll driver)
      // wired to the SAME scrollRef as the TranscriptSurface ScrollBox. The
      // bounded-height wrapper constrains the ScrollBox so content overflows.
      root.render(
        <Box flexDirection="column" height={12} width={120}>
          <ScrollKeybindingHandler scrollRef={scrollRef} isActive isModal={false} />
          <TranscriptSurface scrollRef={scrollRef}>
            <StreamingTranscript rowsRef={rowsRef} />
          </TranscriptSurface>
        </Box>,
      );

      await waitForCondition(
        () =>
          scrollRef.current !== null &&
          scrollRef.current.getScrollHeight() > scrollRef.current.getViewportHeight(),
        "TranscriptSurface did not attach a ScrollBox with overflowing content",
      );

      const handle = scrollRef.current;
      if (!handle) throw new Error("scroll handle missing");

      // Pinned to the bottom (sticky) at start — indicator hidden.
      expect(handle.isSticky()).toBe(true);
      expect(indicatorCount(output())).toBeNull();

      // Drive the REAL PageUp keybinding repeatedly to walk up from the bottom,
      // exactly as the live workbench does. This is the path the live capture
      // suspected of NOT showing the indicator. Each PageUp is jumpBy(-vh/2) ->
      // scrollTo, which sets stickyScroll=false when it lands above the bottom.
      const fire = pageUpHandler();
      for (let i = 0; i < 4; i++) {
        fire();
        // eslint-disable-next-line no-await-in-loop
        await sleep(20);
      }

      // After PageUp the box must be unstuck and the indicator must be visible
      // with a below-count for the CURRENT geometry.
      await waitForCondition(
        () => indicatorCount(output()) !== null,
        "indicator did not appear after PageUp scrolled the transcript up mid-stream",
      );
      expect(handle.isSticky()).toBe(false);
      const beforeStream = indicatorCount(output());
      expect(beforeStream).not.toBeNull();

      // The turn keeps streaming: append many more rows WITHOUT any further
      // scroll input. The renderer's geometry-growth notify must wake the
      // indicator so its below-count climbs while the box stays unstuck.
      rowsRef.current.setRows(120);

      await waitForCondition(
        () => {
          const n = indicatorCount(output());
          return n !== null && beforeStream !== null && n > beforeStream;
        },
        "indicator below-count did NOT grow as streamed rows extended the transcript " +
          `(was ${beforeStream}, still ${indicatorCount(output())}) — the live workbench bug`,
      );

      const afterStream = indicatorCount(output());
      expect(afterStream).not.toBeNull();
      // Still scrolled up, still not following — the renderer must NOT have
      // re-stuck the box just because the stream grew.
      expect(handle.isSticky()).toBe(false);
      expect(afterStream as number).toBeGreaterThan((beforeStream as number) + 50);
      expect(hasFollowHint(output())).toBe(true);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("a single PageUp from the bottom while content fits-then-grows still shows the indicator", async () => {
    // Reproduces the slow-model scenario: only a little content has streamed
    // when the user PageUps, then much more arrives. The indicator must appear
    // as soon as there is content below the viewport and update as it grows.
    handlerHarness.bindings.length = 0;
    const scrollRef = React.createRef<ScrollBoxHandle>();
    const rowsRef = {
      current: { setRows: (_n: number) => {} },
    } as React.MutableRefObject<{ setRows: (n: number) => void }>;
    const { output, stdin, stdout } = createTestStreams(120, 12);
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <Box flexDirection="column" height={12} width={120}>
          <ScrollKeybindingHandler scrollRef={scrollRef} isActive isModal={false} />
          <TranscriptSurface scrollRef={scrollRef}>
            <StreamingTranscript rowsRef={rowsRef} />
          </TranscriptSurface>
        </Box>,
      );

      await waitForCondition(
        () =>
          scrollRef.current !== null &&
          scrollRef.current.getScrollHeight() > scrollRef.current.getViewportHeight(),
        "ScrollBox with overflowing content did not attach",
      );

      const handle = scrollRef.current;
      if (!handle) throw new Error("scroll handle missing");

      // One PageUp off the bottom.
      pageUpHandler()();
      await waitForCondition(
        () => handle.isSticky() === false,
        "single PageUp did not break sticky",
      );
      await waitForCondition(
        () => indicatorCount(output()) !== null,
        "indicator did not appear after a single PageUp",
      );
      const before = indicatorCount(output());

      // Stream a large burst.
      rowsRef.current.setRows(160);
      await waitForCondition(
        () => {
          const n = indicatorCount(output());
          return n !== null && before !== null && n > before;
        },
        "indicator did not track the streamed growth after a single PageUp",
      );

      expect(handle.isSticky()).toBe(false);
      expect(indicatorCount(output())).toBeGreaterThan(before as number);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
