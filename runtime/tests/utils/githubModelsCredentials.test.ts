import { describe, expect, test } from 'bun:test'
import {
  resolveAgentRuntimeOptions,
  runWithAgentRuntimeOptions,
} from '../../src/session/runtime-options.ts'
import { resolveHomeContext } from '../../src/config/home.ts'

const SIMPLE_MODE = resolveAgentRuntimeOptions({}, { simpleMode: true })
const HOME = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-github-models-bare' },
  { platformHome: '/tmp' },
)

describe('readGithubModelsToken', () => {
  test('returns undefined in bare mode', async () => {
    const { readGithubModelsToken } = await import(
      '../../src/utils/githubModelsCredentials.ts?read-bare-mode'
    )

    runWithAgentRuntimeOptions(SIMPLE_MODE, () => {
      expect(readGithubModelsToken(HOME)).toBeUndefined()
    })
  })
})

describe('saveGithubModelsToken / clearGithubModelsToken', () => {
  test('save returns failure in bare mode', async () => {
    const { saveGithubModelsToken } = await import(
      '../../src/utils/githubModelsCredentials.ts?save-bare-mode'
    )

    runWithAgentRuntimeOptions(SIMPLE_MODE, () => {
      const r = saveGithubModelsToken(HOME, 'abc')
      expect(r.success).toBe(false)
      expect(r.warning).toContain('Bare mode')
    })
  })

  test('clear succeeds in bare mode', async () => {
    const { clearGithubModelsToken } = await import(
      '../../src/utils/githubModelsCredentials.ts?clear-bare-mode'
    )

    runWithAgentRuntimeOptions(SIMPLE_MODE, () => {
      expect(clearGithubModelsToken(HOME).success).toBe(true)
    })
  })
})
