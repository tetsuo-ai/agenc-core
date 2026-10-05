import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { BaseBox as Box, Text } from "../../../src/tui/ink.js";
import { setDefaultTextColor } from "../../../src/tui/ink/render-node-to-output.js";
import { renderToAnsiString } from "../../../src/utils/staticRender.js";

// The fullscreen app paints its own background and text color, so no cell
// may fall back to the terminal's defaults: borders and opaque boxes take the
// inherited background, and text with no color takes the app text color.
const APP_BG = "\u001b[48;2;1;2;3m";
const APP_FG = "\u001b[38;2;250;250;250m";

function codesBefore(out: string, marker: string): string {
  const at = out.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  return out.slice(Math.max(0, at - 60), at);
}

afterEach(() => setDefaultTextColor(undefined));

describe("app-painted background", () => {
  it("paints a nested box border with the inherited background", async () => {
    const out = await renderToAnsiString(
      <Box backgroundColor="rgb(1,2,3)" width={20} height={4}>
        <Box borderStyle="single" width={10}>
          <Text>in</Text>
        </Box>
      </Box>,
      { columns: 20, rows: 4, color: true },
    );

    expect(codesBefore(out, "┌")).toContain(APP_BG);
  });

  it("fills an opaque box with no color of its own with the inherited background", async () => {
    const out = await renderToAnsiString(
      <Box backgroundColor="rgb(1,2,3)" width={20} height={3} flexDirection="column">
        <Box opaque width={12} height={1}>
          <Text>marker</Text>
        </Box>
      </Box>,
      { columns: 20, rows: 3, color: true },
    );

    expect(codesBefore(out, "marker")).toContain(APP_BG);
    // The box's empty cells after the text keep the background: it is never
    // dropped and re-applied later on the same row.
    const at = out.indexOf("marker");
    const row = out.slice(at, out.indexOf("\n", at) === -1 ? undefined : out.indexOf("\n", at));
    expect(row).not.toMatch(/\u001b\[49m.*\u001b\[48;2;1;2;3m/su);
  });

  it("gives text with no color the app text color", async () => {
    setDefaultTextColor("rgb(250,250,250)");
    const out = await renderToAnsiString(<Text>plain words</Text>, {
      columns: 20,
      rows: 1,
      color: true,
    });

    expect(codesBefore(out, "plain")).toContain(APP_FG);
  });

  it("keeps the terminal's text color when no app color is set", async () => {
    const out = await renderToAnsiString(<Text>plain words</Text>, {
      columns: 20,
      rows: 1,
      color: true,
    });

    expect(out).not.toContain(APP_FG);
  });
});
