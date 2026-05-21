import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const compilerRuntime = vi.hoisted(() => {
  const sentinel = Symbol.for("react.memo_cache_sentinel");
  let cache: unknown[] = [];

  function reset(size = 10): void {
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

const spinnerFixture = vi.hoisted(() => ({
  Spinner: function MockSpinner() {
    return null;
  },
}));

vi.mock("react-compiler-runtime", () => ({
  c: compilerRuntime.c,
}));

vi.mock("../../../src/tui/components/spinner/Spinner.js", () => ({
  Spinner: spinnerFixture.Spinner,
}));

import { LoadingState } from "../../../src/tui/components/design-system/LoadingState.js";

type LoadingStateElement = React.ReactElement<{
  children?: React.ReactNode;
  flexDirection?: string;
}>;

type TextElement = React.ReactElement<{
  bold?: boolean;
  children?: React.ReactNode;
  dimColor?: boolean;
}>;

function requireElement(node: React.ReactNode, label: string): LoadingStateElement {
  expect(React.isValidElement(node), label).toBe(true);
  return node as LoadingStateElement;
}

function childrenOf(element: LoadingStateElement): React.ReactNode[] {
  return React.Children.toArray(element.props.children);
}

function renderLoadingState(
  props: React.ComponentProps<typeof LoadingState>,
): LoadingStateElement {
  return requireElement(LoadingState(props), "LoadingState root");
}

describe("LoadingState coverage swarm row 150", () => {
  beforeEach(() => {
    compilerRuntime.reset();
    compilerRuntime.c.mockClear();
  });

  test("renders the default loading row without a subtitle and reuses memoized output", () => {
    const first = renderLoadingState({ message: "Loading sessions" });
    const rootChildren = childrenOf(first);
    const row = requireElement(rootChildren[0], "loading row");
    const rowChildren = childrenOf(row);
    const message = requireElement(rowChildren[1], "message text") as TextElement;

    expect(compilerRuntime.c).toHaveBeenCalledWith(10);
    expect(first.props.flexDirection).toBe("column");
    expect(rootChildren).toHaveLength(1);
    expect(row.props.flexDirection).toBe("row");
    expect(requireElement(rowChildren[0], "spinner").type).toBe(
      spinnerFixture.Spinner,
    );
    expect(message.props).toMatchObject({
      bold: false,
      dimColor: false,
    });
    expect(message.props.children).toEqual([" ", "Loading sessions"]);

    const second = renderLoadingState({ message: "Loading sessions" });

    expect(second).toBe(first);
  });

  test("applies explicit emphasis props and adds a dim subtitle", () => {
    const withoutSubtitle = renderLoadingState({ message: "Loading" });

    const withSubtitle = renderLoadingState({
      bold: true,
      dimColor: true,
      message: "Loading teams",
      subtitle: "Fetching project state",
    });
    const rootChildren = childrenOf(withSubtitle);
    const row = requireElement(rootChildren[0], "loading row");
    const rowChildren = childrenOf(row);
    const message = requireElement(rowChildren[1], "message text") as TextElement;
    const subtitle = requireElement(rootChildren[1], "subtitle") as TextElement;

    expect(withSubtitle).not.toBe(withoutSubtitle);
    expect(requireElement(rowChildren[0], "spinner").type).toBe(
      spinnerFixture.Spinner,
    );
    expect(message.props).toMatchObject({
      bold: true,
      dimColor: true,
    });
    expect(message.props.children).toEqual([" ", "Loading teams"]);
    expect(subtitle.props).toMatchObject({ dimColor: true });
    expect(subtitle.props.children).toBe("Fetching project state");
  });
});
