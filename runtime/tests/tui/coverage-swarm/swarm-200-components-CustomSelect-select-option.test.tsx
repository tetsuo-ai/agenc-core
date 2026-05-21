import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRoot, type Root } from "../../../src/tui/ink/root.js";
import { SelectOption } from "../../../src/tui/components/CustomSelect/select-option.js";

const listItemMock = vi.hoisted(() => ({
  calls: [] as Array<{
    children?: React.ReactNode;
    declareCursor?: boolean;
    description?: string;
    isFocused: boolean;
    isSelected?: boolean;
    showScrollDown?: boolean;
    showScrollUp?: boolean;
    styled?: boolean;
  }>,
}));

vi.mock("../../../src/tui/components/design-system/ListItem.js", async () => {
  const ReactActual = await vi.importActual<typeof import("react")>("react");

  return {
    ListItem: (props: (typeof listItemMock.calls)[number]) => {
      listItemMock.calls.push(props);

      return ReactActual.createElement("ink-text", null, props.children);
    },
  };
});

const mountedRoots: Root[] = [];

async function makeRoot(): Promise<Root> {
  const stdout = new PassThrough() as PassThrough & { columns: number };
  stdout.columns = 80;

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref: () => void;
    setRawMode: (mode: boolean) => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });
  mountedRoots.push(root);

  return root;
}

async function renderAndWait(root: Root, node: React.ReactNode): Promise<void> {
  root.render(node);
  await new Promise(resolve => setTimeout(resolve, 30));
}

describe("SelectOption coverage swarm row 200", () => {
  beforeEach(() => {
    listItemMock.calls = [];
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      root.unmount();
    }
  });

  test("forwards option state, scroll hints, description, and cursor control", async () => {
    const root = await makeRoot();

    await renderAndWait(
      root,
      <SelectOption
        isFocused={true}
        isSelected={true}
        description="Secondary details"
        shouldShowDownArrow={true}
        shouldShowUpArrow={true}
        declareCursor={false}
      >
        Primary option
      </SelectOption>,
    );

    expect(listItemMock.calls).toHaveLength(1);
    expect(listItemMock.calls[0]).toMatchObject({
      declareCursor: false,
      description: "Secondary details",
      isFocused: true,
      isSelected: true,
      showScrollDown: true,
      showScrollUp: true,
      styled: false,
    });
    expect(listItemMock.calls[0]?.children).toBe("Primary option");
  });

  test("keeps optional ListItem props unset when no option adornments are requested", async () => {
    const root = await makeRoot();

    await renderAndWait(
      root,
      <SelectOption isFocused={false} isSelected={false}>
        Plain option
      </SelectOption>,
    );

    expect(listItemMock.calls[0]).toMatchObject({
      isFocused: false,
      isSelected: false,
      styled: false,
    });
    expect(listItemMock.calls[0]?.declareCursor).toBeUndefined();
    expect(listItemMock.calls[0]?.description).toBeUndefined();
    expect(listItemMock.calls[0]?.showScrollDown).toBeUndefined();
    expect(listItemMock.calls[0]?.showScrollUp).toBeUndefined();
  });

  test("reuses the cached ListItem element until a forwarded prop changes", async () => {
    const root = await makeRoot();
    const label = "Cached option";

    await renderAndWait(
      root,
      <SelectOption isFocused={false} isSelected={false}>
        {label}
      </SelectOption>,
    );
    expect(listItemMock.calls).toHaveLength(1);

    await renderAndWait(
      root,
      <SelectOption isFocused={false} isSelected={false}>
        {label}
      </SelectOption>,
    );
    expect(listItemMock.calls).toHaveLength(1);

    await renderAndWait(
      root,
      <SelectOption
        isFocused={false}
        isSelected={false}
        declareCursor={false}
      >
        {label}
      </SelectOption>,
    );
    expect(listItemMock.calls).toHaveLength(2);

    await renderAndWait(
      root,
      <SelectOption
        isFocused={false}
        isSelected={false}
        declareCursor={false}
        description="Updated detail"
      >
        {label}
      </SelectOption>,
    );
    expect(listItemMock.calls).toHaveLength(3);

    await renderAndWait(
      root,
      <SelectOption
        isFocused={true}
        isSelected={false}
        declareCursor={false}
        description="Updated detail"
      >
        {label}
      </SelectOption>,
    );
    expect(listItemMock.calls).toHaveLength(4);

    await renderAndWait(
      root,
      <SelectOption
        isFocused={true}
        isSelected={true}
        declareCursor={false}
        description="Updated detail"
      >
        {label}
      </SelectOption>,
    );
    expect(listItemMock.calls).toHaveLength(5);

    await renderAndWait(
      root,
      <SelectOption
        isFocused={true}
        isSelected={true}
        declareCursor={false}
        description="Updated detail"
        shouldShowDownArrow={true}
      >
        {label}
      </SelectOption>,
    );
    expect(listItemMock.calls).toHaveLength(6);

    await renderAndWait(
      root,
      <SelectOption
        isFocused={true}
        isSelected={true}
        declareCursor={false}
        description="Updated detail"
        shouldShowDownArrow={true}
        shouldShowUpArrow={true}
      >
        {label}
      </SelectOption>,
    );
    expect(listItemMock.calls).toHaveLength(7);
    expect(listItemMock.calls.at(-1)).toMatchObject({
      declareCursor: false,
      description: "Updated detail",
      isFocused: true,
      isSelected: true,
      showScrollDown: true,
      showScrollUp: true,
      styled: false,
    });
  });
});
