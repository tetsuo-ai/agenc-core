import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { Tool, Tools } from '../../../tools/Tool.js'
import type { ProgressMessage } from '../../../types/message.js'
import { renderToString } from '../../../utils/staticRender.js'
import { Text } from '../../ink.js'
import { UserToolRejectMessage } from './UserToolRejectMessage.js'

const previousGlyphMode = process.env.AGENC_TUI_GLYPHS

afterEach(() => {
  if (previousGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = previousGlyphMode
  }
})

describe('UserToolRejectMessage wave200-072 coverage', () => {
  test('falls back for unavailable rejected renderers and delegates validated rejected input', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const tools = [] as unknown as Tools
    const toolProgress = {
      uuid: 'tool-progress',
      data: { type: 'tool_progress', text: 'kept' },
    } as ProgressMessage
    const hookProgress = {
      uuid: 'hook-progress',
      data: { type: 'hook_progress', hookEvent: 'PreToolUse' },
    } as ProgressMessage
    const progressMessagesForMessage = [hookProgress, toolProgress]
    const noRendererSafeParse = vi.fn()
    const invalidRenderer = vi.fn()
    const nullRenderer = vi.fn(() => null)
    const delegatedRenderer = vi.fn((input, options) => (
      <Text>
        delegated {input.path} columns {options.columns} progress{' '}
        {options.progressMessagesForMessage.length} style {options.style} theme{' '}
        {options.theme} transcript {String(options.isTranscriptMode)} verbose{' '}
        {String(options.verbose)}
      </Text>
    ))
    const noRendererTool = {
      name: 'NoRejectedRenderer',
      inputSchema: { safeParse: noRendererSafeParse },
    } as unknown as Tool
    const invalidTool = {
      name: 'InvalidRejectedInput',
      inputSchema: {
        safeParse: () => ({ success: false }),
      },
      renderToolUseRejectedMessage: invalidRenderer,
    } as unknown as Tool
    const nullTool = {
      name: 'NullRejectedRenderer',
      inputSchema: {
        safeParse: () => ({ success: true, data: { path: 'null-render' } }),
      },
      renderToolUseRejectedMessage: nullRenderer,
    } as unknown as Tool
    const delegatedTool = {
      name: 'DelegatedRejectedRenderer',
      inputSchema: {
        safeParse: (input: { path: string }) => ({
          success: true,
          data: { path: `${input.path}:parsed` },
        }),
      },
      renderToolUseRejectedMessage: delegatedRenderer,
    } as unknown as Tool

    const sharedProps = {
      input: { path: 'runtime/src/example.ts' },
      progressMessagesForMessage,
      tools,
      lookups: {} as never,
    }

    const output = await renderToString(
      <>
        <UserToolRejectMessage
          {...sharedProps}
          tool={undefined}
          verbose={false}
        />
        <UserToolRejectMessage
          {...sharedProps}
          tool={noRendererTool}
          verbose={false}
        />
        <UserToolRejectMessage
          {...sharedProps}
          tool={invalidTool}
          verbose={false}
        />
        <UserToolRejectMessage
          {...sharedProps}
          tool={nullTool}
          verbose={false}
        />
        <UserToolRejectMessage
          {...sharedProps}
          tool={delegatedTool}
          style="condensed"
          verbose={true}
          isTranscriptMode={true}
        />
      </>,
      { columns: 96, rows: 24 },
    )

    expect(output).toContain('Interrupted')
    expect(output).toContain('What should AgenC do instead?')
    const normalizedOutput = output.replace(/\s+/g, ' ')
    expect(normalizedOutput).toContain(
      'delegated runtime/src/example.ts:parsed columns 96 progress 1 style condensed theme dark transcript true verbose true',
    )
    expect(noRendererSafeParse).not.toHaveBeenCalled()
    expect(invalidRenderer).not.toHaveBeenCalled()
    expect(nullRenderer).toHaveBeenCalledTimes(1)
    expect(delegatedRenderer).toHaveBeenCalledTimes(1)
    expect(delegatedRenderer.mock.calls[0]?.[1]).toMatchObject({
      columns: 96,
      messages: [],
      tools,
      verbose: true,
      progressMessagesForMessage: [toolProgress],
      style: 'condensed',
      theme: 'dark',
      isTranscriptMode: true,
    })
  })
})
