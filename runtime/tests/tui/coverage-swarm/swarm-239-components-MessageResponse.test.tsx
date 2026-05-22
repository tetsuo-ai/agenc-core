import type { ReactNode } from "react";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ratchetHarness = vi.hoisted(() => ({
  calls: [] as Array<{ readonly lock?: "always" | "offscreen" }>,
  reset() {
    ratchetHarness.calls = [];
  },
}));

vi.mock("../../../src/tui/components/design-system/Ratchet.js", async () => {
  const ReactModule = await import("react");
  const { Box, Text } = await import("../../../src/tui/ink.js");

  return {
    Ratchet({
      children,
      lock,
    }: {
      readonly children: ReactNode;
      readonly lock?: "always" | "offscreen";
    }) {
      ratchetHarness.calls.push({ lock });

      return ReactModule.createElement(
        Box,
        { flexDirection: "column" },
        ReactModule.createElement(Text, null, `ratchet:${lock ?? "always"}`),
        children,
        ReactModule.createElement(Text, null, "/ratchet"),
      );
    },
  };
});

import { MessageResponse } from "../../../src/tui/components/MessageResponse.js";
import { Text } from "../../../src/tui/ink.js";
import { renderToString } from "../../../src/utils/staticRender.js";

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS;

async function renderResponse(node: ReactNode): Promise<string> {
  return renderToString(<>{node}</>, { columns: 80, rows: 12 });
}

describe("MessageResponse coverage swarm row 239", () => {
  beforeEach(() => {
    ratchetHarness.reset();
    process.env.AGENC_TUI_GLYPHS = "ascii";
  });

  afterEach(() => {
    if (originalGlyphMode === undefined) {
      delete process.env.AGENC_TUI_GLYPHS;
    } else {
      process.env.AGENC_TUI_GLYPHS = originalGlyphMode;
    }
  });

  test("wraps auto-height responses in an offscreen ratchet with a response gutter", async () => {
    const output = await renderResponse(
      <MessageResponse>
        <Text>auto-height reply</Text>
      </MessageResponse>,
    );

    expect(ratchetHarness.calls).toEqual([{ lock: "offscreen" }]);
    expect(output).toContain("ratchet:offscreen");
    expect(output).toContain("|_");
    expect(output).toContain("auto-height reply");
  });

  test("renders fixed-height responses directly without ratchet wrapping", async () => {
    const output = await renderResponse(
      <MessageResponse height={2}>
        <Text>fixed-height reply</Text>
      </MessageResponse>,
    );

    expect(ratchetHarness.calls).toEqual([]);
    expect(output).not.toContain("ratchet:");
    expect(output).toContain("|_");
    expect(output).toContain("fixed-height reply");
  });

  test("does not add a second gutter for nested message responses", async () => {
    const output = await renderResponse(
      <MessageResponse height={4}>
        <Text>outer reply</Text>
        <MessageResponse>
          <Text>inner reply</Text>
        </MessageResponse>
      </MessageResponse>,
    );

    expect(output.match(/\|_/g) ?? []).toHaveLength(1);
    expect(output).toContain("outer reply");
    expect(output).toContain("inner reply");
  });
});
