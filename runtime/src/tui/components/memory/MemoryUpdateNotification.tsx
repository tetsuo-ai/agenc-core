import { homedir } from 'os';
import React from 'react';
import { Box, Text } from '../../ink.js';
import { getCwd } from '../../../utils/cwd.js'; // upstream-import: keep target is owned by another Z-PURGE item
import { getRelativeMemoryPathForRoots } from './path-format.js';

/**
 * Ports the TUI source reference
 * `src/components/memory/MemoryUpdateNotification.tsx` path formatter and
 * update notice onto AgenC's TUI component tree.
 */
export function getRelativeMemoryPath(memoryPath: string): string {
  return getRelativeMemoryPathForRoots(memoryPath, homedir(), getCwd());
}

export function MemoryUpdateNotification({
  memoryPath,
}: {
  memoryPath: string;
}): React.ReactNode {
  const displayPath = getRelativeMemoryPath(memoryPath);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color="text">Memory updated in {displayPath} · /memory to edit</Text>
    </Box>
  );
}
