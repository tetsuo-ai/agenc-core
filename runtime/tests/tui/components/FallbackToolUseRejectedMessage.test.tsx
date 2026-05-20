import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { FallbackToolUseRejectedMessage } from './FallbackToolUseRejectedMessage.js'

function RerenderFallbackToolUseRejectedMessage() {
  const [tick, setTick] = React.useState(0)

  React.useLayoutEffect(() => {
    if (tick === 0) {
      setTick(1)
    }
  }, [tick])

  return <FallbackToolUseRejectedMessage />
}

describe('FallbackToolUseRejectedMessage', () => {
  test('renders the interrupted-by-user fallback and reuses its compiled cache', async () => {
    const output = await renderToString(
      <RerenderFallbackToolUseRejectedMessage />,
      80,
    )

    expect(output).toContain('Interrupted')
    expect(output).toContain('What should AgenC do instead?')
  })
})
