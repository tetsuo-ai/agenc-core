import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import Text from '../components/Text.js'
import { TerminalWriteProvider } from '../useTerminalNotification.js'
import { useTerminalTitle } from './use-terminal-title.js'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalTitle = process.title

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  })
}

function TerminalTitleProbe({ title }: { title: string | null }) {
  useTerminalTitle(title)

  return <Text>ready</Text>
}

async function renderProbe(
  title: string | null,
  writeRaw: ((data: string) => void) | null,
): Promise<void> {
  await renderToString(
    <TerminalWriteProvider value={writeRaw}>
      <TerminalTitleProbe title={title} />
    </TerminalWriteProvider>,
    80,
  )
}

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  process.title = originalTitle
})

describe('useTerminalTitle', () => {
  test('does nothing when title is null or no terminal writer exists', async () => {
    const writes: string[] = []

    await renderProbe(null, data => writes.push(data))
    await renderProbe('Ignored title', null)

    expect(writes).toEqual([])
  })

  test('writes a sanitized OSC title on non-Windows platforms', async () => {
    const writes: string[] = []
    setPlatform('linux')

    await renderProbe('\x1b[31mRed\x1b[0m title', data => writes.push(data))

    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('\x1b]0;Red title')
    expect(writes[0]).not.toContain('\x1b[31m')
  })

  test('sets process.title on Windows platforms', async () => {
    const writes: string[] = []
    setPlatform('win32')
    process.title = 'before'

    await renderProbe('\x1b[32mWindows\x1b[0m title', data => writes.push(data))

    expect(writes).toEqual([])
    expect(process.title).toBe('Windows title')
  })
})
