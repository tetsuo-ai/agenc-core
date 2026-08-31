import { beforeEach, describe, expect, test, vi } from 'vitest'

import { resolveHomeContext } from '../../src/config/home.js'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
}))

vi.mock('../../src/utils/openAiOauthCredentials.js', () => ({
  readOpenAiOauthCredentials: mocks.read,
}))

import {
  formatOpenAiModelsCliHelpText,
  parseOpenAiModelsCliArgs,
  runOpenAiModelsCli,
  type OpenAiModelsCliIo,
} from '../../src/bin/openai-models-cli.js'

const home = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-openai-models-cli-test' },
  { platformHome: '/tmp' },
)

// A JWT-shaped access token whose payload carries the chatgpt account id.
const ACCESS_TOKEN = [
  Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
  Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
    }),
  ).toString('base64url'),
  '',
].join('.')

function captureIo(fetchImpl: OpenAiModelsCliIo['fetchImpl']) {
  let stdout = ''
  let stderr = ''
  const io = {
    stdout: { write: (value: string) => (stdout += value) },
    stderr: { write: (value: string) => (stderr += value) },
    fetchImpl,
  } as unknown as OpenAiModelsCliIo
  return {
    io,
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

function lastJson(output: string): Record<string, unknown> {
  const lines = output.split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>
}

describe('headless OpenAI model discovery CLI', () => {
  beforeEach(() => {
    mocks.read.mockReset()
  })

  test('parses the command and rejects stray arguments', () => {
    expect(parseOpenAiModelsCliArgs(['openai-models', '--json'])).toEqual({
      kind: 'list',
      json: true,
    })
    expect(parseOpenAiModelsCliArgs(['openai-models'])).toEqual({
      kind: 'list',
      json: false,
    })
    expect(parseOpenAiModelsCliArgs(['openai-models', '--help'])).toEqual({
      kind: 'help',
    })
    expect(parseOpenAiModelsCliArgs(['openai-models', 'typo'])).toEqual({
      kind: 'error',
      message: 'openai-models accepts only --json or --help',
    })
    expect(parseOpenAiModelsCliArgs(['providers'])).toBeNull()
  })

  test('chatgpt sign-in queries the subscription backend', async () => {
    mocks.read.mockReturnValue({
      authMode: 'chatgpt',
      accessToken: ACCESS_TOKEN,
      accountId: 'acct-1',
    })
    const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=1.0.0')
      expect(init?.headers?.['ChatGPT-Account-ID']).toBe('acct-1')
      expect(init?.headers?.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.4' }],
        }),
      }
    })
    const { io, stdout } = captureIo(fetchImpl)
    const code = await runOpenAiModelsCli(
      { kind: 'list', json: true },
      { home, environment: Object.freeze({}) },
      io,
    )
    expect(code).toBe(0)
    expect(lastJson(stdout())).toEqual({
      ok: true,
      models: ['gpt-5.6-sol', 'gpt-5.4'],
      authMode: 'chatgpt',
    })
  })

  test('api-key credential queries api.openai.com', async () => {
    mocks.read.mockReturnValue({ authMode: 'apiKey', apiKey: 'sk-test' })
    const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toBe('https://api.openai.com/v1/models')
      expect(init?.headers?.Authorization).toBe('Bearer sk-test')
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-5' }, { id: 'gpt-5' }] }),
      }
    })
    const { io, stdout } = captureIo(fetchImpl)
    const code = await runOpenAiModelsCli(
      { kind: 'list', json: true },
      { home, environment: Object.freeze({}) },
      io,
    )
    expect(code).toBe(0)
    expect(lastJson(stdout())).toEqual({
      ok: true,
      models: ['gpt-5'],
      authMode: 'apiKey',
    })
  })

  test('environment key works without a stored credential', async () => {
    mocks.read.mockReturnValue(undefined)
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'gpt-5.4-mini' }] }),
    }))
    const { io, stdout } = captureIo(fetchImpl)
    const code = await runOpenAiModelsCli(
      { kind: 'list', json: true },
      { home, environment: Object.freeze({ OPENAI_API_KEY: 'sk-env' }) },
      io,
    )
    expect(code).toBe(0)
    expect(lastJson(stdout())).toEqual({
      ok: true,
      models: ['gpt-5.4-mini'],
      authMode: 'apiKey',
    })
  })

  test('no credential fails with the sign-in guidance', async () => {
    mocks.read.mockReturnValue(undefined)
    const { io, stdout } = captureIo(vi.fn())
    const code = await runOpenAiModelsCli(
      { kind: 'list', json: true },
      { home, environment: Object.freeze({}) },
      io,
    )
    expect(code).toBe(1)
    expect(lastJson(stdout())).toEqual({
      ok: false,
      error:
        'Sign in with ChatGPT or add an OpenAI API key before refreshing models.',
    })
  })

  test('http refusal surfaces the status without leaking tokens', async () => {
    mocks.read.mockReturnValue({
      authMode: 'chatgpt',
      accessToken: ACCESS_TOKEN,
      accountId: 'acct-1',
    })
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    }))
    const { io, stdout } = captureIo(fetchImpl)
    const code = await runOpenAiModelsCli(
      { kind: 'list', json: true },
      { home, environment: Object.freeze({}) },
      io,
    )
    expect(code).toBe(1)
    const verdict = lastJson(stdout())
    expect(verdict.ok).toBe(false)
    expect(String(verdict.error)).toContain('403')
    expect(stdout()).not.toContain(ACCESS_TOKEN)
  })

  test('help text documents the credential order', () => {
    const text = formatOpenAiModelsCliHelpText()
    expect(text).toContain('openai-models')
    expect(text).toContain('OPENAI_API_KEY')
  })
})
