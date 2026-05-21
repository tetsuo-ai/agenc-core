import { describe, expect, test } from "vitest";

import {
  applyToolJSXUpdate,
  type ToolJSXArgs,
  type ToolJSXState,
} from "src/tui/tool-jsx-state.js";

function toolState(overrides: Partial<ToolJSXState> = {}): ToolJSXState {
  return {
    jsx: "tool",
    shouldHidePromptInput: false,
    ...overrides,
  };
}

function toolArgs(overrides: Partial<ToolJSXArgs> = {}): ToolJSXArgs {
  return {
    jsx: "tool",
    shouldHidePromptInput: false,
    ...overrides,
  };
}

describe("coverage swarm row 233 tool-jsx-state", () => {
  test("persists local JSX commands without writing the clear directive into state", () => {
    const result = applyToolJSXUpdate(
      toolArgs({
        clearLocalJSX: true,
        isLocalJSXCommand: true,
        jsx: "local command",
        shouldContinueAnimation: true,
        shouldHidePromptInput: true,
        showSpinner: true,
      }),
      null,
    );

    expect(result).toEqual({
      nextLocalRef: {
        isLocalJSXCommand: true,
        jsx: "local command",
        shouldContinueAnimation: true,
        shouldHidePromptInput: true,
        showSpinner: true,
      },
      nextState: {
        isLocalJSXCommand: true,
        jsx: "local command",
        shouldContinueAnimation: true,
        shouldHidePromptInput: true,
        showSpinner: true,
      },
    });
    expect("clearLocalJSX" in result.nextState).toBe(false);
    expect("clearLocalJSX" in result.nextLocalRef).toBe(false);
  });

  test("skips ordinary updates while a local JSX command is preserved", () => {
    const preserved = toolState({
      isLocalJSXCommand: true,
      jsx: "preserved",
      shouldHidePromptInput: true,
    });

    expect(applyToolJSXUpdate(toolArgs({ jsx: "ordinary" }), preserved)).toEqual({
      skip: true,
    });
    expect(applyToolJSXUpdate(null, preserved)).toEqual({ skip: true });
  });

  test("clears preserved local JSX when explicitly requested", () => {
    const preserved = toolState({
      isLocalJSXCommand: true,
      jsx: "preserved",
      shouldHidePromptInput: true,
    });

    expect(
      applyToolJSXUpdate(toolArgs({ clearLocalJSX: true, jsx: "replacement" }), preserved),
    ).toEqual({
      nextLocalRef: null,
      nextState: null,
    });
  });

  test("clears current state even when no local JSX command is preserved", () => {
    expect(applyToolJSXUpdate(toolArgs({ clearLocalJSX: true }), null)).toEqual({
      nextState: null,
    });
  });

  test("accepts normal updates and null resets when no local JSX command is active", () => {
    const ordinary = toolArgs({
      jsx: "ordinary",
      shouldHidePromptInput: true,
      showSpinner: true,
    });

    expect(applyToolJSXUpdate(ordinary, null)).toEqual({ nextState: ordinary });
    expect(applyToolJSXUpdate(null, null)).toEqual({ nextState: null });
  });
});
