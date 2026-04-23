import React from "react";

import Box from "../ink/components/Box.js";
import Text from "../ink/components/Text.js";
import { useAnimationTick } from "../hooks/useAnimationTick.js";
import type { Color } from "../ink/styles.js";
import { theme } from "../theme.js";

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export function getSpinnerFrame(tick: number): string {
  const index = Number.isFinite(tick) ? Math.abs(Math.floor(tick)) : 0;
  return SPINNER_FRAMES[index % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
}

export interface SpinnerGlyphProps {
  readonly tick: number;
  readonly color?: Color;
}

export const SpinnerGlyph: React.FC<SpinnerGlyphProps> = ({
  tick,
  color = theme.colors.primary,
}) => <Text color={color}>{getSpinnerFrame(tick)}</Text>;

export interface SpinnerProps {
  readonly label?: string;
  readonly color?: Color;
}

export const Spinner: React.FC<SpinnerProps> = ({
  label,
  color = theme.colors.primary as Color,
}) => {
  const { tick } = useAnimationTick();
  return (
    <Box flexDirection="row" alignItems="center">
      <SpinnerGlyph tick={tick} color={color} />
      {label !== undefined && label.length > 0 ? (
        <>
          <Text> </Text>
          <Text color={color}>{label}</Text>
        </>
      ) : null}
    </Box>
  );
};

export default Spinner;
