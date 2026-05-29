import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  AGENTS_PROJECT_INSTRUCTION_FILE,
  CLAUDE_PROJECT_INSTRUCTION_FILE,
  findProjectInstructionFilePathInAncestors,
  FALLBACK_PROJECT_INSTRUCTION_FILE,
  FALLBACK_PROJECT_INSTRUCTION_FILES,
  getProjectInstructionFileNames,
  getProjectInstructionFilePath,
  getProjectInstructionFilePaths,
  hasProjectInstructionFile,
  isProjectInstructionFileName,
  PRIMARY_PROJECT_INSTRUCTION_FILE,
} from '../../src/utils/projectInstructions.ts'

describe('projectInstructions', () => {
  test('prefers AGENC.md over fallback project instructions', () => {
    const dir = '/repo'
    const existingPaths = new Set([
      join(dir, PRIMARY_PROJECT_INSTRUCTION_FILE),
      join(dir, FALLBACK_PROJECT_INSTRUCTION_FILE),
      join(dir, CLAUDE_PROJECT_INSTRUCTION_FILE),
    ])

    const filePath = getProjectInstructionFilePath(
      dir,
      path => existingPaths.has(path),
    )

    expect(filePath).toBe(join(dir, PRIMARY_PROJECT_INSTRUCTION_FILE))
  })

  test('falls back to AGENTS.md when AGENC.md is absent', () => {
    const dir = '/repo'
    const existingPaths = new Set([join(dir, FALLBACK_PROJECT_INSTRUCTION_FILE)])

    const filePath = getProjectInstructionFilePath(
      dir,
      path => existingPaths.has(path),
    )

    expect(filePath).toBe(join(dir, FALLBACK_PROJECT_INSTRUCTION_FILE))
  })

  test('does not fall back to legacy donor instruction files', () => {
    const dir = '/repo'
    const existingPaths = new Set([join(dir, CLAUDE_PROJECT_INSTRUCTION_FILE)])

    const filePath = getProjectInstructionFilePath(
      dir,
      path => existingPaths.has(path),
    )

    expect(filePath).toBe(join(dir, PRIMARY_PROJECT_INSTRUCTION_FILE))
    expect(hasProjectInstructionFile(dir, path => existingPaths.has(path))).toBe(
      false,
    )
  })

  test('skips non-regular candidates when a usable predicate is provided', () => {
    const dir = '/repo'
    const existingPaths = new Set([
      join(dir, PRIMARY_PROJECT_INSTRUCTION_FILE),
      join(dir, AGENTS_PROJECT_INSTRUCTION_FILE),
    ])
    const regularFiles = new Set([join(dir, AGENTS_PROJECT_INSTRUCTION_FILE)])

    const filePath = getProjectInstructionFilePath(
      dir,
      path => existingPaths.has(path),
      path => regularFiles.has(path),
    )

    expect(filePath).toBe(join(dir, AGENTS_PROJECT_INSTRUCTION_FILE))
    expect(
      findProjectInstructionFilePathInAncestors(
        join(dir, 'src'),
        path => existingPaths.has(path),
        path => regularFiles.has(path),
      ),
    ).toBe(join(dir, AGENTS_PROJECT_INSTRUCTION_FILE))
  })

  test('returns project instruction paths in priority order', () => {
    const dir = '/repo'

    expect(getProjectInstructionFileNames()).toEqual([
      PRIMARY_PROJECT_INSTRUCTION_FILE,
      ...FALLBACK_PROJECT_INSTRUCTION_FILES,
    ])
    expect(getProjectInstructionFilePaths(dir)).toEqual([
      join(dir, PRIMARY_PROJECT_INSTRUCTION_FILE),
      join(dir, AGENTS_PROJECT_INSTRUCTION_FILE),
    ])
  })

  test('detects whether a repo instruction file exists', () => {
    const dir = '/repo'
    const existingPaths = new Set([join(dir, PRIMARY_PROJECT_INSTRUCTION_FILE)])

    expect(hasProjectInstructionFile(dir, path => existingPaths.has(path))).toBe(
      true,
    )
    expect(hasProjectInstructionFile(dir, () => false)).toBe(false)
  })

  test('recognizes root instruction filenames', () => {
    expect(isProjectInstructionFileName(PRIMARY_PROJECT_INSTRUCTION_FILE)).toBe(
      true,
    )
    expect(isProjectInstructionFileName(FALLBACK_PROJECT_INSTRUCTION_FILE)).toBe(
      true,
    )
    expect(isProjectInstructionFileName(CLAUDE_PROJECT_INSTRUCTION_FILE)).toBe(
      false,
    )
    expect(isProjectInstructionFileName('README.md')).toBe(false)
  })

  test('finds repo instructions in ancestor directories', () => {
    const repoDir = '/repo'
    const nestedDir = join(repoDir, 'packages', 'app')
    const existingPaths = new Set([join(repoDir, PRIMARY_PROJECT_INSTRUCTION_FILE)])

    expect(
      findProjectInstructionFilePathInAncestors(
        nestedDir,
        path => existingPaths.has(path),
      ),
    ).toBe(join(repoDir, PRIMARY_PROJECT_INSTRUCTION_FILE))
  })

  test('prefers the closest ancestor project instruction file', () => {
    const repoDir = '/repo'
    const nestedProjectDir = join(repoDir, 'packages', 'app')
    const existingPaths = new Set([
      join(repoDir, PRIMARY_PROJECT_INSTRUCTION_FILE),
      join(nestedProjectDir, FALLBACK_PROJECT_INSTRUCTION_FILE),
    ])

    expect(
      findProjectInstructionFilePathInAncestors(
        join(nestedProjectDir, 'src'),
        path => existingPaths.has(path),
      ),
    ).toBe(join(nestedProjectDir, FALLBACK_PROJECT_INSTRUCTION_FILE))
  })

  test('returns null when no ancestor repo instruction file exists', () => {
    expect(
      findProjectInstructionFilePathInAncestors('/repo/packages/app', () => false),
    ).toBeNull()
  })
})
