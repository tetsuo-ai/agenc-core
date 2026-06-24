import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Controllable scroll state shared with the ScrollBox mock. Each test sets
// these before rendering so the indicator reads a deterministic position
// instead of depending on real Yoga layout (which needs overflowing content
// to produce a scroll height). The mock wires a ScrollBoxHandle onto the
// forwarded ref exposing exactly the getters the indicator subscribes to.
const scrollState = vi.hoisted(() => ({
  sticky: true,
  scrollTop: 0,
  pendingDelta: 0,
  viewportHeight: 10,
  scrollHeight: 10,
}));

vi.mock("../../../src/tui/ink/components/ScrollBox.js", async () => {
  const ReactModule = await import("react");
  const ScrollBoxMock = (props: Record<string, unknown>) => {
    ReactModule.useImperativeHandle(props.ref as React.Ref<unknown>, () => ({
      scrollTo: () => {},
      scrollBy: () => {},
      scrollToElement: () => {},
      scrollToBottom: () => {},
      getScrollTop: () => scrollState.scrollTop,
      getPendingDelta: () => scrollState.pendingDelta,
      getScrollHeight: () => scrollState.scrollHeight,
      getFreshScrollHeight: () => scrollState.scrollHeight,
      getViewportHeight: () => scrollState.viewportHeight,
      getViewportTop: () => 0,
      isSticky: () => scrollState.sticky,
      // The indicator subscribes but the snapshot is read synchronously on
      // mount; tests assert the committed first frame, so no listener fires.
      subscribe: () => () => {},
      setClampBounds: () => {},
    }));
    return ReactModule.createElement(ReactModule.Fragment, null, props.children as React.ReactNode);
  };
  return { default: ScrollBoxMock };
});

import { TranscriptSurface } from "../../../src/tui/workbench/surfaces/TranscriptSurface.js";
import type { ScrollBoxHandle } from "../../../src/tui/ink/components/ScrollBox.js";
import { Text } from "../../../src/tui/ink.js";
import { renderToString } from "../../../src/utils/staticRender.js";

function setScrollState(next: Partial<typeof scrollState>): void {
  Object.assign(scrollState, next);
}

async function renderSurface(columns = 80, rows = 14): Promise<string> {
  const scrollRef = React.createRef<ScrollBoxHandle>();
  return renderToString(
    <TranscriptSurface scrollRef={scrollRef}>
      <Text>conversation body</Text>
    </TranscriptSurface>,
    { columns, rows },
  );
}

function maxRowWidth(rendered: string): number {
  return rendered
    .split("\n")
    .reduce((widest, line) => Math.max(widest, [...line].length), 0);
}

describe("TranscriptSurface scroll-position indicator", () => {
  beforeEach(() => {
    setScrollState({
      sticky: true,
      scrollTop: 0,
      pendingDelta: 0,
      viewportHeight: 10,
      scrollHeight: 10,
    });
  });

  it("shows a below-count and a return-to-bottom hint when scrolled up", async () => {
    // 200-row transcript, viewport of 20, scrolled to the top: 180 rows below.
    setScrollState({ sticky: false, scrollTop: 0, viewportHeight: 20, scrollHeight: 200 });
    const rendered = await renderSurface();

    expect(rendered).toContain("180 lines below");
    // The hint must name the live key that returns to the bottom.
    expect(rendered).toMatch(/End to follow/);
  });

  it("renders NOTHING when pinned to the bottom (sticky / following)", async () => {
    setScrollState({ sticky: true, scrollTop: 180, viewportHeight: 20, scrollHeight: 200 });
    const rendered = await renderSurface();

    expect(rendered).not.toContain("below");
    expect(rendered).not.toContain("to follow");
    // The transcript itself still renders — only the indicator is suppressed.
    expect(rendered).toContain("conversation body");
  });

  it("renders NOTHING when the viewport already reaches the bottom", async () => {
    // Not sticky (user nudged) but scrollTop puts the viewport bottom AT the
    // content bottom: 0 rows below → no indicator.
    setScrollState({ sticky: false, scrollTop: 180, viewportHeight: 20, scrollHeight: 200 });
    const rendered = await renderSurface();

    expect(rendered).not.toContain("below");
    expect(rendered).not.toContain("to follow");
  });

  it("renders NOTHING when content fits the viewport (no scroll)", async () => {
    setScrollState({ sticky: false, scrollTop: 0, viewportHeight: 20, scrollHeight: 12 });
    const rendered = await renderSurface();

    expect(rendered).not.toContain("below");
  });

  it("counts the not-yet-drained pending wheel delta", async () => {
    // Mid wheel-burst: scrollTop=0 but pendingDelta=+50 already heads down.
    // bottom = 0 + 50 + 20 = 70, below = 200 - 70 = 130.
    setScrollState({ sticky: false, scrollTop: 0, pendingDelta: 50, viewportHeight: 20, scrollHeight: 200 });
    const rendered = await renderSurface();

    expect(rendered).toContain("130 lines below");
  });

  it("singularizes the noun when exactly one row is below", async () => {
    setScrollState({ sticky: false, scrollTop: 0, viewportHeight: 20, scrollHeight: 21 });
    const rendered = await renderSurface();

    expect(rendered).toContain("1 line below");
    expect(rendered).not.toContain("1 lines below");
  });

  it("never overflows the viewport width, even when scrolled up", async () => {
    setScrollState({ sticky: false, scrollTop: 0, viewportHeight: 20, scrollHeight: 9999 });

    for (const columns of [80, 40, 24, 12]) {
      const rendered = await renderSurface(columns, 14);
      expect(maxRowWidth(rendered)).toBeLessThanOrEqual(columns);
    }
  });

  it("degrades at narrow widths without dropping into a second row", async () => {
    setScrollState({ sticky: false, scrollTop: 0, viewportHeight: 20, scrollHeight: 9999 });
    const rendered = await renderSurface(20, 14);

    // The single 1-row indicator must not wrap — a 20-col render still has the
    // arrow glyph, and the below text is truncated rather than wrapped.
    expect(maxRowWidth(rendered)).toBeLessThanOrEqual(20);
  });
});
