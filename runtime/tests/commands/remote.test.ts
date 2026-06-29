import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { remoteCommand } from 'src/commands/remote.js'
import { runRemoteSlash, startRemoteOn } from 'src/bin/remote-cli.js'

const ORIGINAL_AGENC_HOME = process.env.AGENC_HOME

afterEach(() => {
  if (ORIGINAL_AGENC_HOME === undefined) delete process.env.AGENC_HOME
  else process.env.AGENC_HOME = ORIGINAL_AGENC_HOME
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

  it('does not start pairing without a remote login session', async () => {
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
})
