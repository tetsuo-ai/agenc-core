import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { ModeSwitcher, SlashPalette, StatusSegment, TerminalFrame } from './primitives.js'

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

    expect(output).toContain('permission mode')
    expect(output).toContain('default')
    expect(output).toContain('acceptEdits')
    expect(output).toContain('plan')
    expect(output).toContain('auto')
    expect(output).toContain('bypassPermissions')
    expect(output).toContain('read-only · propose plans')
    expect(output).toContain('bypassPermissions')
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

    expect(output).toContain('acceptEdits')
    expect(output).toContain('auto-accept file edits')
    expect(output).not.toContain('auto-approve everything')
    expect(output).not.toContain('bypassPermissions')
  })

  it('renders body overlays without requiring modal content in chat flow', async () => {
    const output = await renderToString(
      <TerminalFrame
        title="agenc ~ swap-program"
        bodyOverlay={<StatusSegment label="overlay" value="menu modal" color="agenc" />}
        statusLeft={[<StatusSegment key="model" label="model" value="haiku-4.5" />]}
        statusRight={[]}
        columns={96}
        minHeight={24}
      >
        <StatusSegment label="chat" value="prompt only" />
      </TerminalFrame>,
      { columns: 96, rows: 24 },
    )

    expect(output).toContain('CHAT prompt only')
    expect(output).toContain('OVERLAY menu modal')
    expect(output).toContain('MODEL haiku-4.5')
  })

  it('renders slash palettes with filtered command rows', async () => {
    const output = await renderToString(
      <SlashPalette
        activeCommand="/delegate"
        filter="/d"
        items={[
          { command: '/delegate', args: '<agent> <step>', description: 'delegate a step to another agent' },
          { command: '/diff', args: 'core', description: 'show the current working diff' },
        ]}
      />,
      96,
    )

    expect(output).toContain('matches · 2')
    expect(output).toContain('/delegate')
    expect(output).toContain('<agent> <step>')
    expect(output).toContain('/diff')
    expect(output).toContain('show the current working diff')
  })
})
