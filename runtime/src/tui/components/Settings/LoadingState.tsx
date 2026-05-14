import * as React from 'react';
import { Box, Text } from '../../ink.js';

export function SettingsConfigLoadingState(): React.ReactNode {
  return (
    <Box paddingX={1}>
      <Text dimColor>Loading settings...</Text>
    </Box>
  );
}
