import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { Tool, Tools } from '../../../src/tools/Tool.js'
import type { ProgressMessage } from '../../../src/types/message.js'
import { Text, createRoot, type Root } from '../../../src/tui/ink.js'
import { UserToolRejectMessage } from '../../../src/tui/message-renderers/UserToolResultMessage/UserToolRejectMessage.js'
import { renderToString } from '../../../src/utils/staticRender.js'

const previousGlyphMode = process.env.AGENC_TUI_GLYPHS

afterEach(() => {
  if (previousGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = previousGlyphMode
  }
})

function createProgressMessages(): ProgressMessage[] {
  return [
    {
      uuid: 'swarm-145-hook-progress',
      data: { type: 'hook_progress', hookEvent: 'PreToolUse' },
    } as ProgressMessage,
    {
      uuid: 'swarm-145-tool-progress',
      data: { type: 'tool_progress', text: 'visible tool progress' },
    } as ProgressMessage,
  ]
}

function createStreams(): {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough & { columns: number; rows: number }
} {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  const stdout = new PassThrough() as PassThrough & {
    columns: number
    rows: number
  }

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.columns = 104
  stdout.rows = 12
  stdout.resume()

  return { stdin, stdout }
}

function flushRender(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5))
}

describe('UserToolRejectMessage swarm-145 coverage', () => {
  test('renders the fallback without validating when the rejected renderer is unavailable', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const noRendererSafeParse = vi.fn()
    const output = await renderToString(
      <UserToolRejectMessage
        input={{ path: 'runtime/src/unrendered.ts' }}
        progressMessagesForMessage={[]}
        tool={
          {
            inputSchema: { safeParse: noRendererSafeParse },
            name: 'NoRejectedRenderer',
          } as unknown as Tool
        }
        tools={[] as unknown as Tools}
        lookups={{} as never}
        verbose={false}
      />,
      { columns: 88, rows: 10 },
    )

    expect(output).toContain('Interrupted')
    expect(output).toContain('What should AgenC do instead?')
    expect(noRendererSafeParse).not.toHaveBeenCalled()
  })

  test('falls back when rejected input fails the tool schema', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const renderToolUseRejectedMessage = vi.fn(() => <Text>delegated</Text>)
    const output = await renderToString(
      <UserToolRejectMessage
        input={{ path: 'runtime/src/invalid.ts' }}
        progressMessagesForMessage={createProgressMessages()}
        tool={
          {
            inputSchema: {
              safeParse: vi.fn(() => ({ success: false })),
            },
            name: 'InvalidRejectedInput',
            renderToolUseRejectedMessage,
          } as unknown as Tool
        }
        tools={[] as unknown as Tools}
        lookups={{} as never}
        verbose={true}
      />,
      { columns: 92, rows: 10 },
    )

    expect(output).toContain('Interrupted')
    expect(renderToolUseRejectedMessage).not.toHaveBeenCalled()
  })

  test('delegates parsed rejected input with terminal, theme, and filtered progress options', async () => {
    const tools = [] as unknown as Tools
    const progressMessagesForMessage = createProgressMessages()
    const renderToolUseRejectedMessage = vi.fn(
      (
        input: { path: string; parsed: boolean },
        options: {
          readonly columns: number
          readonly isTranscriptMode?: boolean
          readonly progressMessagesForMessage: readonly ProgressMessage[]
          readonly style?: string
          readonly theme: string
          readonly tools: Tools
          readonly verbose: boolean
        },
      ) => (
        <Text>
          rejected {input.path} parsed:{String(input.parsed)} columns:
          {options.columns} progress:
          {options.progressMessagesForMessage.length} style:{options.style}{' '}
          theme:{options.theme} transcript:
          {String(options.isTranscriptMode)} verbose:{String(options.verbose)}
        </Text>
      ),
    )
    const tool = {
      inputSchema: {
        safeParse: (input: { path: string }) => ({
          success: true,
          data: { path: input.path, parsed: true },
        }),
      },
      name: 'DelegatedRejectedInput',
      renderToolUseRejectedMessage,
    } as unknown as Tool

    const output = await renderToString(
      <UserToolRejectMessage
        input={{ path: 'runtime/src/delegated.ts' }}
        progressMessagesForMessage={progressMessagesForMessage}
        style="condensed"
        tool={tool}
        tools={tools}
        lookups={{} as never}
        verbose={true}
        isTranscriptMode={true}
      />,
      { columns: 117, rows: 10 },
    )

    expect(output.replace(/\s+/g, ' ')).toContain(
      'rejected runtime/src/delegated.ts parsed:true columns:117 progress:1 style:condensed theme:dark transcript:true verbose:true',
    )
    expect(renderToolUseRejectedMessage).toHaveBeenCalledTimes(1)
    expect(renderToolUseRejectedMessage.mock.calls[0]?.[1]).toMatchObject({
      columns: 117,
      messages: [],
      progressMessagesForMessage: [progressMessagesForMessage[1]],
      style: 'condensed',
      theme: 'dark',
      tools,
      verbose: true,
      isTranscriptMode: true,
    })
  })

  test('reuses the delegated render result while rejection props stay referentially stable', async () => {
    const progressMessagesForMessage = createProgressMessages()
    const tools = [] as unknown as Tools
    const stableInput = { path: 'runtime/src/stable.ts' }
    const renderToolUseRejectedMessage = vi.fn((input: { path: string }) => (
      <Text>delegated {input.path}</Text>
    ))
    const tool = {
      inputSchema: {
        safeParse: (input: { path: string }) => ({ success: true, data: input }),
      },
      name: 'MemoizedRejectedInput',
      renderToolUseRejectedMessage,
    } as unknown as Tool
    const { stdin, stdout } = createStreams()
    const root: Root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    function render(input: { path: string }): void {
      root.render(
        <UserToolRejectMessage
          input={input}
          progressMessagesForMessage={progressMessagesForMessage}
          tool={tool}
          tools={tools}
          lookups={{} as never}
          verbose={false}
        />,
      )
    }

    try {
      render(stableInput)
      await flushRender()
      render(stableInput)
      await flushRender()

      expect(renderToolUseRejectedMessage).toHaveBeenCalledTimes(1)

      render({ path: 'runtime/src/changed.ts' })
      await flushRender()

      expect(renderToolUseRejectedMessage).toHaveBeenCalledTimes(2)
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushRender()
    }
  })
})
