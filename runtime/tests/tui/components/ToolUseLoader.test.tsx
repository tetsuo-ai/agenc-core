import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { ToolUseLoader } from './ToolUseLoader.js'

function RerenderLoader() {
  const [tick, setTick] = React.useState(0)

  React.useLayoutEffect(() => {
    if (tick === 0) {
      setTick(1)
    }
  }, [tick])

  return <ToolUseLoader isError={false} isUnresolved={false} shouldAnimate={false} />
}

describe('ToolUseLoader', () => {
  test('renders pending, failed, and successful glyphs', async () => {
    await expect(
      renderToString(
        <ToolUseLoader isError={false} isUnresolved shouldAnimate />,
        20,
      ),
    ).resolves.toContain('◐')

    await expect(
      renderToString(
        <ToolUseLoader isError isUnresolved={false} shouldAnimate={false} />,
        20,
      ),
    ).resolves.toContain('✕')

    await expect(
      renderToString(
        <ToolUseLoader isError isUnresolved shouldAnimate />,
        20,
      ),
    ).resolves.toContain('✕')

    await expect(renderToString(<RerenderLoader />, 20)).resolves.toContain('●')
  })
})
