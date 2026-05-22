import React from "react";
import { describe, expect, it } from "vitest";

import { SearchSurfaceView } from "../../../src/tui/workbench/surfaces/SearchSurface.js";
import { renderToString } from "../../../src/utils/staticRender.js";

describe("SearchSurfaceView", () => {
  it("renders loading, no result, error, and truncated states", async () => {
    const loading = await renderToString(
      <SearchSurfaceView query="needle" matches={[]} selected={0} loading={true} error={null} focused={true} />,
      80,
    );
    const empty = await renderToString(
      <SearchSurfaceView query="needle" matches={[]} selected={0} loading={false} error={null} focused={true} />,
      80,
    );
    const error = await renderToString(
      <SearchSurfaceView query="needle" matches={[]} selected={0} loading={false} error="ripgrep failed" focused={true} />,
      80,
    );
    const truncated = await renderToString(
      <SearchSurfaceView
        query="needle"
        matches={Array.from({ length: 500 }, (_, index) => ({
          id: `src/app.ts:${index + 1}:needle`,
          file: "src/app.ts",
          line: index + 1,
          text: "needle",
        }))}
        selected={0}
        loading={false}
        error={null}
        focused={true}
      />,
      80,
    );

    expect(loading).toContain("searching");
    expect(empty).toContain("No results");
    expect(error).toContain("ripgrep failed");
    expect(truncated).toContain("Results truncated at 500 matches");
  });

  it("renders grouped results and selected match actions without overflow", async () => {
    const output = await renderToString(
      <SearchSurfaceView
        query="needle"
        matches={[
          { id: "src/app.ts:4:needle", file: "src/app.ts", line: 4, text: "const needle = true" },
          { id: "src/other.ts:9:needle", file: "src/other.ts", line: 9, text: "needle()" },
        ]}
        selected={1}
        loading={false}
        error={null}
        focused={true}
      />,
      60,
    );

    expect(output).toContain("src/app.ts");
    expect(output).toContain("src/other.ts");
    expect(output).toContain("@ attach");
    for (const line of output.split(/\r?\n/u)) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });
});
