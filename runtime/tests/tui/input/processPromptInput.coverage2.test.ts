import { describe, expect, test } from 'vitest'

import { processPromptInput } from './processPromptInput.js'

function contextWithBlockingHook() {
  return {
    options: { commands: [] },
    services: {
      hooks: {
        userPromptSubmitHooks: [
          () => ({
            additionalContexts: ['x'.repeat(10001)],
            blockingError: {
              blockingError: 'blocked by local policy',
            },
          }),
        ],
      },
    },
    getAppState: () => ({
      toolPermissionContext: { mode: 'default' },
    }),
    setAppState: () => {},
    requestPrompt: async () => '',
  } as any
}

describe('processPromptInput coverage hooks', () => {
  test('returns hook context and warning when a prompt-submit hook blocks', async () => {
    const result = await processPromptInput({
      input: 'summarize the deployment plan',
      mode: 'prompt' as any,
      setToolJSX: () => {},
      context: contextWithBlockingHook(),
      skipAttachments: true,
    })

    expect(result.shouldQuery).toBe(false)
    expect(result.messages).toHaveLength(2)

    const contextMessage = result.messages[0] as any
    expect(contextMessage.type).toBe('attachment')
    expect(contextMessage.attachment.type).toBe('hook_additional_context')
    expect(contextMessage.attachment.content[0]).toContain(
      '[output truncated - exceeded 10000 characters]',
    )

    const warningMessage = result.messages[1] as any
    expect(warningMessage.type).toBe('system')
    expect(warningMessage.level).toBe('warning')
    expect(warningMessage.content).toBe(
      'UserPromptSubmit operation blocked by hook:\n' +
        'blocked by local policy\n\n' +
        'Original prompt: summarize the deployment plan',
    )
  })
})
