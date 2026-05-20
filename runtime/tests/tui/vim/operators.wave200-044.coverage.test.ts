import { describe, expect, test } from 'vitest'

import { TextCursor } from '../../utils/TextCursor.js'
import { executeOpenLine, type OperatorContext } from './operators.js'
import type { FindType, RecordedChange } from './types.js'

function makeContext(initialText: string, initialOffset = 0): {
  ctx: OperatorContext
  state: {
    text: string
    offset: number
    register: string
    linewise: boolean
    lastFind: { type: FindType; char: string } | null
    changes: RecordedChange[]
    enteredInsertAt: number | null
  }
} {
  const state = {
    text: initialText,
    offset: initialOffset,
    register: '',
    linewise: false,
    lastFind: null as { type: FindType; char: string } | null,
    changes: [] as RecordedChange[],
    enteredInsertAt: null as number | null,
  }
  const ctx: OperatorContext = {
    get cursor() {
      return TextCursor.fromText(state.text, 80, state.offset)
    },
    get text() {
      return state.text
    },
    setText: text => {
      state.text = text
    },
    setOffset: offset => {
      state.offset = offset
    },
    enterInsert: offset => {
      state.enteredInsertAt = offset
      state.offset = offset
    },
    getRegister: () => state.register,
    setRegister: (content, linewise) => {
      state.register = content
      state.linewise = linewise
    },
    getLastFind: () => state.lastFind,
    setLastFind: (type, char) => {
      state.lastFind = { type, char }
    },
    recordChange: change => {
      state.changes.push(change)
    },
  }
  return { ctx, state }
}

describe('vim open line operator coverage', () => {
  test('opens blank lines above and below the current logical line', () => {
    const below = makeContext('one\ntwo\nthree', 'one\ntwo'.length)

    executeOpenLine('below', below.ctx)

    expect(below.state.text).toBe('one\ntwo\n\nthree')
    expect(below.state.enteredInsertAt).toBe('one\ntwo\n'.length)
    expect(below.state.offset).toBe(below.state.enteredInsertAt)
    expect(below.state.changes).toEqual([
      { type: 'openLine', direction: 'below' },
    ])

    const above = makeContext('one\ntwo\nthree', 'one\n'.length)

    executeOpenLine('above', above.ctx)

    expect(above.state.text).toBe('one\n\ntwo\nthree')
    expect(above.state.enteredInsertAt).toBe('one\n'.length)
    expect(above.state.offset).toBe(above.state.enteredInsertAt)
    expect(above.state.changes).toEqual([
      { type: 'openLine', direction: 'above' },
    ])
  })
})
