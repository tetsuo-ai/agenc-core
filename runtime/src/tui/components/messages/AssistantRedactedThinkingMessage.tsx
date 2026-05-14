import React from 'react';
import { selectAgenCTuiGlyphs } from '../../glyphs.js';
import { Box, Text } from '../../ink.js';
type Props = {
  addMargin: boolean;
};
export function AssistantRedactedThinkingMessage({ addMargin = false }: Props) {
  const glyphs = selectAgenCTuiGlyphs();
  const prefix = glyphs.redactedThinkingPrefix.length > 0
    ? `${glyphs.redactedThinkingPrefix} `
    : '';
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text dimColor={true} italic={true}>{prefix}Thinking{glyphs.thinkingEllipsis}</Text>
    </Box>
  );
}
