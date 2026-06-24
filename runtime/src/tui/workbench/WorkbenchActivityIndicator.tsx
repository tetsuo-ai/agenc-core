import React, { useEffect, useState } from "react";

import { Box, Text } from "../ink.js";
import type { SpinnerMode } from "../components/spinner/types.js";
import {
  getDefaultCharacters,
  getReducedMotionDot,
  verbForMode,
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

  // When the animated glyph lands on its dot frame ("·"), it sits right next to
  // the leading "·" separator and reads as a doubled "· ·". Drop the separator
  // for that frame so it renders a single dot instead.
  const separator = glyph === "·" ? " " : " · ";

  return (
    <Box flexShrink={0} flexDirection="row">
      <Text dimColor wrap="truncate-end">{separator}</Text>
      <Text color="agenc">{glyph}</Text>
      <Text color="text2" wrap="truncate-end"> {verbForMode(mode)}…</Text>
    </Box>
  );
}
