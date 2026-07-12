import { describe, expect, test } from 'vitest'

import { renderPlaceholder } from './renderPlaceholder.js'

const invert = (text: string) => `[${text}]`

describe('renderPlaceholder', () => {
  test('returns no rendered placeholder when no placeholder is configured', () => {
    expect(
      renderPlaceholder({
        value: '',
        terminalFocus: true,
        invert,
      }),
    ).toEqual({
      renderedPlaceholder: undefined,
      showPlaceholder: false,
    })
  })

  test('renders hidden placeholder text as only the cursor when focused', () => {
    expect(
      renderPlaceholder({
        placeholder: 'Speak now',
        value: '',
        showCursor: true,
        focus: true,
        terminalFocus: true,
        hidePlaceholderText: true,
        invert,
      }),
    ).toEqual({
      renderedPlaceholder: '[ ]',
      showPlaceholder: true,
    })

    expect(
      renderPlaceholder({
        placeholder: 'Speak now',
        value: '',
        showCursor: false,
        focus: true,
        terminalFocus: true,
        hidePlaceholderText: true,
        invert,
      }).renderedPlaceholder,
    ).toBe('')
  })

  test('renders plain dim placeholder text without a cursor', () => {
    const rendered = renderPlaceholder({
      placeholder: 'Type something',
      value: 'existing input',
      showCursor: false,
      focus: true,
      terminalFocus: true,
      invert,
    })

    expect(rendered.renderedPlaceholder).toContain('Type something')
    expect(rendered.showPlaceholder).toBe(false)
  })

  test('renders the cursor as its own cell before the ghost text only when focused', () => {
    // The cursor must NOT swallow the placeholder's first letter — inverting
    // it fused cursor and hint into what read like a typo ("D■escribe…").
    const focused = renderPlaceholder({
      placeholder: 'hello',
      value: '',
      showCursor: true,
      focus: true,
      terminalFocus: true,
      invert,
    }).renderedPlaceholder
    expect(focused).toContain('[ ]')
    expect(focused).toContain('hello')
    expect(focused).not.toContain('[h]')

    expect(
      renderPlaceholder({
        placeholder: 'hello',
        value: '',
        showCursor: true,
        focus: false,
        terminalFocus: true,
        invert,
      }).renderedPlaceholder,
    ).not.toContain('[ ]')

    expect(
      renderPlaceholder({
        placeholder: 'hello',
        value: '',
        showCursor: true,
        focus: true,
        terminalFocus: false,
        invert,
      }).renderedPlaceholder,
    ).not.toContain('[ ]')
  })
})
