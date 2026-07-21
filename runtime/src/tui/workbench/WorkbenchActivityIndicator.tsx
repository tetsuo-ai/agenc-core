import React from "react";

import { Box, Text } from "../ink.js";
import type { SpinnerMode } from "../components/spinner/types.js";
import { SpiralDots } from "../components/spinner/SpiralDots.js";
import { titleVerbForMode } from "../components/spinner/utils.js";

/**
 * Compact, always-visible "the model is working" indicator for the workbench
 * status bar. The big composer spinner can scroll out of view or be visually
 * subtle, so this gives a distinct, persistent signal that a turn is in flight.
 *
 * It renders nothing while idle (`mode === null`) so the status bar looks
 * identical to before when nothing is happening — the indicator only appears
 * while a real turn is active, and disappears the moment it ends.
 */
export function WorkbenchActivityIndicator({
  mode,
}: {
  /** Current streaming phase, or null when the session is idle. */
  readonly mode: SpinnerMode | null;
}): React.ReactElement | null {
  if (mode === null) return null;

  return (
    <Box flexShrink={0} flexDirection="row">
      <Text dimColor wrap="truncate-end">{" · "}</Text>
      {/*
        The SAME live spiral as the composer body spinner and the agents rail:
        one activity signal across the whole workbench, not three different
        glyphs for the same in-flight turn.
      */}
      <SpiralDots />
      <Text color="text2" wrap="truncate-end"> {titleVerbForMode(mode)}…</Text>
    </Box>
  );
}
