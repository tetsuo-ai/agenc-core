import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ConfigStore } from '../config/store.js'
import { runWithCanonicalSettingsAuthority } from '../utils/settings/canonicalAuthority.js'

vi.mock('bun:bundle', () => ({ feature: () => false }))
vi.mock('../tools.js', () => ({}))
vi.mock('src/tools.js', () => ({}))

import {
  detectSessionFileType,
  detectSessionPatternType,
  getProjectMemoryPathForSelector,
  isMemoryFilePath,
  isMemoryMention,
  MEMORY_MENTION_ALIASES,
  MEMORY_MENTION_SYNTAX,
  type MemoryFileInfo,
} from './project-memory.js'

function projectFile(path: string, parent?: string): MemoryFileInfo {
  return {
    path,
    parent,
    type: 'Project',
    content: '',
  }
}

describe('project-memory API', () => {
  it('selects the nearest loaded project instruction file', () => {
    const repoDir = '/repo'
    const packageDir = join(repoDir, 'packages', 'app')

    expect(
      getProjectMemoryPathForSelector(
        [
          projectFile(join(repoDir, 'AGENC.md')),
          projectFile(join(packageDir, 'AGENC.md')),
        ],
        join(packageDir, 'src'),
      ),
    ).toBe(join(packageDir, 'AGENC.md'))
  })

  it('defaults new project memory to AGENC.md in the current directory', () => {
    const cwd = join('/repo', 'packages', 'app')
    expect(
      getProjectMemoryPathForSelector(
        [projectFile(join('/other-worktree', 'AGENTS.md'))],
        cwd,
      ),
    ).toBe(join(cwd, 'AGENC.md'))
  })

  it('ignores included project instruction files for selector ownership', () => {
    const repoDir = '/repo'
    const includePath = join(repoDir, 'included', 'AGENTS.md')

    expect(
      getProjectMemoryPathForSelector(
        [
          projectFile(join(repoDir, 'AGENC.md')),
          projectFile(includePath, join(repoDir, 'AGENC.md')),
        ],
        join(repoDir, 'src'),
      ),
    ).toBe(join(repoDir, 'AGENC.md'))
  })

  it('exposes memory mention syntax for mention extraction routing', () => {
    expect(MEMORY_MENTION_ALIASES).toEqual(['@memory', '@memories'])
    expect(MEMORY_MENTION_SYNTAX).toBe('@memory')
    expect(isMemoryMention('@memory')).toBe(true)
    expect(isMemoryMention('@memory/project')).toBe(true)
    expect(isMemoryMention('@memories:global')).toBe(true)
    expect(isMemoryMention('  @MeMoRy  ')).toBe(true)
    expect(isMemoryMention('@memo')).toBe(false)
    expect(isMemoryMention('@memory:')).toBe(false)
    expect(isMemoryMention('@memory/')).toBe(false)
    expect(isMemoryMention('@memory-other')).toBe(false)
  })

  it('re-exports project memory file and pattern detection helpers', () => {
    expect(isMemoryFilePath(join('/repo', 'AGENTS.md'))).toBe(true)
    expect(isMemoryFilePath(join('/repo', 'CLAUDE.md'))).toBe(false)
    expect(isMemoryFilePath(join('/repo', '.agenc', 'rules', 'style.md'))).toBe(
      true,
    )
    expect(detectSessionPatternType('session-memory/*.md')).toBe(
      'session_memory',
    )
  })

  it('classifies session files through the canonical detector', () => {
    const store = new ConfigStore({
      home: '/tmp/agenc-test-config',
      env: { AGENC_HOME: '/tmp/agenc-test-config' },
      cwd: '/tmp',
    })
    runWithCanonicalSettingsAuthority(store, () => {
      expect(
        detectSessionFileType(
          '/tmp/agenc-test-config/session-memory/summary.md',
        ),
      ).toBe('session_memory')
      expect(
        detectSessionFileType('/tmp/agenc-test-config/projects/repo/turn.jsonl'),
      ).toBe('session_transcript')
      expect(detectSessionFileType('/tmp/other/session-memory/summary.md')).toBe(
        null,
      )
    })
  })
})
