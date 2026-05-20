import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../utils/staticRender.js";

const structuredDiffMock = vi.hoisted(() => ({
  props: [] as Array<{
    dim: boolean;
    fileContent?: string;
    filePath: string;
    firstLine: string | null;
    patch: { newStart: number };
    width: number;
  }>,
}));

vi.mock("./StructuredDiff", () => ({
  StructuredDiff: (props: (typeof structuredDiffMock.props)[number]) => {
    structuredDiffMock.props.push(props);
    return null;
  },
}));

function hunk(newStart: number) {
  return {
    lines: [],
    newLines: 0,
    newStart,
    oldLines: 0,
    oldStart: newStart,
  };
}

describe("StructuredDiffList", () => {
  beforeEach(() => {
    structuredDiffMock.props = [];
  });

  test("renders each hunk and inserts ellipsis separators", async () => {
    const { StructuredDiffList } = await import("./StructuredDiffList.js");

    const output = await renderToString(
      <StructuredDiffList
        dim={true}
        fileContent={"alpha\nbeta"}
        filePath="src/app.ts"
        firstLine="alpha"
        hunks={[hunk(1), hunk(10), hunk(20)]}
        width={100}
      />,
      120,
    );

    expect(output).toContain("...");
    expect(structuredDiffMock.props).toHaveLength(3);
    expect(structuredDiffMock.props.map(props => props.patch.newStart)).toEqual([
      1,
      10,
      20,
    ]);
    expect(structuredDiffMock.props[0]).toMatchObject({
      dim: true,
      fileContent: "alpha\nbeta",
      filePath: "src/app.ts",
      firstLine: "alpha",
      width: 100,
    });
  });

  test("renders an empty list without hunks or separators", async () => {
    const { StructuredDiffList } = await import("./StructuredDiffList.js");

    const output = await renderToString(
      <StructuredDiffList
        dim={false}
        filePath="src/empty.ts"
        firstLine={null}
        hunks={[]}
        width={80}
      />,
      80,
    );

    expect(output).not.toContain("...");
    expect(structuredDiffMock.props).toEqual([]);
  });
});
