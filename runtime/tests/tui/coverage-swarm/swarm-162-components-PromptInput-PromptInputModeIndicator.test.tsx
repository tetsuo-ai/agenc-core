import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  swarmsEnabled: false,
  teammateColor: undefined as string | undefined,
  getTeammateColor: vi.fn((): string | undefined => harness.teammateColor),
  isAgentSwarmsEnabled: vi.fn((): boolean => harness.swarmsEnabled),
  reset() {
    harness.swarmsEnabled = false
    harness.teammateColor = undefined
    harness.getTeammateColor.mockClear()
    harness.isAgentSwarmsEnabled.mockClear()
  },
}))

vi.mock('../../../src/utils/agentSwarmsEnabled.js', () => ({
  isAgentSwarmsEnabled: harness.isAgentSwarmsEnabled,
}))

vi.mock('../../../src/utils/teammate.js', () => ({
  getTeammateColor: harness.getTeammateColor,
}))

import { PromptInputModeIndicator } from '../../../src/tui/components/PromptInput/PromptInputModeIndicator.js'
import { Box, createRoot } from '../../../src/tui/ink.js'
import { renderToString } from '../../../src/utils/staticRender.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  rows: number
  isTTY: boolean
}

function createStreams(): {
  readonly stdin: TestStdin
  readonly stdout: TestStdout
} {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 24
  stdout.rows = 8
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function renderIndicator(
  props: React.ComponentProps<typeof PromptInputModeIndicator>,
): Promise<string> {
  return renderToString(<PromptInputModeIndicator {...props} />, 24)
}

describe('PromptInputModeIndicator coverage swarm 162', () => {
  test('renders the bash indicator without consulting teammate color when swarms are off', async () => {
    harness.reset()

    const output = await renderIndicator({
      mode: 'bash',
      permissionMode: 'bypassPermissions',
      isLoading: true,
    })

    expect(output).toContain('!')
    expect(output).not.toContain('❯')
    expect(output).not.toContain('▶')
    expect(harness.isAgentSwarmsEnabled).toHaveBeenCalled()
    expect(harness.getTeammateColor).not.toHaveBeenCalled()
  })

  test('handles teammate color lookup fallbacks for prompt-like modes', async () => {
    harness.reset()
    harness.swarmsEnabled = true

    harness.teammateColor = undefined
    await expect(
      renderIndicator({
        mode: 'prompt',
        isLoading: false,
      }),
    ).resolves.toContain('❯')

    harness.teammateColor = 'ultraviolet'
    await expect(
      renderIndicator({
        mode: 'orphaned-permission',
        permissionMode: 'default',
        isLoading: false,
      }),
    ).resolves.toContain('❯')

    harness.teammateColor = 'cyan'
    await expect(
      renderIndicator({
        mode: 'task-notification',
        permissionMode: 'acceptEdits',
        isLoading: true,
      }),
    ).resolves.toContain('❯')

    expect(harness.getTeammateColor).toHaveBeenCalledTimes(3)
  })

  test('prefers the viewed-agent branch and maps optional viewed colors', async () => {
    harness.reset()
    harness.swarmsEnabled = true
    harness.teammateColor = 'red'

    const output = await renderToString(
      <Box flexDirection="column">
        <PromptInputModeIndicator
          mode="prompt"
          permissionMode="bypassPermissions"
          isLoading={false}
          viewingAgentName="planner"
        />
        <PromptInputModeIndicator
          mode="prompt"
          permissionMode="bypassPermissions"
          isLoading={false}
          viewingAgentName="runner"
          viewingAgentColor="purple"
        />
      </Box>,
      24,
    )

    expect(output.match(/▶/g)).toHaveLength(2)
    expect(output).not.toContain('!')
    expect(harness.getTeammateColor).toHaveBeenCalled()
  })

  test('keeps the same prompt output across an identical rerender', async () => {
    harness.reset()
    harness.swarmsEnabled = true
    harness.teammateColor = 'pink'

    const { stdin, stdout } = createStreams()
    let output = ''

    stdout.on('data', chunk => {
      output += chunk.toString()
    })

    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      const renderNode = () => (
        <PromptInputModeIndicator
          mode="prompt"
          permissionMode="bypassPermissions"
          isLoading={false}
        />
      )

      root.render(renderNode())
      await sleep()
      root.render(renderNode())
      await sleep()

      expect(stripAnsi(output)).toContain('▶')
      expect(harness.getTeammateColor).toHaveBeenCalledTimes(1)
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
