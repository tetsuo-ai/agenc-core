import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { WelcomeColdPanel } from './primitives.js'

// Regression for "welcome-model": the TUI welcome/home box used to show the
// literal placeholder "default model" because its sole render site
// (LogoHeader in Messages.tsx) passed no `model` prop, so WelcomeColdPanel
// fell back to its `model = 'default model'` default. The fix resolves the
// effective model via useMainLoopModel in LogoHeader and threads it through
// as the `model` prop. These tests pin that the panel actually surfaces an
// explicit model and still keeps the placeholder default for fixtures.
describe('WelcomeColdPanel model row', () => {
  it('renders an explicitly provided model instead of the placeholder', async () => {
    const output = await renderToString(
      <WelcomeColdPanel model="grok-build-0.1" />,
      { columns: 120, rows: 24 },
    )

    expect(output).toContain('model')
    expect(output).toContain('grok-build-0.1')
    expect(output).not.toContain('default model')
  })

  it('keeps the placeholder default for fixtures when no model is provided', async () => {
    const output = await renderToString(<WelcomeColdPanel />, {
      columns: 120,
      rows: 24,
    })

    expect(output).toContain('default model')
  })
})
