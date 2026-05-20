import { describe, expect, test, vi } from 'vitest'

import { processPromptInput } from './processPromptInput.js'

function bridgeContext(commands: any[]) {
  return {
    options: { commands },
    getAppState: () => ({
      toolPermissionContext: { mode: 'default' },
    }),
    setAppState: () => {},
    requestPrompt: async () => '',
  } as any
}

describe('processPromptInput coverage', () => {
  test('executes bridge-safe slash commands even when slash commands are skipped', async () => {
    const call = vi.fn(async (args: string) => ({
      type: 'text',
      value: `bridge result: ${args}`,
    }))
    const load = vi.fn(async () => ({ call }))

    const result = await processPromptInput({
      input: '/help remote status',
      mode: 'prompt' as any,
      setToolJSX: () => {},
      context: bridgeContext([
        {
          type: 'local',
          name: 'help',
          description: 'Show help',
          load,
        },
      ]),
      skipSlashCommands: true,
      bridgeOrigin: true,
      skipAttachments: true,
    })

    expect(load).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('remote status', expect.any(Object))
    expect(result.shouldQuery).toBe(false)
    expect(result.resultText).toBe('bridge result: remote status')
    expect(JSON.stringify(result.messages)).toContain(
      '<local-command-stdout>bridge result: remote status</local-command-stdout>',
    )
  })
})
