import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: (flag: string) => flag === 'TEAMMEM',
}))
vi.mock('../utils/settings/settings.js', () => ({
  getInitialSettings: () => ({ autoMemoryEnabled: true }),
  getSettingsForSource: () => undefined,
}))
vi.mock('../tui/message-renderers/CollapsedReadSearchContent.tsx', () => ({
  CollapsedReadSearchContent: () => null,
}))
vi.mock('../tui/message-renderers/SystemTextMessage.tsx', () => ({
  SystemTextMessage: () => null,
}))
vi.mock('../tools.js', () => ({}))
vi.mock('src/tools.js', () => ({}))

import { getProjectRoot, setProjectRoot } from '../bootstrap/state.js'
import {
  getGlobalMemoryPath,
  getProjectMemoryPath,
} from './paths.js'
import {
  checkTeamMemSecrets,
  detectSessionFileType,
  detectSessionPatternType,
  getSecretLabel,
  isAutoManagedMemoryFile,
  isMemoryDirectory,
  isShellCommandTargetingMemory,
  memoryScopeForPath,
  redactSecrets,
  scanForSecrets,
} from './privacy.js'
import { getAgentMemoryDir } from '../tools/AgentTool/agentMemory.js'

let tempRoot = ''
let oldProjectRoot = ''
let oldConfigDir: string | undefined
let oldDisableAutoMemory: string | undefined
let oldRemoteMemoryDir: string | undefined
let oldPathOverride: string | undefined

const fakeGitHubPat = `ghp_${'A'.repeat(36)}`

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'agenc-memory-privacy-'))
  oldProjectRoot = getProjectRoot()
  oldConfigDir = process.env.AGENC_CONFIG_DIR
  oldDisableAutoMemory = process.env.AGENC_DISABLE_AUTO_MEMORY
  oldRemoteMemoryDir = process.env.AGENC_REMOTE_MEMORY_DIR
  oldPathOverride = process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE
  process.env.AGENC_CONFIG_DIR = join(tempRoot, 'home')
  process.env.AGENC_DISABLE_AUTO_MEMORY = '0'
  delete process.env.AGENC_REMOTE_MEMORY_DIR
  delete process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE
  setProjectRoot(join(tempRoot, 'repo'))
  clearPathCaches()
})

afterEach(() => {
  setProjectRoot(oldProjectRoot)
  if (oldConfigDir === undefined) delete process.env.AGENC_CONFIG_DIR
  else process.env.AGENC_CONFIG_DIR = oldConfigDir
  if (oldDisableAutoMemory === undefined) {
    delete process.env.AGENC_DISABLE_AUTO_MEMORY
  } else {
    process.env.AGENC_DISABLE_AUTO_MEMORY = oldDisableAutoMemory
  }
  if (oldRemoteMemoryDir === undefined) delete process.env.AGENC_REMOTE_MEMORY_DIR
  else process.env.AGENC_REMOTE_MEMORY_DIR = oldRemoteMemoryDir
  if (oldPathOverride === undefined) {
    delete process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE
  } else {
    process.env.AGENC_COWORK_MEMORY_PATH_OVERRIDE = oldPathOverride
  }
  clearPathCaches()
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('memory privacy', () => {
  it('classifies durable, team, and session memory paths', () => {
    const configDir = join(tempRoot, 'home')
    const projectMemoryFile = join(getProjectMemoryPath(), 'notes.md')
    const globalMemoryFile = join(getGlobalMemoryPath(), 'profile.md')
    const teamMemoryFile = join(getProjectMemoryPath(), 'team', 'shared.md')
    const sessionSummary = join(
      tempRoot,
      'home',
      'session-memory',
      'summary.md',
    )
    const transcript = join(tempRoot, 'home', 'projects', 'repo.jsonl')

    expect(memoryScopeForPath(projectMemoryFile)).toBe('personal')
    expect(memoryScopeForPath(globalMemoryFile)).toBe('personal')
    expect(memoryScopeForPath(teamMemoryFile)).toBe('team')
    expect(isAutoManagedMemoryFile(projectMemoryFile)).toBe(true)
    expect(isAutoManagedMemoryFile(teamMemoryFile)).toBe(true)
    expect(
      isAutoManagedMemoryFile(
        join(getAgentMemoryDir('privacy-worker', 'user'), 'MEMORY.md'),
      ),
    ).toBe(true)
    expect(detectSessionFileType(sessionSummary)).toBe('session_memory')
    expect(detectSessionFileType(transcript)).toBe('session_transcript')
    expect(detectSessionPatternType('session-memory/*.md')).toBe(
      'session_memory',
    )
    expect(detectSessionPatternType('projects/repo/*.jsonl')).toBe(
      'session_transcript',
    )
    expect(detectSessionPatternType('*.jsonl')).toBe('session_transcript')
    expect(detectSessionPatternType('logs/*.jsonl')).toBeNull()
    expect(
      detectSessionFileType(join(`${configDir}-evil`, 'session-memory', 'x.md')),
    ).toBeNull()
    expect(memoryScopeForPath(join(tempRoot, 'repo', 'AGENC.md'))).toBeNull()
  })

  it('detects memory directories and shell commands targeting memory', () => {
    const configDir = join(tempRoot, 'home')
    const projectMemoryDir = getProjectMemoryPath().replace(/[/\\]+$/, '')
    const globalMemoryDir = getGlobalMemoryPath().replace(/[/\\]+$/, '')
    const projectMemoryFile = join(getProjectMemoryPath(), 'notes.md')
    const projectMemorySibling = `${projectMemoryDir}-evil`
    const projectMemorySiblingFile = join(projectMemorySibling, 'notes.md')

    expect(isMemoryDirectory(projectMemoryDir)).toBe(true)
    expect(isMemoryDirectory(getGlobalMemoryPath())).toBe(true)
    expect(isMemoryDirectory(globalMemoryDir)).toBe(true)
    expect(isShellCommandTargetingMemory(`grep token ${projectMemoryFile}`)).toBe(
      true,
    )
    expect(isAutoManagedMemoryFile(projectMemorySiblingFile)).toBe(false)
    expect(isMemoryDirectory(projectMemorySibling)).toBe(false)
    expect(isMemoryDirectory(join(`${configDir}-evil`, 'memory'))).toBe(false)
    expect(
      isShellCommandTargetingMemory(`grep token ${projectMemorySiblingFile}`),
    ).toBe(false)
    expect(isShellCommandTargetingMemory('grep token /tmp/not-memory.txt')).toBe(
      false,
    )
  })

  it('scans and redacts high-confidence memory secrets without returning values', () => {
    const content = `token=${fakeGitHubPat}`

    expect(scanForSecrets(content)).toEqual([
      { ruleId: 'github-pat', label: 'GitHub PAT' },
    ])
    expect(scanForSecrets(`${content}\nagain=${fakeGitHubPat}`)).toHaveLength(1)
    // branding-scan: allow real provider display name
    expect(getSecretLabel('openai-api-key')).toBe('OpenAI API Key')
    expect(redactSecrets(content)).toBe('token=[REDACTED]')
    expect(redactSecrets(content)).not.toContain(fakeGitHubPat)
  })

  it('rejects secret-bearing writes only inside team memory', () => {
    const teamMemoryFile = join(getProjectMemoryPath(), 'team', 'shared.md')
    const projectMemoryFile = join(getProjectMemoryPath(), 'notes.md')

    expect(checkTeamMemSecrets(teamMemoryFile, 'safe note')).toBeNull()
    expect(checkTeamMemSecrets(projectMemoryFile, fakeGitHubPat)).toBeNull()
    expect(checkTeamMemSecrets(teamMemoryFile, fakeGitHubPat)).toContain(
      'GitHub PAT',
    )
  })
})

function clearPathCaches(): void {
  getProjectMemoryPath.cache?.clear?.()
}
