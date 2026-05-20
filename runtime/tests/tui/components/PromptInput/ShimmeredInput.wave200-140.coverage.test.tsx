import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { HighlightedInput } from './ShimmeredInput.js'

describe('HighlightedInput coverage', () => {
  test('renders plain, highlighted, shimmered, and empty input lines', async () => {
    const output = await renderToString(
      <HighlightedInput
        text={'ask\n\nreview now'}
        highlights={[
          {
            start: 0,
            end: 3,
            color: 'success',
            priority: 1,
          },
          {
            start: 5,
            end: 11,
            color: 'warning',
            shimmerColor: 'warningShimmer',
            priority: 2,
          },
        ]}
      />,
      40,
    )

    expect(output).toContain('ask')
    expect(output).toContain('review now')
    expect(output.split('\n')).toEqual(['ask', '', 'review now'])
  })
})
