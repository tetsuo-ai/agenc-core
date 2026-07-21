import React, { useEffect, useState } from "react";

import { Text } from "../../ink.js";

/**
 * 9-dot spiral activity spinner: the braille circle family draws a ring of
 * dots that rotates clockwise (a spiral pattern), and the ring color cycles
 * per frame so the "something is executing" signal reads as alive instead of
 * the old static half-painted circle (◐).
 */
const FRAMES = ["⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽", "⣾"] as const;
// Starts on "suggestion" so the resting frame matches the spinner's own
// messageColor (activity indicators stay unified across the workbench).
const FRAME_COLORS = [
  "suggestion",
  "agenc",
  "planMode",
  "success",
  "warning",
  "fastMode",
] as const;
const FRAME_MS = 90;

export function SpiralDots({
  reducedMotion = false,
}: {
  readonly reducedMotion?: boolean;
}): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(
      () => setFrame((value) => (value + 1) % FRAMES.length),
      FRAME_MS,
    );
    return () => clearInterval(timer);
  }, [reducedMotion]);

  const index = reducedMotion ? 0 : frame;
  return (
    <Text color={FRAME_COLORS[index % FRAME_COLORS.length]}>
      {FRAMES[index]}
    </Text>
  );
}
