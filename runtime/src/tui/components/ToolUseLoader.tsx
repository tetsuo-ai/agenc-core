import type React from 'react';
import { Box, Text } from '../ink.js';

type Props = {
  isError: boolean;
  isUnresolved: boolean;
  shouldAnimate: boolean;
};
export function ToolUseLoader({
  isError,
  isUnresolved,
}: Props): React.ReactNode {
  const color = isError ? "error" : isUnresolved ? undefined : "success";
  const glyph = isError ? "✕" : isUnresolved ? "◐" : "●";
  return (
    <Box minWidth={2}>
      <Text color={color} dimColor={!isError && isUnresolved}>{glyph}</Text>
    </Box>
  );
}
