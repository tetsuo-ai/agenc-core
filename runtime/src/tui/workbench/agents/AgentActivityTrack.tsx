import React, { useEffect, useState } from "react";

import { Text } from "../../ink.js";

const ACTIVITY_TRACK_FRAME_MS = 80;
const MIN_TRACK_WIDTH = 6;

export type AgentActivityTrackFrame = {
  readonly after: string;
  readonly before: string;
  readonly head: "◆" | "◇";
  readonly tail: string;
};

/**
 * Pure frame builder for the indeterminate agent activity track. AgenC does
 * not receive a trustworthy completion percentage from a running agent, so a
 * moving scanline is honest where a fixed "58%" fill is not.
 */
export function buildAgentActivityTrackFrame(
  width: number,
  step: number,
): AgentActivityTrackFrame {
  const trackWidth = Math.max(MIN_TRACK_WIDTH, Math.floor(width));
  const headIndex = ((Math.floor(step) % trackWidth) + trackWidth) % trackWidth;
  const tail = headIndex === 0 ? "" : headIndex === 1 ? "╺" : "╺━";
  const before = "·".repeat(Math.max(0, headIndex - tail.length));
  const after = "·".repeat(Math.max(0, trackWidth - headIndex - 1));
  const head = Math.floor(step / 2) % 2 === 0 ? "◆" : "◇";
  return { after, before, head, tail };
}

export function AgentActivityTrack({
  reducedMotion,
  seed,
  width,
}: {
  readonly reducedMotion: boolean;
  readonly seed: string;
  readonly width: number;
}): React.ReactElement {
  const trackWidth = Math.max(MIN_TRACK_WIDTH, Math.floor(width));
  const [step, setStep] = useState(() =>
    reducedMotion ? Math.floor(trackWidth / 2) : phaseForSeed(seed, trackWidth),
  );

  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(
      () => setStep((value) => (value + 1) % trackWidth),
      ACTIVITY_TRACK_FRAME_MS,
    );
    return () => clearInterval(timer);
  }, [reducedMotion, trackWidth]);

  const frame = buildAgentActivityTrackFrame(
    trackWidth,
    reducedMotion ? Math.floor(trackWidth / 2) : step,
  );

  return (
    <Text wrap="truncate-end">
      <Text color="lineSoft">{frame.before}</Text>
      <Text color="inactive">{frame.tail}</Text>
      <Text color="text">{frame.head}</Text>
      <Text color="lineSoft">{frame.after}</Text>
    </Text>
  );
}

function phaseForSeed(seed: string, width: number): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % width;
}
