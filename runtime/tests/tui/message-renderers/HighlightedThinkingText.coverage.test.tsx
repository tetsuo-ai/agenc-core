import figures from 'figures'
import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { MessageActionsSelectedContext } from '../components/messageActions.js'
import { QueuedMessageProvider } from '../context/QueuedMessageContext.js'
import { HighlightedThinkingText } from './HighlightedThinkingText.js'

const thinkingMock = vi.hoisted(() => ({
  findThinkingTriggerPositions: vi.fn((text: string) => {
    const start = text.toLowerCase().indexOf('ultrathink')
    if (start === -1) return []
    return [{ word: text.slice(start, start + 10), start, end: start + 10 }]
  }),
  getRainbowColor: vi.fn(() => 'suggestion'),
  isUltrathinkEnabled: vi.fn(() => true),
}))

const timestampMock = vi.hoisted(() => ({
  formatBriefTimestamp: vi.fn(() => '12:34 PM'),
}))

vi.mock('../../utils/thinking.js', () => thinkingMock)
vi.mock('../../utils/formatBriefTimestamp.js', () => timestampMock)

describe('HighlightedThinkingText coverage', () => {
  test('renders pointer, thinking highlight pieces, and brief queued layout', async () => {
    const highlighted = await renderToString(
      <MessageActionsSelectedContext.Provider value={true}>
        <HighlightedThinkingText text="please ultrathink now" />
      </MessageActionsSelectedContext.Provider>,
      80,
    )

    expect(highlighted).toContain(`${figures.pointer} please ultrathink now`)
    expect(thinkingMock.findThinkingTriggerPositions).toHaveBeenCalledWith(
      'please ultrathink now',
    )
    expect(thinkingMock.getRainbowColor).toHaveBeenCalledTimes(10)
    expect(thinkingMock.getRainbowColor.mock.calls.map(([index]) => index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])

    const plainWithoutPointer = await renderToString(
      <HighlightedThinkingText text="plain prompt" showPointer={false} />,
      80,
    )

    expect(plainWithoutPointer.trim()).toBe('plain prompt')

    const brief = await renderToString(
      <QueuedMessageProvider isFirst={true} useBriefLayout={true}>
        <HighlightedThinkingText
          text="queued prompt"
          timestamp="2026-05-20T18:34:00.000Z"
          useBriefLayout={true}
        />
      </QueuedMessageProvider>,
      80,
    )

    expect(brief).toContain('You 12:34 PM')
    expect(brief).toContain('queued prompt')
    expect(brief).not.toContain(figures.pointer)
    expect(timestampMock.formatBriefTimestamp).toHaveBeenCalledWith(
      '2026-05-20T18:34:00.000Z',
    )
  })
})
