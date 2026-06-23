import React from "react";

import { Box, Text } from "../ink.js";
import type { SpinnerMode } from "../components/spinner/types.js";
import { WorkbenchActivityIndicator } from "./WorkbenchActivityIndicator.js";
import { useWorkbenchState } from "./state.js";

export function WorkbenchStatusBar({
  activityMode = null,
}: {
  /** Current streaming phase, or null when idle. Drives the working indicator. */
  readonly activityMode?: SpinnerMode | null;
} = {}): React.ReactElement {
  const workbench = useWorkbenchState();
  // Show the active file path when one is open (preview/buffer); otherwise show
  // the surface name. Uppercase the surface name so the title-bar label matches
  // the pane-header casing (e.g. "TRANSCRIPT", not lowercase "transcript") —
  // the descriptors in ActiveWorkSurface render the same uppercase titles. The
  // file-path branch is left untouched so file labels keep their real casing.
  const active = workbench.activeFilePath ?? workbench.activeSurfaceMode.toUpperCase();
  return (
    <Box height={1} width="100%" flexDirection="row">
      <Text color="text2" wrap="truncate-end">AgenC Workbench</Text>
      <Text dimColor wrap="truncate-end"> | {active}</Text>
      <WorkbenchActivityIndicator mode={activityMode} />
    </Box>
  );
}
