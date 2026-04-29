/**
 * Renders the leading-glyph next to the composer input.
 *
 * In `prompt` mode the glyph is the standard `❯` pointer, dimmed when
 * the runtime is mid-turn (so the operator sees the indicator gray out
 * the moment they submit). In `bash` mode the pointer is replaced with
 * a fuchsia `!` so the bash-shell context is visually distinct.
 *
 * `memory` mode uses `#` to mirror the prefix character the operator
 * typed; the color is intentionally the same warning-rose used by
 * notifications so an accidental `#` keystroke that flips mode is easy
 * to spot.
 */

import * as React from "react";

import { Box, Text } from "../ink-public.js";
import { glyphs } from "../design-system/glyphs.js";
import type { PromptInputMode } from "./inputModes.js";

export type Props = {
  readonly mode: PromptInputMode;
  readonly isLoading: boolean;
};

export function PromptInputModeIndicator({
  mode,
  isLoading,
}: Props): React.ReactNode {
  let glyph: React.ReactNode;
  switch (mode) {
    case "bash":
      glyph = (
        <Text color="accent" dimColor={isLoading}>
          {"! "}
        </Text>
      );
      break;
    case "memory":
      glyph = (
        <Text color="warning" dimColor={isLoading}>
          {"# "}
        </Text>
      );
      break;
    default:
      glyph = (
        <Text dimColor={isLoading}>{`${glyphs.pointer} `}</Text>
      );
      break;
  }
  return (
    <Box
      alignItems="flex-start"
      alignSelf="flex-start"
      flexWrap="nowrap"
      justifyContent="flex-start"
    >
      {glyph}
    </Box>
  );
}
