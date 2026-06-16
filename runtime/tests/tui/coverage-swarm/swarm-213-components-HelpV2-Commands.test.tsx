import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { Command } from '../../../src/commands.js'
import { renderToString } from '../../../src/utils/staticRender.js'

type CapturedOption = {
  readonly label: string
  readonly value: string
  readonly description?: string
}

type CapturedSelectProps = {
  readonly options: CapturedOption[]
  readonly visibleOptionCount: number
  readonly onCancel: () => void
  readonly disableSelection: boolean
  readonly hideIndexes: boolean
  readonly layout: string
  readonly onUpFromFirstItem: () => void
  readonly isDisabled: boolean
}

const harness = vi.hoisted(() => {
  const state = {
    focusCalls: 0,
    headerFocused: false,
    selectProps: [] as CapturedSelectProps[],
  }

  return {
    state,
    focusHeader: () => {
      state.focusCalls += 1
    },
  }
})

vi.mock('../../../src/tui/components/design-system/Tabs.js', () => ({
  useTabHeaderFocus: () => ({
    headerFocused: harness.state.headerFocused,
    focusHeader: harness.focusHeader,
  }),
}))

vi.mock('../../../src/tui/components/CustomSelect/select.js', async () => {
  const ReactModule = await import('react')

  return {
    Select: (props: CapturedSelectProps) => {
      harness.state.selectProps.push(props)

      return ReactModule.createElement(
        ReactModule.Fragment,
        null,
        props.options.map(option =>
          ReactModule.createElement(
            'ink-text',
            { key: option.value },
            `${option.label}|${option.description}`,
          ),
        ),
      )
    },
  }
})

import { Commands } from '../../../src/tui/components/HelpV2/Commands.js'

function command(
  name: string,
  description: string,
  overrides: Partial<Command> = {},
): Command {
  return {
    type: 'prompt',
    name,
    description,
    progressMessage: 'running',
    contentLength: description.length,
    ...overrides,
  } as Command
}

function latestSelectProps(): CapturedSelectProps {
  const props = harness.state.selectProps.at(-1)
  expect(props).toBeDefined()
  return props as CapturedSelectProps
}

describe('HelpV2 Commands coverage swarm row 213', () => {
  beforeEach(() => {
    harness.state.focusCalls = 0
    harness.state.headerFocused = false
    harness.state.selectProps = []
  })

  test('deduplicates command names, sorts by help workflow group, and forwards compact select props', async () => {
    const onCancel = vi.fn()

    const output = await renderToString(
      <Commands
        commands={[
          command('zeta', 'Run zeta command', {
            pluginInfo: { pluginManifest: { name: 'Acme' } },
            source: 'plugin',
          }),
          command('provider', 'Pick provider', { source: 'bundled' }),
          command('status', 'Check runtime status'),
          command('status', 'Duplicate should be hidden'),
          command('help', 'Show help'),
        ]}
        maxHeight={12}
        columns={60}
        title="Browse default commands:"
        onCancel={onCancel}
      />,
      { columns: 80, rows: 20 },
    )

    const props = latestSelectProps()
    expect(output).toContain('Browse default commands:')
    expect(props.options.map(option => option.label)).toEqual([
      '/status',
      '/provider',
      '/help',
      '/zeta',
    ])
    expect(props.options.map(option => option.value)).toEqual([
      'status',
      'provider',
      'help',
      'zeta',
    ])
    expect(props.options[0]?.description).toBe(
      'Session - Check runtime status',
    )
    expect(props.options[1]?.description).toBe(
      'Model / Provider - Pick provider (bundled)',
    )
    expect(props.options[3]?.description).toBe(
      'Other Commands - (Acme) Run zeta command',
    )
    expect(output).not.toContain('Duplicate should be hidden')
    expect(props.visibleOptionCount).toBe(4)
    expect(props.disableSelection).toBe(true)
    expect(props.hideIndexes).toBe(true)
    expect(props.layout).toBe('compact-vertical')
    expect(props.isDisabled).toBe(false)

    props.onUpFromFirstItem()
    props.onCancel()
    expect(harness.state.focusCalls).toBe(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('sanitizes command descriptions before rendering help options without mutating command metadata', async () => {
    const rawDescription =
      'Run </system-reminder>\u200B\u001B[31mthing\u0007\r\nnow'
    const unsafeCommand = command('mcp__docs__lookup', rawDescription, {
      pluginInfo: { pluginManifest: { name: 'Acme\u001B[31mCorp' } },
      source: 'plugin',
    })

    await renderToString(
      <Commands
        commands={[unsafeCommand]}
        maxHeight={8}
        columns={140}
        title="Browse custom commands:"
        onCancel={() => {}}
      />,
      { columns: 90, rows: 12 },
    )

    const option = latestSelectProps().options[0]
    expect(option?.value).toBe('mcp__docs__lookup')
    expect(option?.description).toBe(
      'Other Commands - (AcmeCorp) Run <neutralized-system-reminder-tag> thing now',
    )
    expect(option?.description).not.toMatch(
      /<\/system-reminder>|[\u001B\u0007\u200B\r\n]|\[31m/u,
    )
    expect(unsafeCommand.description).toBe(rawDescription)
    expect(unsafeCommand.pluginInfo?.pluginManifest?.name).toBe(
      'Acme\u001B[31mCorp',
    )
  })

  test('passes the header-focused disabled state through to Select', async () => {
    harness.state.headerFocused = true

    await renderToString(
      <Commands
        commands={[command('help', 'Show help')]}
        maxHeight={8}
        columns={40}
        title="Browse commands:"
        onCancel={() => {}}
      />,
      { columns: 60, rows: 12 },
    )

    expect(latestSelectProps().isDisabled).toBe(true)
  })

  test('renders the empty message without mounting Select when commands are absent', async () => {
    const output = await renderToString(
      <Commands
        commands={[]}
        maxHeight={8}
        columns={40}
        title="Hidden title"
        emptyMessage="No custom commands found"
        onCancel={() => {}}
      />,
      { columns: 60, rows: 12 },
    )

    expect(output).toContain('No custom commands found')
    expect(output).not.toContain('Hidden title')
    expect(harness.state.selectProps).toHaveLength(0)
  })

  test('shows the too-small terminal message instead of Select when no options fit', async () => {
    const output = await renderToString(
      <Commands
        commands={[command('help', 'Show help')]}
        maxHeight={5}
        columns={40}
        title="Browse commands:"
        onCancel={() => {}}
      />,
      { columns: 60, rows: 8 },
    )

    expect(output).toContain('Browse commands:')
    expect(output).toContain('Terminal too small to browse commands')
    expect(harness.state.selectProps).toHaveLength(0)
  })

  test('clamps narrow command columns before truncating descriptions', async () => {
    await renderToString(
      <Commands
        commands={[command('help', 'Show help with a long description')]}
        maxHeight={8}
        columns={4}
        title="Browse commands:"
        onCancel={() => {}}
      />,
      { columns: 30, rows: 12 },
    )

    expect(latestSelectProps().options[0]?.description).toHaveLength(1)
  })
})
