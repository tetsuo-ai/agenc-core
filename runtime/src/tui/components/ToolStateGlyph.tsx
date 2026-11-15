import React, { useEffect, useState } from "react";

import { resolveAgenCTuiGlyphMode } from "../glyphs.js";
import { Box, Text } from "../ink.js";
import { getTheme, type Theme } from "../../utils/theme.js";
import { blendRgb } from "./colorBlend.js";
import { useTheme } from "./design-system/ThemeProvider.js";
import ThemedText from "./design-system/ThemedText.js";

export type ToolGlyphState = "queued" | "running" | "done" | "failed";

/**
 * A running tool call or agent row shows one dot that breathes: it fades
 * between two grays and back, so a live row reads as alive without the
 * glyph changing shape or the row jumping. A finished row keeps a solid dot.
 *
 * The ANSI themes cannot blend tones, so there the dot breathes by size
 * instead (small, medium, full, medium). Ascii mode does the same with
 * characters every terminal has.
 */
export const TOOL_BREATH_FRAME_MS = 100;
/** Steps in one breath: 2.4 s at 100 ms a step, as in the approved mockup. */
export const TOOL_BREATH_CYCLE_FRAMES = 24;
const RUNNING_DOT = "●";
const UNICODE_BREATH_SHAPES = ["·", "•", "●", "•"] as const;
const ASCII_BREATH_SHAPES = [".", "o", "O", "o"] as const;

/**
 * Resolved states are static. `running` is only static when motion is off;
 * its hollow ring must differ from the solid `done` dot so a reduced-motion
 * user can still tell an in-flight tool from a finished one.
 */
const UNICODE_STATIC: Readonly<Record<ToolGlyphState, string>> = {
  queued: "·",
  running: "○",
  done: "●",
  failed: "✕",
};

const ASCII_STATIC: Readonly<Record<ToolGlyphState, string>> = {
  queued: ".",
  running: "o",
  done: "*",
  failed: "X",
};

/** How far into the breath a step is: 0 at the start, 1 at the middle. */
export function toolBreathWeight(frame: number): number {
  const step = ((frame % TOOL_BREATH_CYCLE_FRAMES) + TOOL_BREATH_CYCLE_FRAMES) % TOOL_BREATH_CYCLE_FRAMES;
  return (1 - Math.cos((2 * Math.PI * step) / TOOL_BREATH_CYCLE_FRAMES)) / 2;
}

/** The shape a breathing dot takes on a step where tones cannot blend. */
export function toolBreathShape(frame: number, ascii: boolean): string {
  const shapes = ascii ? ASCII_BREATH_SHAPES : UNICODE_BREATH_SHAPES;
  const step = Math.floor((((frame % TOOL_BREATH_CYCLE_FRAMES) + TOOL_BREATH_CYCLE_FRAMES) % TOOL_BREATH_CYCLE_FRAMES) / (TOOL_BREATH_CYCLE_FRAMES / shapes.length));
  return shapes[step % shapes.length]!;
}

export function toolStaticGlyph(
  state: ToolGlyphState,
  ascii: boolean,
): string {
  return (ascii ? ASCII_STATIC : UNICODE_STATIC)[state];
}

/**
 * The glyph beside a tool call. Breathes only while the tool is actually
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
  const animating = state === "running" && !reducedMotion;
  const [frame, setFrame] = useState(0);
  const [themeName] = useTheme();

  useEffect(() => {
    if (!animating) return;
    const timer = setInterval(
      () => setFrame((value) => (value + 1) % TOOL_BREATH_CYCLE_FRAMES),
      TOOL_BREATH_FRAME_MS,
    );
    return () => clearInterval(timer);
  }, [animating]);

  if (animating) {
    const theme = getTheme(themeName);
    const tone = ascii ? null : blendRgb(theme.inactive, theme.subtle, toolBreathWeight(frame));
    return tone === null ? (
      <ThemedText color="inactive">{toolBreathShape(frame, ascii)}</ThemedText>
    ) : (
      <ThemedText color={tone}>{RUNNING_DOT}</ThemedText>
    );
  }

  return (
    <Text color={color} dimColor={dim}>
      {toolStaticGlyph(state, ascii)}
    </Text>
  );
}

/**
 * A one-line "this is happening right now" label: the breathing dot followed
 * by the text, dimmed like the rest of the progress chrome.
 *
 * Every in-flight thing in the transcript should say so the same way: a tool
 * call, a permission wait, a classifier check, a wait on other agents. The eye
 * learns one mark instead of four.
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
