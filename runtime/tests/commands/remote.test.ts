import { describe, expect, it } from 'vitest'

import { remoteCommand } from 'src/commands/remote.js'
import { runRemoteSlash } from 'src/bin/remote-cli.js'

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
})
