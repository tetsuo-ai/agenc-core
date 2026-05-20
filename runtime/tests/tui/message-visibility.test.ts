import { describe, expect, test } from 'vitest'

import { isNullRenderingAttachment } from './message-visibility.js'

describe('isNullRenderingAttachment', () => {
  test('recognizes attachment types that do not render a TUI row', () => {
    expect(
      isNullRenderingAttachment({
        attachment: { type: 'hook_success' },
        type: 'attachment',
      }),
    ).toBe(true)
  })

  test('rejects visible attachment types', () => {
    expect(
      isNullRenderingAttachment({
        attachment: { type: 'image' },
        type: 'attachment',
      }),
    ).toBe(false)
  })

  test('rejects non-attachment messages without reading attachment data', () => {
    expect(isNullRenderingAttachment({ type: 'assistant' })).toBe(false)
  })
})
