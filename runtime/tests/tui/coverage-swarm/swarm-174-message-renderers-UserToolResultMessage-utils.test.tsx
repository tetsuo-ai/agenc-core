import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test } from 'vitest'

import type { Tool, Tools } from '../../../src/tools/Tool.js'
import { createRoot, type Root } from '../../../src/tui/ink/root.js'
import {
  getTextToolResultContent,
  useGetToolFromMessages,
} from '../../../src/tui/message-renderers/UserToolResultMessage/utils.js'

type ToolUseLike = {
  readonly id: string
  readonly input: Record<string, unknown>
  readonly name: string
  readonly type: 'tool_use'
}

type HookProps = {
  readonly lookups: Parameters<typeof useGetToolFromMessages>[2]
  readonly toolUseID: string
  readonly tools: Tools
}

type HookValue = ReturnType<typeof useGetToolFromMessages>

function createStreams(): {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough
} {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  const stdout = new PassThrough()

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()

  return { stdin, stdout }
}

function flushRender(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 5))
}

function makeTool(name: string, aliases: string[] = []): Tool {
  return { aliases, name } as unknown as Tool
}

function makeToolUse(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): ToolUseLike {
  return { id, input, name, type: 'tool_use' }
}

function makeLookups(
  toolUses: readonly ToolUseLike[],
): Parameters<typeof useGetToolFromMessages>[2] {
  return {
    toolUseByToolUseID: new Map(toolUses.map(toolUse => [toolUse.id, toolUse])),
  } as Parameters<typeof useGetToolFromMessages>[2]
}

async function renderHookHarness(
  initialProps: HookProps,
): Promise<{
  readonly dispose: () => Promise<void>
  readonly latest: () => HookValue
  readonly render: (next: Partial<HookProps>) => Promise<void>
}> {
  let latest: HookValue | undefined
  let props = initialProps
  const { stdin, stdout } = createStreams()
  const root: Root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function HookProbe(): null {
    latest = useGetToolFromMessages(props.toolUseID, props.tools, props.lookups)
    return null
  }

  async function render(next: Partial<HookProps> = {}): Promise<void> {
    props = { ...props, ...next }
    root.render(<HookProbe />)
    await flushRender()
  }

  await render()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushRender()
    },
    latest: () => {
      if (latest === undefined) throw new Error('hook did not render')
      return latest
    },
    render,
  }
}

describe('UserToolResultMessage utils coverage swarm row 174', () => {
  test('extracts string and structured text result content', () => {
    expect(getTextToolResultContent('plain text')).toBe('plain text')
    expect(
      getTextToolResultContent([
        'first',
        { type: 'text', text: 'second' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        { text: 123 },
      ]),
    ).toBe('first\nsecond')
    expect(getTextToolResultContent([{ type: 'image', source: {} }])).toBeUndefined()
    expect(getTextToolResultContent({ type: 'json', value: 'ignored' })).toBeUndefined()
  })

  test('returns null when the tool use is missing or the referenced tool is unavailable', async () => {
    const rendered = await renderHookHarness({
      lookups: makeLookups([]),
      toolUseID: 'missing-tool-use',
      tools: [makeTool('Read')],
    })

    try {
      expect(rendered.latest()).toBeNull()

      await rendered.render({
        lookups: makeLookups([makeToolUse('write-1', 'Write')]),
        toolUseID: 'write-1',
      })

      expect(rendered.latest()).toBeNull()
    } finally {
      await rendered.dispose()
    }
  })

  test('resolves aliases and reuses the memoized result for equivalent lookups', async () => {
    const readTool = makeTool('Read', ['View'])
    const toolUse = makeToolUse('read-1', 'View', { file_path: 'notes.txt' })
    const rendered = await renderHookHarness({
      lookups: makeLookups([toolUse]),
      toolUseID: 'read-1',
      tools: [readTool],
    })

    try {
      const firstResult = rendered.latest()

      expect(firstResult).toEqual({ tool: readTool, toolUse })

      await rendered.render({})
      expect(rendered.latest()).toBe(firstResult)

      await rendered.render({
        lookups: makeLookups([toolUse]),
      })
      expect(rendered.latest()).toBe(firstResult)

      const nextToolUse = makeToolUse('read-1', 'View', {
        file_path: 'updated.txt',
      })
      await rendered.render({
        lookups: makeLookups([nextToolUse]),
      })

      expect(rendered.latest()).toEqual({ tool: readTool, toolUse: nextToolUse })
      expect(rendered.latest()).not.toBe(firstResult)
    } finally {
      await rendered.dispose()
    }
  })
})
