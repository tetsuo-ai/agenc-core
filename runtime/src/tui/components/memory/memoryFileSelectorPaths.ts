import { basename, join } from 'path'

import type { MemoryFileInfo } from '../../../agenc/upstream/utils/claudemd' // branding-scan: allow upstream mirror import path pending purge // upstream-import: keep target is owned by another Z-PURGE item
import {
  findProjectInstructionFilePathInAncestors,
  isProjectInstructionFileName,
  PRIMARY_PROJECT_INSTRUCTION_FILE,
} from '../../../agenc/upstream/utils/projectInstructions' // upstream-import: keep target is owned by another Z-PURGE item

function isLoadedProjectInstructionFile(file: MemoryFileInfo): boolean {
  return (
    file.type === 'Project' &&
    file.parent === undefined &&
    isProjectInstructionFileName(basename(file.path))
  )
}

export function getProjectMemoryPathForSelector(
  existingMemoryFiles: MemoryFileInfo[],
  cwd: string,
): string {
  const loadedProjectInstructionPaths = new Set(
    existingMemoryFiles
      .filter(isLoadedProjectInstructionFile)
      .map(file => file.path),
  )

  return (
    findProjectInstructionFilePathInAncestors(
      cwd,
      path => loadedProjectInstructionPaths.has(path),
    ) ?? join(cwd, PRIMARY_PROJECT_INSTRUCTION_FILE)
  )
}
