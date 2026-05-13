import { describe, expect, it, vi } from 'vitest'

import {
  type AutocompleteKeyboardEvent,
  consumeAutocompleteEnterKey,
} from './typeaheadKeyHandling.js'

function makeEvent(
  overrides: Partial<AutocompleteKeyboardEvent> = {},
): AutocompleteKeyboardEvent {
  return {
    key: 'return',
    shift: false,
    meta: false,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides,
  }
}

describe('consumeAutocompleteEnterKey', () => {
  it('consumes bare Enter while suggestions are visible', () => {
    const event = makeEvent()

    expect(consumeAutocompleteEnterKey(event, 1)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce()
  })

  it('leaves Enter alone when there is no active suggestion list', () => {
    const event = makeEvent()

    expect(consumeAutocompleteEnterKey(event, 0)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
  })

  it('leaves multiline Enter chords to the text input', () => {
    for (const event of [makeEvent({ shift: true }), makeEvent({ meta: true })]) {
      expect(consumeAutocompleteEnterKey(event, 1)).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(event.stopImmediatePropagation).not.toHaveBeenCalled()
    }
  })
})
