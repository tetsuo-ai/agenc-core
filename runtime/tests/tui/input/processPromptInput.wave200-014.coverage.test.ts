import { describe, expect, test } from 'vitest'

import { processPromptInput } from './processPromptInput.js'

function contextWithPromptHooks(hooks: any[]) {
  const emitted: unknown[] = []

  return {
    context: {
      options: { commands: [] },
      services: {
        hooks: {
          userPromptSubmitHooks: hooks,
        },
      },
      session: {
        emit: (event: unknown) => emitted.push(event),
        nextInternalSubId: () => `hook-warning-${emitted.length + 1}`,
      },
      getAppState: () => ({
        toolPermissionContext: { mode: 'default' },
      }),
      setAppState: () => {},
      requestPrompt: async () => '',
    } as any,
    emitted,
  }
}

describe('processPromptInput prompt-submit hook coverage', () => {
  test('emits hook warnings and appends only non-progress hook messages', async () => {
    const { context, emitted } = contextWithPromptHooks([
      () => {
        throw new Error('lint hook exploded')
      },
      () => ({
        message: {
          type: 'progress',
          attachment: { type: 'hook_progress' },
        },
      }),
      () => ({
        additionalContexts: [],
        message: {
          type: 'attachment',
          attachment: {
            type: 'hook_success',
            content: 'approved context',
          },
        },
      }),
      () => ({
        message: {
          type: 'attachment',
          attachment: {
            type: 'hook_stderr',
            content: 'nonblocking note',
          },
        },
      }),
    ])

    const result = await processPromptInput({
      input: 'prepare release notes',
      mode: 'prompt' as any,
      setToolJSX: () => {},
      context,
      skipAttachments: true,
    })

    expect(result.shouldQuery).toBe(true)
    expect(result.messages).toHaveLength(3)
    expect((result.messages[1] as any).attachment).toEqual({
      type: 'hook_success',
      content: 'approved context',
    })
    expect((result.messages[2] as any).attachment).toEqual({
      type: 'hook_stderr',
      content: 'nonblocking note',
    })
    expect(JSON.stringify(result.messages)).not.toContain('hook_progress')
    expect(emitted).toEqual([
      {
        id: 'hook-warning-1',
        msg: {
          type: 'warning',
          payload: {
            cause: 'user_prompt_submit_hook_threw',
            message: 'UserPromptSubmit hook 0 failed: lint hook exploded',
          },
        },
      },
    ])
  })
})
