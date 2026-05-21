import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { Text } from '../../ink.js'
import {
  MenuModal,
  ModeSwitcher,
  PlanList,
  SlashPalette,
  StatusSegment,
  TerminalFrame,
  WelcomeColdPanel,
} from './primitives.js'

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

  it('keeps welcome command labels separated from surrounding text', async () => {
    const output = await renderToString(<WelcomeColdPanel />, { columns: 120, rows: 24 })

    expect(output).toContain('type /help for commands ·  /claim to pick a task off the marketplace')
    expect(output).not.toContain('/helpfor')
    expect(output).not.toContain('/claimto')
  })

  it('uses AURA lifecycle glyphs for plan rows', async () => {
    const output = await renderToString(
      <PlanList
        items={[
          { state: 'done', text: 'read repo state' },
          { state: 'active', text: 'apply focused patch' },
          { state: 'pending', text: 'run verification' },
          { state: 'failed', text: 'surface blocker' },
        ]}
      />,
      96,
    )

    expect(output).toContain('01 ● read repo state')
    expect(output).toContain('02 ▮ apply focused patch')
    expect(output).toContain('03 ○ run verification')
    expect(output).toContain('04 ✕ surface blocker')
    expect(output).not.toContain('✓ read repo state')
    expect(output).not.toContain('· run verification')
  })

  it('windows long menus to the active row and exposes scroll position', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      status: 'available',
      name: `item-${String(index).padStart(2, '0')}`,
      detail: `detail-${index}`,
    }))

    const output = await renderToString(
      <MenuModal
        title="skills"
        count={`${rows.length}`}
        columns={[12, 12, 20]}
        headers={['status', 'name', 'detail']}
        items={rows}
        activeIndex={18}
        footer={[{ keyName: 'up/down', label: 'navigate' }]}
        renderRow={row => [
          <Text key="status">{row.status}</Text>,
          <Text key="name">{row.name}</Text>,
          <Text key="detail">{row.detail}</Text>,
        ]}
      />,
      { columns: 100, rows: 12 },
    )

    expect(output).toContain('item-18')
    expect(output).toContain('scroll 16-22/30')
    expect(output).not.toContain('item-00')
    expect(output).not.toContain('item-29')
  })
})
