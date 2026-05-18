import { describe, expect, test, vi } from 'vitest'

import {
  computeTeammateActivityMaxWidth,
  computeTeammatePreviewTextWidth,
  getMessagePreview,
} from './TeammateSpinnerLine.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

describe('TeammateSpinnerLine layout helpers', () => {
  test('does not force a minimum activity width in tiny terminals', () => {
    expect(computeTeammateActivityMaxWidth(20, 8, 0, 0)).toBe(11)
    expect(computeTeammateActivityMaxWidth(8, 8, 0, 0)).toBe(0)
  })

  test('sizes preview text from the current terminal width', () => {
    expect(computeTeammatePreviewTextWidth(30)).toBe(22)
    expect(computeTeammatePreviewTextWidth(7)).toBe(0)
  })

  test('clamps teammate previews to the supplied row budget', () => {
    const messages = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'short\nabcdefghijklmnopqrstuvwxyz',
            },
          ],
        },
      },
    ] as never

    expect(getMessagePreview(messages, 12)).toEqual([
      'short',
      'abcdefghijk…',
    ])
    expect(getMessagePreview(messages, 0)).toEqual([])
  })
})
