import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { Box, Text } from '../../ink.js'
import { ProgressBar } from './ProgressBar.js'

function renderDelimitedBar(node: React.ReactNode): Promise<string> {
  return renderToString(
    <Box flexDirection="row">
      <Text>|</Text>
      {node}
      <Text>|</Text>
    </Box>,
    20,
  )
}

describe('ProgressBar wave200-079 coverage', () => {
  test('renders clamped and fractional bar states at fixed width', async () => {
    const empty = await renderDelimitedBar(<ProgressBar ratio={-0.5} width={4} />)
    const partial = await renderDelimitedBar(
      <ProgressBar
        ratio={0.33}
        width={10}
        fillColor="success"
        emptyColor="rate_limit_empty"
      />,
    )
    const nearlyFull = await renderDelimitedBar(
      <ProgressBar ratio={0.95} width={4} />,
    )
    const overFull = await renderDelimitedBar(
      <ProgressBar ratio={1.5} width={4} />,
    )

    expect(empty).toBe('|    |')
    expect(partial).toBe('|███▎      |')
    expect(nearlyFull).toBe('|███▉|')
    expect(overFull).toBe('|████|')
  })
})
