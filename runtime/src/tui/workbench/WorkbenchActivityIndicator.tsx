import React, { useEffect, useState } from "react";

import { Box, Text } from "../ink.js";
import type { SpinnerMode } from "../components/spinner/types.js";
import {
  getDefaultCharacters,
  getReducedMotionDot,
} from "../components/spinner/utils.js";
import { useSettings } from "../hooks/useSettings.js";

/**
 * Compact, always-visible "the model is working" indicator for the workbench
 * status bar. The big composer spinner can scroll out of view or be visually
 * subtle, so this gives a distinct, persistent signal that a turn is in flight.
 *
 * It renders nothing while idle (`mode === null`) so the status bar looks
 * identical to before when nothing is happening — the indicator only appears
 * while a real turn is active, and disappears the moment it ends.
 */

const FRAME_INTERVAL_MS = 120;

/** Plain-language verb for each streaming phase, kept short for the status bar. */
function verbForMode(mode: SpinnerMode): string {
  switch (mode) {
    case "tool-use":
      return "running tools";
    case "tool-input":
      return "preparing tools";
    case "thinking":
      return "thinking";
    case "responding":
      return "responding";
    case "requesting":
    default:
      return "working";
  }
}

export function WorkbenchActivityIndicator({
  mode,
}: {
  /** Current streaming phase, or null when the session is idle. */
  readonly mode: SpinnerMode | null;
}): React.ReactElement | null {
  const settings = useSettings();
  const reducedMotion = settings?.prefersReducedMotion ?? false;
  const frames = getDefaultCharacters();
  const [frameIndex, setFrameIndex] = useState(0);

  const active = mode !== null;
  useEffect(() => {
    if (!active || reducedMotion) return;
    const timer = setInterval(() => {
      setFrameIndex((value) => (value + 1) % frames.length);
    }, FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, reducedMotion, frames.length]);

  if (mode === null) return null;

  const glyph = reducedMotion
    ? getReducedMotionDot()
    : (frames[frameIndex % frames.length] ?? frames[0] ?? "·");

  return (
    <Box flexShrink={0} flexDirection="row">
      <Text dimColor wrap="truncate-end"> · </Text>
      <Text color="agenc">{glyph}</Text>
      <Text color="text2" wrap="truncate-end"> {verbForMode(mode)}…</Text>
    </Box>
  );
}
