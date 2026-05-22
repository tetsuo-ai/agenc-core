import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const compilerRuntime = vi.hoisted(() => {
  const sentinel = Symbol("memo-cache-sentinel");
  let cache: unknown[] = [];

  function reset(size = 6): void {
    cache = Array.from({ length: size }, () => sentinel);
  }

  reset();

  return {
    c: vi.fn((size: number) => {
      if (cache.length !== size) reset(size);
      return cache;
    }),
    reset,
  };
});

vi.mock("react-compiler-runtime", () => ({
  c: compilerRuntime.c,
}));

import { RawAnsi } from "../../../src/tui/ink/components/RawAnsi.js";

type RawAnsiElement = React.ReactElement<{
  rawHeight: number;
  rawText: string;
  rawWidth: number;
}>;

function renderRawAnsi(
  props: Parameters<typeof RawAnsi>[0],
): RawAnsiElement | null {
  const element = RawAnsi(props);

  if (element !== null) {
    expect(React.isValidElement(element)).toBe(true);
  }

  return element as RawAnsiElement | null;
}

describe("RawAnsi coverage swarm row 210", () => {
  beforeEach(() => {
    compilerRuntime.reset();
    compilerRuntime.c.mockClear();
  });

  test("returns null when there are no raw lines", () => {
    expect(renderRawAnsi({ lines: [], width: 12 })).toBeNull();
    expect(compilerRuntime.c).toHaveBeenCalledWith(6);
  });

  test("joins raw lines and forwards the producer dimensions to the raw leaf", () => {
    const element = renderRawAnsi({
      lines: ["\x1b[31mred\x1b[0m", "", "plain"],
      width: 18,
    });

    expect(element?.type).toBe("ink-raw-ansi");
    expect(element?.props).toMatchObject({
      rawHeight: 3,
      rawText: "\x1b[31mred\x1b[0m\n\nplain",
      rawWidth: 18,
    });
  });

  test("reuses the memoized raw leaf for stable lines and width", () => {
    const lines = ["first row", "second row"];

    const first = renderRawAnsi({ lines, width: 20 });
    const second = renderRawAnsi({ lines, width: 20 });

    expect(second).toBe(first);
    expect(compilerRuntime.c).toHaveBeenCalledTimes(2);
  });

  test("keeps the joined text but refreshes the raw leaf when width changes", () => {
    const lines = ["gutter", "content"];

    const first = renderRawAnsi({ lines, width: 8 });
    const second = renderRawAnsi({ lines, width: 13 });

    expect(second).not.toBe(first);
    expect(second?.props).toMatchObject({
      rawHeight: 2,
      rawText: "gutter\ncontent",
      rawWidth: 13,
    });
  });
});
