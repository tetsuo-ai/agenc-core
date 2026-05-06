import { describe, expect, test } from 'vitest'

import { TextCursor } from '../../utils/TextCursor.js'
import {
  executeIndent,
  executeJoin,
  executeLineOp,
  executeOperatorFind,
  executeOperatorG,
  executeOperatorGg,
  executeOperatorMotion,
  executeOperatorTextObj,
  executePaste,
  executeReplace,
  executeX,
  type OperatorContext,
} from './operators.js'
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

describe('vim operators', () => {
  test('deletes, changes, and yanks with motion counts', () => {
    const deleted = makeContext('one two three')
    executeOperatorMotion('delete', 'w', 2, deleted.ctx)
    expect(deleted.state.text).toBe('three')
    expect(deleted.state.register).toBe('one two ')

    const changed = makeContext('one two')
    executeOperatorMotion('change', 'w', 1, changed.ctx)
    expect(changed.state.text).toBe(' two')
    expect(changed.state.enteredInsertAt).toBe(0)

    const yanked = makeContext('one two')
    executeOperatorMotion('yank', 'e', 1, yanked.ctx)
    expect(yanked.state.text).toBe('one two')
    expect(yanked.state.register).toBe('one')
  })

  test('executes linewise operators and paste', () => {
    const deleted = makeContext('one\ntwo\nthree')
    executeLineOp('delete', 2, deleted.ctx)
    expect(deleted.state.text).toBe('three')
    expect(deleted.state.register).toBe('one\ntwo\n')
    expect(deleted.state.linewise).toBe(true)

    const pasted = makeContext('zero\nthree')
    pasted.state.register = 'one\ntwo\n'
    executePaste(true, 1, pasted.ctx)
    expect(pasted.state.text).toBe('zero\none\ntwo\nthree')
  })

  test('executes find, text-object, replace, x, indent, and join operations', () => {
    const find = makeContext('abc-def')
    executeOperatorFind('delete', 'f', '-', 1, find.ctx)
    expect(find.state.text).toBe('def')
    expect(find.state.lastFind).toEqual({ type: 'f', char: '-' })

    const textObject = makeContext('<tag>inner</tag>', 6)
    executeOperatorTextObj('change', 'inner', 't', 1, textObject.ctx)
    expect(textObject.state.text).toBe('<tag></tag>')
    expect(textObject.state.enteredInsertAt).toBe(5)

    const replace = makeContext('abc')
    executeReplace('x', 2, replace.ctx)
    expect(replace.state.text).toBe('xxc')

    const x = makeContext('abc')
    executeX(2, x.ctx)
    expect(x.state.text).toBe('c')
    expect(x.state.register).toBe('ab')

    const indent = makeContext('one\ntwo')
    executeIndent('>', 2, indent.ctx)
    expect(indent.state.text).toBe('  one\n  two')
    executeIndent('<', 2, indent.ctx)
    expect(indent.state.text).toBe('one\ntwo')

    const joined = makeContext('one\n  two\nthree')
    executeJoin(1, joined.ctx)
    expect(joined.state.text).toBe('one two\nthree')
  })

  test('supports g-prefixed operator motions', () => {
    const ctx = makeContext('one two three', 'one two three'.indexOf('three'))
    executeOperatorMotion('delete', 'ge', 1, ctx.ctx)
    expect(ctx.state.text).toBe('one twthree')
    expect(ctx.state.register).toBe('o ')

    const bigWord = makeContext('one two three', 'one two three'.indexOf('three'))
    executeOperatorMotion('delete', 'gE', 1, bigWord.ctx)
    expect(bigWord.state.text).toBe('one twthree')
    expect(bigWord.state.register).toBe('o ')
  })

  test('expands linewise operator motions from mid-line cursors', () => {
    const deleteDown = makeContext('one\ntwo\nthree', 5)
    executeOperatorMotion('delete', 'j', 1, deleteDown.ctx)
    expect(deleteDown.state.text).toBe('one')
    expect(deleteDown.state.register).toBe('\ntwo\nthree\n')
    expect(deleteDown.state.linewise).toBe(true)

    const deleteUp = makeContext('one\ntwo\nthree', 5)
    executeOperatorMotion('delete', 'k', 1, deleteUp.ctx)
    expect(deleteUp.state.text).toBe('three')
    expect(deleteUp.state.register).toBe('one\ntwo\n')
    expect(deleteUp.state.linewise).toBe(true)

    const deleteToLastLine = makeContext('one\ntwo\nthree', 5)
    executeOperatorG('delete', 1, deleteToLastLine.ctx)
    expect(deleteToLastLine.state.text).toBe('one')
    expect(deleteToLastLine.state.register).toBe('\ntwo\nthree\n')
    expect(deleteToLastLine.state.linewise).toBe(true)

    const deleteToFirstLine = makeContext('one\ntwo\nthree', 5)
    executeOperatorGg('delete', 1, deleteToFirstLine.ctx)
    expect(deleteToFirstLine.state.text).toBe('three')
    expect(deleteToFirstLine.state.register).toBe('one\ntwo\n')
    expect(deleteToFirstLine.state.linewise).toBe(true)

    const yankToLastLine = makeContext('one\ntwo\nthree', 5)
    executeOperatorG('yank', 1, yankToLastLine.ctx)
    expect(yankToLastLine.state.text).toBe('one\ntwo\nthree')
    expect(yankToLastLine.state.register).toBe('\ntwo\nthree\n')
    expect(yankToLastLine.state.linewise).toBe(true)
  })

  test('executes required operator motion behavior', () => {
    const reverseDelete = makeContext('abc', 2)
    executeOperatorMotion('delete', 'h', 1, reverseDelete.ctx)
    expect(reverseDelete.state.text).toBe('ac')
    expect(reverseDelete.state.register).toBe('b')

    const reverseChange = makeContext('abc', 2)
    executeOperatorMotion('change', 'h', 1, reverseChange.ctx)
    expect(reverseChange.state.text).toBe('ac')
    expect(reverseChange.state.register).toBe('b')
    expect(reverseChange.state.enteredInsertAt).toBe(1)

    const reverseYank = makeContext('abc', 2)
    executeOperatorMotion('yank', 'h', 1, reverseYank.ctx)
    expect(reverseYank.state.text).toBe('abc')
    expect(reverseYank.state.register).toBe('b')
    expect(reverseYank.state.offset).toBe(1)

    const backwardFind = makeContext('a-b-c', 4)
    executeOperatorFind('delete', 'F', '-', 1, backwardFind.ctx)
    expect(backwardFind.state.text).toBe('a-b')
    expect(backwardFind.state.register).toBe('-c')
    expect(backwardFind.state.lastFind).toEqual({ type: 'F', char: '-' })

    const backwardTill = makeContext('a-b-c', 4)
    executeOperatorFind('yank', 'T', '-', 1, backwardTill.ctx)
    expect(backwardTill.state.text).toBe('a-b-c')
    expect(backwardTill.state.register).toBe('c')
    expect(backwardTill.state.lastFind).toEqual({ type: 'T', char: '-' })

    const forwardTill = makeContext('a-b-c')
    executeOperatorFind('change', 't', '-', 1, forwardTill.ctx)
    expect(forwardTill.state.text).toBe('-b-c')
    expect(forwardTill.state.register).toBe('a')
    expect(forwardTill.state.enteredInsertAt).toBe(0)

    const goToLastLine = makeContext('one\ntwo\nthree', 4)
    executeOperatorG('delete', 1, goToLastLine.ctx)
    expect(goToLastLine.state.text).toBe('one')
    expect(goToLastLine.state.register).toBe('\ntwo\nthree\n')
    expect(goToLastLine.state.linewise).toBe(true)

    const explicitOneG = makeContext('one\ntwo\nthree', 4)
    executeOperatorG('delete', 1, explicitOneG.ctx, true)
    expect(explicitOneG.state.text).toBe('three')
    expect(explicitOneG.state.register).toBe('one\ntwo\n')
    expect(explicitOneG.state.linewise).toBe(true)

    const deleteLastLineWithG = makeContext('one\ntwo\nthree', 8)
    executeOperatorG('delete', 1, deleteLastLineWithG.ctx)
    expect(deleteLastLineWithG.state.text).toBe('one\ntwo')
    expect(deleteLastLineWithG.state.register).toBe('\nthree\n')
    expect(deleteLastLineWithG.state.linewise).toBe(true)

    const goToFirstLine = makeContext('one\ntwo\nthree', 8)
    executeOperatorGg('yank', 1, goToFirstLine.ctx)
    expect(goToFirstLine.state.text).toBe('one\ntwo\nthree')
    expect(goToFirstLine.state.register).toBe('one\ntwo\nthree\n')
    expect(goToFirstLine.state.linewise).toBe(true)
    expect(goToFirstLine.state.offset).toBe(0)

    const deleteFirstLineWithGg = makeContext('one\ntwo\nthree')
    executeOperatorGg('delete', 1, deleteFirstLineWithGg.ctx)
    expect(deleteFirstLineWithGg.state.text).toBe('two\nthree')
    expect(deleteFirstLineWithGg.state.register).toBe('one\n')
    expect(deleteFirstLineWithGg.state.linewise).toBe(true)
  })

  test('applies counts to text-object operations', () => {
    const counted = makeContext('one two three')
    executeOperatorTextObj('delete', 'around', 'w', 2, counted.ctx)
    expect(counted.state.text).toBe('three')
    expect(counted.state.register).toBe('one two ')
  })

  test('executes delete, change, and yank text-object behavior', () => {
    const deleted = makeContext('one two', 1)
    executeOperatorTextObj('delete', 'around', 'w', 1, deleted.ctx)
    expect(deleted.state.text).toBe('two')
    expect(deleted.state.register).toBe('one ')

    const changed = makeContext('fn(alpha)', 'fn(alpha)'.indexOf('p'))
    executeOperatorTextObj('change', 'inner', '(', 1, changed.ctx)
    expect(changed.state.text).toBe('fn()')
    expect(changed.state.register).toBe('alpha')
    expect(changed.state.enteredInsertAt).toBe(3)

    const yanked = makeContext('say "hello"', 'say "hello"'.indexOf('e'))
    executeOperatorTextObj('yank', 'inner', '"', 1, yanked.ctx)
    expect(yanked.state.text).toBe('say "hello"')
    expect(yanked.state.register).toBe('hello')
    expect(yanked.state.linewise).toBe(false)
  })

  test('covers delete, change, and yank across required text objects', () => {
    const textObjects = [
      {
        keys: 'iw',
        text: 'one two',
        needle: 'n',
        scope: 'inner',
        objType: 'w',
        expectedRegister: 'one',
        expectedText: ' two',
        expectedInsertAt: 0,
      },
      {
        keys: 'aw',
        text: 'one two',
        needle: 'n',
        scope: 'around',
        objType: 'w',
        expectedRegister: 'one ',
        expectedText: 'two',
        expectedInsertAt: 0,
      },
      {
        keys: 'ip',
        text: 'first\n\nsecond\n\nthird',
        needle: 'second',
        scope: 'inner',
        objType: 'p',
        expectedRegister: 'second',
        expectedText: 'first\n\n\n\nthird',
        expectedInsertAt: 7,
      },
      {
        keys: 'ap',
        text: 'first\n\nsecond\n\nthird',
        needle: 'second',
        scope: 'around',
        objType: 'p',
        expectedRegister: 'second\n\n',
        expectedText: 'first\n\nthird',
        expectedInsertAt: 7,
      },
      {
        keys: 'it',
        text: '<div><span>inner</span></div>',
        needle: 'inner',
        scope: 'inner',
        objType: 't',
        expectedRegister: 'inner',
        expectedText: '<div><span></span></div>',
        expectedInsertAt: 11,
      },
      {
        keys: 'at',
        text: '<div><span>inner</span></div>',
        needle: 'inner',
        scope: 'around',
        objType: 't',
        expectedRegister: '<span>inner</span>',
        expectedText: '<div></div>',
        expectedInsertAt: 5,
      },
      {
        keys: 'i"',
        text: 'say "hello"',
        needle: 'e',
        scope: 'inner',
        objType: '"',
        expectedRegister: 'hello',
        expectedText: 'say ""',
        expectedInsertAt: 5,
      },
      {
        keys: 'a"',
        text: 'say "hello"',
        needle: 'e',
        scope: 'around',
        objType: '"',
        expectedRegister: '"hello"',
        expectedText: 'say ',
        expectedInsertAt: 4,
      },
      {
        keys: 'i(',
        text: 'fn(alpha)',
        needle: 'p',
        scope: 'inner',
        objType: '(',
        expectedRegister: 'alpha',
        expectedText: 'fn()',
        expectedInsertAt: 3,
      },
      {
        keys: 'a(',
        text: 'fn(alpha)',
        needle: 'p',
        scope: 'around',
        objType: '(',
        expectedRegister: '(alpha)',
        expectedText: 'fn',
        expectedInsertAt: 2,
      },
      {
        keys: 'i[',
        text: 'arr[zero]',
        needle: 'e',
        scope: 'inner',
        objType: '[',
        expectedRegister: 'zero',
        expectedText: 'arr[]',
        expectedInsertAt: 4,
      },
      {
        keys: 'a[',
        text: 'arr[zero]',
        needle: 'e',
        scope: 'around',
        objType: '[',
        expectedRegister: '[zero]',
        expectedText: 'arr',
        expectedInsertAt: 3,
      },
      {
        keys: 'i{',
        text: 'obj{key}',
        needle: 'e',
        scope: 'inner',
        objType: '{',
        expectedRegister: 'key',
        expectedText: 'obj{}',
        expectedInsertAt: 4,
      },
      {
        keys: 'a{',
        text: 'obj{key}',
        needle: 'e',
        scope: 'around',
        objType: '{',
        expectedRegister: '{key}',
        expectedText: 'obj',
        expectedInsertAt: 3,
      },
    ] as const
    const operators = ['delete', 'change', 'yank'] as const

    for (const spec of textObjects) {
      for (const op of operators) {
        const ctx = makeContext(spec.text, spec.text.indexOf(spec.needle))
        executeOperatorTextObj(op, spec.scope, spec.objType, 1, ctx.ctx)
        expect(ctx.state.register, `${op} ${spec.keys}`).toBe(
          spec.expectedRegister,
        )
        if (op === 'yank') {
          expect(ctx.state.text, `${op} ${spec.keys}`).toBe(spec.text)
          expect(ctx.state.linewise, `${op} ${spec.keys}`).toBe(false)
        } else {
          expect(ctx.state.text, `${op} ${spec.keys}`).toBe(spec.expectedText)
          if (op === 'change') {
            expect(
              ctx.state.enteredInsertAt,
              `${op} ${spec.keys}`,
            ).toBe(spec.expectedInsertAt)
          }
        }
      }
    }
  })
})
