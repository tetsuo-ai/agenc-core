import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { Text } from '../../ink.js'
import { QueuedMessageProvider } from '../../context/QueuedMessageContext.js'
import {
  MenuModal,
  ModeSwitcher,
  Msg,
  PlanList,
  SlashPalette,
  StatusSegment,
  TerminalFrame,
  Tool,
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

  it('renders the AURA cold-start welcome without chain hero state', async () => {
    const output = await renderToString(
      <WelcomeColdPanel
        lastSession="12m ago · clean handoff"
        recentSessions={[
          { keyName: '1', title: 'swap-program', detail: '12m ago · main · clean' },
          { keyName: '2', title: 'runtime coverage', detail: 'yesterday · tests' },
          { keyName: '3', title: 'agent catalog', detail: '3d ago · review' },
        ]}
      />,
      { columns: 120, rows: 24 },
    )

    expect(output).toContain('agenc.')
    expect(output).toContain('a netrunner with hands on every file')
    expect(output).toContain('workspace')
    expect(output).toContain('model')
    expect(output).toContain('last session')
    expect(output).toContain('recent')
    expect(output).toContain('[1] swap-program')
    expect(output).toContain('[2] runtime coverage')
    expect(output).toContain('[3] agent catalog')
    expect(output).not.toContain('STAKE')
    expect(output).not.toContain('18.40')
    expect(output).not.toContain('/claim')
  })

  it('fabricates no session data when the caller has none', async () => {
    // The production caller (Messages.tsx) only passes `model` — with no real
    // recent-session feed the card and the last-session row must not render.
    const output = await renderToString(<WelcomeColdPanel />, { columns: 120, rows: 24 })

    expect(output).toContain('agenc.')
    expect(output).toContain('workspace')
    expect(output).toContain('model')
    expect(output).not.toContain('last session')
    expect(output).not.toContain('recent')
    expect(output).not.toContain('to resume')
    expect(output).not.toContain('swap-program')
    expect(output).not.toContain('12m ago')
  })

  it('tells a new user how to start and that recent sessions resume', async () => {
    const output = await renderToString(
      <WelcomeColdPanel
        recentSessions={[
          { keyName: '1', title: 'swap-program', detail: '12m ago · main · clean' },
          { keyName: '2', title: 'runtime coverage', detail: 'yesterday · tests' },
          { keyName: '3', title: 'agent catalog', detail: '3d ago · review' },
        ]}
      />,
      { columns: 120, rows: 24 },
    )

    // First-action guidance so the cold-start screen says HOW to begin.
    expect(output).toContain('type a task and press')
    expect(output).toContain('/ for commands')
    expect(output).toContain('@ to attach')
    // "? for shortcuts" moved out of this line: the composer footer already
    // shows it, and the welcome screen was saying it twice.
    expect(output).not.toContain('? for shortcuts')
    // Resume affordance on the recent box so the [1]-[3] numbers read as shortcuts.
    expect(output).toContain('press 1-3 to resume')
  })

  it('drops whole hint segments on a narrow pane instead of cutting mid-word', async () => {
    const output = await renderToString(<WelcomeColdPanel />, { columns: 44, rows: 24 })

    // The first segment always survives…
    expect(output).toContain('type a task and press')
    // …and narrower panes lose trailing segments whole: no mid-word ellipsis
    // like "@ to atta…" (the literal regression this guards against).
    expect(output).not.toMatch(/@ to att\S*…/)
  })

  it('omits the resume affordance when there are no recent sessions', async () => {
    const output = await renderToString(
      <WelcomeColdPanel recentSessions={[]} />,
      { columns: 120, rows: 24 },
    )

    expect(output).not.toContain('recent')
    expect(output).not.toContain('to resume')
    // Guidance still helps a brand-new user with no history.
    expect(output).toContain('type a task and press')
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

describe('Msg queued header marker', () => {
  it('shows a quiet "queued" marker (not a clock) for a queued message without a time', async () => {
    const output = await renderToString(
      <QueuedMessageProvider isFirst>
        <Msg role="user" label="you">
          <Text>pending prompt body</Text>
        </Msg>
      </QueuedMessageProvider>,
      { columns: 100, rows: 12 },
    )

    expect(output).toContain('YOU')
    expect(output).toContain('pending prompt body')
    // The neutral marker stands in for the missing per-item enqueue time.
    // (Body text deliberately avoids the word "queued" so this assertion is
    // revert-sensitive to the marker rendering.)
    expect(output).toContain('queued')
    // It must not invent a clock or leak an ISO machine timestamp.
    expect(output).not.toMatch(/\d{1,2}:\d{2}/)
    expect(output).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('shows the provided time (not the queued marker) when a non-queued message has a time', async () => {
    const output = await renderToString(
      <Msg role="user" label="you" time="1:37 AM">
        <Text>live prompt body</Text>
      </Msg>,
      { columns: 100, rows: 12 },
    )

    expect(output).toContain('1:37 AM')
    expect(output).not.toContain('queued')
  })
})

describe('Tool call header paren spacing', () => {
  it('hugs the args with parens — no space on the inside of either paren', async () => {
    const output = await renderToString(
      <Tool kind="edit" label="Write" args="index.html" />,
      { columns: 100, rows: 12 },
    )

    // Industry convention: `Tool(arg)` with the parens hugging the argument.
    // Revert-sensitive: putting the `(`, args, and `)` back as separate
    // children of the gap={1} row re-introduces `( index.html )` and fails
    // both assertions (the negative one most directly).
    expect(output).toContain('(index.html)')
    expect(output).not.toContain('( index.html )')
    // The single space between the bold tool label and the opening paren is
    // still supplied by the row's gap — `Write (index.html)`.
    expect(output).toContain('Write (index.html)')
  })
})

describe('Msg role gutter', () => {
  it('renders a full-height left gutter (no single-row ▮ marker)', async () => {
    const output = await renderToString(
      <Msg role="agenc" label="agenc">
        <Text>body</Text>
      </Msg>,
      { columns: 100, rows: 12 },
    )

    // The role identity is a left border spanning the WHOLE message (header
    // AND body rows), blockquote-style, with exactly one padding space before
    // the label. Revert-sensitive: restoring the ▮ marker fails all three.
    expect(output).toContain('│ AGENC')
    expect(output).toContain('│ body')
    expect(output).not.toContain('▮')
  })

  it('renders the system role with the same gutter treatment', async () => {
    const output = await renderToString(
      <Msg role="system" label="system">
        <Text>body</Text>
      </Msg>,
      { columns: 100, rows: 12 },
    )

    expect(output).toContain('│ SYSTEM')
    expect(output).not.toContain('∙ SYSTEM')
  })
})
