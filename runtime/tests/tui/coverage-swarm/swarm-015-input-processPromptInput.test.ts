import { beforeEach, describe, expect, test, vi } from 'vitest'

const imageMocks = vi.hoisted(() => ({
  createImageMetadataText: vi.fn(),
  maybeResizeAndDownsampleImageBlock: vi.fn(),
  storeImages: vi.fn(),
}))

vi.mock('src/utils/imageResizer.js', () => ({
  createImageMetadataText: imageMocks.createImageMetadataText,
  maybeResizeAndDownsampleImageBlock:
    imageMocks.maybeResizeAndDownsampleImageBlock,
}))

vi.mock('src/utils/imageStore.js', () => ({
  storeImages: imageMocks.storeImages,
}))

import { processPromptInput } from 'src/tui/input/processPromptInput.js'
import {
  createImageMetadataText,
  maybeResizeAndDownsampleImageBlock,
} from 'src/utils/imageResizer.js'
import { storeImages } from 'src/utils/imageStore.js'

function baseContext(commands: any[] = [], extra: Record<string, unknown> = {}) {
  return {
    options: { commands },
    getAppState: () => ({
      toolPermissionContext: { mode: 'default' },
    }),
    setAppState: () => {},
    requestPrompt: async () => '',
    ...extra,
  } as any
}

async function routePrompt(
  input: Parameters<typeof processPromptInput>[0]['input'],
  options: Partial<Parameters<typeof processPromptInput>[0]> = {},
) {
  return processPromptInput({
    input,
    mode: 'prompt' as any,
    setToolJSX: () => {},
    context: baseContext(),
    skipAttachments: true,
    ...options,
  })
}

function localCommand(
  name: string,
  result: unknown,
  overrides: Record<string, unknown> = {},
) {
  const call = vi.fn(async () => result)
  const load = vi.fn(async () => ({ call }))

  return {
    command: {
      type: 'local',
      name,
      description: `/${name}`,
      load,
      ...overrides,
    },
    call,
    load,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(maybeResizeAndDownsampleImageBlock).mockImplementation(
    async block => ({
      block,
      dimensions: undefined,
    }),
  )
  vi.mocked(createImageMetadataText).mockImplementation(
    (dimensions: any, sourcePath?: string) =>
      sourcePath
        ? `[image ${dimensions.width}x${dimensions.height} ${sourcePath}]`
        : `[image ${dimensions.width}x${dimensions.height}]`,
  )
  vi.mocked(storeImages).mockResolvedValue(new Map())
})

describe('processPromptInput coverage swarm row 015', () => {
  test('rejects bridge slash commands that are not bridge safe', async () => {
    const { command, load } = localCommand('config', {
      type: 'text',
      value: 'should not run',
    })

    const result = await routePrompt('/config', {
      context: baseContext([command]),
      bridgeOrigin: true,
      skipSlashCommands: true,
    })

    expect(load).not.toHaveBeenCalled()
    expect(result.shouldQuery).toBe(false)
    expect(result.resultText).toBe(
      "/config isn't available over Remote Control.",
    )
    expect(JSON.stringify(result.messages)).toContain(
      "<local-command-stdout>/config isn't available over Remote Control.</local-command-stdout>",
    )
  })

  test('formats invalid, unknown, unavailable, skip, and compact slash results', async () => {
    const invalid = await routePrompt('/', {
      context: baseContext([]),
    })
    expect(invalid.shouldQuery).toBe(false)
    expect(invalid.resultText).toBe('Commands are in the form `/command [args]`')

    const unknown = await routePrompt('/missing args', {
      context: baseContext([]),
    })
    expect(unknown.shouldQuery).toBe(false)
    expect(unknown.resultText).toBe('Unknown command: /missing')

    const unavailable = localCommand('disabled', {
      type: 'text',
      value: 'should not run',
    }, {
      isEnabled: () => false,
    })
    const unavailableResult = await routePrompt('/disabled', {
      context: baseContext([unavailable.command]),
    })
    expect(unavailable.load).not.toHaveBeenCalled()
    expect(unavailableResult.resultText).toBe('/disabled is not available')

    const hidden = localCommand('hidden', {
      type: 'text',
      value: 'should not run',
    }, {
      userInvocable: false,
    })
    const hiddenResult = await routePrompt('/hidden', {
      context: baseContext([hidden.command]),
    })
    expect(hidden.load).not.toHaveBeenCalled()
    expect(hiddenResult.resultText).toBe('/hidden is not available')

    const skipped = localCommand('noop', { type: 'skip' })
    const skippedResult = await routePrompt('/noop', {
      context: baseContext([skipped.command]),
    })
    expect(skippedResult).toEqual({ messages: [], shouldQuery: false })

    const emptyCompact = localCommand('compact-empty', {
      type: 'compact',
    })
    const emptyCompactResult = await routePrompt('/compact-empty', {
      context: baseContext([emptyCompact.command]),
    })
    expect(emptyCompactResult).toEqual({ messages: [], shouldQuery: false })

    const compact = localCommand('compact', {
      type: 'compact',
      displayText: 'summary ready',
    })
    const compactResult = await routePrompt('/compact now', {
      context: baseContext([compact.command]),
      uuid: 'slash-uuid',
    })
    expect(compact.call).toHaveBeenCalledWith('now', expect.any(Object))
    expect(compactResult.shouldQuery).toBe(false)
    expect(compactResult.resultText).toBe('summary ready')
    expect(JSON.stringify(compactResult.messages)).toContain(
      '<local-command-stdout>summary ready</local-command-stdout>',
    )
    expect(JSON.stringify(compactResult.messages)).toContain('slash-uuid')
  })

  test('keeps skipped slash input as regular prompt text', async () => {
    const result = await routePrompt('/help from remote text', {
      skipSlashCommands: true,
    })

    expect(result.shouldQuery).toBe(true)
    expect((result.messages[0] as any).message.content).toBe(
      '/help from remote text',
    )
  })

  test('stops after nonblocking hook context when continuation is prevented', async () => {
    const context = baseContext([], {
      services: {
        hooks: {
          userPromptSubmitHooks: [
            () => ({
              additionalContexts: ['review note'],
              preventContinuation: true,
              stopReason: 'needs approval',
            }),
          ],
        },
      },
    })

    const result = await routePrompt('deploy now', { context })

    expect(result.shouldQuery).toBe(false)
    expect(result.messages).toHaveLength(3)
    expect((result.messages[1] as any).attachment).toMatchObject({
      type: 'hook_additional_context',
      content: ['review note'],
      hookName: 'UserPromptSubmit',
      hookEvent: 'UserPromptSubmit',
    })
    expect((result.messages[2] as any).message.content).toBe(
      'Operation stopped by hook: needs approval',
    )
  })

  test('routes invisible meta prompts without showing processing input', async () => {
    const setUserInputOnProcessing = vi.fn()

    const result = await routePrompt('quiet system prompt', {
      isMeta: true,
      setUserInputOnProcessing,
    })

    expect(setUserInputOnProcessing).not.toHaveBeenCalled()
    expect(result.shouldQuery).toBe(true)
    expect((result.messages[0] as any).isMeta).toBe(true)
  })

  test('finalizes vim insert keys before showing and submitting prompt text', async () => {
    const setUserInputOnProcessing = vi.fn()

    const result = await routePrompt('abc', {
      setUserInputOnProcessing,
      vimRoutingState: {
        enabled: true,
        mode: 'INSERT',
        keys: ['!'],
        cursorOffset: 3,
      },
    })

    expect(setUserInputOnProcessing).toHaveBeenCalledWith('abc!')
    expect((result.messages[0] as any).message.content).toBe('abc!')
  })

  test('normalizes content-block image input and appends resized metadata', async () => {
    vi.mocked(maybeResizeAndDownsampleImageBlock).mockResolvedValueOnce({
      block: {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'resized-array-image',
        },
      },
      dimensions: { width: 12, height: 34 },
    } as any)

    const result = await routePrompt([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'array-image',
        },
      },
      { type: 'text', text: 'describe this' },
    ] as any)

    expect(maybeResizeAndDownsampleImageBlock).toHaveBeenCalledTimes(1)
    expect(createImageMetadataText).toHaveBeenCalledWith({
      width: 12,
      height: 34,
    })
    expect((result.messages[0] as any).message.content).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'resized-array-image',
        },
      },
      { type: 'text', text: 'describe this' },
    ])
    expect((result.messages[1] as any).isMeta).toBe(true)
    expect((result.messages[1] as any).message.content).toEqual([
      { type: 'text', text: '[image 12x34]' },
    ])
  })

  test('adds pasted image blocks and falls back to original dimensions for metadata', async () => {
    vi.mocked(storeImages).mockResolvedValueOnce(
      new Map([[7, '/tmp/pasted-image.png']]),
    )
    vi.mocked(maybeResizeAndDownsampleImageBlock).mockResolvedValueOnce({
      block: {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: 'resized-pasted-image',
        },
      },
      dimensions: undefined,
    } as any)

    const result = await routePrompt('use this image', {
      pastedContents: {
        7: {
          id: 7,
          type: 'image',
          content: 'pasted-image',
          mediaType: 'image/jpeg',
          dimensions: { width: 80, height: 60 },
        },
      },
    })

    expect(storeImages).toHaveBeenCalledWith({
      7: {
        id: 7,
        type: 'image',
        content: 'pasted-image',
        mediaType: 'image/jpeg',
        dimensions: { width: 80, height: 60 },
      },
    })
    expect(maybeResizeAndDownsampleImageBlock).toHaveBeenCalledWith({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: 'pasted-image',
      },
    })
    expect(createImageMetadataText).toHaveBeenCalledWith(
      { width: 80, height: 60 },
      '/tmp/pasted-image.png',
    )
    expect((result.messages[0] as any).imagePasteIds).toEqual([7])
    expect((result.messages[0] as any).message.content).toEqual([
      { type: 'text', text: 'use this image' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: 'resized-pasted-image',
        },
      },
    ])
    expect((result.messages[1] as any).message.content).toEqual([
      { type: 'text', text: '[image 80x60 /tmp/pasted-image.png]' },
    ])
  })

  test('throws when non-prompt modes receive content blocks without text', async () => {
    await expect(
      processPromptInput({
        input: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'image-only',
            },
          },
        ] as any,
        mode: 'bash' as any,
        setToolJSX: () => {},
        context: baseContext(),
      }),
    ).rejects.toThrow('Mode: bash requires a string input.')
  })
})
