import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: (_flag: string) => false,
}))
vi.mock('../analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: <T>(_key: string, fallback: T) =>
    fallback,
}))
vi.mock('../../utils/settings/settings.js', () => ({
  getInitialSettings: () => ({ autoMemoryEnabled: true }),
  getSettingsForSource: () => undefined,
}))
vi.mock('../../tools.js', () => ({}))
vi.mock('src/tools.js', () => ({}))

import { getProjectRoot, setProjectRoot } from '../../bootstrap/state.js'
import { getProjectMemoryPath } from '../../memory/index.js'
import { readLocalTeamMemory } from './index.js'

let tempRoot = ''
let oldProjectRoot = ''
let oldConfigDir: string | undefined
let oldDisableAutoMemory: string | undefined

const fakeGitHubPat = `ghp_${'A'.repeat(36)}`

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'agenc-team-memory-privacy-'))
  oldProjectRoot = getProjectRoot()
  oldConfigDir = process.env.AGENC_CONFIG_DIR
  oldDisableAutoMemory = process.env.AGENC_DISABLE_AUTO_MEMORY
  process.env.AGENC_CONFIG_DIR = join(tempRoot, 'home')
  process.env.AGENC_DISABLE_AUTO_MEMORY = '0'
  setProjectRoot(join(tempRoot, 'repo'))
  getProjectMemoryPath.cache?.clear?.()
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
  getProjectMemoryPath.cache?.clear?.()
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('team memory privacy screening', () => {
  it('skips secret-bearing local files before building upload entries', async () => {
    const teamDir = join(getProjectMemoryPath(), 'team')
    mkdirSync(teamDir, { recursive: true })
    writeFileSync(join(teamDir, 'safe.md'), 'shared project convention')
    writeFileSync(join(teamDir, 'secret.md'), `token=${fakeGitHubPat}`)

    const result = await readLocalTeamMemory(null)

    expect(result.entries).toEqual({ 'safe.md': 'shared project convention' })
    expect(result.skippedSecrets).toEqual([
      {
        path: 'secret.md',
        ruleId: 'github-pat',
        label: 'GitHub PAT',
      },
    ])
  })
})
