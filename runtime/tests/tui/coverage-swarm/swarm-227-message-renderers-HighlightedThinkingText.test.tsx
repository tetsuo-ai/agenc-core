import figures from 'figures'
import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../src/utils/staticRender.js'
import { HighlightedThinkingText } from '../../../src/tui/message-renderers/HighlightedThinkingText.js'

const thinkingMock = vi.hoisted(() => ({
  findThinkingTriggerPositions: vi.fn(() => []),
  getRainbowColor: vi.fn(() => 'suggestion'),
  isUltrathinkEnabled: vi.fn(() => true),
}))

const timestampMock = vi.hoisted(() => ({
  formatBriefTimestamp: vi.fn(() => '9:41 AM'),
}))

vi.mock('../../../src/utils/thinking.js', () => thinkingMock)
vi.mock('../../../src/utils/formatBriefTimestamp.js', () => timestampMock)

afterEach(() => {
  vi.clearAllMocks()
  thinkingMock.findThinkingTriggerPositions.mockReturnValue([])
  thinkingMock.getRainbowColor.mockReturnValue('suggestion')
  thinkingMock.isUltrathinkEnabled.mockReturnValue(true)
})

describe('HighlightedThinkingText swarm-227 coverage', () => {
  test('skips trigger lookup and rainbow coloring when ultrathink highlighting is disabled', async () => {
    thinkingMock.isUltrathinkEnabled.mockReturnValue(false)

    const output = await renderToString(
      <HighlightedThinkingText
        text="please ultrathink later"
        showPointer={false}
      />,
      80,
    )

    expect(output.trim()).toBe('please ultrathink later')
    expect(thinkingMock.findThinkingTriggerPositions).not.toHaveBeenCalled()
    expect(thinkingMock.getRainbowColor).not.toHaveBeenCalled()
  })

  test('renders a full-string thinking trigger without plain leading or trailing spans', async () => {
    thinkingMock.findThinkingTriggerPositions.mockReturnValue([
      { word: 'ultra', start: 0, end: 5 },
    ])

    const output = await renderToString(
      <HighlightedThinkingText text="ultra" showPointer={false} />,
      80,
    )

    expect(output.trim()).toBe('ultra')
    expect(thinkingMock.getRainbowColor.mock.calls.map(([index]) => index)).toEqual([
      0, 1, 2, 3, 4,
    ])
  })

  test('renders non-queued brief layout without timestamp formatting', async () => {
    const output = await renderToString(
      <HighlightedThinkingText
        text="brief prompt"
        useBriefLayout={true}
      />,
      { columns: 80, rows: 6 },
    )

    expect(output).toContain('You')
    expect(output).toContain('brief prompt')
    expect(output).not.toContain(figures.pointer)
    expect(timestampMock.formatBriefTimestamp).not.toHaveBeenCalled()
    expect(thinkingMock.findThinkingTriggerPositions).not.toHaveBeenCalled()
  })
})
