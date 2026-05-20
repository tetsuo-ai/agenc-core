import { PassThrough } from "node:stream";

import React from "react";
import { describe, expect, test, vi } from "vitest";

import Text from "../../ink/components/Text.js";
import { createRoot } from "../../ink/root.js";
import type { InputEvent } from "../../ink/events/input-event.js";
import type { OptionWithDescription } from "./select.js";
import {
  type MultiSelectState,
  type UseMultiSelectStateProps,
  useMultiSelectState,
} from "./use-multi-select-state.js";

const inputMock = vi.hoisted(() => ({
  handler: undefined as
    | undefined
    | ((
      input: string,
      key: Record<string, boolean>,
      event: InputEvent,
    ) => void),
  options: undefined as undefined | { isActive?: boolean },
}));

const overlayMock = vi.hoisted(() => ({
  useRegisterOverlay: vi.fn(),
}));

vi.mock("../../context/overlayContext.js", () => overlayMock);

vi.mock("../../ink.js", async () => {
  const actual = await vi.importActual<typeof import("../../ink.js")>(
    "../../ink.js",
  );
  return {
    ...actual,
    useInput: (
      handler: (
        input: string,
        key: Record<string, boolean>,
        event: InputEvent,
      ) => void,
      options?: { isActive?: boolean },
    ) => {
      inputMock.handler = handler;
      inputMock.options = options;
    },
  };
});

vi.mock("../../../utils/debug.js", () => ({
  logForDebugging: () => {},
}));
vi.mock("../../../bootstrap/state.js", () => ({
  flushInteractionTime: () => {},
  getActiveTimeCounter: () => 0,
  markScrollActivity: () => {},
  updateLastInteractionTime: () => {},
}));
vi.mock("../../../utils/earlyInput.js", () => ({
  stopCapturingEarlyInput: () => {},
}));
vi.mock("../../../utils/envUtils.js", () => ({
  isEnvTruthy: () => false,
}));
vi.mock("../../../utils/fullscreen.js", () => ({
  isMouseClicksDisabled: () => true,
}));
vi.mock("../../../utils/log.js", () => ({
  logError: () => {},
}));

type Snapshot = {
  focusedValue: string | undefined;
  isInInput: boolean;
  isSubmitFocused: boolean;
  selectedValues: string[];
  inputValues: Array<[string, string]>;
  visibleValues: string[];
};

function createTestStreams() {
  const stdout = new PassThrough();
  (stdout as unknown as { columns: number }).columns = 120;
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  return { stdin, stdout };
}

function snapshotOf(state: MultiSelectState<string>): Snapshot {
  return {
    focusedValue: state.focusedValue,
    isInInput: state.isInInput,
    isSubmitFocused: state.isSubmitFocused,
    selectedValues: [...state.selectedValues],
    inputValues: [...state.inputValues.entries()],
    visibleValues: state.visibleOptions.map(option => option.value),
  };
}

function Harness({
  controlsRef,
  props,
  snapshots,
}: {
  controlsRef: { current: MultiSelectState<string> | null };
  props: UseMultiSelectStateProps<string>;
  snapshots: Snapshot[];
}): React.ReactNode {
  const state = useMultiSelectState(props);
  controlsRef.current = state;

  React.useEffect(() => {
    snapshots.push(snapshotOf(state));
  }, [snapshots, state]);

  return <Text>{state.focusedValue ?? "none"}</Text>;
}

async function renderHarness(
  props: UseMultiSelectStateProps<string>,
  snapshots: Snapshot[] = [],
) {
  const controlsRef = { current: null as MultiSelectState<string> | null };
  const { stdin, stdout } = createTestStreams();
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  });

  const render = (nextProps = props) => {
    root.render(
      <Harness
        controlsRef={controlsRef}
        props={nextProps}
        snapshots={snapshots}
      />,
    );
  };

  render();
  await waitForSnapshot(snapshots, {});

  return {
    controlsRef,
    render,
    snapshots,
    unmount: () => {
      root.unmount();
      stdin.end();
      stdout.end();
    },
  };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for multi-select state");
}

async function waitForSnapshot(
  snapshots: Snapshot[],
  expected: Partial<Snapshot>,
): Promise<void> {
  await waitForCondition(() =>
    snapshots.some(snapshot =>
      Object.entries(expected).every(([key, value]) =>
        Array.isArray(value)
          ? JSON.stringify(snapshot[key as keyof Snapshot]) ===
            JSON.stringify(value)
          : snapshot[key as keyof Snapshot] === value,
      ),
    ),
  );
}

async function waitForSelectedValues(
  controlsRef: { current: MultiSelectState<string> | null },
  expected: string[],
): Promise<void> {
  await waitForCondition(
    () =>
      JSON.stringify(controlsRef.current?.selectedValues ?? []) ===
      JSON.stringify(expected),
  );
}

async function waitForFocusedValue(
  controlsRef: { current: MultiSelectState<string> | null },
  expected: string,
): Promise<void> {
  await waitForCondition(() => controlsRef.current?.focusedValue === expected);
}

async function waitForSubmitFocus(
  controlsRef: { current: MultiSelectState<string> | null },
  expected: boolean,
): Promise<void> {
  await waitForCondition(
    () => controlsRef.current?.isSubmitFocused === expected,
  );
}

function key(overrides: Record<string, boolean> = {}) {
  return {
    ctrl: false,
    downArrow: false,
    escape: false,
    pageDown: false,
    pageUp: false,
    return: false,
    shift: false,
    tab: false,
    upArrow: false,
    ...overrides,
  };
}

function press(input = "", overrides: Record<string, boolean> = {}) {
  const event = {
    stopImmediatePropagation: vi.fn(),
  } as unknown as InputEvent;

  inputMock.handler?.(input, key(overrides), event);
  return event;
}

function textOption(value: string): OptionWithDescription<string> {
  return { label: value, value };
}

function inputOption(
  value: string,
  onChange = vi.fn(),
  initialValue?: string,
): OptionWithDescription<string> {
  return {
    type: "input",
    label: value,
    value,
    initialValue,
    onChange,
  };
}

describe("useMultiSelectState", () => {
  test("tracks input option values, selection changes, and option replacement resets", async () => {
    const onChange = vi.fn();
    const onInputChange = vi.fn();
    const initialOptions = [
      inputOption("name", onInputChange, "seed"),
      textOption("mode"),
    ];
    const snapshots: Snapshot[] = [];
    const rendered = await renderHarness(
      {
        options: initialOptions,
        defaultValue: ["mode"],
        onCancel: vi.fn(),
        onChange,
      },
      snapshots,
    );

    try {
      await waitForSnapshot(snapshots, {
        focusedValue: "name",
        isInInput: true,
        inputValues: [["name", "seed"]],
        selectedValues: ["mode"],
      });

      rendered.controlsRef.current?.updateInputValue("name", "alice");
      await waitForSnapshot(snapshots, {
        selectedValues: ["mode", "name"],
        inputValues: [["name", "alice"]],
      });
      expect(onInputChange).toHaveBeenCalledWith("alice");
      expect(onChange).toHaveBeenLastCalledWith(["mode", "name"]);

      rendered.controlsRef.current?.updateInputValue("name", "");
      await waitForSnapshot(snapshots, {
        selectedValues: ["mode"],
        inputValues: [["name", ""]],
      });
      expect(onChange).toHaveBeenLastCalledWith(["mode"]);

      rendered.controlsRef.current?.updateInputValue("mode", "ignored");
      await waitForSnapshot(snapshots, {
        selectedValues: ["mode"],
        inputValues: [
          ["name", ""],
          ["mode", "ignored"],
        ],
      });

      rendered.render({
        options: [textOption("fresh"), textOption("extra")],
        defaultValue: ["fresh"],
        onCancel: vi.fn(),
        onChange,
      });
      await waitForSnapshot(snapshots, {
        focusedValue: "fresh",
        selectedValues: ["fresh"],
        visibleValues: ["fresh", "extra"],
      });
    } finally {
      rendered.unmount();
    }
  });

  test("handles toggles, numeric shortcuts, direct submit, and escape", async () => {
    const onCancel = vi.fn();
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const snapshots: Snapshot[] = [];
    const rendered = await renderHarness(
      {
        options: [textOption("one"), textOption("two"), textOption("three")],
        onCancel,
        onChange,
        onSubmit,
      },
      snapshots,
    );

    try {
      press(" ");
      await waitForSelectedValues(rendered.controlsRef, ["one"]);
      expect(onChange).toHaveBeenLastCalledWith(["one"]);

      press(" ");
      await waitForCondition(
        () =>
          onChange.mock.calls.length === 2 &&
          rendered.controlsRef.current?.selectedValues.length === 0,
      );
      expect(onChange).toHaveBeenLastCalledWith([]);

      press("2");
      await waitForCondition(
        () =>
          onChange.mock.calls.length === 3 &&
          JSON.stringify(rendered.controlsRef.current?.selectedValues) ===
            JSON.stringify(["two"]),
      );

      press("2");
      await waitForCondition(
        () =>
          onChange.mock.calls.length === 4 &&
          rendered.controlsRef.current?.selectedValues.length === 0,
      );

      press("2");
      await waitForCondition(
        () =>
          onChange.mock.calls.length === 5 &&
          JSON.stringify(rendered.controlsRef.current?.selectedValues) ===
            JSON.stringify(["two"]),
      );

      press("３");
      await waitForCondition(
        () =>
          onChange.mock.calls.length === 6 &&
          JSON.stringify(rendered.controlsRef.current?.selectedValues) ===
            JSON.stringify(["two", "three"]),
      );

      press("0");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(onChange).toHaveBeenCalledTimes(6);

      press("", { return: true });
      expect(onSubmit).toHaveBeenCalledWith(["two", "three"]);

      const event = press("", { escape: true });
      expect(onCancel).toHaveBeenCalledOnce();
      expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    } finally {
      rendered.unmount();
    }
  });

  test("moves through options and the submit button with tab and arrow keys", async () => {
    const onDownFromLastItem = vi.fn();
    const onSubmit = vi.fn();
    const onUpFromFirstItem = vi.fn();
    const snapshots: Snapshot[] = [];
    const rendered = await renderHarness(
      {
        options: [textOption("one"), textOption("two"), textOption("three")],
        onCancel: vi.fn(),
        onDownFromLastItem,
        onSubmit,
        onUpFromFirstItem,
        submitButtonText: "Import",
        visibleOptionCount: 2,
      },
      snapshots,
    );

    try {
      press("", { tab: true });
      await waitForSnapshot(snapshots, { focusedValue: "two" });

      press("j");
      await waitForSnapshot(snapshots, {
        focusedValue: "three",
        visibleValues: ["two", "three"],
      });

      press("", { tab: true });
      await waitForSubmitFocus(rendered.controlsRef, true);
      press("", { tab: true });
      await waitForSubmitFocus(rendered.controlsRef, true);

      press("", { downArrow: true });
      expect(onDownFromLastItem).toHaveBeenCalledOnce();

      press("", { tab: true, shift: true });
      await waitForSubmitFocus(rendered.controlsRef, false);
      await waitForFocusedValue(rendered.controlsRef, "three");

      press("", { downArrow: true });
      await waitForSubmitFocus(rendered.controlsRef, true);

      press("", { upArrow: true });
      await waitForSubmitFocus(rendered.controlsRef, false);
      await waitForFocusedValue(rendered.controlsRef, "three");

      rendered.controlsRef.current?.focusOption("one");
      await waitForFocusedValue(rendered.controlsRef, "one");
      press("k");
      expect(onUpFromFirstItem).toHaveBeenCalledOnce();

      press("", { pageDown: true });
      await waitForFocusedValue(rendered.controlsRef, "three");
      press("", { upArrow: true });
      await waitForFocusedValue(rendered.controlsRef, "two");
      press("", { pageDown: true });
      await waitForFocusedValue(rendered.controlsRef, "three");
      press("", { pageUp: true });
      await waitForFocusedValue(rendered.controlsRef, "one");

      press("", { tab: true, shift: true });
      await waitForFocusedValue(rendered.controlsRef, "three");
      press("", { tab: true });
      await waitForSubmitFocus(rendered.controlsRef, true);
      press("", { return: true });
      expect(onSubmit).toHaveBeenCalledWith([]);
    } finally {
      rendered.unmount();
    }
  });

  test("supports input-field submit, allowed navigation, and ignored typing", async () => {
    const onSubmit = vi.fn();
    const snapshots: Snapshot[] = [];
    const rendered = await renderHarness(
      {
        options: [inputOption("name"), textOption("mode")],
        onCancel: vi.fn(),
        onSubmit,
      },
      snapshots,
    );

    try {
      await waitForSnapshot(snapshots, {
        focusedValue: "name",
        isInInput: true,
      });

      press("x");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(snapshots.at(-1)?.focusedValue).toBe("name");

      press("n", { ctrl: true });
      await waitForFocusedValue(rendered.controlsRef, "mode");

      rendered.controlsRef.current?.focusOption("name");
      await waitForFocusedValue(rendered.controlsRef, "name");
      press("p", { ctrl: true });
      await waitForFocusedValue(rendered.controlsRef, "mode");

      rendered.controlsRef.current?.focusOption("name");
      await waitForFocusedValue(rendered.controlsRef, "name");
      press("", { ctrl: true, return: true });
      expect(onSubmit).toHaveBeenCalledWith([]);

      rendered.controlsRef.current?.focusOption("name");
      await waitForFocusedValue(rendered.controlsRef, "name");
      press("", { downArrow: true });
      await waitForSnapshot(snapshots, {
        focusedValue: "mode",
        isInInput: false,
      });
    } finally {
      rendered.unmount();
    }
  });

  test("honors disabled input and hidden numeric indexes", async () => {
    const onChange = vi.fn();
    const hiddenIndexSnapshots: Snapshot[] = [];
    const hiddenIndexRender = await renderHarness(
      {
        hideIndexes: true,
        options: [textOption("one")],
        onCancel: vi.fn(),
        onChange,
      },
      hiddenIndexSnapshots,
    );

    try {
      press("1");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      hiddenIndexRender.unmount();
    }

    const disabledRender = await renderHarness({
      isDisabled: true,
      options: [textOption("one")],
      onCancel: vi.fn(),
    });

    try {
      expect(inputMock.options).toEqual({ isActive: false });
      expect(overlayMock.useRegisterOverlay).toHaveBeenCalledWith(
        "multi-select",
      );
    } finally {
      disabledRender.unmount();
    }
  });

  test("exits downward from the last option when there is no submit button", async () => {
    const onDownFromLastItem = vi.fn();
    const snapshots: Snapshot[] = [];
    const rendered = await renderHarness(
      {
        initialFocusLast: true,
        options: [textOption("one"), textOption("two")],
        onCancel: vi.fn(),
        onDownFromLastItem,
      },
      snapshots,
    );

    try {
      await waitForSnapshot(snapshots, { focusedValue: "two" });
      press("", { downArrow: true });
      expect(onDownFromLastItem).toHaveBeenCalledOnce();
    } finally {
      rendered.unmount();
    }
  });

  test("handles submit-focus and empty-list no-op paths", async () => {
    const submitButtonSnapshots: Snapshot[] = [];
    const submitButtonRender = await renderHarness(
      {
        options: [textOption("one")],
        onCancel: vi.fn(),
        onSubmit: vi.fn(),
        submitButtonText: "Apply",
      },
      submitButtonSnapshots,
    );

    try {
      press("", { tab: true });
      await waitForSubmitFocus(submitButtonRender.controlsRef, true);
      press("", { downArrow: true });
      await waitForSubmitFocus(submitButtonRender.controlsRef, true);
    } finally {
      submitButtonRender.unmount();
    }

    const emptySnapshots: Snapshot[] = [];
    const emptyRender = await renderHarness(
      {
        options: [],
        onCancel: vi.fn(),
      },
      emptySnapshots,
    );

    try {
      press(" ");
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(emptyRender.controlsRef.current?.selectedValues).toEqual([]);
      expect(emptyRender.controlsRef.current?.focusedValue).toBeUndefined();
    } finally {
      emptyRender.unmount();
    }
  });
});
