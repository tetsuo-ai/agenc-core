import { describe, expect, it } from 'vitest'

import { getPreviewQuestionNotesInputColumns } from './PreviewQuestionView.js'

describe('getPreviewQuestionNotesInputColumns', () => {
  it('clamps notes input width to the available preview panel width', () => {
    expect(getPreviewQuestionNotesInputColumns(Number.NaN)).toBe(1)
    expect(getPreviewQuestionNotesInputColumns(0)).toBe(1)
    expect(getPreviewQuestionNotesInputColumns(4)).toBe(1)
    expect(getPreviewQuestionNotesInputColumns(12)).toBe(4)
    expect(getPreviewQuestionNotesInputColumns(60.9)).toBe(52)
  })
})
