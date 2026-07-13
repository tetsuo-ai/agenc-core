import { homedir } from 'os';
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
