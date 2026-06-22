import type { ReactNode } from "react";

import type {
  SlashCommandAppStateBridge,
  SlashCommandContext,
} from "./types.js";

export type CloseLocalJsxCommand = () => void;

interface LocalJsxCommandOptions {
  readonly shouldHidePromptInput?: boolean;
}

type SetToolJSX = NonNullable<SlashCommandAppStateBridge["setToolJSX"]>;

function localJsxBridge(
  ctx: SlashCommandContext,
): {
  readonly setToolJSX: SetToolJSX;
  readonly close: CloseLocalJsxCommand;
} | null {
  const setToolJSX = ctx.appState?.setToolJSX;
  if (typeof setToolJSX !== "function") return null;

  const close = () => {
    setToolJSX({
      jsx: null,
      shouldHidePromptInput: false,
      clearLocalJSX: true,
    });
  };

  return { setToolJSX, close };
}

function showLocalJsxCommand(
  setToolJSX: SetToolJSX,
  jsx: ReactNode,
  options: LocalJsxCommandOptions,
): void {
  setToolJSX({
    isLocalJSXCommand: true,
    shouldHidePromptInput: options.shouldHidePromptInput ?? true,
    jsx,
  });
}

export function openLocalJsxCommand(
  ctx: SlashCommandContext,
  render: (close: CloseLocalJsxCommand) => ReactNode,
  options: LocalJsxCommandOptions = {},
): boolean {
  const bridge = localJsxBridge(ctx);
  if (bridge === null) return false;

  showLocalJsxCommand(bridge.setToolJSX, render(bridge.close), options);
  return true;
}

export async function openAsyncLocalJsxCommand(
  ctx: SlashCommandContext,
  render: (close: CloseLocalJsxCommand) => Promise<ReactNode>,
  options: LocalJsxCommandOptions = {},
): Promise<boolean> {
  const bridge = localJsxBridge(ctx);
  if (bridge === null) return false;

  showLocalJsxCommand(
    bridge.setToolJSX,
    await render(bridge.close),
    options,
  );
  return true;
}
