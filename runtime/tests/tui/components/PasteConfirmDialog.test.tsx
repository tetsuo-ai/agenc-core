import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'

const textProps = vi.hoisted(() => [] as Array<{ children?: React.ReactNode; color?: string }>)

const inputState = vi.hoisted(() => ({
  handler: undefined as
    | undefined
    | ((
      input: string,
      key: Record<string, boolean>,
      event: { stopImmediatePropagation: () => void },
    ) => void),
}))

const overlayMock = vi.hoisted(() => ({
  useRegisterOverlay: vi.fn(),
}))

vi.mock('../context/overlayContext.js', () => overlayMock)

vi.mock('../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../ink.js')>('../ink.js')
  return {
    ...actual,
    Text: (props: React.ComponentProps<typeof actual.Text>) => {
      textProps.push(props)
      return React.createElement(actual.Text, props)
    },
    useInput: (
      handler: (
        input: string,
        key: Record<string, boolean>,
        event: { stopImmediatePropagation: () => void },
      ) => void,
    ) => {
      inputState.handler = handler
    },
  }
})

function key(overrides: Record<string, boolean> = {}) {
  return {
    escape: false,
    return: false,
    ...overrides,
  }
}

function event() {
  return { stopImmediatePropagation: vi.fn() }
}

describe('PasteConfirmDialog', () => {
  beforeEach(() => {
    textProps.length = 0
    inputState.handler = undefined
    overlayMock.useRegisterOverlay.mockClear()
  })

  it('registers itself as a modal overlay', async () => {
    const { PasteConfirmDialog } = await import('./PasteConfirmDialog.js')

    const output = await renderToString(
      <PasteConfirmDialog command="echo ok" onDecide={vi.fn()} />,
      80,
    )

    expect(output).toContain('Suspected paste detected')
    expect(overlayMock.useRegisterOverlay).toHaveBeenCalledWith(
      'paste-confirm',
    )
  })

  it('colors the paste warning and confirmation with the active theme', async () => {
    const { PasteConfirmDialog } = await import('./PasteConfirmDialog.js')
    const { getTheme } = await import('../../utils/theme.js')
    const { resolveThemedColor } = await import('./design-system/resolveThemedColor.js')
    await renderToString(<PasteConfirmDialog command="echo ok" onDecide={vi.fn()} />, 80)
    const theme = getTheme('dark')
    for (const [label, expected] of [['Suspected paste detected', theme.warning], ['y', theme.success]]) {
      const color = textProps.find(props => props.children === label)?.color
      expect(resolveThemedColor(color as Parameters<typeof resolveThemedColor>[0], theme)).toBe(expected)
    }
  })

  it('consumes confirmation keys before deciding', async () => {
    const onDecide = vi.fn()
    const { PasteConfirmDialog } = await import('./PasteConfirmDialog.js')
    await renderToString(
      <PasteConfirmDialog command="echo ok" onDecide={onDecide} />,
      80,
    )

    const acceptEvent = event()
    inputState.handler?.('y', key(), acceptEvent)

    expect(acceptEvent.stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(onDecide).toHaveBeenCalledWith(true)

    const rejectEvent = event()
    inputState.handler?.('n', key(), rejectEvent)

    expect(rejectEvent.stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(onDecide).toHaveBeenCalledWith(false)
  })

  it('consumes unrelated keys without deciding', async () => {
    const onDecide = vi.fn()
    const { PasteConfirmDialog } = await import('./PasteConfirmDialog.js')
    await renderToString(
      <PasteConfirmDialog command="echo ok" onDecide={onDecide} />,
      80,
    )

    const unrelatedEvent = event()
    inputState.handler?.('x', key(), unrelatedEvent)

    expect(unrelatedEvent.stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(onDecide).not.toHaveBeenCalled()
  })
})
