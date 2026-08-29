import { beforeEach, describe, expect, test, vi } from 'vitest'

import { resolveHomeContext } from '../../src/config/home.js'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  clear: vi.fn(),
  browserLogin: vi.fn(),
  completeLogin: vi.fn(),
}))

vi.mock('../../src/utils/openAiOauthCredentials.js', () => ({
  readOpenAiOauthCredentials: mocks.read,
  clearOpenAiOauthCredentials: mocks.clear,
}))

vi.mock('../../src/services/openai/oauth.js', () => ({
  OpenAiOauthError: class OpenAiOauthError extends Error {},
  runOpenAiBrowserLogin: mocks.browserLogin,
}))

vi.mock('../../src/services/openai/login.js', () => ({
  OpenAiLoginCompletionError: class OpenAiLoginCompletionError extends Error {},
  completeOpenAiLogin: mocks.completeLogin,
}))

import {
  formatOpenAiAuthCliHelpText,
  parseOpenAiAuthCliArgs,
  runOpenAiAuthCli,
  type OpenAiAuthCliIo,
} from '../../src/bin/openai-auth-cli.js'

const home = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-openai-auth-cli-test' },
  { platformHome: '/tmp' },
)
const runtime = { home, environment: Object.freeze({}) }

function captureIo() {
  let stdout = ''
  let stderr = ''
  const io = {
    stdout: { write: (value: string) => (stdout += value) },
    stderr: { write: (value: string) => (stderr += value) },
  } as unknown as OpenAiAuthCliIo
  return {
    io,
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

describe('headless OpenAI auth CLI', () => {
  beforeEach(() => {
    mocks.read.mockReset()
    mocks.clear.mockReset()
    mocks.browserLogin.mockReset()
    mocks.completeLogin.mockReset()
    mocks.clear.mockReturnValue({ success: true })
  })

  test('parses canonical commands and documented aliases', () => {
    expect(parseOpenAiAuthCliArgs(['openai-login', '--json'])).toEqual({
      kind: 'login',
      json: true,
    })
    expect(parseOpenAiAuthCliArgs(['chatgpt-logout'])).toEqual({
      kind: 'logout',
      json: false,
    })
    expect(parseOpenAiAuthCliArgs(['chatgpt-auth-status'])).toEqual({
      kind: 'status',
      json: false,
    })
    expect(parseOpenAiAuthCliArgs(['openai-login', '--help'])).toEqual({
      kind: 'help',
    })
    expect(parseOpenAiAuthCliArgs(['openai-logout', 'typo'])).toEqual({
      kind: 'error',
      message: "OpenAI auth command 'openai-logout' accepts only --json or --help",
    })
    expect(parseOpenAiAuthCliArgs(['openai-logout', '--unknown'])).toEqual({
      kind: 'error',
      message: "OpenAI auth command 'openai-logout' accepts only --json or --help",
    })
    expect(formatOpenAiAuthCliHelpText()).toContain('openai-auth-status')
  })

  test('help and invalid logout arguments never touch credentials', async () => {
    for (const argv of [
      ['openai-logout', '--help'],
      ['openai-logout', 'typo'],
      ['openai-logout', '--unknown'],
    ]) {
      const command = parseOpenAiAuthCliArgs(argv)
      expect(command).not.toBeNull()
      const capture = captureIo()
      await expect(
        runOpenAiAuthCli(command!, runtime, capture.io),
      ).resolves.toBe(argv[1] === '--help' ? 0 : 1)
    }
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(mocks.browserLogin).not.toHaveBeenCalled()
  })

  test('JSON login reports progress and a final result from the shared login path', async () => {
    mocks.browserLogin.mockImplementation(async (options: {
      onAuthorizeUrl: (url: string) => Promise<void>
      onStage?: (stage: string) => void
    }) => {
      await options.onAuthorizeUrl('https://auth.openai.example/authorize')
      options.onStage?.('callback_received')
      options.onStage?.('exchanging_code')
      return { tokens: { accessToken: 'access-token' } }
    })
    mocks.completeLogin.mockResolvedValue({
      account: 'operator@example.com',
      authMode: 'chatgpt',
    })
    const capture = captureIo()
    const openUrl = vi.fn()

    await expect(runOpenAiAuthCli(
      { kind: 'login', json: true },
      runtime,
      { ...capture.io, openUrl },
    )).resolves.toBe(0)

    const records = capture.stdout().trim().split('\n').map(line => JSON.parse(line))
    expect(records).toEqual([
      { stage: 'authorize', url: 'https://auth.openai.example/authorize' },
      { stage: 'callback_received' },
      { stage: 'exchanging_code' },
      {
        ok: true,
        signedIn: true,
        account: 'operator@example.com',
        authMode: 'chatgpt',
      },
    ])
    expect(openUrl).toHaveBeenCalledTimes(1)
    expect(mocks.completeLogin).toHaveBeenCalledWith(expect.objectContaining({
      home,
      environment: runtime.environment,
    }))
    expect(capture.stderr()).toBe('')
  })

  test('JSON login failure emits a final machine-readable error', async () => {
    mocks.browserLogin.mockRejectedValue(new Error('browser login failed'))
    const capture = captureIo()

    await expect(runOpenAiAuthCli(
      { kind: 'login', json: true },
      runtime,
      capture.io,
    )).resolves.toBe(1)

    expect(JSON.parse(capture.stdout())).toEqual({
      ok: false,
      error: 'browser login failed',
    })
    expect(mocks.completeLogin).not.toHaveBeenCalled()
    expect(capture.stderr()).toBe('')
  })

  test('reports status from the explicitly bound home', async () => {
    mocks.read.mockReturnValue({
      apiKey: 'stored-key',
      accountLabel: 'operator@example.com',
    })
    const capture = captureIo()

    await expect(runOpenAiAuthCli(
      { kind: 'status', json: true },
      runtime,
      capture.io,
    )).resolves.toBe(0)
    expect(mocks.read).toHaveBeenCalledWith(home)
    expect(JSON.parse(capture.stdout())).toMatchObject({
      ok: true,
      signedIn: true,
      account: 'operator@example.com',
    })
    expect(capture.stderr()).toBe('')
  })

  test('clears only the explicitly bound home', async () => {
    mocks.read.mockReturnValue({ apiKey: 'stored-key' })
    const capture = captureIo()

    await expect(runOpenAiAuthCli(
      { kind: 'logout', json: false },
      runtime,
      capture.io,
    )).resolves.toBe(0)
    expect(mocks.clear).toHaveBeenCalledWith(home)
    expect(capture.stdout()).toBe('Signed out of ChatGPT.\n')
    expect(capture.stderr()).toBe('')
  })
})
