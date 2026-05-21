import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

import { ThemeProvider } from '../../../src/tui/components/design-system/ThemeProvider.js'
import ThemedBox from '../../../src/tui/components/design-system/ThemedBox.js'
import type { DOMElement } from '../../../src/tui/ink/dom.js'
import instances from '../../../src/tui/ink/instances.js'
import { createRoot } from '../../../src/tui/ink/root.js'
import { getTheme } from '../../../src/utils/theme.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  isTTY: boolean
  rows: number
}

type MountedRoot = {
  root: Awaited<ReturnType<typeof createRoot>>
  stdin: TestStdin
  stdout: TestStdout
}

const mountedRoots: MountedRoot[] = []

function createStreams(): {
  stderr: PassThrough
  stdin: TestStdin
  stdout: TestStdout
} {
  const stderr = new PassThrough()
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout

  stderr.resume()
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.columns = 80
  stdout.isTTY = true
  stdout.rows = 24
  stdout.resume()

  return { stderr, stdin, stdout }
}

function sleep(ms = 20): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown

  for (let i = 0; i < 50; i += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await sleep(10)
    }
  }

  throw lastError
}

async function renderNode(node: React.ReactNode): Promise<void> {
  const { stderr, stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  mountedRoots.push({ root, stdin, stdout })
  root.render(node)
}

afterEach(async () => {
  while (mountedRoots.length > 0) {
    const mounted = mountedRoots.pop()!
    mounted.root.unmount()
    mounted.stdin.end()
    mounted.stdout.end()
    instances.delete(mounted.stdout as unknown as NodeJS.WriteStream)
  }

  await sleep()
})

describe('ThemedBox coverage swarm row 135', () => {
  test('resolves every theme color prop against the active theme', async () => {
    const ref = React.createRef<DOMElement>()
    const theme = getTheme('light')

    await renderNode(
      <ThemeProvider initialState="light" onThemeSave={vi.fn()}>
        <ThemedBox
          ref={ref}
          backgroundColor="surfaceBackground"
          borderBottomColor="success"
          borderColor="lineSoft"
          borderLeftColor="warning"
          borderRightColor="error"
          borderStyle="single"
          borderTopColor="agenc"
          paddingX={2}
          width={12}
        >
          themed
        </ThemedBox>
      </ThemeProvider>,
    )

    await waitFor(() => {
      expect(ref.current).not.toBeNull()
    })

    expect(ref.current?.style).toMatchObject({
      backgroundColor: theme.surfaceBackground,
      borderBottomColor: theme.success,
      borderColor: theme.lineSoft,
      borderLeftColor: theme.warning,
      borderRightColor: theme.error,
      borderStyle: 'single',
      borderTopColor: theme.agenc,
      paddingX: 2,
      width: 12,
    })
  })

  test('passes raw colors through without theme lookup', async () => {
    const ref = React.createRef<DOMElement>()

    await renderNode(
      <ThemedBox
        ref={ref}
        backgroundColor="#101010"
        borderBottomColor="ansi256(42)"
        borderColor="#abcdef"
        borderLeftColor="ansi:cyan"
        borderRightColor="remember"
        borderTopColor="rgb(1,2,3)"
      >
        raw
      </ThemedBox>,
    )

    await waitFor(() => {
      expect(ref.current).not.toBeNull()
    })

    const darkTheme = getTheme('dark')
    expect(ref.current?.style).toMatchObject({
      backgroundColor: '#101010',
      borderBottomColor: 'ansi256(42)',
      borderColor: '#abcdef',
      borderLeftColor: 'ansi:cyan',
      borderRightColor: darkTheme.remember,
      borderTopColor: 'rgb(1,2,3)',
    })
  })

  test('leaves omitted color props undefined while forwarding layout props', async () => {
    const ref = React.createRef<DOMElement>()

    await renderNode(
      <ThemedBox ref={ref} flexDirection="column" gap={1} margin={2}>
        plain
      </ThemedBox>,
    )

    await waitFor(() => {
      expect(ref.current).not.toBeNull()
    })

    expect(ref.current?.style).toMatchObject({
      flexDirection: 'column',
      flexGrow: 0,
      flexShrink: 1,
      flexWrap: 'nowrap',
      gap: 1,
      margin: 2,
    })
    expect(ref.current?.style.backgroundColor).toBeUndefined()
    expect(ref.current?.style.borderBottomColor).toBeUndefined()
    expect(ref.current?.style.borderColor).toBeUndefined()
    expect(ref.current?.style.borderLeftColor).toBeUndefined()
    expect(ref.current?.style.borderRightColor).toBeUndefined()
    expect(ref.current?.style.borderTopColor).toBeUndefined()
  })
})
