import React from "react";

import { useKeybinding } from "../../keybindings/useKeybinding.js";
import type { PendingRequest } from "../../permission-requests.js";
import { useWorkbenchDispatch } from "../state.js";

/**
 * Headless opt-in for full diff review: registers the `ctrl+w d` (openDiff)
 * keybinding while an approval is pending and renders NOTHING. The approval
 * card itself now prints the `ctrl+w d full diff` hint, so this bridge no
 * longer paints a line of its own — it used to render a duplicate
 * "risk X - press d…" row that fused with the card below into "reviewall".
 * Kept mounted (B3.5 parity): diff review stays opt-in, never auto-focused.
 */
export function ApprovalSurfaceBridge({
  request,
}: {
  readonly request?: PendingRequest;
}): React.ReactElement | null {
  const dispatch = useWorkbenchDispatch();
  useKeybinding(
    "workbench:openDiff",
    () => {
      if (request) {
        dispatch({ type: "openDiff", diffId: request.id, focus: true });
      }
    },
    { context: "Confirmation", isActive: request !== undefined },
  );

  return null;
}
