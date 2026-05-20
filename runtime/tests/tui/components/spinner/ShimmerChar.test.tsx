import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { ShimmerChar } from './ShimmerChar.js'

function RerenderShimmerChar() {
  const [tick, setTick] = React.useState(0)

  React.useLayoutEffect(() => {
    if (tick === 0) {
      setTick(1)
    }
  }, [tick])

  return (
    <ShimmerChar
      char="C"
      index={3}
      glimmerIndex={3}
      messageColor="text"
      shimmerColor="success"
    />
  )
}

describe('ShimmerChar', () => {
  test('renders highlighted, adjacent, and normal characters', async () => {
    await expect(renderToString(<RerenderShimmerChar />, 20)).resolves.toContain(
      'C',
    )

    await expect(
      renderToString(
        <ShimmerChar
          char="B"
          index={2}
          glimmerIndex={3}
          messageColor="text"
          shimmerColor="success"
        />,
        20,
      ),
    ).resolves.toContain('B')

    await expect(
      renderToString(
        <ShimmerChar
          char="A"
          index={0}
          glimmerIndex={3}
          messageColor="text"
          shimmerColor="success"
        />,
        20,
      ),
    ).resolves.toContain('A')
  })
})
