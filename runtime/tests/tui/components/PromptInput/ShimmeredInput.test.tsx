import React from "react";
import { describe, expect, test, vi } from "vitest";

import { renderToString } from "../../../utils/staticRender.js";
import { Text } from "../../ink.js";
import { HighlightedInput } from "./ShimmeredInput.js";

vi.mock("../spinner/ShimmerChar.js", () => ({
  ShimmerChar: ({
    char,
    glimmerIndex,
    index,
    messageColor,
    shimmerColor,
  }: {
    char: string;
    glimmerIndex: number;
    index: number;
    messageColor: string;
    shimmerColor: string;
  }) => (
    <Text>
      {`S(${char}:${index}:${glimmerIndex}:${messageColor}:${shimmerColor})`}
    </Text>
  ),
}));

describe("HighlightedInput", () => {
  test("renders plain text and empty lines without highlights", async () => {
    const output = await renderToString(
      <HighlightedInput highlights={[]} text={"alpha\n\nbeta"} />,
      80,
    );

    expect(output).toContain("alpha");
    expect(output).toContain("beta");
  });

  test("treats undefined split parts as empty lines", async () => {
    const originalSplit = String.prototype.split;
    const splitSpy = vi
      .spyOn(String.prototype, "split")
      .mockImplementation(function split(
        this: string,
        separator: string | RegExp,
        limit?: number,
      ) {
        if (String(this) === "alpha\nbeta" && separator === "\n") {
          return ["alpha", undefined, "beta"] as unknown as string[];
        }

        return originalSplit.call(this, separator, limit);
      });

    try {
      const output = await renderToString(
        <HighlightedInput highlights={[]} text={"alpha\nbeta"} />,
        80,
      );

      expect(output).toContain("alpha");
      expect(output).toContain("beta");
    } finally {
      splitSpy.mockRestore();
    }
  });

  test("renders highlighted text through normal Text and Ansi when shimmer is incomplete", async () => {
    const output = await renderToString(
      <HighlightedInput
        text="abcdef"
        highlights={[
          {
            color: "success",
            dimColor: true,
            end: 3,
            inverse: true,
            priority: 1,
            shimmerColor: undefined,
            start: 1,
          },
        ]}
      />,
      80,
    );

    expect(output).toContain("abcdef");
    expect(output).not.toContain("S(");
  });

  test("falls back to normal text when shimmer color has no message color", async () => {
    const output = await renderToString(
      <HighlightedInput
        text="abcdef"
        highlights={[
          {
            end: 4,
            priority: 1,
            shimmerColor: "agencShimmer",
            start: 1,
          },
        ]}
      />,
      80,
    );

    expect(output).toContain("abcdef");
    expect(output).not.toContain("S(");
  });

  test("renders shimmer highlights character-by-character with visible indexes", async () => {
    const output = await renderToString(
      <HighlightedInput
        text="abcdef"
        highlights={[
          {
            color: "agenc",
            end: 4,
            priority: 1,
            shimmerColor: "agencShimmer",
            start: 1,
          },
        ]}
      />,
      120,
    );

    expect(output).toContain("a");
    expect(output).toContain("S(b:1:-100:agenc:agencShimmer)");
    expect(output).toContain("S(c:2:-100:agenc:agencShimmer)");
    expect(output).toContain("S(d:3:-100:agenc:agencShimmer)");
    expect(output).toContain("ef");
  });
});
