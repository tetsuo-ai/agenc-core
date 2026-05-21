import { describe, expect, test, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../../src/tui/keybindings/parser.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../src/tui/keybindings/parser.js')>()

  return {
    ...actual,
    parseKeystroke: (input: string) => {
      if (input === 'mock-empty') {
        return {
          alt: false,
          ctrl: false,
          key: '',
          meta: false,
          shift: false,
          super: false,
        }
      }

      return actual.parseKeystroke(input)
    },
  }
})

import type {
  KeybindingBlock,
  ParsedBinding,
} from '../../../src/tui/keybindings/types.js'
import {
  checkDuplicateKeysInJson,
  checkDuplicates,
  checkReservedShortcuts,
  formatWarnings,
  validateBindings,
  validateUserConfig,
} from '../../../src/tui/keybindings/validate.js'

describe('keybinding validate coverage swarm row 126', () => {
  test('reports parser failures when a keystroke produces no key or modifiers', () => {
    const warnings = validateUserConfig([
      {
        context: 'Chat',
        bindings: {
          'mock-empty': 'chat:submit',
        },
      },
    ])

    expect(warnings).toEqual([
      expect.objectContaining({
        context: 'Chat',
        key: 'mock-empty',
        message: 'Could not parse keystroke "mock-empty"',
        severity: 'error',
        type: 'parse_error',
      }),
    ])
  })

  test('accepts null unbinds and valid chat command bindings', () => {
    expect(
      validateUserConfig([
        {
          context: 'Chat',
          bindings: {
            'ctrl+y': null,
            'meta+r': 'command:run_task-1',
          },
        },
      ]),
    ).toEqual([])
  })

  test('handles empty duplicate-json blocks and missing context names', () => {
    const warnings = checkDuplicateKeysInJson(`[
      {
        "bindings": {}
      },
      {
        "bindings": {
          "ctrl+x": "chat:cancel",
          "ctrl+x": "chat:submit",
          "ctrl+x": "chat:newline"
        }
      },
      {
        "context": "Chat",
        "bindings": {
          "enter": "chat:submit"
        }
      },
      {
        "context": "Chat",
        "bindings": {
          "enter": "chat:newline"
        }
      }
    ]`)

    expect(warnings).toEqual([
      expect.objectContaining({
        context: 'unknown',
        key: 'ctrl+x',
        message: 'Duplicate key "ctrl+x" in unknown bindings',
        severity: 'warning',
        type: 'duplicate',
      }),
    ])
  })

  test('describes null unbinds when normalized duplicates conflict', () => {
    const blocks: KeybindingBlock[] = [
      {
        context: 'Chat',
        bindings: {
          'ctrl+z': 'chat:cancel',
          'control+z': null,
        },
      },
    ]

    expect(checkDuplicates(blocks)).toEqual([
      expect.objectContaining({
        action: 'null (unbind)',
        context: 'Chat',
        key: 'control+z',
        suggestion:
          'Previously bound to "chat:cancel". Only the last binding will be used.',
        type: 'duplicate',
      }),
    ])
  })

  test('preserves null action metadata on reserved shortcut warnings', () => {
    const warnings = checkReservedShortcuts([
      {
        action: null,
        chord: [
          {
            alt: false,
            ctrl: true,
            key: 'm',
            meta: false,
            shift: false,
            super: false,
          },
        ],
        context: 'Chat',
      },
    ] as ParsedBinding[])

    expect(warnings).toEqual([
      expect.objectContaining({
        action: undefined,
        context: 'Chat',
        key: 'ctrl+m',
        severity: 'error',
        type: 'reserved',
      }),
    ])
  })

  test('skips duplicate and reserved checks for structurally invalid config', () => {
    const warnings = validateBindings(
      [
        {
          context: 'Chat',
          bindings: null,
        },
      ],
      [],
    )

    expect(warnings).toEqual([
      expect.objectContaining({
        message: 'Keybinding block 1 missing "bindings" field',
        type: 'parse_error',
      }),
    ])
  })

  test('pluralizes all-error and all-warning batches', () => {
    expect(
      formatWarnings([
        {
          message: 'Bad key one',
          severity: 'error',
          type: 'parse_error',
        },
        {
          message: 'Bad key two',
          severity: 'error',
          type: 'invalid_context',
        },
      ]),
    ).toBe(
      [
        'Found 2 keybinding errors:',
        '✗ Keybinding error: Bad key one',
        '✗ Keybinding error: Bad key two',
      ].join('\n'),
    )

    expect(
      formatWarnings([
        {
          message: 'Risky key one',
          severity: 'warning',
          type: 'reserved',
        },
        {
          message: 'Risky key two',
          severity: 'warning',
          type: 'duplicate',
        },
      ]),
    ).toBe(
      [
        'Found 2 keybinding warnings:',
        '! Keybinding warning: Risky key one',
        '! Keybinding warning: Risky key two',
      ].join('\n'),
    )
  })
})
