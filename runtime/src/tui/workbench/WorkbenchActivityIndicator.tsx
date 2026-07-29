import React from "react";

import { Box, Text } from "../ink.js";
import type { SpinnerMode } from "../components/spinner/types.js";
import { AgenCActivityMark } from "../components/spinner/AgenCActivityMark.js";
import { titleVerbForMode } from "../components/spinner/utils.js";
import { useAppStateMaybeOutsideOfProvider } from "../state/AppState.js";

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
  const reducedMotion =
    useAppStateMaybeOutsideOfProvider(
      (state) => state.settings?.prefersReducedMotion ?? false,
    ) ?? false;

  if (mode === null) return null;

  return (
    <Box flexShrink={0} flexDirection="row">
      <Text>{"  "}</Text>
      <AgenCActivityMark color="text" reducedMotion={reducedMotion} />
      <Text color="text2" wrap="truncate-end"> {titleVerbForMode(mode)}…</Text>
    </Box>
  );
}
