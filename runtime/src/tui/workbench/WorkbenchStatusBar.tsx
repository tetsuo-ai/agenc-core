// @ts-nocheck
import React from "react";

import { Box, Text } from "../ink.js";
import { useWorkbenchState } from "./state.js";

export function WorkbenchStatusBar({
  columns,
}: {
  readonly columns: number;
}): React.ReactElement {
  const workbench = useWorkbenchState();
  const active = workbench.activeFilePath ?? workbench.activeSurfaceMode;
  return (
    <Box height={1} width="100%">
      <Text color="text2" wrap="truncate-end">AgenC Workbench</Text>
      <Text dimColor wrap="truncate-end"> | {active}</Text>
      <Text dimColor wrap="truncate-end"> | {columns} cols</Text>
    </Box>
  );
}
