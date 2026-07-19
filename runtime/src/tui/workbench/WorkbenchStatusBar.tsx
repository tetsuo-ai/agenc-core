import React from "react";

import { Box, Text } from "../ink.js";
import type { SpinnerMode } from "../components/spinner/types.js";
import { WorkbenchActivityIndicator } from "./WorkbenchActivityIndicator.js";
import { WorkbenchContextStrip } from "./WorkbenchContextStrip.js";
import { useWorkbenchState } from "./state.js";

export function WorkbenchStatusBar({
  activityMode = null,
  columns,
  contextPctLabel = null,
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
  /**
   * Real context-window usage label (e.g. "ctx 42%"); null when no assistant
   * usage data exists yet. Rendered ahead of the model/mode/cwd strip, which
   * keeps its own width budget (the label's width is reserved here).
   */
  readonly contextPctLabel?: string | null;
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
  // The ctx label plus its separator gutter is reserved up front so the strip
  // budget below never has to know whether the label is present.
  const contextPctWidth = contextPctLabel === null ? 0 : contextPctLabel.length + 3;
  const stripAvailable =
    typeof columns === "number" ? columns - leftLabelWidth - contextPctWidth - 1 : 0;
  return (
    <Box height={1} width="100%" flexDirection="row">
      <Text color="text2" wrap="truncate-end">AgenC Workbench</Text>
      <Text dimColor wrap="truncate-end"> | {active}</Text>
      <WorkbenchActivityIndicator mode={activityMode} />
      <Box flexGrow={1} />
      {contextPctLabel !== null ? <Text dimColor wrap="truncate-end">{contextPctLabel} · </Text> : null}
      {stripAvailable > 0 ? <WorkbenchContextStrip available={stripAvailable} /> : null}
    </Box>
  );
}
