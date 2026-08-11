import type React from 'react';
import { Box } from '../ink.js';
import { ToolStateGlyph } from './ToolStateGlyph.js';

type Props = {
  isError: boolean;
  isUnresolved: boolean;
  shouldAnimate: boolean;
};
export function ToolUseLoader({
  isError,
  isUnresolved,
  shouldAnimate,
}: Props): React.ReactNode {
  const color = isError ? "error" : isUnresolved ? undefined : "success";
  const state = isError ? "failed" : isUnresolved ? "running" : "done";
  return (
    <Box minWidth={2}>
      <ToolStateGlyph
        state={state}
        color={color}
        dim={!isError && isUnresolved}
        // Callers that already know the row is frozen (replayed history, a
        // collapsed group that is no longer the active one) pass false, and a
        // still star costs nothing on the render clock.
        reducedMotion={!shouldAnimate}
      />
    </Box>
  );
}
