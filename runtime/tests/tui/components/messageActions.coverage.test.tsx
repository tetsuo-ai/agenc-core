import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test } from 'vitest'

import { createRoot } from '../ink/root.js'
import {
  MessageActionsBar,
  type MessageActionsState,
} from './messageActions.js'

function createStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  return { stdin, stdout }
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function renderBar(cursor: MessageActionsState): Promise<{
  dispose: () => Promise<void>
  output: () => string
}> {
  let output = ''
  const { stdin, stdout } = createStreams()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  root.render(<MessageActionsBar cursor={cursor} />)
  await sleep()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    output: () => stripAnsi(output),
  }
}

describe('MessageActionsBar coverage', () => {
  test('renders grouped tool-use actions with expansion and primary input labels', async () => {
    const collapsed = await renderBar({
      expanded: false,
      msgType: 'grouped_tool_use',
      toolName: 'Agent',
      uuid: 'grouped-agent',
    })

    try {
      expect(collapsed.output()).toMatch(/enter\s+expand/)
      expect(collapsed.output()).toMatch(/c\s+copy/)
      expect(collapsed.output()).toMatch(/p\s+copy prompt/)
      expect(collapsed.output()).toContain('navigate')
      expect(collapsed.output()).toMatch(/esc\s+back/)
    } finally {
      await collapsed.dispose()
    }

    const expanded = await renderBar({
      expanded: true,
      msgType: 'grouped_tool_use',
      toolName: 'Agent',
      uuid: 'grouped-agent',
    })

    try {
      expect(expanded.output()).toMatch(/enter\s+collapse/)
      expect(expanded.output()).toMatch(/p\s+copy prompt/)
    } finally {
      await expanded.dispose()
    }
  })
})
