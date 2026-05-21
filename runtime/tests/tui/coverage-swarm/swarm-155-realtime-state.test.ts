import { describe, expect, test } from 'vitest'

import {
  effectiveRealtimeMicrophoneMuted,
  formatRealtimeItemSummary,
  initialRealtimeTuiState,
  normalizeRealtimePeak,
  realtimeLevelBar,
  reduceRealtimeTuiState,
} from '../../../src/tui/realtime/state.js'

describe('realtime state coverage swarm row 155', () => {
  test('guards lifecycle transitions that should not advance active state', () => {
    const inactive = initialRealtimeTuiState()
    expect(reduceRealtimeTuiState(inactive, { type: 'stop_requested' })).toBe(
      inactive,
    )
    expect(
      reduceRealtimeTuiState(inactive, {
        type: 'started',
        realtimeSessionId: 'rt_ignored',
      }),
    ).toBe(inactive)

    const starting = reduceRealtimeTuiState(inactive, {
      type: 'start_requested',
      transport: 'websocket',
    })
    const started = reduceRealtimeTuiState(starting, {
      type: 'started',
      realtimeSessionId: undefined,
      transport: 'webrtc',
    })
    expect(started).toMatchObject({
      phase: 'active',
      transport: 'webrtc',
      realtimeSessionId: null,
    })

    const failed = reduceRealtimeTuiState(started, {
      type: 'start_failed',
      message: 'token rejected',
    })
    expect(failed).toMatchObject({
      phase: 'inactive',
      requestedClose: false,
      transport: null,
      realtimeSessionId: null,
      errorBanner: 'token rejected',
    })
  })

  test('normalizes close banners and transcript replacement cases', () => {
    let state = reduceRealtimeTuiState(initialRealtimeTuiState(), {
      type: 'transcript_delta',
      role: 'assistant',
      delta: 'hello',
    })
    state = reduceRealtimeTuiState(state, {
      type: 'transcript_delta',
      role: 'user',
      delta: 'new speaker',
    })
    expect(state.lastTranscript).toEqual({
      role: 'user',
      text: 'new speaker',
    })

    state = reduceRealtimeTuiState(state, {
      type: 'transcript_done',
      role: 'assistant',
      text: 'final answer',
    })
    expect(state.lastTranscript).toEqual({
      role: 'assistant',
      text: 'final answer',
    })

    expect(
      reduceRealtimeTuiState(state, { type: 'closed', reason: '   ' }),
    ).toMatchObject({
      phase: 'inactive',
      closedBanner: 'Realtime closed',
      errorBanner: null,
    })
    expect(
      reduceRealtimeTuiState(state, { type: 'closed', reason: null }),
    ).toMatchObject({
      closedBanner: 'Realtime closed',
    })
  })

  test('handles push-to-talk release and peak meter edge cases', () => {
    let state = reduceRealtimeTuiState(initialRealtimeTuiState(), {
      type: 'push_to_talk_held_changed',
      held: true,
    })
    expect(state.pushToTalkHeld).toBe(false)

    state = reduceRealtimeTuiState(state, {
      type: 'push_to_talk_changed',
      enabled: true,
    })
    state = reduceRealtimeTuiState(state, {
      type: 'push_to_talk_held_changed',
      held: true,
    })
    expect(effectiveRealtimeMicrophoneMuted(state)).toBe(false)

    state = reduceRealtimeTuiState(state, {
      type: 'push_to_talk_changed',
      enabled: false,
    })
    expect(state.pushToTalkHeld).toBe(false)
    expect(effectiveRealtimeMicrophoneMuted(state)).toBe(false)

    expect(normalizeRealtimePeak(Number.NaN)).toBe(0)
    expect(normalizeRealtimePeak(Number.POSITIVE_INFINITY)).toBe(0)
    expect(normalizeRealtimePeak(-1)).toBe(0)
    expect(normalizeRealtimePeak(65_535.6)).toBe(65_535)
    expect(normalizeRealtimePeak(12.6)).toBe(13)
    expect(realtimeLevelBar(-5, 0)).toBe('-')
    expect(realtimeLevelBar(65_535, 2.9)).toBe('##')
  })

  test('summarizes realtime items across primitive, typed, and truncated objects', () => {
    expect(formatRealtimeItemSummary(null)).toBe('null')
    expect(formatRealtimeItemSummary(true)).toBe('true')
    expect(formatRealtimeItemSummary(42)).toBe('42')
    expect(formatRealtimeItemSummary(['a', 'b', 'c'])).toBe('array(3)')
    expect(
      formatRealtimeItemSummary({ type: 'response', itemId: 'item_1' }),
    ).toBe('response item_1')
    expect(formatRealtimeItemSummary({ type: 'response' })).toBe('response')
    expect(formatRealtimeItemSummary({ type: 7, text: 'plain' })).toBe(
      '{"type":7,"text":"plain"}',
    )

    const longSummary = formatRealtimeItemSummary({
      payload: 'x'.repeat(120),
    })
    expect(longSummary).toHaveLength(96)
    expect(longSummary.endsWith('...')).toBe(true)
  })
})
