import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const compilerRuntime = vi.hoisted(() => {
  const sentinel = Symbol("memo-cache-sentinel");
  let cache: unknown[] = [];

  function reset(size = 4): void {
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

import Newline from "../../../src/tui/ink/components/Newline.js";

type NewlineElement = React.ReactElement<{
  children: string;
}>;

function renderNewline(props: Parameters<typeof Newline>[0]): NewlineElement {
  const element = Newline(props);

  expect(React.isValidElement(element)).toBe(true);
  return element as NewlineElement;
}

describe("Newline coverage swarm row 225", () => {
  beforeEach(() => {
    compilerRuntime.reset();
    compilerRuntime.c.mockClear();
  });

  test("renders a single newline by default", () => {
    const element = renderNewline({});

    expect(element.type).toBe("ink-text");
    expect(element.props.children).toBe("\n");
  });

  test("renders the requested number of newline characters", () => {
    const element = renderNewline({ count: 3 });

    expect(element.type).toBe("ink-text");
    expect(element.props.children).toBe("\n\n\n");
  });

  test("supports zero newlines and reuses the cached element for stable input", () => {
    const first = renderNewline({ count: 0 });
    const second = renderNewline({ count: 0 });

    expect(first.props.children).toBe("");
    expect(second).toBe(first);
    expect(compilerRuntime.c).toHaveBeenCalledTimes(2);
  });
});
