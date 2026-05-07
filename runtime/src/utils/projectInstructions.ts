import { dirname, join } from 'path'

type PathPredicate = (path: string) => boolean

export const PRIMARY_PROJECT_INSTRUCTION_FILE = 'AGENC.md'
export const AGENTS_PROJECT_INSTRUCTION_FILE = 'AGENTS.md'
export const CLAUDE_PROJECT_INSTRUCTION_FILE = 'CLAUDE.md'
export const FALLBACK_PROJECT_INSTRUCTION_FILE = AGENTS_PROJECT_INSTRUCTION_FILE
export const FALLBACK_PROJECT_INSTRUCTION_FILES = [
  AGENTS_PROJECT_INSTRUCTION_FILE,
  CLAUDE_PROJECT_INSTRUCTION_FILE,
] as const

export function getProjectInstructionFileNames(): readonly string[] {
  return [
    PRIMARY_PROJECT_INSTRUCTION_FILE,
    ...FALLBACK_PROJECT_INSTRUCTION_FILES,
  ]
}

export function getProjectInstructionFilePaths(dir: string): string[] {
  return getProjectInstructionFileNames().map(name => join(dir, name))
}

export function getProjectInstructionFilePath(
  dir: string,
  existsSync: PathPredicate,
  isUsableFile: PathPredicate = existsSync,
): string {
  const candidates = getProjectInstructionFilePaths(dir)
  return candidates.find(path => isUsableFile(path)) ?? candidates[0]!
}

export function hasProjectInstructionFile(
  dir: string,
  existsSync: PathPredicate,
  isUsableFile: PathPredicate = existsSync,
): boolean {
  return getProjectInstructionFilePaths(dir).some(path => isUsableFile(path))
}

export function findProjectInstructionFilePathInAncestors(
  startDir: string,
  existsSync: PathPredicate,
  isUsableFile: PathPredicate = existsSync,
): string | null {
  let currentDir = startDir

  while (true) {
    if (hasProjectInstructionFile(currentDir, existsSync, isUsableFile)) {
      return getProjectInstructionFilePath(currentDir, existsSync, isUsableFile)
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return null
    }

    currentDir = parentDir
  }
}

export function isProjectInstructionFileName(name: string): boolean {
  return getProjectInstructionFileNames().includes(name)
}
