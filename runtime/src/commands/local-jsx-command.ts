import type { ReactNode } from "react";

import type { SlashCommandContext } from "./types.js";

export type CloseLocalJsxCommand = () => void;

export function openLocalJsxCommand(
  ctx: SlashCommandContext,
  render: (close: CloseLocalJsxCommand) => ReactNode,
  options: {
    readonly shouldHidePromptInput?: boolean;
  } = {},
): boolean {
  const setToolJSX = ctx.appState?.setToolJSX;
  if (typeof setToolJSX !== "function") return false;

  const close = () => {
    setToolJSX({
      jsx: null,
      shouldHidePromptInput: false,
      clearLocalJSX: true,
    });
  };

  setToolJSX({
    isLocalJSXCommand: true,
    shouldHidePromptInput: options.shouldHidePromptInput ?? true,
    jsx: render(close),
  });
  return true;
}
