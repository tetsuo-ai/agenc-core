import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { renderToString } from "../../../utils/staticRender.js";
import type { MultiSelectState, UseMultiSelectStateProps } from "./use-multi-select-state.js";
import type { OptionWithDescription } from "./select.js";

const stateMock = vi.hoisted(() => ({
  hookProps: [] as UseMultiSelectStateProps<string>[],
  state: undefined as undefined | MultiSelectState<string>,
}));

const optionMock = vi.hoisted(() => ({
  props: [] as Array<{
    description?: string;
    isFocused: boolean;
    isSelected: boolean;
    shouldShowDownArrow?: boolean;
    shouldShowUpArrow?: boolean;
    children: React.ReactNode;
  }>,
}));

const inputOptionMock = vi.hoisted(() => ({
  props: [] as Array<{
    index: number;
    inputValue: string;
    isFocused: boolean;
    isSelected: boolean;
    layout: string;
    maxIndexWidth: number;
    onExit?: () => void;
    onInputChange: (value: string) => void;
    option: Extract<OptionWithDescription<string>, { type: "input" }>;
    shouldShowDownArrow: boolean;
    shouldShowUpArrow: boolean;
    children: React.ReactNode;
  }>,
}));

vi.mock("./use-multi-select-state.js", () => ({
  useMultiSelectState: (props: UseMultiSelectStateProps<string>) => {
    stateMock.hookProps.push(props);
    if (!stateMock.state) throw new Error("missing mocked multi-select state");
    return stateMock.state;
  },
}));

vi.mock("./select-option.js", () => ({
  SelectOption: (props: (typeof optionMock.props)[number]) => {
    optionMock.props.push(props);
    return <>{props.children}</>;
  },
}));

vi.mock("./select-input-option.js", () => ({
  SelectInputOption: (props: (typeof inputOptionMock.props)[number]) => {
    inputOptionMock.props.push(props);
    return <>{props.children}</>;
  },
}));

function textOption(
  value: string,
  description?: string,
): OptionWithDescription<string> {
  return { label: value.toUpperCase(), value, description };
}

function inputOption(value: string): Extract<
  OptionWithDescription<string>,
  { type: "input" }
> {
  return {
    type: "input",
    label: `${value} label`,
    value,
    onChange: () => {},
  };
}

function state(
  overrides: Partial<MultiSelectState<string>> = {},
): MultiSelectState<string> {
  return {
    focusedValue: "two",
    inputValues: new Map(),
    isInInput: false,
    isSubmitFocused: false,
    onCancel: vi.fn(),
    options: [textOption("one"), textOption("two"), textOption("three")],
    selectedValues: ["one"],
    updateInputValue: vi.fn(),
    visibleFromIndex: 0,
    visibleOptions: [
      { ...textOption("one", "first"), index: 0 },
      { ...textOption("two", "second"), index: 1 },
    ],
    visibleToIndex: 2,
    ...overrides,
  };
}

describe("SelectMulti", () => {
  beforeEach(() => {
    optionMock.props = [];
    inputOptionMock.props = [];
    stateMock.hookProps = [];
    stateMock.state = state();
  });

  test("passes normalized props into the multi-select state hook", async () => {
    const onCancel = vi.fn();
    const { SelectMulti } = await import("./SelectMulti.js");

    await renderToString(
      <SelectMulti options={[textOption("one")]} onCancel={onCancel} />,
      80,
    );

    expect(stateMock.hookProps.at(-1)).toMatchObject({
      defaultValue: [],
      hideIndexes: false,
      isDisabled: false,
      onCancel,
      options: [{ label: "ONE", value: "one" }],
      visibleOptionCount: 5,
    });
  });

  test("renders text options with indexes, selection, focus, and scroll hints", async () => {
    const { SelectMulti } = await import("./SelectMulti.js");

    const output = await renderToString(
      <SelectMulti
        options={[textOption("one"), textOption("two"), textOption("three")]}
        defaultValue={["one"]}
        onCancel={vi.fn()}
        visibleOptionCount={2}
      />,
      120,
    );

    expect(output).toContain("1.");
    expect(output).toContain("2.");
    expect(output).toContain("[");
    expect(output).toContain("ONE");
    expect(output).toContain("TWO");
    expect(optionMock.props).toHaveLength(2);
    expect(optionMock.props[0]).toMatchObject({
      description: "first",
      isFocused: false,
      isSelected: false,
      shouldShowDownArrow: false,
      shouldShowUpArrow: false,
    });
    expect(optionMock.props[1]).toMatchObject({
      description: "second",
      isFocused: true,
      isSelected: false,
      shouldShowDownArrow: true,
      shouldShowUpArrow: false,
    });
  });

  test("renders input options and forwards input changes and exits", async () => {
    const onCancel = vi.fn();
    const updateInputValue = vi.fn();
    const option = inputOption("name");
    stateMock.state = state({
      focusedValue: "name",
      inputValues: new Map([["name", "Alice"]]),
      selectedValues: ["name"],
      updateInputValue,
      visibleFromIndex: 1,
      visibleOptions: [{ ...option, index: 1 }],
      visibleToIndex: 2,
    });

    const { SelectMulti } = await import("./SelectMulti.js");
    const output = await renderToString(
      <SelectMulti
        options={[textOption("before"), option, textOption("after")]}
        onCancel={onCancel}
        onImagePaste={vi.fn()}
        onOpenEditor={vi.fn()}
        onRemoveImage={vi.fn()}
        pastedContents={{
          1: {
            id: 1,
            content: "image",
            mediaType: "image/png",
          },
        }}
      />,
      120,
    );

    expect(output).toContain("[");
    expect(inputOptionMock.props).toHaveLength(1);
    expect(inputOptionMock.props[0]).toMatchObject({
      index: 2,
      inputValue: "Alice",
      isFocused: true,
      isSelected: false,
      layout: "compact",
      maxIndexWidth: 1,
      option,
      shouldShowDownArrow: true,
      shouldShowUpArrow: true,
    });

    inputOptionMock.props[0]!.onInputChange("Bob");
    expect(updateInputValue).toHaveBeenCalledWith("name", "Bob");

    inputOptionMock.props[0]!.onExit?.();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test("hides indexes and suppresses option focus while disabled", async () => {
    stateMock.state = state({
      focusedValue: "two",
      selectedValues: [],
    });
    const { SelectMulti } = await import("./SelectMulti.js");

    const output = await renderToString(
      <SelectMulti
        hideIndexes={true}
        isDisabled={true}
        options={[textOption("one"), textOption("two"), textOption("three")]}
        onCancel={vi.fn()}
      />,
      120,
    );

    expect(output).not.toContain("1.");
    expect(output).not.toContain("2.");
    expect(optionMock.props.map(props => props.isFocused)).toEqual([
      false,
      false,
    ]);
    expect(stateMock.hookProps.at(-1)).toMatchObject({
      hideIndexes: true,
      isDisabled: true,
    });
  });

  test("renders submit buttons in focused and unfocused states", async () => {
    const onSubmit = vi.fn();
    const { SelectMulti } = await import("./SelectMulti.js");

    stateMock.state = state({ isSubmitFocused: true });
    const focused = await renderToString(
      <SelectMulti
        options={[textOption("one")]}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        submitButtonText="Import"
      />,
      120,
    );

    expect(focused).toContain("Import");
    expect(stateMock.hookProps.at(-1)).toMatchObject({
      onSubmit,
      submitButtonText: "Import",
    });

    stateMock.state = state({ isSubmitFocused: false });
    const unfocused = await renderToString(
      <SelectMulti
        options={[textOption("one")]}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        submitButtonText="Import"
      />,
      120,
    );

    expect(unfocused).toContain("Import");
  });
});
