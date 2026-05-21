import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const compilerRuntime = vi.hoisted(() => {
  const sentinel = Symbol("memo-cache-sentinel");
  let cache: unknown[] = [];

  function reset(size = 8): void {
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

import { NoSelect } from "../../../src/tui/ink/components/NoSelect.js";

type NoSelectElement = React.ReactElement<{
  children?: React.ReactNode;
  flexDirection?: string;
  fromLeftEdge?: boolean;
  marginLeft?: number;
  noSelect?: boolean | "from-left-edge";
  paddingX?: number;
  width?: number;
}>;

function renderNoSelect(props: Parameters<typeof NoSelect>[0]): NoSelectElement {
  const element = NoSelect(props);

  expect(React.isValidElement(element)).toBe(true);
  return element as NoSelectElement;
}

describe("NoSelect coverage swarm row 178", () => {
  beforeEach(() => {
    compilerRuntime.reset();
    compilerRuntime.c.mockClear();
  });

  test("wraps children in a selectable-exclusion Box by default", () => {
    const element = renderNoSelect({
      children: "plain text",
      flexDirection: "column",
      marginLeft: 2,
    });

    expect(element.props.noSelect).toBe(true);
    expect(element.props.children).toBe("plain text");
    expect(element.props.flexDirection).toBe("column");
    expect(element.props.marginLeft).toBe(2);
    expect(element.props.fromLeftEdge).toBeUndefined();
  });

  test("extends the exclusion region from the left edge when requested", () => {
    const child = <ink-text>gutter</ink-text>;
    const element = renderNoSelect({
      children: child,
      fromLeftEdge: true,
      width: 6,
    });

    expect(element.props.noSelect).toBe("from-left-edge");
    expect(element.props.children).toBe(child);
    expect(element.props.width).toBe(6);
    expect(element.props.fromLeftEdge).toBeUndefined();
  });

  test("reuses the memoized Box element for identical props", () => {
    const props = {
      children: "stable",
      paddingX: 1,
    };

    const first = renderNoSelect(props);
    const second = renderNoSelect(props);

    expect(second).toBe(first);
    expect(compilerRuntime.c).toHaveBeenCalledTimes(2);
  });
});
