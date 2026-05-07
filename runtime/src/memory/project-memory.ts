/**
 * Ports the TUI source reference project-instruction loader, memory selector
 * helper, and memory-file detection helper onto AgenC's project-memory API.
 *
 * Why this lives here / shape difference from upstream:
 *   - MM-01 already owns the low-level loader and detection implementation.
 *     This file is the strict public surface for project-memory callers.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Feature-flagged team memory behavior remains behind the existing
 *     runtime feature gates in the underlying implementation.
 */
import { basename, join } from 'path'

import type { MemoryFileInfo } from './agencmd.js'
import {
  findProjectInstructionFilePathInAncestors,
  isProjectInstructionFileName,
  PRIMARY_PROJECT_INSTRUCTION_FILE,
} from '../utils/projectInstructions.js'

export type { ExternalAgenCMdInclude, MemoryFileInfo } from './agencmd.js'

export {
  clearMemoryFileCaches,
  filterInjectedMemoryFiles,
  getAgenCMds,
  getAllMemoryFilePaths,
  getConditionalRulesForCwdLevelDirectory,
  getExternalAgenCMdIncludes,
  getLargeMemoryFiles,
  getManagedAndUserConditionalRules,
  getMemoryFiles,
  getMemoryFilesForNestedDirectory,
  hasExternalAgenCMdIncludes,
  isMemoryFilePath,
  MAX_MEMORY_CHARACTER_COUNT,
  processConditionedMdRules,
  processMdRules,
  processMemoryFile,
  resetGetMemoryFilesCache,
  shouldShowAgenCMdExternalIncludesWarning,
  stripHtmlComments,
} from './agencmd.js'

export {
  detectSessionFileType,
  detectSessionPatternType,
  isAutoManagedMemoryFile,
  isAutoManagedMemoryPattern,
  isAutoMemFile,
  isMemoryDirectory,
  isShellCommandTargetingMemory,
  memoryScopeForPath,
  type MemoryScope,
} from './privacy.js'

export const MEMORY_MENTION_SYNTAX = '@memory'
export const MEMORY_MENTION_ALIASES = ['@memory', '@memories'] as const
const MEMORY_MENTION_RE = /^@(memory|memories)(?:(?:[:/])[\w./-]+)?$/i

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

export function isMemoryMention(input: string): boolean {
  return MEMORY_MENTION_RE.test(input.trim())
}
