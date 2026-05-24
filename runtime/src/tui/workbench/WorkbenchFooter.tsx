// @ts-nocheck
import React from "react";

import { Box, Text } from "../ink.js";
import { footerHintsForSurface } from "./surfaces/ActiveWorkSurface.js";
import { composerAttachmentsForState, visibleWorkbenchPane } from "./reducer.js";
import { useWorkbenchState } from "./state.js";

export function WorkbenchFooter(): React.ReactElement {
  const workbench = useWorkbenchState();
  const hints = hintsForPane(visibleWorkbenchPane(workbench), workbench.activeSurfaceMode);
  const composerAttachments = composerAttachmentsForState(workbench);
  return (
    <Box height={1} width="100%">
      <Text dimColor wrap="truncate-end">{hints}</Text>
      {composerAttachments.length > 0 ? (
        <Text color="suggestion" wrap="truncate-end"> | context {composerAttachments.map((item) => item.label).join(", ")}</Text>
      ) : null}
    </Box>
  );
}

function hintsForPane(pane: string, surface: string): string {
  if (pane === "explorer") return "Explorer: j/k move  h/l fold  enter/o edit  a add  r rename  d delete  @ attach";
  if (pane === "agents") return "Agents: enter detail  ctrl+w w next";
  if (pane === "composer") return "Composer: write prompt  ctrl+w k surface";
  return footerHintsForSurface(surface as never);
}
