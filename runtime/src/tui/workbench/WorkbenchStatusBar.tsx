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
  const active = workbench.activeFilePath ?? workbench.activeSurfaceMode;
  return (
    <Box height={1} width="100%" flexDirection="row">
      <Text color="text2" wrap="truncate-end">AgenC Workbench</Text>
      <Text dimColor wrap="truncate-end"> | {active}</Text>
      <WorkbenchActivityIndicator mode={activityMode} />
    </Box>
  );
}
