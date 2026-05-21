import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { PasteConfirmDialog } from '../../../src/tui/components/PasteConfirmDialog.js'
import { renderToString } from '../../../src/utils/staticRender.js'

type InputEvent = {
  stopImmediatePropagation: () => void
}

type InputHandler = (
  input: string,
  key: Record<string, boolean>,
  event: InputEvent,
) => void

const harness = vi.hoisted(() => ({
  inputHandler: undefined as InputHandler | undefined,
  useRegisterOverlay: vi.fn(),
}))

vi.mock('../../../src/tui/context/overlayContext.js', () => ({
  useRegisterOverlay: harness.useRegisterOverlay,
}))

vi.mock('../../../src/tui/ink.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/tui/ink.js')>()

  return {
    ...actual,
    useInput: (handler: InputHandler) => {
      harness.inputHandler = handler
    },
  }
})

function key(overrides: Record<string, boolean> = {}): Record<string, boolean> {
  return {
    escape: false,
    return: false,
    ...overrides,
  }
}

function event(): InputEvent {
  return {
    stopImmediatePropagation: vi.fn(),
  }
}

async function renderDialog(
  command: string,
  onDecide = vi.fn(),
): Promise<string> {
  return renderToString(
    <PasteConfirmDialog command={command} onDecide={onDecide} />,
    { columns: 280, rows: 12 },
  )
}

function registeredInputHandler(): InputHandler {
  expect(harness.inputHandler).toBeDefined()
  return harness.inputHandler!
}

describe('PasteConfirmDialog coverage swarm row 240', () => {
  beforeEach(() => {
    harness.inputHandler = undefined
    harness.useRegisterOverlay.mockClear()
  })

  test('trims whitespace, folds newlines, and truncates long command previews', async () => {
    const longSegment = 'a'.repeat(205)
    const output = await renderDialog(`  ${longSegment}\nrm -rf /tmp/example  `)

    expect(output).toContain('Suspected paste detected')
    expect(output).toContain('a'.repeat(200))
    expect(output).not.toContain('rm -rf /tmp/example')
    expect(harness.useRegisterOverlay).toHaveBeenCalledWith('paste-confirm')
  })

  test('accepts uppercase confirmation and return after consuming the input event', async () => {
    const onDecide = vi.fn()
    await renderDialog('echo ok', onDecide)
    const handleInput = registeredInputHandler()

    const uppercaseEvent = event()
    handleInput('Y', key(), uppercaseEvent)

    const returnEvent = event()
    handleInput('', key({ return: true }), returnEvent)

    expect(uppercaseEvent.stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(returnEvent.stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(onDecide).toHaveBeenNthCalledWith(1, true)
    expect(onDecide).toHaveBeenNthCalledWith(2, true)
  })

  test('rejects uppercase denial and escape after consuming the input event', async () => {
    const onDecide = vi.fn()
    await renderDialog('echo ok', onDecide)
    const handleInput = registeredInputHandler()

    const uppercaseEvent = event()
    handleInput('N', key(), uppercaseEvent)

    const escapeEvent = event()
    handleInput('', key({ escape: true }), escapeEvent)

    expect(uppercaseEvent.stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(escapeEvent.stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(onDecide).toHaveBeenNthCalledWith(1, false)
    expect(onDecide).toHaveBeenNthCalledWith(2, false)
  })
})
