import { describe, expect, test, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: () => ({}),
  saveGlobalConfig: () => {},
}))

vi.mock('../../../utils/env.js', () => ({
  env: {
    isSSH: () => false,
    terminal: undefined,
  },
}))

import { getNextPasteIdAfter } from './PromptInput.js'

describe('PromptInput helper behavior', () => {
  test('allocates after paste ids in current input, saved contents, and array-form messages', () => {
    expect(
      getNextPasteIdAfter(
        [
          {
            type: 'assistant',
            message: { content: 'ignored [Image #99]' },
          },
          {
            type: 'user',
            imagePasteIds: [3],
            message: {
              content: [
                { type: 'text', text: 'array [Pasted text #8]' },
                { type: 'image', source: { type: 'base64', data: 'ignored' } },
              ],
            },
          },
        ],
        {
          9: { id: 4, type: 'image', content: 'base64' },
          bad: { id: 10, type: 'text', content: 'stored' },
        },
        'draft [Image #6]',
      ),
    ).toBe(11)
  })

  test('allocates after paste references in string-form resumed messages', () => {
    expect(
      getNextPasteIdAfter([
        {
          type: 'user',
          message: {
            content: 'previous [Image #7] and [Pasted text #11 +3 lines]',
          },
        },
      ]),
    ).toBe(12)
  })
})
