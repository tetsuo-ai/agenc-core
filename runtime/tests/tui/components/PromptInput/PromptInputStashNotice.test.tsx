import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { PromptInputStashNotice } from './PromptInputStashNotice.js'

function RerenderStashNotice() {
  const [tick, setTick] = React.useState(0)

  React.useLayoutEffect(() => {
    if (tick === 0) {
      setTick(1)
    }
  }, [tick])

  return <PromptInputStashNotice hasStash />
}

describe('PromptInputStashNotice', () => {
  test('renders no notice when there is no stashed prompt', async () => {
    const output = await renderToString(
      <PromptInputStashNotice hasStash={false} />,
      80,
    )

    expect(output).not.toContain('Stashed')
  })

  test('renders the stashed prompt notice and reuses compiled cache', async () => {
    const output = await renderToString(<RerenderStashNotice />, 80)

    expect(output).toContain('Stashed')
    expect(output).toContain('auto-restores after submit')
  })
})
