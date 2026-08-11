import React, { useEffect, useState } from "react";

import { Text } from "../../ink.js";

const ACTIVITY_PULSE_FRAME_MS = 450;
const MIN_TRACK_WIDTH = 6;

export type AgentActivityTrackFrame = {
  /** Dots for work already done, drawn bright. */
  readonly filled: string;
  /** The dot about to be earned; pulses so the row reads as alive. */
  readonly head: string;
  /** Work not done yet, drawn grey. */
  readonly rest: string;
  /** Completed laps of the bar — real work beyond one bar's width. */
  readonly laps: number;
};

/**
 * Pure frame builder for the agent activity bar.
 *
 * The bar measures WORK DONE, not percent complete: AgenC receives no
 * trustworthy completion estimate from a running agent, so one dot per tool
 * call is a fact where a "58%" fill would be an invention. It fills left to
 * right and wraps, and the `N tools` counter beside it makes the lap
 * unambiguous. (The previous design walked a marker along the line for the
 * same honesty reason; this keeps the honesty and adds real information.)
 */
export function buildAgentActivityTrackFrame(
  width: number,
  toolCount: number,
  pulseOn: boolean,
): AgentActivityTrackFrame {
  const trackWidth = Math.max(MIN_TRACK_WIDTH, Math.floor(width));
  // A non-finite count would poison every downstream `repeat()` into "" and
  // collapse the bar to zero cells — an invisible row rather than an empty one.
  const done = Number.isFinite(toolCount)
    ? Math.max(0, Math.floor(toolCount))
    : 0;
  const laps = Math.floor(done / trackWidth);
  const filledCount = done % trackWidth;
  // A dot is spent on the head, so it only exists while the bar has room.
  const headCount = filledCount < trackWidth ? 1 : 0;
  return {
    filled: "·".repeat(filledCount),
    head: headCount === 1 && pulseOn ? "·" : headCount === 1 ? " " : "",
    rest: "·".repeat(Math.max(0, trackWidth - filledCount - headCount)),
    laps,
  };
}

export function AgentActivityTrack({
  reducedMotion,
  toolCount = 0,
  width,
}: {
  readonly reducedMotion: boolean;
  readonly toolCount?: number;
  readonly width: number;
}): React.ReactElement {
  const [pulseOn, setPulseOn] = useState(true);

  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(
      () => setPulseOn((value) => !value),
      ACTIVITY_PULSE_FRAME_MS,
    );
    return () => clearInterval(timer);
  }, [reducedMotion]);

  const frame = buildAgentActivityTrackFrame(
    width,
    toolCount,
    reducedMotion ? true : pulseOn,
  );

  return (
    <Text wrap="truncate-end">
      <Text color="text">{frame.filled}</Text>
      <Text color={frame.laps > 0 ? "inactive" : "text"}>{frame.head}</Text>
      {/*
        After a full lap the remaining dots brighten one step, so a second pass
        over the bar is visibly a second pass instead of looking like the agent
        started over.
      */}
      <Text color={frame.laps > 0 ? "inactive" : "lineSoft"}>{frame.rest}</Text>
    </Text>
  );
}
