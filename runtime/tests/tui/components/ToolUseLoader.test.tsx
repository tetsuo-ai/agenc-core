import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { toolStarFrames, toolStaticGlyph } from './ToolStateGlyph.js'
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
  // The lifecycle circles (`◐` running, `●` done) were replaced by a star
  // whose points sweep while a tool is in flight; a static render lands on
  // whichever frame the animation starts on, so assert against the frame set.
  test('renders pending, failed, and successful glyphs', async () => {
    const running = await renderToString(
      <ToolUseLoader isError={false} isUnresolved shouldAnimate />,
      20,
    )
    expect(toolStarFrames(false).some((frame) => running.includes(frame))).toBe(
      true,
    )

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

    await expect(renderToString(<RerenderLoader />, 20)).resolves.toContain(
      toolStaticGlyph('done', false),
    )
  })
})
