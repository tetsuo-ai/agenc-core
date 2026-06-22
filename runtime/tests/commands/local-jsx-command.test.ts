import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  openAsyncLocalJsxCommand,
  openLocalJsxCommand,
} from "../../src/commands/local-jsx-command.js";
import type { SlashCommandContext } from "../../src/commands/types.js";

function makeContext(
  setToolJSX?: (value: unknown) => void,
): SlashCommandContext {
  return {
    appState: setToolJSX !== undefined ? { setToolJSX } : undefined,
  } as unknown as SlashCommandContext;
}

describe("openLocalJsxCommand", () => {
  it("returns false when no local JSX bridge is available", () => {
    const render = vi.fn(() => React.createElement("div"));

    expect(openLocalJsxCommand(makeContext(), render)).toBe(false);
    expect(render).not.toHaveBeenCalled();
  });

  it("returns false from the async opener without importing or rendering", async () => {
    const render = vi.fn(async () => React.createElement("div"));

    await expect(openAsyncLocalJsxCommand(makeContext(), render)).resolves.toBe(
      false,
    );
    expect(render).not.toHaveBeenCalled();
  });

  it("opens local JSX and provides a close callback with the standard clear payload", () => {
    const setToolJSX = vi.fn();
    let close: (() => void) | undefined;
    const jsx = React.createElement("div", { id: "menu" });

    expect(
      openLocalJsxCommand(makeContext(setToolJSX), nextClose => {
        close = nextClose;
        return jsx;
      }),
    ).toBe(true);

    expect(setToolJSX).toHaveBeenCalledWith({
      isLocalJSXCommand: true,
      shouldHidePromptInput: true,
      jsx,
    });

    expect(close).toBeDefined();
    close?.();
    expect(setToolJSX).toHaveBeenLastCalledWith({
      jsx: null,
      shouldHidePromptInput: false,
      clearLocalJSX: true,
    });
  });

  it("can leave the prompt input visible for lightweight local surfaces", () => {
    const setToolJSX = vi.fn();

    openLocalJsxCommand(
      makeContext(setToolJSX),
      () => React.createElement("span"),
      { shouldHidePromptInput: false },
    );

    expect(setToolJSX).toHaveBeenCalledWith(
      expect.objectContaining({ shouldHidePromptInput: false }),
    );
  });

  it("opens async local JSX after the render callback resolves", async () => {
    const setToolJSX = vi.fn();
    const jsx = React.createElement("strong", { id: "async-menu" });

    await expect(
      openAsyncLocalJsxCommand(makeContext(setToolJSX), async () => jsx),
    ).resolves.toBe(true);

    expect(setToolJSX).toHaveBeenCalledWith({
      isLocalJSXCommand: true,
      shouldHidePromptInput: true,
      jsx,
    });
  });
});
