import { beforeEach, describe, expect, test, vi } from 'vitest'

import { resolveHomeContext } from '../../src/config/home.js'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  clear: vi.fn(),
  save: vi.fn(),
  toBlob: vi.fn(),
  browserLogin: vi.fn(),
  deviceLogin: vi.fn(),
}))

vi.mock('../../src/utils/xaiOauthCredentials.js', () => ({
  readXaiOauthCredentials: mocks.read,
  clearXaiOauthCredentials: mocks.clear,
  saveXaiOauthCredentials: mocks.save,
  xaiOauthTokensToBlob: mocks.toBlob,
}))

vi.mock('../../src/services/xai/oauth.js', () => ({
  XaiOauthError: class XaiOauthError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  runXaiBrowserLogin: mocks.browserLogin,
  runXaiDeviceLogin: mocks.deviceLogin,
}))

import { XaiOauthError } from '../../src/services/xai/oauth.js'
import {
  formatGrokAuthCliHelpText,
  parseGrokAuthCliArgs,
  runGrokAuthCli,
  type GrokAuthCliIo,
} from '../../src/bin/grok-auth-cli.js'

const home = resolveHomeContext(
  { AGENC_HOME: '/tmp/agenc-grok-auth-cli-test' },
  { platformHome: '/tmp' },
)
const runtime = { home }

const LOGIN_RESULT = {
  tokens: { accessToken: 'token' },
  identity: { sub: 'user-1', email: 'paul@x.com' },
  tokenEndpoint: 'https://auth.x.ai/token',
}

function captureIo() {
  let stdout = ''
  let stderr = ''
  const io = {
    stdout: { write: (value: string) => (stdout += value) },
    stderr: { write: (value: string) => (stderr += value) },
    openUrl: () => {},
  } as unknown as GrokAuthCliIo
  return {
    io,
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

function jsonLines(output: string): Record<string, unknown>[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('headless Grok auth CLI', () => {
  beforeEach(() => {
    mocks.read.mockReset()
    mocks.clear.mockReset()
    mocks.save.mockReset()
    mocks.toBlob.mockReset()
    mocks.browserLogin.mockReset()
    mocks.deviceLogin.mockReset()
    mocks.clear.mockReturnValue({ success: true })
    mocks.save.mockReturnValue({ success: true })
    mocks.toBlob.mockReturnValue({
      accessToken: 'token',
      accountLabel: 'paul@x.com',
    })
  })

  test('parses canonical commands and documented aliases', () => {
    expect(parseGrokAuthCliArgs(['grok-login', '--json'])).toEqual({
      kind: 'login',
      json: true,
      device: false,
    })
    expect(parseGrokAuthCliArgs(['grok-login', 'device', '--json'])).toEqual({
      kind: 'login',
      json: true,
      device: true,
    })
    expect(parseGrokAuthCliArgs(['xai-logout'])).toEqual({
      kind: 'logout',
      json: false,
    })
    expect(parseGrokAuthCliArgs(['grok-auth-status'])).toEqual({
      kind: 'status',
      json: false,
    })
    expect(parseGrokAuthCliArgs(['grok-login', '--help'])).toEqual({
      kind: 'help',
    })
    expect(parseGrokAuthCliArgs(['grok-logout', 'typo'])).toEqual({
      kind: 'error',
      message: "Grok auth command 'grok-logout' accepts only --json or --help",
    })
    expect(parseGrokAuthCliArgs(['providers'])).toBeNull()
  })

  test('status reports the stored sign-in', async () => {
    mocks.read.mockReturnValue({ accessToken: 'x', accountLabel: 'paul@x.com' })
    const { io, stdout } = captureIo()
    const code = await runGrokAuthCli(
      { kind: 'status', json: true },
      runtime,
      io,
    )
    expect(code).toBe(0)
    expect(jsonLines(stdout())).toEqual([
      { ok: true, signedIn: true, account: 'paul@x.com' },
    ])
    expect(mocks.read).toHaveBeenCalledWith(home)
  })

  test('logout without a stored sign-in is a no-op success', async () => {
    mocks.read.mockReturnValue(undefined)
    const { io, stdout } = captureIo()
    const code = await runGrokAuthCli(
      { kind: 'logout', json: true },
      runtime,
      io,
    )
    expect(code).toBe(0)
    expect(jsonLines(stdout())).toEqual([{ ok: true, signedIn: false }])
    expect(mocks.clear).not.toHaveBeenCalled()
  })

  test('logout clears the stored sign-in', async () => {
    mocks.read.mockReturnValue({ accessToken: 'x' })
    const { io, stdout } = captureIo()
    const code = await runGrokAuthCli(
      { kind: 'logout', json: true },
      runtime,
      io,
    )
    expect(code).toBe(0)
    expect(mocks.clear).toHaveBeenCalledWith(home)
    expect(jsonLines(stdout())).toEqual([{ ok: true, signedIn: false }])
  })

  test('browser login emits staged progress and saves the blob', async () => {
    mocks.browserLogin.mockImplementation(
      async (params: {
        onAuthorizeUrl: (url: string) => Promise<void>
        onStage?: (stage: string) => void
      }) => {
        await params.onAuthorizeUrl('https://auth.x.ai/authorize?state=s')
        params.onStage?.('callback_received')
        params.onStage?.('exchanging_code')
        return LOGIN_RESULT
      },
    )
    const { io, stdout } = captureIo()
    const code = await runGrokAuthCli(
      { kind: 'login', json: true, device: false },
      runtime,
      io,
    )
    expect(code).toBe(0)
    expect(jsonLines(stdout())).toEqual([
      {
        stage: 'authorize',
        flow: 'browser',
        url: 'https://auth.x.ai/authorize?state=s',
      },
      { stage: 'callback_received' },
      { stage: 'exchanging_code' },
      { ok: true, signedIn: true, account: 'paul@x.com' },
    ])
    expect(mocks.toBlob).toHaveBeenCalledWith(LOGIN_RESULT.tokens, {
      tokenEndpoint: LOGIN_RESULT.tokenEndpoint,
    })
    expect(mocks.save).toHaveBeenCalledWith(home, {
      accessToken: 'token',
      accountLabel: 'paul@x.com',
    })
    expect(mocks.deviceLogin).not.toHaveBeenCalled()
  })

  test('loopback failure falls back to the device flow', async () => {
    mocks.browserLogin.mockRejectedValue(
      new XaiOauthError('callback_failed', 'port busy'),
    )
    mocks.deviceLogin.mockImplementation(
      async (params: {
        onUserCode: (info: {
          userCode: string
          verificationUri: string
        }) => Promise<void>
      }) => {
        await params.onUserCode({
          userCode: 'ABCD-1234',
          verificationUri: 'https://x.ai/device',
        })
        return LOGIN_RESULT
      },
    )
    const { io, stdout } = captureIo()
    const code = await runGrokAuthCli(
      { kind: 'login', json: true, device: false },
      runtime,
      io,
    )
    expect(code).toBe(0)
    expect(jsonLines(stdout())).toEqual([
      { stage: 'device_fallback', flow: 'device' },
      {
        stage: 'device_authorize',
        flow: 'device',
        url: 'https://x.ai/device',
        userCode: 'ABCD-1234',
      },
      { ok: true, signedIn: true, account: 'paul@x.com' },
    ])
  })

  test('forced device flow skips the browser entirely', async () => {
    mocks.deviceLogin.mockResolvedValue(LOGIN_RESULT)
    const { io } = captureIo()
    const code = await runGrokAuthCli(
      { kind: 'login', json: true, device: true },
      runtime,
      io,
    )
    expect(code).toBe(0)
    expect(mocks.browserLogin).not.toHaveBeenCalled()
    expect(mocks.deviceLogin).toHaveBeenCalledTimes(1)
  })

  test('oauth errors surface a structured failure', async () => {
    mocks.browserLogin.mockRejectedValue(
      new XaiOauthError('access_denied', 'the user declined'),
    )
    const { io, stdout } = captureIo()
    const code = await runGrokAuthCli(
      { kind: 'login', json: true, device: false },
      runtime,
      io,
    )
    expect(code).toBe(1)
    expect(jsonLines(stdout())).toEqual([
      { ok: false, error: 'the user declined', code: 'access_denied' },
    ])
    expect(mocks.save).not.toHaveBeenCalled()
  })

  test('help text names every command and alias', () => {
    const text = formatGrokAuthCliHelpText()
    for (const needle of [
      'grok-login',
      'grok-logout',
      'grok-auth-status',
      'xai-login',
      'device',
    ]) {
      expect(text).toContain(needle)
    }
  })
})
