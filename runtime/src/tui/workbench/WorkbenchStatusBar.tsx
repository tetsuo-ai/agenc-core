import React from "react";

import { Box, Text } from "../ink.js";
import type { SpinnerMode } from "../components/spinner/types.js";
import { WorkbenchActivityIndicator } from "./WorkbenchActivityIndicator.js";
import { WorkbenchContextStrip } from "./WorkbenchContextStrip.js";
import { useWorkbenchState } from "./state.js";

export function WorkbenchStatusBar({
  activityMode = null,
  columns,
}: {
  /** Current streaming phase, or null when idle. Drives the working indicator. */
  readonly activityMode?: SpinnerMode | null;
  /**
   * Full status-bar row width (terminal columns). Lets the right-hand context
   * strip budget its remaining space so it degrades gracefully instead of
   * overflowing the row. Omitted in tiny/unknown-width contexts, where the
   * strip is hidden.
   */
  readonly columns?: number;
} = {}): React.ReactElement {
  const workbench = useWorkbenchState();
  // Show the active file path when one is open (preview/buffer); otherwise show
  // the surface name. Uppercase the surface name so the title-bar label matches
  // the pane-header casing (e.g. "TRANSCRIPT", not lowercase "transcript") —
  // the descriptors in ActiveWorkSurface render the same uppercase titles. The
  // file-path branch is left untouched so file labels keep their real casing.
  const active = workbench.activeFilePath ?? workbench.activeSurfaceMode.toUpperCase();
  // Reserve the columns the fixed left label consumes ("AgenC Workbench | <x>")
  // plus a small gutter, so the context strip only claims what is actually left
  // over and never collides with the title or overflows the row.
  const leftLabelWidth = "AgenC Workbench | ".length + active.length;
  const stripAvailable =
    typeof columns === "number" ? columns - leftLabelWidth - 1 : 0;
  return (
    <Box height={1} width="100%" flexDirection="row">
      <Text color="text2" wrap="truncate-end">AgenC Workbench</Text>
      <Text dimColor wrap="truncate-end"> | {active}</Text>
      <WorkbenchActivityIndicator mode={activityMode} />
      <Box flexGrow={1} />
      {stripAvailable > 0 ? <WorkbenchContextStrip available={stripAvailable} /> : null}
    </Box>
  );
}
