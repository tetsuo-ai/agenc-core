import React, { useLayoutEffect, useState } from "react";
import { describe, expect, test } from "vitest";

import { SearchBox } from "../../../src/tui/components/SearchBox.js";
import {
  renderToAnsiString,
  renderToString,
} from "../../../src/utils/staticRender.js";

async function renderSearchBox(
  props: React.ComponentProps<typeof SearchBox>,
): Promise<string> {
  return renderToString(<SearchBox {...props} />, { columns: 40 });
}

function RerenderSameSearchBox() {
  const [rerendered, setRerendered] = useState(false);

  useLayoutEffect(() => {
    if (!rerendered) setRerendered(true);
  }, [rerendered]);

  return (
    <SearchBox
      query="cached"
      prefix=">"
      placeholder="Find"
      isFocused={true}
      isTerminalFocused={true}
      cursorOffset={2}
      width={18}
    />
  );
}

describe("SearchBox coverage swarm row 205", () => {
  test("renders terminal cursor branches inside a query and at the query end", async () => {
    const middleCursor = await renderToAnsiString(
      <SearchBox
        query="abc"
        prefix=">"
        placeholder="Find"
        isFocused={true}
        isTerminalFocused={true}
        cursorOffset={1}
        borderless={true}
      />,
      { columns: 40, color: true },
    );
    const endCursor = await renderSearchBox({
      query: "go",
      prefix: ">",
      placeholder: "Find",
      isFocused: true,
      isTerminalFocused: true,
      cursorOffset: 2,
      borderless: true,
    });

    expect(middleCursor).toContain("a");
    expect(middleCursor).toContain("b");
    expect(middleCursor).toContain("c");
    expect(middleCursor).toContain("\x1B[7m");
    expect(endCursor).toContain("> go");
  });

  test("renders focused and unfocused text without terminal cursor styling", async () => {
    await expect(
      renderSearchBox({
        query: "plain",
        prefix: ">",
        placeholder: "Find",
        isFocused: true,
        isTerminalFocused: false,
        borderless: true,
      }),
    ).resolves.toContain("> plain");

    await expect(
      renderSearchBox({
        query: "match",
        prefix: ">",
        placeholder: "Find",
        isFocused: false,
        isTerminalFocused: false,
        borderless: true,
      }),
    ).resolves.toContain("> match");

    await expect(
      renderSearchBox({
        query: "",
        prefix: ">",
        placeholder: "Find",
        isFocused: false,
        isTerminalFocused: true,
        borderless: true,
      }),
    ).resolves.toContain("> Find");
  });

  test("renders focused terminal placeholders and survives same-props rerenders", async () => {
    await expect(
      renderSearchBox({
        query: "",
        prefix: ">",
        placeholder: "Find",
        isFocused: true,
        isTerminalFocused: true,
        borderless: true,
      }),
    ).resolves.toContain("> Find");

    await expect(
      renderToString(<RerenderSameSearchBox />, { columns: 40 }),
    ).resolves.toContain("> cached");
  });
});
