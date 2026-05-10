import { dirname, join } from 'path'

type PathPredicate = (path: string) => boolean

export const PRIMARY_PROJECT_INSTRUCTION_FILE = 'AGENC.md'
export const AGENTS_PROJECT_INSTRUCTION_FILE = 'AGENTS.md'
// The donor-product house-instructions filename is retained as an
// exported constant so the resolver code (which references it for
// type compatibility and historical lookups) keeps compiling, but it
// is NOT in `FALLBACK_PROJECT_INSTRUCTION_FILES`. That file is
// written in second-person roleplay language addressed to the donor
// product's assistant. Loading it as the system prompt for an
// unrelated model (e.g. Qwen via lmstudio) makes that model adopt
// the donor's identity verbatim, because it interprets the file as
// its own instructions.
// branding-scan: allow CLAUDE.md is a real upstream filename users have on disk
export const CLAUDE_PROJECT_INSTRUCTION_FILE = 'CLAUDE.md'
export const FALLBACK_PROJECT_INSTRUCTION_FILE = AGENTS_PROJECT_INSTRUCTION_FILE
export const FALLBACK_PROJECT_INSTRUCTION_FILES = [
  AGENTS_PROJECT_INSTRUCTION_FILE,
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
