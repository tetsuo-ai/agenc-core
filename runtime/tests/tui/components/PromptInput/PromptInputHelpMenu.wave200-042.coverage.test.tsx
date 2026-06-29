import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test, vi } from 'vitest'

import { createRoot } from '../../ink/root.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../keybindings/useShortcutDisplay.js', () => ({
  useShortcutDisplay: (action: string, _context: string, fallback: string) => {
    const shortcuts: Record<string, string> = {
      'app:toggleTranscript': 'ctrl+shift+o',
      'chat:fastMode': 'alt+shift+o',
    }

    return shortcuts[action] ?? fallback
  },
}))

vi.mock('../../keybindings/loadUserBindings.js', () => ({
  isKeybindingCustomizationEnabled: () => true,
}))

vi.mock('../../../utils/fastMode.js', () => ({
  isFastModeAvailable: () => true,
  isFastModeEnabled: () => true,
}))

vi.mock('../../../utils/platform.js', () => ({
  getPlatform: () => 'linux',
}))

function createStreams(): {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough
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
  ;(stdout as unknown as { columns: number; rows: number }).columns = 160
  ;(stdout as unknown as { columns: number; rows: number }).rows = 40

  return { stdin, stdout }
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('PromptInputHelpMenu optional shortcuts coverage', () => {
  test('renders optional shortcut rows across identical TUI rerenders', async () => {
    const { PromptInputHelpMenu } = await import('./PromptInputHelpMenu.js')
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
    const renderNode = () => (
      <PromptInputHelpMenu dimColor fixedWidth gap={1} paddingX={1} />
    )

    try {
      root.render(renderNode())
      await sleep()
      root.render(renderNode())
      await sleep()

      const text = stripAnsi(output)
      expect(text).toContain('ctrl + shift + o for verbose output')
      expect(text).toContain('alt + shift + o to toggle fast mode')
      expect(text).toContain('/keybindings to customize')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })
})
