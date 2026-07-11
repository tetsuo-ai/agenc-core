import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { remoteCommand } from 'src/commands/remote.js'
import {
  runAgenCRemoteCli,
  runRemoteSlash,
  startRemoteOn,
} from 'src/bin/remote-cli.js'

const ORIGINAL_AGENC_HOME = process.env.AGENC_HOME
const ORIGINAL_BACKEND_URL = process.env.AGENC_BACKEND_URL
const ORIGINAL_REMOTE_TEST_HOME = process.env.AGENC_REMOTE_TEST_HOME

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => process.env.AGENC_REMOTE_TEST_HOME ?? actual.homedir(),
  }
})

afterEach(() => {
  if (ORIGINAL_AGENC_HOME === undefined) delete process.env.AGENC_HOME
  else process.env.AGENC_HOME = ORIGINAL_AGENC_HOME
  if (ORIGINAL_BACKEND_URL === undefined) delete process.env.AGENC_BACKEND_URL
  else process.env.AGENC_BACKEND_URL = ORIGINAL_BACKEND_URL
  if (ORIGINAL_REMOTE_TEST_HOME === undefined) {
    delete process.env.AGENC_REMOTE_TEST_HOME
  } else {
    process.env.AGENC_REMOTE_TEST_HOME = ORIGINAL_REMOTE_TEST_HOME
  }
  vi.restoreAllMocks()
})

describe('/remote slash command', () => {
  it('is an immediate command named remote', () => {
    expect(remoteCommand.name).toBe('remote')
    expect(remoteCommand.immediate).toBe(true)
    expect(remoteCommand.description.toLowerCase()).toContain('phone')
  })

  it('status returns a link-state line without touching the network', async () => {
    const text = await runRemoteSlash('status')
    expect(typeof text).toBe('string')
    expect(text.toLowerCase()).toMatch(/link/)
  })

  it("execute returns a { kind: 'text' } result", async () => {
    const result = await remoteCommand.execute({
      argsRaw: 'status',
    } as unknown as Parameters<typeof remoteCommand.execute>[0])
    expect(result.kind).toBe('text')
  })

  it('does not create a mobile sign-in code without a remote login session', async () => {
    const agencHome = mkdtempSync(join(tmpdir(), 'agenc-remote-no-login-'))
    process.env.AGENC_HOME = agencHome
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network should not be touched'))
    try {
      const result = await startRemoteOn()

      expect(result).toEqual({
        message:
          'Not logged in. Run `/login` in the TUI or `AGENC_AUTH_BACKEND=remote agenc login` before using remote pairing.',
      })
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      rmSync(agencHome, { recursive: true, force: true })
    }
  })

  it('sends the Core login bearer when creating the mobile bootstrap code', async () => {
    const testHome = mkdtempSync(join(tmpdir(), 'agenc-remote-bearer-'))
    const agencHome = join(testHome, '.agenc')
    process.env.AGENC_REMOTE_TEST_HOME = testHome
    process.env.AGENC_HOME = agencHome
    process.env.AGENC_BACKEND_URL = 'https://backend.test'
    mkdirSync(agencHome, { recursive: true })
    writeFileSync(
      join(agencHome, 'auth.json'),
      JSON.stringify({
        version: 1,
        provider: 'remote',
        token: 'core-login-token',
        createdAt: '2026-07-11T00:00:00.000Z',
      }),
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'stop-after-observation' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    )

    try {
      await expect(startRemoteOn()).resolves.toEqual({
        message: 'Could not start pairing (503). Check your connection.',
      })
      expect(fetchSpy).toHaveBeenCalledOnce()
      const [url, request] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://backend.test/v1/pair/start')
      expect(request.headers).toEqual({
        'content-type': 'application/json',
        authorization: 'Bearer core-login-token',
      })
      expect(JSON.parse(String(request.body))).toEqual({
        machineName: expect.any(String),
      })
    } finally {
      rmSync(testHome, { recursive: true, force: true })
    }
  })

  it('sends the Core login bearer from foreground `agenc remote on`', async () => {
    const testHome = mkdtempSync(join(tmpdir(), 'agenc-remote-cli-bearer-'))
    const agencHome = join(testHome, '.agenc')
    process.env.AGENC_REMOTE_TEST_HOME = testHome
    process.env.AGENC_HOME = agencHome
    process.env.AGENC_BACKEND_URL = 'https://backend.test'
    mkdirSync(agencHome, { recursive: true })
    writeFileSync(
      join(agencHome, 'auth.json'),
      JSON.stringify({
        version: 1,
        provider: 'remote',
        token: 'core-login-token',
        createdAt: '2026-07-11T00:00:00.000Z',
      }),
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'stop-after-observation' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      await expect(
        runAgenCRemoteCli({ kind: 'on' }),
      ).resolves.toBe(1)
      expect(fetchSpy).toHaveBeenCalledOnce()
      const [url, request] = fetchSpy.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://backend.test/v1/pair/start')
      expect(request.headers).toEqual({
        'content-type': 'application/json',
        authorization: 'Bearer core-login-token',
      })
      expect(JSON.parse(String(request.body))).toEqual({
        machineName: expect.any(String),
      })
    } finally {
      rmSync(testHome, { recursive: true, force: true })
    }
  })
})
