import * as React from "react";
import type { SetToolJSXFn } from "../../tools/Tool.js";
import { PasteConfirmDialog } from "../components/PasteConfirmDialog.js";
import { consumeSuspectedPaste } from "./burst-detector.js";

/** Consume the one-shot burst flag and require confirmation before execution. */
export async function confirmSuspectedShellPaste(
  command: string,
  setToolJSX: SetToolJSXFn,
): Promise<boolean> {
  if (!consumeSuspectedPaste()) return true;
  const allowed = await new Promise<boolean>((resolve) => {
    let settled = false;
    const decide = (decision: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(decision);
    };
    setToolJSX({
      jsx: <PasteConfirmDialog command={command} onDecide={decide} />,
      shouldHidePromptInput: true,
    });
  });
  setToolJSX(null);
  return allowed;
}
