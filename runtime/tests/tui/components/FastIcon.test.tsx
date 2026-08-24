import React from 'react'
import { describe, expect, test } from 'vitest'

import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { renderToString } from '../../utils/staticRender.js'
import { FastIcon } from './FastIcon.js'

function RerenderFastIcon({ cooldown }: { cooldown?: boolean }) {
  const [tick, setTick] = React.useState(0)

  React.useLayoutEffect(() => {
    if (tick === 0) {
      setTick(1)
    }
  }, [tick])

  return <FastIcon cooldown={cooldown} />
}

describe('FastIcon', () => {
  test('renders active and cooldown fast icons', async () => {
    await expect(
      renderToString(<RerenderFastIcon cooldown={false} />, 20),
    ).resolves.toContain(LIGHTNING_BOLT)
    await expect(
      renderToString(<RerenderFastIcon cooldown />, 20),
    ).resolves.toContain(LIGHTNING_BOLT)
  })
})
