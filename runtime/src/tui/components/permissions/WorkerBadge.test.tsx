import React from 'react'
import { afterEach, describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { PermissionRequestTitle } from './PermissionRequestTitle.js'
import { WorkerBadge } from './WorkerBadge.js'

const originalGlyphMode = process.env.AGENC_TUI_GLYPHS

afterEach(() => {
  if (originalGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = originalGlyphMode
  }
})

describe('permission worker identity glyphs', () => {
  test('renders worker badge status dot with ASCII fallback', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const output = await renderToString(
      <WorkerBadge name="build-agent" color="permission" />,
      80,
    )

    expect(output).toContain('* @build-agent')
    expect(output).not.toContain('●')
  })

  test('renders permission title worker separator with ASCII fallback', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const output = await renderToString(
      <PermissionRequestTitle
        title="Allow tool?"
        workerBadge={{ name: 'build-agent', color: 'permission' }}
      />,
      80,
    )

    expect(output).toContain('Allow tool?')
    expect(output).toContain('- @build-agent')
    expect(output).not.toContain('·')
  })
})
