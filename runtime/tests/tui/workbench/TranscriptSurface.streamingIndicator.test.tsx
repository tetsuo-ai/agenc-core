import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test } from "vitest";

import { Box, Text } from "../../../src/tui/ink.js";
import type { DOMElement } from "../../../src/tui/ink/dom.js";
import instances from "../../../src/tui/ink/instances.js";
import { createRoot } from "../../../src/tui/ink/root.js";
import type { ScrollBoxHandle } from "../../../src/tui/ink/components/ScrollBox.js";
import { TranscriptSurface } from "../../../src/tui/workbench/surfaces/TranscriptSurface.js";

// End-to-end proof that the transcript scroll-position indicator tracks a
// LIVE streaming turn: while the user is scrolled up (not sticky), appending
// rows grows the ScrollBox's scrollHeight in the renderer's paint pass. That
// growth must wake the indicator's useSyncExternalStore subscriber so its
// below-count recomputes WITHOUT any further manual scroll — i.e. the
// renderer calls node.notifyScrollSubscribers() on geometry growth. Revert
// the renderer notify (or the ScrollBox ref wiring) and the count goes stale
// and stops tracking the stream, which is the bug this guards.

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

// A growable transcript whose row count is driven imperatively by the test —
// simulating streamed rows appending while the turn is in flight.
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

// Strip all ANSI escape sequences. The renderer emits the spaces between
// styled words as cursor-forward moves (\x1b[1C), not literal spaces, so the
// words rejoin once the escapes are gone ("N lines below" -> "Nlinesbelow").
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

// Pull the current below-count the indicator is showing, or null when absent.
// Reads the LAST committed value (output accumulates frame after frame).
function indicatorCount(output: string): number | null {
  const stripped = stripAnsi(output);
  const matches = [...stripped.matchAll(/(\d+) ?lines? ?below/g)];
  const last = matches.at(-1);
  return last ? Number(last[1]) : null;
}

function hasFollowHint(output: string): boolean {
  return stripAnsi(output).includes("Endtofollow") || stripAnsi(output).includes("End to follow");
}

describe("transcript scroll-position indicator during a live streaming turn", () => {
  test("shows and updates the below-count as streamed rows grow scrollHeight while scrolled up", async () => {
    const scrollRef = React.createRef<ScrollBoxHandle>();
    const rowsRef = {
      current: { setRows: (_n: number) => {} },
    } as React.MutableRefObject<{ setRows: (n: number) => void }>;
    // Short viewport so 40 rows overflow heavily and there's a large below-count.
    const { output, stdin, stdout } = createTestStreams(120, 12);
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      // Fixed-height wrapper constrains the ScrollBox so 40 rows overflow the
      // ~11-row viewport (without a bounded-height ancestor the ScrollBox grows
      // to fit all content and nothing scrolls).
      root.render(
        <Box flexDirection="column" height={12} width={120}>
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

      // The transcript starts pinned to the bottom (sticky) — indicator hidden.
      expect(indicatorCount(output())).toBeNull();

      // User scrolls to the very top mid-turn. This breaks sticky and the
      // indicator appears with the rows-below count for the CURRENT geometry.
      handle.scrollTo(0);
      await waitForCondition(
        () => indicatorCount(output()) !== null,
        "indicator did not appear after scrolling up",
      );
      const beforeStream = indicatorCount(output());
      expect(beforeStream).not.toBeNull();
      expect(handle.isSticky()).toBe(false);

      // Now the turn keeps streaming: append many more rows WITHOUT any further
      // manual scroll. scrollHeight grows in the renderer; the indicator must
      // recompute its below-count from the renderer's geometry-growth notify.
      rowsRef.current.setRows(120);

      await waitForCondition(
        () => {
          const n = indicatorCount(output());
          return n !== null && beforeStream !== null && n > beforeStream;
        },
        "indicator below-count did NOT grow as streamed rows extended the transcript " +
          `(was ${beforeStream}, still ${indicatorCount(output())}) — geometry-growth notify missing`,
      );

      const afterStream = indicatorCount(output());
      expect(afterStream).not.toBeNull();
      // Still scrolled up (top), still not following.
      expect(handle.isSticky()).toBe(false);
      // Growing the transcript by 80 rows adds ~80 rows below the (top) viewport.
      expect(afterStream as number).toBeGreaterThan((beforeStream as number) + 50);
      expect(hasFollowHint(output())).toBe(true);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });

  test("stays suppressed while sticky (following the bottom) even as the stream grows", async () => {
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

      // Sticky (default) → following the bottom. Grow the stream; the indicator
      // must NOT appear, because the user is pinned at the live bottom.
      rowsRef.current.setRows(120);
      await sleep(60);

      expect(scrollRef.current?.isSticky()).toBe(true);
      expect(indicatorCount(output())).toBeNull();
      expect(hasFollowHint(output())).toBe(false);
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
      await sleep();
    }
  });
});
