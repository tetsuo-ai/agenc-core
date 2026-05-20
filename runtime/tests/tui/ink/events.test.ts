import { describe, expect, test } from 'vitest'

import { ClickEvent } from './events/click-event.ts'
import { Event } from './events/event.ts'
import { TerminalFocusEvent } from './events/terminal-focus-event.ts'

describe('Ink event classes', () => {
  test('tracks immediate propagation state on the base event', () => {
    const event = new Event()

    expect(event.didStopImmediatePropagation()).toBe(false)

    event.stopImmediatePropagation()

    expect(event.didStopImmediatePropagation()).toBe(true)
  })

  test('stores click coordinates, blank-cell state, and local coordinates', () => {
    const event = new ClickEvent(12, 4, true)

    expect(event.col).toBe(12)
    expect(event.row).toBe(4)
    expect(event.cellIsBlank).toBe(true)
    expect(event.localCol).toBe(0)
    expect(event.localRow).toBe(0)

    event.localCol = 3
    event.localRow = 2
    expect(event.localCol).toBe(3)
    expect(event.localRow).toBe(2)

    event.stopImmediatePropagation()
    expect(event.didStopImmediatePropagation()).toBe(true)
  })

  test('stores terminal focus and blur event types', () => {
    const focus = new TerminalFocusEvent('terminalfocus')
    const blur = new TerminalFocusEvent('terminalblur')

    expect(focus.type).toBe('terminalfocus')
    expect(blur.type).toBe('terminalblur')

    blur.stopImmediatePropagation()
    expect(blur.didStopImmediatePropagation()).toBe(true)
  })
})
