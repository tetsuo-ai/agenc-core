import { PassThrough } from "node:stream";

import React from "react";
import stripAnsi from "strip-ansi";
import { describe, expect, test } from "vitest";

import {
  calculateFullscreenLayoutBudget,
  FullscreenLayout,
  ScrollChromeContext,
} from "./FullscreenLayout.js";
import { Text } from "../ink.js";
import { createRoot } from "../ink/root.js";
import {
  useModalOrTerminalSize,
  useModalScrollRef,
} from "../context/modalContext.js";
import { renderToString } from "../../utils/staticRender.js";

const SYNC_START = "\x1B[?2026h";
const SYNC_END = "\x1B[?2026l";

type Viewport = {
  readonly columns: number;
  readonly rows: number;
};

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

async function withFullscreenEnv<T>(
  value: "0" | "1",
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.AGENC_NO_FLICKER;
  process.env.AGENC_NO_FLICKER = value;
  try {
    return await fn();
  } finally {
    restoreEnv("AGENC_NO_FLICKER", previous);
  }
}

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null;
  let cursor = 0;

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor);
    if (start === -1) break;

    const contentStart = start + SYNC_START.length;
    const end = output.indexOf(SYNC_END, contentStart);
    if (end === -1) break;

    const frame = output.slice(contentStart, end);
    if (frame.trim().length > 0) {
      lastFrame = frame;
    }
    cursor = end + SYNC_END.length;
  }

  return lastFrame ?? output;
}

function createTestStreams(viewport: Viewport): {
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
  readonly getOutput: () => string;
} {
  let output = "";
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number; rows: number }).columns =
    viewport.columns;
  (stdout as unknown as { columns: number; rows: number }).rows = viewport.rows;
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  return {
    stdin,
    stdout,
    getOutput: () => output,
  };
}

async function sleep(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderFullscreenLayout(
  node: React.ReactNode,
  viewport: Viewport,
): Promise<string> {
  return withFullscreenEnv("1", () => renderToString(node, viewport));
}

async function renderFullscreenLayoutLatestFrame(
  node: React.ReactNode,
  viewport: Viewport,
): Promise<string> {
  return withFullscreenEnv("1", async () => {
    const { stdin, stdout, getOutput } = createTestStreams(viewport);
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    root.render(node);
    await sleep();
    const output = stripAnsi(extractLastFrame(getOutput()));
    root.unmount();
    stdin.end();
    stdout.end();
    await sleep();
    return output;
  });
}

function makeVisiblePillRefs(): {
  readonly scrollRef: React.RefObject<unknown>;
  readonly dividerYRef: React.RefObject<number | null>;
} {
  return {
    scrollRef: {
      current: {
        getPendingDelta: () => 0,
        getScrollTop: () => 0,
        getViewportHeight: () => 5,
        subscribe: () => () => {},
      },
    } as React.RefObject<unknown>,
    dividerYRef: { current: 20 },
  };
}

function ModalSizeProbe(): React.ReactNode {
  const size = useModalOrTerminalSize({ rows: 99, columns: 88 });
  const scrollRef = useModalScrollRef();

  return (
    <Text>
      modal context {size.rows}x{size.columns}{" "}
      {scrollRef === null ? "without-ref" : "with-ref"}
    </Text>
  );
}

function StickyPromptWriter({
  text,
}: {
  readonly text: string;
}): React.ReactNode {
  const { setStickyPrompt } = React.useContext(ScrollChromeContext);

  React.useLayoutEffect(() => {
    setStickyPrompt({ text, scrollTo: () => {} } as never);
    return () => setStickyPrompt(null);
  }, [setStickyPrompt, text]);

  return <Text>sticky scroll content</Text>;
}

describe("FullscreenLayout render branches", () => {
  test("normalizes non-finite and fractional row budgets before chrome gating", () => {
    expect(calculateFullscreenLayoutBudget(Number.POSITIVE_INFINITY)).toEqual({
      showTopChrome: false,
      showScrollable: false,
      showBottomChrome: false,
      bottomMaxHeight: 1,
    });
    expect(calculateFullscreenLayoutBudget(-4)).toEqual({
      showTopChrome: false,
      showScrollable: false,
      showBottomChrome: false,
      bottomMaxHeight: 1,
    });
    expect(calculateFullscreenLayoutBudget(7.9)).toEqual({
      showTopChrome: false,
      showScrollable: true,
      showBottomChrome: true,
      bottomMaxHeight: 3,
    });
  });

  test("renders content sequentially when fullscreen is disabled", async () => {
    const output = await withFullscreenEnv("0", () =>
      renderToString(
        <FullscreenLayout
          scrollable={<Text>sequential scrollable</Text>}
          bottom={<Text>sequential bottom</Text>}
          overlay={<Text>sequential overlay</Text>}
          modal={<Text>sequential modal</Text>}
        />,
        { columns: 80, rows: 12 },
      ),
    );

    expect(output).toContain("sequential scrollable");
    expect(output).toContain("sequential bottom");
    expect(output).toContain("sequential overlay");
    expect(output).toContain("sequential modal");
    expect(output.indexOf("sequential scrollable")).toBeLessThan(
      output.indexOf("sequential bottom"),
    );
    expect(output.indexOf("sequential bottom")).toBeLessThan(
      output.indexOf("sequential overlay"),
    );
    expect(output.indexOf("sequential overlay")).toBeLessThan(
      output.indexOf("sequential modal"),
    );
    expect(output).not.toContain("agenc · orchestrator");
  });

  test.each([
    {
      rows: 1,
      includes: ["budget bottom"],
      excludes: ["budget scrollable", "agenc · orchestrator", "spend"],
    },
    {
      rows: 4,
      includes: ["budget scrollable", "budget bottom"],
      excludes: ["agenc · orchestrator", "spend"],
    },
    {
      rows: 5,
      includes: ["budget scrollable", "budget bottom", "spend"],
      excludes: ["agenc · orchestrator"],
    },
  ])(
    "applies fullscreen row-budget render gates at $rows rows",
    async ({ rows, includes, excludes }) => {
      const output = await renderFullscreenLayout(
        <FullscreenLayout
          scrollable={<Text>budget scrollable</Text>}
          bottom={<Text>budget bottom</Text>}
        />,
        { columns: 80, rows },
      );

      for (const marker of includes) {
        expect(output).toContain(marker);
      }
      for (const marker of excludes) {
        expect(output).not.toContain(marker);
      }
    },
  );

  test("does not render the deprecated file-tree gutter in fullscreen base scenes", async () => {
    const wide = await renderFullscreenLayout(
      <FullscreenLayout
        scrollable={<Text>wide scrollable</Text>}
        bottom={<Text>wide bottom</Text>}
      />,
      { columns: 148, rows: 40 },
    );
    const compact = await renderFullscreenLayout(
      <FullscreenLayout
        scrollable={<Text>compact scrollable</Text>}
        bottom={<Text>compact bottom</Text>}
      />,
      { columns: 80, rows: 24 },
    );
    const modal = await renderFullscreenLayout(
      <FullscreenLayout
        scrollable={<Text>modal scrollable</Text>}
        bottom={<Text>modal bottom</Text>}
        modal={<Text>modal branch marker</Text>}
      />,
      { columns: 148, rows: 40 },
    );

    expect(wide).toContain("runtime");
    expect(wide).toContain("wide scrollable");
    expect(wide).not.toContain("FILES");
    expect(compact).not.toContain("FILES");
    expect(modal).not.toContain("FILES");
    expect(modal).toContain("modal branch marker");
  });

  test("provides modal viewport sizing and scroll ref through modal context", async () => {
    const modalScrollRef = { current: null };
    const output = await renderFullscreenLayout(
      <FullscreenLayout
        scrollable={<Text>modal scrollable</Text>}
        bottom={<Text>modal bottom</Text>}
        modal={<ModalSizeProbe />}
        modalScrollRef={modalScrollRef}
      />,
      { columns: 40, rows: 10 },
    );

    expect(output).toContain("modal context 7x36 with-ref");
  });

  test("renders bottomFloat inside the fullscreen scroll region", async () => {
    const output = await renderFullscreenLayout(
      <FullscreenLayout
        scrollable={<Text>float scrollable</Text>}
        bottom={<Text>float bottom</Text>}
        bottomFloat={<Text>floating branch marker</Text>}
      />,
      { columns: 90, rows: 12 },
    );

    expect(output).toContain("float scrollable");
    expect(output).toContain("floating branch marker");
  });

  test.each([
    [0, "Jump to bottom"],
    [2, "2 new messages"],
  ])("renders the new-message pill label for count %i", async (count, label) => {
    const { scrollRef, dividerYRef } = makeVisiblePillRefs();
    const output = await renderFullscreenLayout(
      <FullscreenLayout
        scrollable={<Text>pill scrollable</Text>}
        bottom={<Text>pill bottom</Text>}
        scrollRef={scrollRef}
        dividerYRef={dividerYRef}
        newMessageCount={count}
      />,
      { columns: 90, rows: 12 },
    );

    expect(output).toContain(label);
  });

  test.each([
    {
      name: "explicit hide",
      props: {
        hidePill: true,
      },
    },
    {
      name: "active overlay",
      props: {
        overlay: <Text>pill suppressing overlay</Text>,
      },
    },
  ])("suppresses the new-message pill for $name", async ({ props }) => {
    const { scrollRef, dividerYRef } = makeVisiblePillRefs();
    const output = await renderFullscreenLayout(
      <FullscreenLayout
        scrollable={<Text>suppressed pill scrollable</Text>}
        bottom={<Text>suppressed pill bottom</Text>}
        scrollRef={scrollRef}
        dividerYRef={dividerYRef}
        newMessageCount={3}
        {...props}
      />,
      { columns: 90, rows: 12 },
    );

    expect(output).not.toContain("new messages");
    if (props.overlay) {
      expect(output).toContain("pill suppressing overlay");
    }
  });

  test("renders sticky prompt chrome from ScrollChromeContext unless hidden", async () => {
    const visible = await renderFullscreenLayoutLatestFrame(
      <FullscreenLayout
        scrollable={<StickyPromptWriter text="sticky prompt marker" />}
        bottom={<Text>sticky bottom</Text>}
      />,
      { columns: 90, rows: 12 },
    );
    const hidden = await renderFullscreenLayoutLatestFrame(
      <FullscreenLayout
        scrollable={<StickyPromptWriter text="hidden sticky prompt marker" />}
        bottom={<Text>hidden sticky bottom</Text>}
        hideSticky={true}
      />,
      { columns: 90, rows: 12 },
    );
    const overlaySuppressed = await renderFullscreenLayoutLatestFrame(
      <FullscreenLayout
        scrollable={<StickyPromptWriter text="overlay sticky prompt marker" />}
        bottom={<Text>overlay sticky bottom</Text>}
        overlay={<Text>sticky suppressing overlay</Text>}
      />,
      { columns: 90, rows: 12 },
    );

    expect(visible).toContain("sticky prompt marker");
    expect(hidden).not.toContain("hidden sticky prompt marker");
    expect(hidden).toContain("sticky scroll content");
    expect(overlaySuppressed).not.toContain("overlay sticky prompt marker");
    expect(overlaySuppressed).toContain("sticky suppressing overlay");
  });
});
