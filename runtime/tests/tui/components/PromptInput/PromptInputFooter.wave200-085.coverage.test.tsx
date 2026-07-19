import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'

const harness = vi.hoisted(() => ({
  appState: {
    coordinatorTaskIndex: -1,
  },
  columns: 100,
  coordinatorTaskCount: 0,
  fullscreen: false,
  modalOverlayActive: false,
  overlays: [] as unknown[],
  rows: 30,
  statusLineEnabled: false,
  reset() {
    harness.appState.coordinatorTaskIndex = -1
    harness.columns = 100
    harness.coordinatorTaskCount = 0
    harness.fullscreen = false
    harness.modalOverlayActive = false
    harness.overlays = []
    harness.rows = 30
    harness.statusLineEnabled = false
  },
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../context/overlayContext.js', () => ({
  useIsModalOverlayActive: () => harness.modalOverlayActive,
}))

vi.mock('../../context/promptOverlayContext.js', () => ({
  useSetPromptOverlay: (data: unknown) => {
    harness.overlays.push(data)
  },
}))

vi.mock('../../hooks/useSettings.js', () => ({
  useSettings: () => ({
    statusLine: harness.statusLineEnabled
      ? {
          command: 'status',
        }
      : undefined,
  }),
}))

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({
    columns: harness.columns,
    rows: harness.rows,
  }),
}))

vi.mock('../../../utils/fullscreen.js', () => ({
  isFullscreenEnvEnabled: () => harness.fullscreen,
}))

vi.mock('../../state/AppState.js', () => ({
  useAppState: (selector: (state: typeof harness.appState) => unknown) =>
    selector(harness.appState),
}))

vi.mock('../CoordinatorAgentStatus.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')

  return {
    CoordinatorTaskPanel: () =>
      ReactModule.createElement(Text, null, 'CoordinatorTaskPanel'),
    useCoordinatorTaskCount: () => harness.coordinatorTaskCount,
  }
})

vi.mock('../../startup/StatusLine.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')

  return {
    getLastAssistantMessageId: (messages: Array<{ uuid?: string }>) =>
      messages.at(-1)?.uuid ?? null,
    StatusLine: ({ lastAssistantMessageId }: { lastAssistantMessageId: string | null }) =>
      ReactModule.createElement(Text, null, `StatusLine:${lastAssistantMessageId}`),
    statusLineShouldDisplay: (settings: { statusLine?: unknown }) =>
      settings.statusLine !== undefined,
  }
})

vi.mock('./Notifications.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')

  return {
    Notifications: (props: {
      readonly isInputWrapped: boolean
      readonly isNarrow: boolean
      readonly getMessages: () => unknown[]
    }) =>
      ReactModule.createElement(
        Text,
        null,
        `Notifications:${String(props.isNarrow)}:${String(props.isInputWrapped)}:${props.getMessages().length}`,
      ),
  }
})

vi.mock('./PromptInputFooterLeftSide.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')

  return {
    PromptInputFooterLeftSide: (props: {
      readonly isSearching: boolean
      readonly suppressHint: boolean
      readonly tasksSelected: boolean
      readonly vimMode?: string
    }) =>
      ReactModule.createElement(
        Text,
        null,
        `Left:${String(props.tasksSelected)}:${props.vimMode ?? 'none'}:${String(props.suppressHint)}:${String(props.isSearching)}`,
      ),
  }
})

vi.mock('./PromptInputFooterSuggestions.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')

  return {
    PromptInputFooterSuggestions: (props: {
      readonly selectedSuggestion: number
      readonly suggestionType: string
      readonly suggestions: Array<{ displayText: string }>
    }) =>
      ReactModule.createElement(
        Text,
        null,
        `Suggestions:${props.selectedSuggestion}:${props.suggestionType}:${props.suggestions.map(suggestion => suggestion.displayText).join(',')}`,
      ),
  }
})

vi.mock('./PromptInputHelpMenu.js', async () => {
  const ReactModule = await import('react')
  const { Text } = await import('../../ink.js')

  return {
    PromptInputHelpMenu: (props: {
      readonly dimColor: boolean
      readonly fixedWidth: boolean
      readonly paddingX: number
    }) =>
      ReactModule.createElement(
        Text,
        null,
        `HelpMenu:${String(props.dimColor)}:${String(props.fixedWidth)}:${props.paddingX}`,
      ),
  }
})

import PromptInputFooter from './PromptInputFooter.js'

type FooterProps = React.ComponentProps<typeof PromptInputFooter>

const suggestions = [
  {
    id: 'command-help',
    displayText: '/help',
    description: 'Show help',
  },
]

function props(overrides: Partial<FooterProps> = {}): FooterProps {
  return {
    apiKeyStatus: 'valid',
    autoUpdaterResult: null,
    debug: false,
    exitMessage: {
      show: false,
    },
    helpOpen: false,
    historyFailedMatch: false,
    historyQuery: '',
    ideSelection: undefined,
    isAutoUpdating: false,
    isLoading: false,
    isPasting: false,
    isSearching: false,
    maxColumnWidth: 42,
    getMessages: () => [],
    lastAssistantMessageId: null,
    mode: 'prompt',
    onAutoUpdaterResult: vi.fn(),
    onChangeIsUpdating: vi.fn(),
    selectedSuggestion: 0,
    setHistoryQuery: vi.fn(),
    suggestionType: 'command',
    suggestions: [],
    suppressHint: false,
    tasksSelected: false,
    teamsSelected: false,
    toolPermissionContext: {
      mode: 'default',
    } as FooterProps['toolPermissionContext'],
    verbose: false,
    vimMode: 'INSERT',
    ...overrides,
  }
}

describe('PromptInputFooter coverage branch render', () => {
  test('switches between suggestions, fullscreen overlay, help, and footer rows', async () => {
    harness.reset()
    const inlineSuggestions = await renderToString(
      <PromptInputFooter {...props({ suggestions })} />,
      100,
    )

    expect(inlineSuggestions).toContain('Suggestions:0:command:/help')
    expect(inlineSuggestions).not.toContain('Left:')
    expect(harness.overlays.at(-1)).toBeNull()

    harness.reset()
    harness.fullscreen = true
    harness.statusLineEnabled = true
    const fullscreenOutput = await renderToString(
      <PromptInputFooter
        {...props({
          getMessages: () => [{ type: 'assistant', uuid: 'msg-1' } as never],
          lastAssistantMessageId: 'msg-1',
          suggestions,
          tasksSelected: true,
        })}
      />,
      {
        columns: 120,
        rows: 30,
      },
    )

    expect(fullscreenOutput).toContain('StatusLine:msg-1')
    expect(fullscreenOutput).toContain('Left:true:none:true:false')
    expect(fullscreenOutput).not.toContain('Notifications:')
    expect(fullscreenOutput).not.toContain('Suggestions:')
    expect(harness.overlays.at(-1)).toMatchObject({
      maxColumnWidth: 42,
      selectedSuggestion: 0,
      suggestionType: 'command',
      suggestions,
    })

    harness.reset()
    const helpOutput = await renderToString(
      <PromptInputFooter {...props({ helpOpen: true })} />,
      100,
    )

    expect(helpOutput).toContain('HelpMenu:true:true:2')
    expect(helpOutput).not.toContain('Left:')

    harness.reset()
    harness.columns = 60
    harness.modalOverlayActive = true
    const footerOutput = await renderToString(
      <PromptInputFooter
        {...props({
          isInputWrapped: true,
          isSearching: true,
          suggestions,
        })}
      />,
      {
        columns: 60,
        rows: 30,
      },
    )

    expect(footerOutput).toContain('Left:false:INSERT:true:true')
    expect(footerOutput).toContain('Notifications:true:true:0')
    expect(footerOutput).not.toContain('Suggestions:')
    expect(harness.overlays.at(-1)).toBeNull()
  })
})
