import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import {
  SpinnerAnimationRow,
  type SpinnerAnimationRowProps,
} from './SpinnerAnimationRow.js'

const NOW = new Date('2026-05-20T12:00:00.000Z').getTime()

function props(
  overrides: Partial<SpinnerAnimationRowProps> = {},
): SpinnerAnimationRowProps {
  return {
    columns: 100,
    effortSuffix: '',
    foregroundedTeammate: undefined,
    hasActiveTools: false,
    hasRunningTeammates: false,
    leaderIsIdle: false,
    loadingStartTimeRef: { current: NOW - 31_000 },
    message: 'Working',
    messageColor: 'text',
    mode: 'responding',
    overrideColor: null,
    pauseStartTimeRef: { current: null },
    reducedMotion: false,
    responseLengthRef: { current: 16_000 },
    shimmerColor: 'agencShimmer',
    spinnerSuffix: null,
    teammateTokens: 0,
    thinkingStatus: null,
    totalPausedMsRef: { current: 0 },
    verbose: false,
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SpinnerAnimationRow coverage', () => {
  test('renders metadata, thinking fallbacks, thought summaries, and foregrounded teammate status', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)

    const activeTools = await renderToString(
      <SpinnerAnimationRow
        {...props({
          effortSuffix: ' deeply',
          hasActiveTools: true,
          spinnerSuffix: 'indexing',
          teammateTokens: 500,
          thinkingStatus: 'thinking',
          verbose: true,
        })}
      />,
      120,
    )

    expect(activeTools).toContain('⣷')
    expect(activeTools).toContain('Working')
    expect(activeTools).toContain('indexing')
    expect(activeTools).toContain('31s')
    expect(activeTools).toContain('4.5k tokens')
    expect(activeTools).toContain('thinking deeply')

    const compactThinking = await renderToString(
      <SpinnerAnimationRow
        {...props({
          columns: 20,
          effortSuffix: ' deeply',
          loadingStartTimeRef: { current: NOW - 2_000 },
          message: 'Ask',
          thinkingStatus: 'thinking',
        })}
      />,
      20,
    )

    expect(compactThinking).toContain('Ask')
    expect(compactThinking).toContain('(thinking)')
    expect(compactThinking).not.toContain('deeply')
    expect(compactThinking).not.toContain('tokens')

    const thoughtSummary = await renderToString(
      <SpinnerAnimationRow
        {...props({
          loadingStartTimeRef: { current: NOW - 61_000 },
          mode: 'requesting',
          responseLengthRef: { current: 400 },
          thinkingStatus: 1_400,
          verbose: true,
        })}
      />,
      100,
    )

    expect(thoughtSummary).toContain('↑')
    expect(thoughtSummary).toContain('1m 1s')
    expect(thoughtSummary).toContain('100 tokens')
    expect(thoughtSummary).toContain('thought for 1s')

    const foregroundedTeammate = await renderToString(
      <SpinnerAnimationRow
        {...props({
          foregroundedTeammate: {
            identity: {
              agentName: 'Reviewer',
              color: 'blue',
            },
            isIdle: false,
            progress: { tokenCount: 9_100 },
          } as SpinnerAnimationRowProps['foregroundedTeammate'],
          hasRunningTeammates: true,
          mode: 'tool-use',
          responseLengthRef: { current: 20_000 },
          teammateTokens: 3_000,
          thinkingStatus: 'thinking',
          verbose: true,
        })}
      />,
      120,
    )

    expect(foregroundedTeammate).toContain('⣷')
    expect(foregroundedTeammate).toContain('(esc to interrupt Reviewer)')
    expect(foregroundedTeammate).not.toContain('9.1k tokens')
    expect(foregroundedTeammate).not.toContain('thinking')
  })
})
