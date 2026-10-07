import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { VERSION } from '../../../../src/version.js'
import { WelcomeColdPanel } from './primitives.js'

// The welcome carries only the name, the version and one line of keys. The
// folder, model and mode live in the status line under the prompt, so the
// welcome must not repeat them or fall back to placeholders.
describe('WelcomeColdPanel facts', () => {
  it('shows the name, the version and the keys once', async () => {
    const output = await renderToString(<WelcomeColdPanel />, {
      columns: 120,
      rows: 24,
    })

    expect(output).toContain('agenc')
    expect(output).toContain(VERSION)
    expect(output.split('/ commands')).toHaveLength(2)
    expect(output).toContain('@ attach files')
    expect(output).toContain('shift+tab change mode')
    expect(output).toContain('? shortcuts')
  })

  it('repeats no status fact and shows no placeholders', async () => {
    const output = await renderToString(<WelcomeColdPanel />, {
      columns: 120,
      rows: 24,
    })

    expect(output).not.toContain('model')
    expect(output).not.toContain('workspace')
    expect(output).not.toContain('START HERE')
    expect(output).not.toContain('—')
  })
})
