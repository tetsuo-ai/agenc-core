import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { renderToString } from '../../utils/staticRender.js'
import { FastIcon, getFastIconString } from './FastIcon.js'

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => ({ theme: 'dark' }),
}))

vi.mock('../../utils/systemTheme.js', () => ({
  resolveThemeSetting: (theme: string) => theme,
}))

vi.mock('./design-system/color', () => ({
  color: (name: string, themeName: string) => (text: string) =>
    `${name}:${themeName}:${text}`,
}))

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

  test('returns plain and themed fast icon strings', () => {
    expect(getFastIconString(false)).toBe(LIGHTNING_BOLT)
    expect(getFastIconString(true, false)).toContain(
      `fastMode:dark:${LIGHTNING_BOLT}`,
    )
    expect(getFastIconString(true, true)).toContain(
      `promptBorder:dark:${LIGHTNING_BOLT}`,
    )
  })
})
