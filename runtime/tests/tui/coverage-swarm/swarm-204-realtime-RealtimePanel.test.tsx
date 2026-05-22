import React from 'react'
import { describe, expect, test } from 'vitest'

import { stringWidth } from '../../../src/tui/ink/stringWidth.js'
import {
  getRealtimeStatusRenderParts,
  RealtimePanel,
} from '../../../src/tui/realtime/RealtimePanel.js'
import {
  initialRealtimeTuiState,
  type RealtimeTuiState,
} from '../../../src/tui/realtime/state.js'
import { renderToString } from '../../../src/utils/staticRender.js'

function activeState(overrides: Partial<RealtimeTuiState> = {}): RealtimeTuiState {
  return {
    ...initialRealtimeTuiState(),
    phase: 'active',
    transport: 'websocket',
    realtimeSessionId: 'rt_1',
    ...overrides,
  }
}

describe('RealtimePanel coverage swarm row 204', () => {
  test('returns empty status parts for unusable terminal widths', () => {
    const state = activeState()

    expect(getRealtimeStatusRenderParts(state, 0)).toEqual({
      statusText: '',
      meterText: null,
    })
    expect(getRealtimeStatusRenderParts(state, -5)).toEqual({
      statusText: '',
      meterText: null,
    })
    expect(getRealtimeStatusRenderParts(state, Number.NaN)).toEqual({
      statusText: '',
      meterText: null,
    })
    expect(getRealtimeStatusRenderParts(state, Number.POSITIVE_INFINITY)).toEqual(
      {
        statusText: '',
        meterText: null,
      },
    )
  })

  test('reports push-to-talk armed and held microphone status', () => {
    const armed = getRealtimeStatusRenderParts(
      activeState({ pushToTalk: true, pushToTalkHeld: false }),
      140,
    )
    expect(armed.statusText).toContain('mic muted')
    expect(armed.statusText).toContain('ptt armed')

    const held = getRealtimeStatusRenderParts(
      activeState({ pushToTalk: true, pushToTalkHeld: true }),
      140,
    )
    expect(held.statusText).toContain('mic live')
    expect(held.statusText).toContain('ptt held')
  })

  test('truncates status while preserving meter until the meter no longer fits', () => {
    const state = activeState({
      localAudioLevel: 65_535,
      realtimeSessionId:
        'rt_session_with_a_long_identifier_that_should_be_truncated',
    })

    const withMeter = getRealtimeStatusRenderParts(state, 24)
    expect(withMeter.meterText).toBe(' [############]')
    expect(withMeter.statusText).not.toContain('rt_session_with_a_long')
    expect(stringWidth(`${withMeter.statusText}${withMeter.meterText}`)).toBeLessThanOrEqual(
      24,
    )

    const withoutMeter = getRealtimeStatusRenderParts(state, 8)
    expect(withoutMeter.meterText).toBeNull()
    expect(withoutMeter.statusText).not.toContain('[')
    expect(stringWidth(withoutMeter.statusText)).toBeLessThanOrEqual(8)
  })

  test('renders nothing for a clean inactive state and gives errors banner priority', async () => {
    const inactive = await renderToString(
      <RealtimePanel state={initialRealtimeTuiState()} />,
      { columns: 100, rows: 4 },
    )
    expect(inactive.trim()).toBe('')

    const output = await renderToString(
      <RealtimePanel
        state={activeState({
          errorBanner: 'microphone failed',
          closedBanner: 'Realtime closed: remote hangup',
          lastTranscript: { role: 'user', text: 'hello from mic' },
          lastItemSummary: 'response out_1',
        })}
      />,
      { columns: 100, rows: 8 },
    )

    expect(output).toContain('microphone failed')
    expect(output).not.toContain('remote hangup')
    expect(output).toContain('you')
    expect(output).toContain('hello from mic')
    expect(output).toContain('item: response out_1')
  })
})
