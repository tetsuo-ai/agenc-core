import { describe, expect, test } from 'vitest'

import { isNullRenderingAttachment } from './message-visibility.js'

describe('isNullRenderingAttachment', () => {
  test('matches attachment messages with null-rendering attachment types', () => {
    expect(
      isNullRenderingAttachment({
        type: 'attachment',
        attachment: {
          type: 'hook_success',
        },
      } as never),
    ).toBe(true)
    expect(
      isNullRenderingAttachment({
        type: 'attachment',
        attachment: {
          type: 'date_change',
        },
      } as never),
    ).toBe(true)
  })

  test('rejects visible attachments and non-attachment messages', () => {
    expect(
      isNullRenderingAttachment({
        type: 'attachment',
        attachment: {
          type: 'image',
        },
      } as never),
    ).toBe(false)
    expect(
      isNullRenderingAttachment({
        type: 'assistant',
        message: {
          content: [],
        },
      } as never),
    ).toBe(false)
  })
})
