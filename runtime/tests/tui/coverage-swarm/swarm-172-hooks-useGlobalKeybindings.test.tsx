import { createRequire } from 'node:module'

import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from 'src/utils/staticRender.js'
import type { Screen } from 'src/tui/types/screen.js'

type ExpandedView = 'none' | 'tasks' | 'teammates'

type AppState = {
  expandedView: ExpandedView
  isBriefOnly: boolean
  showTeammateMessagePreview: boolean
  tasks: Record<string, unknown>
}

type CapturedKeybinding = {
  handler: () => void
  options?: {
    context?: string
    isActive?: boolean
  }
}

const fixture = vi.hoisted(() => ({
  appState: {
    expandedView: 'none',
    isBriefOnly: false,
    showTeammateMessagePreview: false,
    tasks: {},
  } as AppState,
  briefEnabled: false,
  features: new Set<string>(),
  keybindings: new Map<string, CapturedKeybinding>(),
  terminalToggle: vi.fn(),
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => fixture.features.has(name),
}))

vi.mock('src/tui/keybindings/useKeybinding.js', () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options?: CapturedKeybinding['options'],
  ) => {
    fixture.keybindings.set(action, { handler, options })
  },
}))

vi.mock('src/tui/state/AppState.js', () => ({
  useAppState: (selector: (state: AppState) => unknown) =>
    selector(fixture.appState),
  useSetAppState: () => (
    update: AppState | ((prev: AppState) => AppState),
  ) => {
    fixture.appState =
      typeof update === 'function' ? update(fixture.appState) : update
  },
}))

vi.mock('src/utils/terminalPanel.js', () => ({
  getTerminalPanel: () => ({
    toggle: fixture.terminalToggle,
  }),
}))

import { GlobalKeybindingHandlers } from 'src/tui/hooks/useGlobalKeybindings.js'

const requireForTest = createRequire(import.meta.url)
const moduleLoader = requireForTest('node:module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown
}

function installLazyRequireMocks(): () => void {
  const originalLoad = moduleLoader._load

  moduleLoader._load = ((request: string, parent: unknown, isMain: boolean) => {
    if (request === '../../tools/BriefTool/BriefTool') {
      return {
        isBriefEnabled: () => fixture.briefEnabled,
      }
    }

    return Reflect.apply(originalLoad, moduleLoader, [request, parent, isMain])
  }) as typeof originalLoad

  return () => {
    moduleLoader._load = originalLoad
  }
}

function keybinding(action: string): CapturedKeybinding {
  const binding = fixture.keybindings.get(action)
  if (binding === undefined) {
    throw new Error(`Missing keybinding: ${action}`)
  }
  return binding
}

async function renderHandlers(
  overrides: Partial<React.ComponentProps<typeof GlobalKeybindingHandlers>> = {},
): Promise<{
  getScreen: () => Screen
  getShowAllInTranscript: () => boolean
  onEnterTranscript: ReturnType<typeof vi.fn>
  onExitTranscript: ReturnType<typeof vi.fn>
  setScreen: ReturnType<typeof vi.fn>
  setShowAllInTranscript: ReturnType<typeof vi.fn>
}> {
  let screen = overrides.screen ?? 'prompt'
  let showAllInTranscript = overrides.showAllInTranscript ?? true
  const onEnterTranscript = vi.fn()
  const onExitTranscript = vi.fn()
  const setScreen = vi.fn((next: React.SetStateAction<Screen>) => {
    screen = typeof next === 'function' ? next(screen) : next
  })
  const setShowAllInTranscript = vi.fn(
    (next: React.SetStateAction<boolean>) => {
      showAllInTranscript =
        typeof next === 'function' ? next(showAllInTranscript) : next
    },
  )

  await renderToString(
    <GlobalKeybindingHandlers
      screen={screen}
      setScreen={setScreen}
      showAllInTranscript={showAllInTranscript}
      setShowAllInTranscript={setShowAllInTranscript}
      messageCount={7}
      onEnterTranscript={onEnterTranscript}
      onExitTranscript={onExitTranscript}
      {...overrides}
    />,
    100,
  )

  return {
    getScreen: () => screen,
    getShowAllInTranscript: () => showAllInTranscript,
    onEnterTranscript,
    onExitTranscript,
    setScreen,
    setShowAllInTranscript,
  }
}

describe('GlobalKeybindingHandlers coverage swarm 172', () => {
  beforeEach(() => {
    fixture.appState = {
      expandedView: 'none',
      isBriefOnly: false,
      showTeammateMessagePreview: false,
      tasks: {},
    }
    fixture.briefEnabled = false
    fixture.features = new Set()
    fixture.keybindings = new Map()
    vi.clearAllMocks()
  })

  test('toggles transcript back to prompt and leaves prompt-only transcript bindings inactive', async () => {
    const rendered = await renderHandlers({ screen: 'transcript' })

    keybinding('app:toggleTranscript').handler()

    expect(rendered.getScreen()).toBe('prompt')
    expect(rendered.getShowAllInTranscript()).toBe(false)
    expect(rendered.onEnterTranscript).not.toHaveBeenCalled()
    expect(rendered.onExitTranscript).toHaveBeenCalledTimes(1)

    fixture.keybindings = new Map()
    await renderHandlers({ screen: 'prompt' })

    expect(keybinding('transcript:toggleShowAll').options).toEqual({
      context: 'Transcript',
      isActive: false,
    })
    expect(keybinding('transcript:exit').options).toEqual({
      context: 'Transcript',
      isActive: false,
    })
  })

  test('does not toggle the terminal panel when the feature is disabled and redraw tolerates a missing stdout instance', async () => {
    await renderHandlers()

    keybinding('app:toggleTerminal').handler()
    expect(fixture.terminalToggle).not.toHaveBeenCalled()

    expect(() => keybinding('app:redraw').handler()).not.toThrow()
  })

  test('keeps stale brief-mode updates idempotent when the requested state is already applied', async () => {
    fixture.features = new Set(['KAIROS_BRIEF'])
    fixture.briefEnabled = true
    const restoreLazyRequireMocks = installLazyRequireMocks()

    try {
      await renderHandlers()

      fixture.appState.isBriefOnly = true
      keybinding('app:toggleBrief').handler()

      expect(fixture.appState.isBriefOnly).toBe(true)
    } finally {
      restoreLazyRequireMocks()
    }
  })
})
