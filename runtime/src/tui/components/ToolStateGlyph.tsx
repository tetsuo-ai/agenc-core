import React, { useEffect, useState } from "react";

import { resolveAgenCTuiGlyphMode } from "../glyphs.js";
import { Box, Text } from "../ink.js";
import type { Theme } from "../../utils/theme.js";

export type ToolGlyphState = "queued" | "running" | "done" | "failed";

/**
 * Frames for the star beside a running tool call: the points sweep out from
 * the centre and back, so a live tool reads as moving without the row jumping.
 *
 * The unicode set is drawn from the star family already proven in this TUI
 * (`glyphs.spinnerFrames`). A bare ASCII `*` mixed among unicode stars renders
 * as a thin, raised glyph and visibly flickers once per cycle, which is why
 * `getDefaultCharacters` avoids it too. In ascii mode the arms rotate instead
 * — `+` axis-aligned, `*` six-armed, `x` diagonal — which is the same idea
 * with characters every terminal already has.
 */
const UNICODE_STAR_FRAMES = ["✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳"] as const;
const ASCII_STAR_FRAMES = ["+", "*", "x", "*"] as const;

/**
 * Slower than the composer spinner (90ms): several tool rows can be in flight
 * at once, and a fast sweep across a column of them reads as noise.
 */
export const TOOL_STAR_FRAME_MS = 120;

/**
 * Resolved states are static. `running` is only used when motion is off —
 * it must differ from `done` so a reduced-motion user can still tell an
 * in-flight tool from a finished one.
 */
const UNICODE_STATIC: Readonly<Record<ToolGlyphState, string>> = {
  queued: "·",
  running: "✳",
  done: "✶",
  failed: "✕",
};

const ASCII_STATIC: Readonly<Record<ToolGlyphState, string>> = {
  queued: ".",
  running: "+",
  done: "*",
  failed: "X",
};

export function toolStarFrames(ascii: boolean): readonly string[] {
  return ascii ? ASCII_STAR_FRAMES : UNICODE_STAR_FRAMES;
}

export function toolStaticGlyph(
  state: ToolGlyphState,
  ascii: boolean,
): string {
  return (ascii ? ASCII_STATIC : UNICODE_STATIC)[state];
}

/**
 * The glyph beside a tool call. Animates only while the tool is actually
 * running, so the transcript's finished rows stay off the animation clock.
 */
export function ToolStateGlyph({
  state,
  color,
  dim = false,
  reducedMotion = false,
}: {
  readonly state: ToolGlyphState;
  readonly color?: keyof Theme;
  readonly dim?: boolean;
  readonly reducedMotion?: boolean;
}): React.ReactElement {
  const ascii = resolveAgenCTuiGlyphMode() === "ascii";
  const frames = toolStarFrames(ascii);
  const animating = state === "running" && !reducedMotion;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!animating) return;
    const timer = setInterval(
      () => setFrame((value) => (value + 1) % frames.length),
      TOOL_STAR_FRAME_MS,
    );
    return () => clearInterval(timer);
  }, [animating, frames.length]);

  const glyph = animating
    ? frames[frame % frames.length] ?? frames[0]!
    : toolStaticGlyph(state, ascii);

  return (
    <Text color={color} dimColor={dim}>
      {glyph}
    </Text>
  );
}

/**
 * A one-line "this is happening right now" label: the running star followed by
 * the text, dimmed like the rest of the progress chrome.
 *
 * Every in-flight thing in the transcript should say so the same way — a tool
 * call, a permission wait, a classifier check, a wait on other agents — so the
 * eye learns one mark instead of four.
 */
export function RunningLabel({
  text,
  color,
}: {
  readonly text: string;
  readonly color?: keyof Theme;
}): React.ReactElement {
  return (
    <Box flexDirection="row" gap={1}>
      <ToolStateGlyph state="running" color={color} dim />
      <Text dimColor>{text}</Text>
    </Box>
  );
}
