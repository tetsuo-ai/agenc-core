import { PassThrough } from 'node:stream'

import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  currentSettings: {} as Record<string, unknown>,
  getInitialSettings: vi.fn(() => fixture.currentSettings),
  subscribe: vi.fn(),
}))

vi.mock('../../../src/utils/settings/changeDetector.js', () => ({
  settingsChangeDetector: {
    subscribe: fixture.subscribe,
  },
}))

vi.mock('../../../src/utils/settings/settings.js', () => ({
  getInitialSettings: fixture.getInitialSettings,
}))

import { createRoot } from '../../../src/tui/ink.js'
import { useSettingsChange } from '../../../src/tui/hooks/useSettingsChange.js'

type SettingSource =
  | 'userSettings'
  | 'policySettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'

type TestStreams = {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough & {
    columns: number
    isTTY: boolean
    rows: number
  }
}

function createStreams(): TestStreams {
  const stdin = new PassThrough() as TestStreams['stdin']
  const stdout = new PassThrough() as TestStreams['stdout']

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 100
  stdout.rows = 24
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

async function renderHookHarness(onChange: ReturnType<typeof vi.fn>): Promise<{
  readonly dispose: () => Promise<void>
}> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  function Harness(): null {
    useSettingsChange(onChange)
    return null
  }

  await act(async () => {
    root.render(React.createElement(Harness))
  })
  await flushEffects()

  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await flushEffects()
    },
  }
}

describe('useSettingsChange coverage swarm row 230', () => {
  beforeEach(() => {
    fixture.currentSettings = {}
    fixture.getInitialSettings.mockClear()
    fixture.subscribe.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('subscribes to settings changes and forwards freshly loaded settings', async () => {
    let subscribed:
      | ((source: SettingSource) => void)
      | undefined
    const unsubscribe = vi.fn()
    fixture.subscribe.mockImplementation(
      (handler: (source: SettingSource) => void) => {
        subscribed = handler
        return unsubscribe
      },
    )

    const onChange = vi.fn()
    const rendered = await renderHookHarness(onChange)

    try {
      expect(fixture.subscribe).toHaveBeenCalledTimes(1)
      expect(typeof subscribed).toBe('function')
      expect(fixture.getInitialSettings).not.toHaveBeenCalled()

      fixture.currentSettings = {
        autoUpdatesChannel: 'stable',
        cleanupPeriodDays: 14,
      }
      subscribed?.('projectSettings')

      expect(fixture.getInitialSettings).toHaveBeenCalledTimes(1)
      expect(onChange).toHaveBeenCalledWith('projectSettings', {
        autoUpdatesChannel: 'stable',
        cleanupPeriodDays: 14,
      })
    } finally {
      await rendered.dispose()
    }

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
