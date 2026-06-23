import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the props ScrollBox is rendered with so we can assert the exact
// sticky-scroll wiring TranscriptSurface chooses. The mock renders its children
// so the surface tree still mounts.
const scrollBoxHarness = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../src/tui/ink/components/ScrollBox.js", async () => {
  const ReactModule = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      scrollBoxHarness.props.push(props);
      return ReactModule.createElement(ReactModule.Fragment, null, props.children as React.ReactNode);
    },
  };
});

import { TranscriptSurface } from "../../../src/tui/workbench/surfaces/TranscriptSurface.js";
import type { ScrollBoxHandle } from "../../../src/tui/ink/components/ScrollBox.js";
import { Text } from "../../../src/tui/ink.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("TranscriptSurface cold-start sticky scroll", () => {
  beforeEach(() => {
    scrollBoxHarness.props = [];
  });

  it("does NOT pin to the bottom at cold start so the welcome hero stays on screen", async () => {
    const scrollRef = React.createRef<ScrollBoxHandle>();
    await renderToString(
      <TranscriptSurface scrollRef={scrollRef} atWelcome>
        <Text>welcome body</Text>
      </TranscriptSurface>,
      { columns: 80, rows: 14 },
    );

    const scrollBox = scrollBoxHarness.props.at(-1);
    expect(scrollBox).toBeDefined();
    // The bug: a sticky-bottom ScrollBox scrolled the brand line off the top on
    // a short viewport. At cold start the surface must start at the top.
    expect(scrollBox?.stickyScroll).toBe(false);
  });

  it("pins to the bottom once the transcript has real messages (follow behaviour)", async () => {
    const scrollRef = React.createRef<ScrollBoxHandle>();
    await renderToString(
      <TranscriptSurface scrollRef={scrollRef}>
        <Text>conversation body</Text>
      </TranscriptSurface>,
      { columns: 80, rows: 14 },
    );

    const scrollBox = scrollBoxHarness.props.at(-1);
    expect(scrollBox).toBeDefined();
    expect(scrollBox?.stickyScroll).toBe(true);
  });
});
