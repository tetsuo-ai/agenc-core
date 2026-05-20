import { describe, expect, test } from 'vitest'

import { TextCursor } from '../../utils/TextCursor.js'
import { executeToggleCase, type OperatorContext } from './operators.js'
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

describe('vim operator toggle case coverage', () => {
  test('toggles mixed case characters and ignores cursors past the buffer', () => {
    const toggled = makeContext('aBcd')

    executeToggleCase(3, toggled.ctx)

    expect(toggled.state.text).toBe('AbCd')
    expect(toggled.state.offset).toBe(3)
    expect(toggled.state.changes).toEqual([{ type: 'toggleCase', count: 3 }])

    const atEnd = makeContext('abc', 3)

    executeToggleCase(1, atEnd.ctx)

    expect(atEnd.state.text).toBe('abc')
    expect(atEnd.state.offset).toBe(3)
    expect(atEnd.state.changes).toEqual([])
  })
})
