import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
  featureFlags: new Set<string>(),
  getKairosActive: vi.fn(() => false),
  getUserMsgOptIn: vi.fn(() => false),
  growthbookValue: false,
  isBriefOnly: false,
  logError: vi.fn(),
  viewingAgentTaskId: null as string | null,
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => state.featureFlags.has(name),
}))

vi.mock('../../../src/bootstrap/state', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/bootstrap/state')>()),
  getKairosActive: () => state.getKairosActive(),
  getUserMsgOptIn: () => state.getUserMsgOptIn(),
}))

vi.mock('../../../src/services/analytics/growthbook', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => state.growthbookValue,
}))

vi.mock('../../../src/tui/state/AppState.js', () => ({
  useAppState: <T,>(selector: (appState: {
    readonly isBriefOnly: boolean
    readonly viewingAgentTaskId: string | null
  }) => T): T =>
    selector({
      isBriefOnly: state.isBriefOnly,
      viewingAgentTaskId: state.viewingAgentTaskId,
    }),
}))

vi.mock('../../../src/utils/log.js', () => ({
  logError: (error: Error) => state.logError(error),
}))

vi.mock('../../../src/tui/message-renderers/HighlightedThinkingText', async () => {
  const { default: Text } = await import(
    '../../../src/tui/ink/components/Text.js'
  )

  return {
    HighlightedThinkingText: ({
      showPointer,
      text,
      timestamp,
      useBriefLayout,
    }: {
      readonly showPointer?: boolean
      readonly text: string
      readonly timestamp?: string
      readonly useBriefLayout?: boolean
    }) => (
      <Text>
        {`highlight brief:${String(useBriefLayout)} pointer:${String(
          showPointer,
        )} time:${timestamp ?? 'none'} text:${text}`}
      </Text>
    ),
  }
})

vi.mock('../../../src/tui/components/v2/primitives.js', async () => {
  const { default: Text } = await import(
    '../../../src/tui/ink/components/Text.js'
  )

  return {
    Msg: ({
      children,
      label,
      role,
      time,
    }: {
      readonly children: React.ReactNode
      readonly label: string
      readonly role: string
      readonly time?: string
    }) => (
      <Text>
        {`msg role:${role} label:${label} time:${time ?? 'none'} `}
        {children}
      </Text>
    ),
  }
})

import { renderToString } from '../../../src/utils/staticRender.js'
import { MessageActionsSelectedContext } from '../../../src/tui/components/messageActions.js'
import {
  getUserPromptTruncationNotice,
  truncateUserPromptDisplayText,
  UserPromptMessage,
} from '../../../src/tui/message-renderers/UserPromptMessage.js'

const originalBriefEnv = process.env.AGENC_BRIEF

function resetState(): void {
  state.featureFlags.clear()
  state.getKairosActive.mockReturnValue(false)
  state.getUserMsgOptIn.mockReturnValue(false)
  state.growthbookValue = false
  state.isBriefOnly = false
  state.logError.mockClear()
  state.viewingAgentTaskId = null

  if (originalBriefEnv === undefined) {
    delete process.env.AGENC_BRIEF
  } else {
    process.env.AGENC_BRIEF = originalBriefEnv
  }
}

afterEach(() => {
  resetState()
})

function renderPrompt({
  addMargin = false,
  isSelected = false,
  isTranscriptMode,
  text = 'hello from user',
  timestamp = '10:15',
}: {
  readonly addMargin?: boolean
  readonly isSelected?: boolean
  readonly isTranscriptMode?: boolean
  readonly text?: string
  readonly timestamp?: string
} = {}): Promise<string> {
  return renderToString(
    <MessageActionsSelectedContext.Provider value={isSelected}>
      <UserPromptMessage
        addMargin={addMargin}
        isTranscriptMode={isTranscriptMode}
        param={{ type: 'text', text }}
        timestamp={timestamp}
      />
    </MessageActionsSelectedContext.Provider>,
    { columns: 100, rows: 12 },
  )
}

describe('UserPromptMessage swarm 114 coverage', () => {
  test('formats truncation notices and preserves short prompts', () => {
    expect(getUserPromptTruncationNotice(7, { AGENC_TUI_GLYPHS: 'ascii' })).toBe(
      '... +7 lines ...',
    )

    expect(truncateUserPromptDisplayText('short prompt')).toBe('short prompt')

    const longPrompt = `${'head\n'.repeat(650)}${'middle\n'.repeat(
      1200,
    )}${'tail\n'.repeat(650)}`
    const truncated = truncateUserPromptDisplayText(longPrompt, {
      AGENC_TUI_GLYPHS: 'ascii',
    })

    expect(truncated.length).toBeLessThan(longPrompt.length)
    expect(truncated).toContain('... +')
    expect(truncated).toContain(' lines ...')
    expect(truncated.startsWith(longPrompt.slice(0, 2500))).toBe(true)
    expect(truncated.endsWith(longPrompt.slice(-2500))).toBe(true)
  })

  test('logs and renders nothing for empty prompt text', async () => {
    const output = await renderPrompt({ text: '' })

    expect(output.trim()).toBe('')
    expect(state.logError).toHaveBeenCalledTimes(1)
    expect(state.logError.mock.calls[0]?.[0]).toMatchObject({
      message: 'No content found in user prompt message',
    })
  })

  test('renders normal selected prompt through message chrome', async () => {
    const output = await renderPrompt({
      addMargin: true,
      isSelected: true,
      text: 'normal selected prompt',
      timestamp: '11:45',
    })

    expect(output).toContain('msg role:user label:you time:11:45')
    expect(output).toContain(
      'highlight brief:undefined pointer:false time:none text:normal',
    )
    expect(output).toContain('selected prompt')
  })

  test('uses brief layout only when feature, state, opt-in, and view gates allow it', async () => {
    state.featureFlags.add('KAIROS_BRIEF')
    state.getUserMsgOptIn.mockReturnValue(true)
    state.growthbookValue = true
    state.isBriefOnly = true

    await expect(
      renderPrompt({ text: 'brief prompt', timestamp: '12:00' }),
    ).resolves.toContain(
      'highlight brief:true pointer:undefined time:12:00 text:brief prompt',
    )

    await expect(
      renderPrompt({
        isTranscriptMode: true,
        text: 'transcript prompt',
        timestamp: '12:01',
      }),
    ).resolves.toContain('msg role:user label:you time:12:01')

    state.viewingAgentTaskId = 'task-114'

    await expect(
      renderPrompt({ text: 'viewing task prompt', timestamp: '12:02' }),
    ).resolves.toContain('msg role:user label:you time:12:02')
  })

  test('allows active Kairos with env opt-in to drive brief layout', async () => {
    state.featureFlags.add('KAIROS')
    state.getKairosActive.mockReturnValue(true)
    state.isBriefOnly = true
    process.env.AGENC_BRIEF = '1'

    const output = await renderPrompt({
      text: `${'visible\n'.repeat(1400)}final question`,
      timestamp: '12:03',
    })

    expect(output).toContain('highlight brief:true')
    expect(output).toContain('… +')
    expect(output).toContain('final question')
  })
})
