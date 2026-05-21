import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  feature: vi.fn(() => false),
  getGlobalConfig: vi.fn(() => ({ theme: 'auto' })),
  getSystemThemeName: vi.fn(() => 'dark'),
  saveGlobalConfig: vi.fn(),
}))

vi.mock('bun:bundle', () => ({
  feature: mocks.feature,
}))

vi.mock('../../../src/utils/config.js', () => ({
  getGlobalConfig: mocks.getGlobalConfig,
  saveGlobalConfig: mocks.saveGlobalConfig,
}))

vi.mock('../../../src/utils/systemTheme.js', () => ({
  getSystemThemeName: mocks.getSystemThemeName,
}))

import { createRoot, type Root } from '../../../src/tui/ink/root.js'
import Text from '../../../src/tui/ink/components/Text.js'
import {
  ThemeProvider,
  usePreviewTheme,
  useTheme,
  useThemeSetting,
} from '../../../src/tui/components/design-system/ThemeProvider.js'

type ThemeSetting = 'auto' | 'dark' | 'light'
type ThemeName = 'dark' | 'light'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type Rendered = {
  dispose: () => Promise<void>
  root: Root
}

function createStreams(): {
  stderr: PassThrough
  stdin: TestStdin
  stdout: PassThrough
} {
  const stderr = new PassThrough()
  const stdout = new PassThrough()
  const stdin = new PassThrough() as TestStdin

  stderr.resume()
  stdout.resume()
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number; isTTY: boolean; rows: number }).columns = 80
  ;(stdout as unknown as { columns: number; isTTY: boolean; rows: number }).rows = 24
  ;(stdout as unknown as { columns: number; isTTY: boolean; rows: number }).isTTY = true

  return { stderr, stdin, stdout }
}

function sleep(ms = 20): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function createInkRoot(): Promise<Rendered> {
  const { stderr, stdin, stdout } = createStreams()
  const root = await createRoot({
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      stderr.end()
      await sleep()
    },
    root,
  }
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

describe('ThemeProvider coverage swarm row 091', () => {
  beforeEach(() => {
    mocks.feature.mockReturnValue(false)
    mocks.getGlobalConfig.mockReturnValue({ theme: 'auto' })
    mocks.getSystemThemeName.mockReturnValue('dark')
    mocks.saveGlobalConfig.mockImplementation(
      (update: (current: unknown) => unknown) => {
        update({ retained: true, theme: 'light' })
      },
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  test('returns stable no-op defaults when hooks are used without a provider', async () => {
    const rendered = await createInkRoot()
    let captured:
      | {
          preview: ReturnType<typeof usePreviewTheme>
          setTheme: (setting: ThemeSetting) => void
          setting: ThemeSetting
          theme: ThemeName
        }
      | undefined

    function Probe() {
      const [theme, setTheme] = useTheme()
      const setting = useThemeSetting()
      const preview = usePreviewTheme()

      React.useEffect(() => {
        captured = { preview, setTheme, setting, theme }
      }, [preview, setTheme, setting, theme])

      return <Text>{`${setting}:${theme}`}</Text>
    }

    try {
      rendered.root.render(<Probe />)

      await waitFor(() => {
        expect(captured).toMatchObject({ setting: 'dark', theme: 'dark' })
      })

      expect(() => captured?.setTheme('light')).not.toThrow()
      expect(() => captured?.preview.setPreviewTheme('light')).not.toThrow()
      expect(() => captured?.preview.savePreview()).not.toThrow()
      expect(() => captured?.preview.cancelPreview()).not.toThrow()
      expect(mocks.getGlobalConfig).not.toHaveBeenCalled()
      expect(mocks.saveGlobalConfig).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('uses explicit initial state and delegates direct saves to the supplied callback', async () => {
    const rendered = await createInkRoot()
    const onThemeSave = vi.fn()
    const snapshots: Array<{ setting: ThemeSetting; theme: ThemeName }> = []
    let setTheme: ((setting: ThemeSetting) => void) | undefined
    let preview: ReturnType<typeof usePreviewTheme> | undefined

    function Probe() {
      const [theme, setThemeSetting] = useTheme()
      const setting = useThemeSetting()
      const previewControls = usePreviewTheme()

      React.useEffect(() => {
        snapshots.push({ setting, theme })
        setTheme = setThemeSetting
        preview = previewControls
      }, [previewControls, setThemeSetting, setting, theme])

      return <Text>{`${setting}:${theme}`}</Text>
    }

    try {
      rendered.root.render(
        <ThemeProvider initialState="light" onThemeSave={onThemeSave}>
          <Probe />
        </ThemeProvider>,
      )

      await waitFor(() => {
        expect(snapshots.at(-1)).toEqual({ setting: 'light', theme: 'light' })
      })
      expect(mocks.getGlobalConfig).not.toHaveBeenCalled()
      expect(mocks.getSystemThemeName).not.toHaveBeenCalled()

      preview?.setPreviewTheme('dark')
      await waitFor(() => {
        expect(snapshots.at(-1)).toEqual({ setting: 'light', theme: 'dark' })
      })

      setTheme?.('light')
      await waitFor(() => {
        expect(snapshots.at(-1)).toEqual({ setting: 'light', theme: 'light' })
      })
      expect(onThemeSave).toHaveBeenCalledWith('light')

      setTheme?.('auto')
      await waitFor(() => {
        expect(snapshots.at(-1)).toEqual({ setting: 'auto', theme: 'dark' })
      })

      expect(onThemeSave).toHaveBeenCalledWith('auto')
      expect(mocks.getSystemThemeName).toHaveBeenCalledTimes(1)
      expect(mocks.saveGlobalConfig).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })

  test('feature-enabled effect returns early for concrete active themes', async () => {
    mocks.feature.mockReturnValue(true)
    const rendered = await createInkRoot()
    const snapshots: Array<{ setting: ThemeSetting; theme: ThemeName }> = []
    let preview: ReturnType<typeof usePreviewTheme> | undefined

    function Probe() {
      const [theme] = useTheme()
      const setting = useThemeSetting()
      const previewControls = usePreviewTheme()

      React.useEffect(() => {
        snapshots.push({ setting, theme })
        preview = previewControls
      }, [previewControls, setting, theme])

      return <Text>{`${setting}:${theme}`}</Text>
    }

    try {
      rendered.root.render(
        <ThemeProvider initialState="dark" onThemeSave={vi.fn()}>
          <Probe />
        </ThemeProvider>,
      )

      await waitFor(() => {
        expect(snapshots.at(-1)).toEqual({ setting: 'dark', theme: 'dark' })
      })

      preview?.setPreviewTheme('light')
      await waitFor(() => {
        expect(snapshots.at(-1)).toEqual({ setting: 'dark', theme: 'light' })
      })

      expect(mocks.feature).toHaveBeenCalledWith('AUTO_THEME')
      expect(mocks.getSystemThemeName).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })
})
