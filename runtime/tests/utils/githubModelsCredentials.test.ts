import { describe, expect, test } from 'bun:test'

describe('readGithubModelsToken', () => {
  test('returns undefined in bare mode', async () => {
    const { readGithubModelsToken } = await import(
      '../../src/utils/githubModelsCredentials.ts?read-bare-mode'
    )

    const prev = process.env.AGENC_SIMPLE
    process.env.AGENC_SIMPLE = '1'
    expect(readGithubModelsToken()).toBeUndefined()
    if (prev === undefined) {
      delete process.env.AGENC_SIMPLE
    } else {
      process.env.AGENC_SIMPLE = prev
    }
  })
})

describe('saveGithubModelsToken / clearGithubModelsToken', () => {
  test('save returns failure in bare mode', async () => {
    const { saveGithubModelsToken } = await import(
      '../../src/utils/githubModelsCredentials.ts?save-bare-mode'
    )

    const prev = process.env.AGENC_SIMPLE
    process.env.AGENC_SIMPLE = '1'
    const r = saveGithubModelsToken('abc')
    expect(r.success).toBe(false)
    expect(r.warning).toContain('Bare mode')
    if (prev === undefined) {
      delete process.env.AGENC_SIMPLE
    } else {
      process.env.AGENC_SIMPLE = prev
    }
  })

  test('clear succeeds in bare mode', async () => {
    const { clearGithubModelsToken } = await import(
      '../../src/utils/githubModelsCredentials.ts?clear-bare-mode'
    )

    const prev = process.env.AGENC_SIMPLE
    process.env.AGENC_SIMPLE = '1'
    expect(clearGithubModelsToken().success).toBe(true)
    if (prev === undefined) {
      delete process.env.AGENC_SIMPLE
    } else {
      process.env.AGENC_SIMPLE = prev
    }
  })
})

