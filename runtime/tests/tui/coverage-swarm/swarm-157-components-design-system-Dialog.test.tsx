import React from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../../src/utils/staticRender.js'
import {
  Dialog,
  getDialogBodyMaxHeight,
} from '../../../src/tui/components/design-system/Dialog.js'
import { Text } from '../../../src/tui/ink.js'

type ExitState = {
  keyName: 'Ctrl-C' | 'Ctrl-D' | null
  pending: boolean
}

type KeybindingRecord = {
  action: string
  handler: () => void
  options?: {
    context?: string
    isActive?: boolean
  }
}

const harness = vi.hoisted(() => ({
  exitHookActiveStates: [] as Array<boolean | undefined>,
  exitState: {
    keyName: null,
    pending: false,
  } as ExitState,
  keybindings: [] as KeybindingRecord[],
}))

vi.mock('src/tui/hooks/useExitOnCtrlCDWithKeybindings.js', () => ({
  useExitOnCtrlCDWithKeybindings: (
    _onExit: unknown,
    _onInterrupt: unknown,
    isActive?: boolean,
  ) => {
    harness.exitHookActiveStates.push(isActive)
    return harness.exitState
  },
}))

vi.mock('../../../src/tui/keybindings/useKeybinding.js', () => ({
  useKeybinding: (
    action: string,
    handler: () => void,
    options?: KeybindingRecord['options'],
  ) => {
    harness.keybindings.push({ action, handler, options })
  },
}))

async function renderDialog(
  props: Partial<React.ComponentProps<typeof Dialog>> = {},
): Promise<string> {
  return renderToString(
    <Dialog title="Confirm action" onCancel={() => {}} {...props}>
      <Text>Dialog body</Text>
    </Dialog>,
    { columns: 80, rows: 24 },
  )
}

describe('Dialog coverage swarm row 157', () => {
  beforeEach(() => {
    harness.exitHookActiveStates = []
    harness.exitState = {
      keyName: null,
      pending: false,
    }
    harness.keybindings = []
  })

  test('computes body height with guide chrome, truncation, and unsafe row values', () => {
    expect(getDialogBodyMaxHeight(24, true)).toBe(18)
    expect(getDialogBodyMaxHeight(24, false)).toBe(20)
    expect(getDialogBodyMaxHeight(7.9, true)).toBe(1)
    expect(getDialogBodyMaxHeight(8.9, false)).toBe(4)
    expect(getDialogBodyMaxHeight(Number.POSITIVE_INFINITY, true)).toBe(1)
    expect(getDialogBodyMaxHeight(-4, false)).toBe(1)
  })

  test('renders the default subtitle and input guide and wires cancel keybinding', async () => {
    const onCancel = vi.fn()
    const output = await renderDialog({
      onCancel,
      subtitle: 'Review before continuing',
    })

    expect(output).toContain('Confirm action')
    expect(output).toContain('Review before continuing')
    expect(output).toContain('Dialog body')
    expect(output).toContain('Enter to confirm')
    expect(output).toContain('Esc to cancel')
    expect(harness.exitHookActiveStates).toEqual([true])
    expect(harness.keybindings).toHaveLength(1)
    expect(harness.keybindings[0]).toMatchObject({
      action: 'confirm:no',
      options: {
        context: 'Confirmation',
        isActive: true,
      },
    })

    harness.keybindings[0]?.handler()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('renders the pending exit prompt when the exit hook reports a first press', async () => {
    harness.exitState = {
      keyName: 'Ctrl-D',
      pending: true,
    }

    const output = await renderDialog()

    expect(output).toContain('Press Ctrl-D again to exit')
    expect(output).not.toContain('Enter to confirm')
  })

  test('honors custom guides, hidden guides, hidden borders, and inactive cancel bindings', async () => {
    harness.exitState = {
      keyName: 'Ctrl-C',
      pending: true,
    }
    const inputGuide = vi.fn((exitState: ExitState) => (
      <Text>{`Custom guide ${exitState.keyName} ${exitState.pending}`}</Text>
    ))

    const customGuideOutput = await renderDialog({ inputGuide })

    expect(customGuideOutput).toContain('Custom guide Ctrl-C true')
    expect(inputGuide).toHaveBeenCalledWith(harness.exitState)

    const hiddenOutput = await renderDialog({
      hideBorder: true,
      hideInputGuide: true,
      isCancelActive: false,
      title: 'Borderless dialog',
    })

    expect(hiddenOutput).toContain('Borderless dialog')
    expect(hiddenOutput).toContain('Dialog body')
    expect(hiddenOutput).not.toContain('Custom guide')
    expect(hiddenOutput).not.toContain('Press Ctrl-C again to exit')
    expect(harness.exitHookActiveStates.at(-1)).toBe(false)
    expect(harness.keybindings.at(-1)).toMatchObject({
      action: 'confirm:no',
      options: {
        context: 'Confirmation',
        isActive: false,
      },
    })
  })
})
