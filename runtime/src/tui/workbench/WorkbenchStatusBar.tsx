import React from "react";

import { Box, Text } from "../ink.js";
import { useWorkbenchState } from "./state.js";

export function WorkbenchStatusBar(): React.ReactElement {
  const workbench = useWorkbenchState();
  const active = workbench.activeFilePath ?? workbench.activeSurfaceMode;
  return (
    <Box height={1} width="100%">
      <Text color="text2" wrap="truncate-end">AgenC Workbench</Text>
      <Text dimColor wrap="truncate-end"> | {active}</Text>
    </Box>
  );
}
