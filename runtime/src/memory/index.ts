/**
 * Public memory access surface for runtime, tools, and service code.
 *
 * Why this lives here:
 *   - The low-level memory ports live in focused modules, but tool and code
 *     paths should not depend on the original donor-shaped file split.
 *   - Stable exports here let memory callers consume recall, freshness, path
 *     resolution, and memory-file detection from one AgenC-owned API.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Team-memory sync transport remains behind the existing feature gates.
 *   - Session-memory services keep their own session/turn-context boundary.
 */
import { memoryAge, memoryFreshnessText } from './age.js'
import type { RelevantMemory } from './find-relevant.js'

type AgenCMdModule = typeof import('./agencmd.js')

export {
  memoryAge,
  memoryAgeDays,
  memoryFreshnessNote,
  memoryFreshnessText,
} from './age.js'

export type { RelevantMemory } from './find-relevant.js'
export type { ExternalAgenCMdInclude, MemoryFileInfo } from './agencmd.js'

export {
  ALL_PERSONA_FILE_NAMES,
  BOOTSTRAP_FILE_NAME,
  capPersonaContent,
  getPersonaMemoryFiles,
  IDENTITY_FILE_NAME,
  PERSONA_FILE_MAX_BYTES,
  PERSONA_FILE_NAMES,
} from './persona.js'

export {
  clearMemoryFileCaches,
  filterInjectedMemoryFiles,
  getAgenCMds,
  getAllMemoryFilePaths,
  getExternalAgenCMdIncludes,
  getLargeMemoryFiles,
  getProjectMemoryPathForSelector,
  hasExternalAgenCMdIncludes,
  isMemoryFilePath,
  isMemoryMention,
  MAX_MEMORY_CHARACTER_COUNT,
  MEMORY_MENTION_ALIASES,
  MEMORY_MENTION_SYNTAX,
  resetGetMemoryFilesCache,
  stripHtmlComments,
} from './project-memory.js'

export {
  formatMemoryManifest,
  MAX_MEMORY_FILES,
  scanMemoryFiles,
  type MemoryHeader,
} from './scan.js'

export {
  getAutoMemEntrypoint,
  getAutoMemDailyLogPath,
  getAutoMemPath,
  getGlobalMemoryEntrypoint,
  getGlobalMemoryPath,
  getMemoryBaseDir,
  getProjectInstructionPath,
  getProjectMemoryEntrypoint,
  getProjectMemoryPath,
  hasAutoMemPathOverride,
  isAutoMemoryEnabled,
  isAutoMemPath,
  isDurableMemoryPath,
  isExtractModeActive,
  isGlobalMemoryPath,
  isProjectMemoryPath,
  MEMORY_DIRNAME,
  MEMORY_ENTRYPOINT_NAME,
  PROJECT_INSTRUCTION_FILE,
  PROJECT_MEMORY_DIR,
} from './paths.js'

export {
  detectSessionFileType,
  detectSessionPatternType,
  checkTeamMemSecrets,
  getSecretLabel,
  isAutoManagedMemoryFile,
  isAutoManagedMemoryPattern,
  isAutoMemFile,
  isMemoryDirectory,
  isShellCommandTargetingMemory,
  memoryScopeForPath,
  redactSecrets,
  scanForSecrets,
  type MemoryScope,
  type SecretMatch,
  type SessionFileType,
} from './privacy.js'

export function formatRelevantMemoryHeader(
  path: string,
  mtimeMs: number,
): string {
  const staleness = memoryFreshnessText(mtimeMs)
  return staleness
    ? `${staleness}\n\nMemory: ${path}:`
    : `Memory (saved ${memoryAge(mtimeMs)}): ${path}:`
}

export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  // Keep the side-query chain out of scan/path-only imports.
  const memoryRecall = await import('./find-relevant.js')
  return memoryRecall.findRelevantMemories(
    query,
    memoryDir,
    signal,
    recentTools,
    alreadySurfaced,
  )
}

export async function getMemoryFiles(
  ...args: Parameters<AgenCMdModule['getMemoryFiles']>
): ReturnType<AgenCMdModule['getMemoryFiles']> {
  const agencmd = await import('./agencmd.js')
  return agencmd.getMemoryFiles(...args)
}

export async function processMemoryFile(
  ...args: Parameters<AgenCMdModule['processMemoryFile']>
): ReturnType<AgenCMdModule['processMemoryFile']> {
  const agencmd = await import('./agencmd.js')
  return agencmd.processMemoryFile(...args)
}

export async function processMdRules(
  ...args: Parameters<AgenCMdModule['processMdRules']>
): ReturnType<AgenCMdModule['processMdRules']> {
  const agencmd = await import('./agencmd.js')
  return agencmd.processMdRules(...args)
}

export async function processConditionedMdRules(
  ...args: Parameters<AgenCMdModule['processConditionedMdRules']>
): ReturnType<AgenCMdModule['processConditionedMdRules']> {
  const agencmd = await import('./agencmd.js')
  return agencmd.processConditionedMdRules(...args)
}

export async function getManagedAndUserConditionalRules(
  ...args: Parameters<AgenCMdModule['getManagedAndUserConditionalRules']>
): ReturnType<AgenCMdModule['getManagedAndUserConditionalRules']> {
  const agencmd = await import('./agencmd.js')
  return agencmd.getManagedAndUserConditionalRules(...args)
}

export async function getMemoryFilesForNestedDirectory(
  ...args: Parameters<AgenCMdModule['getMemoryFilesForNestedDirectory']>
): ReturnType<AgenCMdModule['getMemoryFilesForNestedDirectory']> {
  const agencmd = await import('./agencmd.js')
  return agencmd.getMemoryFilesForNestedDirectory(...args)
}

export async function getConditionalRulesForCwdLevelDirectory(
  ...args: Parameters<AgenCMdModule['getConditionalRulesForCwdLevelDirectory']>
): ReturnType<AgenCMdModule['getConditionalRulesForCwdLevelDirectory']> {
  const agencmd = await import('./agencmd.js')
  return agencmd.getConditionalRulesForCwdLevelDirectory(...args)
}

export async function shouldShowAgenCMdExternalIncludesWarning(
  ...args: Parameters<AgenCMdModule['shouldShowAgenCMdExternalIncludesWarning']>
): ReturnType<AgenCMdModule['shouldShowAgenCMdExternalIncludesWarning']> {
  const agencmd = await import('./agencmd.js')
  return agencmd.shouldShowAgenCMdExternalIncludesWarning(...args)
}
