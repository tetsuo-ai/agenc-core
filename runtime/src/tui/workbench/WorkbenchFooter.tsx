import React from "react";

import { Box, Text } from "../ink.js";
import { stringWidth } from "../ink/stringWidth.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { footerHintsForSurface } from "./surfaces/ActiveWorkSurface.js";
import { composerAttachmentsForState, visibleWorkbenchPane } from "./reducer.js";
import { useWorkbenchState } from "./state.js";

// Hints are `<label>: <segment>  <segment>  …` with double-space separators.
// On narrow terminals whole trailing segments are dropped instead of
// ellipsizing the last one mid-word ("ctrl+w k focu…" taught nothing). The
// label plus first segment always render (truncated as a last resort).
export function fitFooterHints(hints: string, available: number): string {
  if (stringWidth(hints) <= available) return hints;
  const segments = hints.split(/ {2,}/);
  let line = "";
  for (const segment of segments) {
    const candidate = line === "" ? segment : `${line}  ${segment}`;
    if (stringWidth(candidate) > available) break;
    line = candidate;
  }
  return line === "" ? (segments[0] ?? hints) : line;
}

export function WorkbenchFooter(): React.ReactElement {
  const workbench = useWorkbenchState();
  const { columns } = useTerminalSize();
  const hints = hintsForPane(visibleWorkbenchPane(workbench), workbench.activeSurfaceMode);
  const composerAttachments = composerAttachmentsForState(workbench);
  // paddingX={2} on both sides, and leave the attachments suffix whatever
  // room it needs before the hints claim the rest.
  const fittedHints = fitFooterHints(hints, Math.max(1, columns - 4));
  return (
    // paddingX={2} matches the composer's own footer hint inset
    // (PromptInputFooter), so the stacked "? for shortcuts" line and this
    // surface-hint line share a consistent left margin instead of one being
    // indented two columns and the other flush at column 0.
    <Box height={1} width="100%" paddingX={2}>
      <Text dimColor wrap="truncate-end">{fittedHints}</Text>
      {composerAttachments.length > 0 ? (
        <Text color="suggestion" wrap="truncate-end"> | context {composerAttachments.map((item) => item.label).join(", ")}</Text>
      ) : null}
    </Box>
  );
}

function hintsForPane(pane: string, surface: string): string {
  if (pane === "explorer") return "Explorer: j/k move  h/l fold  enter/o edit  a add  r rename  d delete  @ attach";
  if (pane === "agents") return "Agents: enter detail  ctrl+w w next";
  if (pane === "composer") return "Composer: write prompt  / commands  @ attach file  ctrl+w k focus transcript";
  return footerHintsForSurface(surface as never);
}
