import { describe, expect, test } from 'vitest'

import { TextCursor } from 'src/utils/TextCursor.js'
import {
  executeIndent,
  executeJoin,
  executeLineOp,
  executeOperatorFind,
  executeOperatorMotion,
  executeOperatorTextObj,
  executePaste,
  executeX,
  type OperatorContext,
} from 'src/tui/vim/operators.js'
import type { FindType, RecordedChange } from 'src/tui/vim/types.js'

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

describe('vim operator coverage swarm row 030', () => {
  test('leaves state untouched when operator targets are missing', () => {
    const sameCursorMotion = makeContext('abc')
    const stableCursor = TextCursor.fromText(
      sameCursorMotion.state.text,
      80,
      sameCursorMotion.state.offset,
    )

    executeOperatorMotion('delete', 'unknown-motion', 1, {
      ...sameCursorMotion.ctx,
      cursor: stableCursor,
    })

    expect(sameCursorMotion.state.text).toBe('abc')
    expect(sameCursorMotion.state.register).toBe('')
    expect(sameCursorMotion.state.changes).toEqual([])

    const missingFind = makeContext('abc')
    executeOperatorFind('delete', 'f', 'z', 1, missingFind.ctx)

    expect(missingFind.state.text).toBe('abc')
    expect(missingFind.state.lastFind).toBeNull()
    expect(missingFind.state.changes).toEqual([])

    const missingTextObject = makeContext('plain text')
    executeOperatorTextObj('delete', 'inner', '"', 1, missingTextObject.ctx)

    expect(missingTextObject.state.text).toBe('plain text')
    expect(missingTextObject.state.register).toBe('')
    expect(missingTextObject.state.changes).toEqual([])
  })

  test('handles counted text objects when the requested count exceeds matches', () => {
    const counted = makeContext('one two', 1)

    executeOperatorTextObj('yank', 'around', 'w', 4, counted.ctx)

    expect(counted.state.text).toBe('one two')
    expect(counted.state.register).toBe('one two')
    expect(counted.state.linewise).toBe(false)
    expect(counted.state.offset).toBe(0)
    expect(counted.state.changes).toEqual([
      {
        type: 'operatorTextObj',
        op: 'yank',
        objType: 'w',
        scope: 'around',
        count: 4,
      },
    ])
  })

  test('covers linewise delete and change boundaries', () => {
    const deleteLastLine = makeContext('one\ntwo', 'one\n'.length)

    executeLineOp('delete', 1, deleteLastLine.ctx)

    expect(deleteLastLine.state.text).toBe('one')
    expect(deleteLastLine.state.register).toBe('two\n')
    expect(deleteLastLine.state.linewise).toBe(true)
    expect(deleteLastLine.state.offset).toBe(2)

    const changeSingle = makeContext('only')

    executeLineOp('change', 1, changeSingle.ctx)

    expect(changeSingle.state.text).toBe('')
    expect(changeSingle.state.register).toBe('only\n')
    expect(changeSingle.state.enteredInsertAt).toBe(0)

    const changeMiddle = makeContext('one\ntwo\nthree\nfour', 'one\n'.length)

    executeLineOp('change', 2, changeMiddle.ctx)

    expect(changeMiddle.state.text).toBe('one\n\nfour')
    expect(changeMiddle.state.register).toBe('two\nthree\n')
    expect(changeMiddle.state.enteredInsertAt).toBe('one\n'.length)
  })

  test('covers no-op delete character and join cases', () => {
    const atEnd = makeContext('abc', 3)

    executeX(1, atEnd.ctx)

    expect(atEnd.state.text).toBe('abc')
    expect(atEnd.state.register).toBe('')
    expect(atEnd.state.changes).toEqual([])

    const lastLine = makeContext('one\ntwo', 'one\ntwo'.length)

    executeJoin(1, lastLine.ctx)

    expect(lastLine.state.text).toBe('one\ntwo')
    expect(lastLine.state.changes).toEqual([])

    const withBlankLine = makeContext('one\n\nthree')

    executeJoin(2, withBlankLine.ctx)

    expect(withBlankLine.state.text).toBe('one three')
    expect(withBlankLine.state.offset).toBe('one'.length)
    expect(withBlankLine.state.changes).toEqual([{ type: 'join', count: 2 }])
  })

  test('covers paste without a register and before-cursor paste variants', () => {
    const emptyRegister = makeContext('abc')

    executePaste(true, 1, emptyRegister.ctx)

    expect(emptyRegister.state.text).toBe('abc')
    expect(emptyRegister.state.offset).toBe(0)

    const linewiseBefore = makeContext('one\ntwo', 'one\n'.length)
    linewiseBefore.state.register = 'alpha\n'

    executePaste(false, 2, linewiseBefore.ctx)

    expect(linewiseBefore.state.text).toBe('one\nalpha\nalpha\ntwo')
    expect(linewiseBefore.state.offset).toBe('one\n'.length)

    const characterBefore = makeContext('ac', 1)
    characterBefore.state.register = 'b'

    executePaste(false, 3, characterBefore.ctx)

    expect(characterBefore.state.text).toBe('abbbc')
    expect(characterBefore.state.offset).toBe(3)
  })

  test('outdents tabs, partial whitespace, and nonblank lines', () => {
    const indented = makeContext('\tone\n one\none')

    executeIndent('<', 3, indented.ctx)

    expect(indented.state.text).toBe('one\none\none')
    expect(indented.state.offset).toBe(0)
    expect(indented.state.changes).toEqual([
      { type: 'indent', dir: '<', count: 3 },
    ])
  })

  test('changes counted big-WORD motion through the last selected word', () => {
    const changed = makeContext('one two three four')

    executeOperatorMotion('change', 'W', 2, changed.ctx)

    expect(changed.state.text).toBe(' three four')
    expect(changed.state.register).toBe('one two')
    expect(changed.state.enteredInsertAt).toBe(0)
    expect(changed.state.changes).toEqual([
      { type: 'operator', op: 'change', motion: 'W', count: 2 },
    ])
  })
})
