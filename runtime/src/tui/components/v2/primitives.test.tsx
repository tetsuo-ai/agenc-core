import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { ModeSwitcher } from './primitives.js'

describe('v2 primitives', () => {
  it('renders the runtime-bound mode switcher state with the current mode selected', async () => {
    const output = await renderToString(
      <ModeSwitcher
        currentMode="plan"
        bypassAvailable={true}
        autoAvailable={true}
      />,
      96,
    )

    expect(output).toContain('MODE SWITCHER')
    expect(output).toContain('default')
    expect(output).toContain('accept edits')
    expect(output).toContain('plan')
    expect(output).toContain('auto')
    expect(output).toContain('bypass perms')
    expect(output).toContain('read-only planning before execution')
    expect(output).toContain('shift+tab')
  })

  it('hides unavailable cycle targets', async () => {
    const output = await renderToString(
      <ModeSwitcher
        currentMode="acceptEdits"
        bypassAvailable={false}
        autoAvailable={false}
      />,
      96,
    )

    expect(output).toContain('accept edits')
    expect(output).not.toContain('run low-risk work automatically')
    expect(output).not.toContain('bypass perms')
  })
})
