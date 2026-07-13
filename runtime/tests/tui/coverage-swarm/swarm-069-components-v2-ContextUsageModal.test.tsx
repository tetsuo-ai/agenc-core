import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../../src/utils/staticRender.js'
import { ContextUsageModal } from '../../../src/tui/components/v2/ContextUsageModal.js'

const inputMock = vi.hoisted(() => ({
  handler: undefined as
    | undefined
    | ((input: string, key: Record<string, boolean>) => void),
  options: undefined as undefined | { readonly isActive?: boolean },
}))

vi.mock('../../../src/tui/ink.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/tui/ink.js')>(
    '../../../src/tui/ink.js',
  )
  return {
    ...actual,
    useInput: (
      handler: (input: string, key: Record<string, boolean>) => void,
      options: { readonly isActive?: boolean } = {},
    ) => {
      inputMock.handler = handler
      inputMock.options = options
    },
  }
})

function key(overrides: Record<string, boolean> = {}): Record<string, boolean> {
  return {
    escape: false,
    ...overrides,
  }
}

describe('ContextUsageModal swarm row 069 coverage', () => {
  beforeEach(() => {
    inputMock.handler = undefined
    inputMock.options = undefined
  })

  it('renders derived structured rows for file, system, plan, and auto-compact details', async () => {
    const output = await renderToString(
      <ContextUsageModal
        text={[
          'Context: 180,000 / 200,000 tokens (90% of hard limit)',
          'system: 10,000 tokens',
          'plan: 5,000 tokens',
          'files: 8,402 tokens',
          'tool catalog: 2,000 tokens',
          'auto-compact: disabled (hard limit applies; 20,000 tokens free)',
        ].join('\n')}
        onDone={() => {}}
        active={false}
      />,
      { columns: 140, rows: 40 },
    )

    expect(output).toContain('180,000 / 200,000 tokens')
    expect(output).toContain('auto-compact at 92%')
    expect(output).toContain('SYSTEM')
    expect(output).toContain('10,000')
    // M-TUI-3: the aggregate FILES row remains, but the fabricated per-file rows
    // (lib.rs/pool.rs/math.rs split by magic ratios) were removed.
    expect(output).toContain('FILES')
    expect(output).toContain('8,402')
    expect(output).not.toContain('lib.rs')
    expect(output).not.toContain('pool.rs')
    expect(output).not.toContain('math.rs')
    expect(output).toContain('HISTORY')
    expect(output).toContain('154,598')
    expect(output).toContain('AUTO COMPACT')
    expect(output).toContain('disabled (hard limit applies; 20,000 tokens free)')
  })

  it('clamps over-limit usage and renders compact-at rows without optional detail', async () => {
    const output = await renderToString(
      <ContextUsageModal
        text={[
          'Context: 250,000 / 200,000 tokens (125% of hard limit)',
          'messages: 249,900 tokens',
          'tool catalog: 100 tokens',
          'compaction threshold: 190,000 tokens',
        ].join('\n')}
        onDone={() => {}}
        active={false}
      />,
      120,
    )

    expect(output).toContain('250,000 / 200,000 tokens')
    expect(output).toContain('125% used')
    expect(output).toContain('headroom 0k')
    expect(output).toContain('auto-compact at 95%')
    expect(output).toContain('COMPACT AT')
    expect(output).toContain('190,000')
    expect(output).not.toContain('AUTO COMPACT')
    expect(output).not.toContain('PROMPT CACHE')
  })

  it('falls back to numbered raw rows for malformed structured headers and blank rows', async () => {
    const output = await renderToString(
      <ContextUsageModal
        text={'Context: 10 / 20 tokens (1.2.3% of hard limit)\n\ntrailing  '}
        onDone={() => {}}
        active={false}
      />,
      100,
    )

    expect(output).toContain('CONTEXT')
    expect(output).toContain('001')
    expect(output).toContain('Context: 10 / 20 tokens')
    expect(output).toContain('002')
    expect(output).toContain('003')
    expect(output).toContain('trailing')
    expect(output).toContain('close')
    expect(output).toContain('esc to close')
  })

  it('wires default active input handling for close keys only', async () => {
    const onDone = vi.fn()

    await renderToString(
      <ContextUsageModal text="unstructured context text" onDone={onDone} />,
      100,
    )

    expect(inputMock.options).toEqual({ isActive: true })
    if (!inputMock.handler) {
      throw new Error('ContextUsageModal did not register input handling')
    }

    inputMock.handler('x', key())
    expect(onDone).not.toHaveBeenCalled()

    inputMock.handler('q', key())
    inputMock.handler('', key({ escape: true }))

    expect(onDone).toHaveBeenCalledTimes(2)
  })
})
