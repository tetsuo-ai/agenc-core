import { describe, expect, test, vi } from 'vitest'

import { TextCursor } from '../../utils/TextCursor.js'
import { transition, type TransitionContext } from './transitions.js'
import type { CommandState, FindType, RecordedChange } from './types.js'

function makeContext(initialText: string, initialOffset = 0): {
  ctx: TransitionContext
  state: {
    text: string
    offset: number
    register: string
    linewise: boolean
    lastFind: { type: FindType; char: string } | null
    changes: RecordedChange[]
    enteredInsertAt: number | null
    onUndo: ReturnType<typeof vi.fn>
    onDotRepeat: ReturnType<typeof vi.fn>
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
    onUndo: vi.fn(),
    onDotRepeat: vi.fn(),
  }
  const ctx: TransitionContext = {
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
    onUndo: state.onUndo,
    onDotRepeat: state.onDotRepeat,
  }
  return { ctx, state }
}

function input(
  command: CommandState,
  key: string,
  ctx: TransitionContext,
): CommandState {
  const result = transition(command, key, ctx)
  result.execute?.()
  return result.next ?? { type: 'idle' }
}

describe('vim transitions wave200 coverage', () => {
  test('dispatches edit commands and cancels pending transition states', () => {
    const toggle = makeContext('aB')
    expect(input({ type: 'idle' }, '~', toggle.ctx)).toEqual({ type: 'idle' })
    expect(toggle.state.text).toBe('AB')
    expect(toggle.state.changes).toEqual([{ type: 'toggleCase', count: 1 }])

    const join = makeContext('one\n  two\nthree')
    input({ type: 'idle' }, 'J', join.ctx)
    expect(join.state.text).toBe('one two\nthree')
    expect(join.state.changes).toEqual([{ type: 'join', count: 1 }])

    const pasteAfter = makeContext('ac')
    pasteAfter.state.register = 'b'
    input({ type: 'idle' }, 'p', pasteAfter.ctx)
    expect(pasteAfter.state.text).toBe('abc')
    expect(pasteAfter.state.offset).toBe(1)

    const pasteBefore = makeContext('ac', 1)
    pasteBefore.state.register = 'b'
    input({ type: 'idle' }, 'P', pasteBefore.ctx)
    expect(pasteBefore.state.text).toBe('abc')
    expect(pasteBefore.state.offset).toBe(1)

    const deleteToEnd = makeContext('one two', 4)
    input({ type: 'idle' }, 'D', deleteToEnd.ctx)
    expect(deleteToEnd.state.text).toBe('one ')
    expect(deleteToEnd.state.register).toBe('two')

    const changeToEnd = makeContext('one two', 4)
    input({ type: 'idle' }, 'C', changeToEnd.ctx)
    expect(changeToEnd.state.text).toBe('one ')
    expect(changeToEnd.state.register).toBe('two')
    expect(changeToEnd.state.enteredInsertAt).toBe(4)

    const yankLine = makeContext('one\ntwo', 4)
    input({ type: 'idle' }, 'Y', yankLine.ctx)
    expect(yankLine.state.register).toBe('two\n')
    expect(yankLine.state.linewise).toBe(true)

    const insert = makeContext('abc', 1)
    input({ type: 'idle' }, 'i', insert.ctx)
    expect(insert.state.enteredInsertAt).toBe(1)

    const insertAtText = makeContext('  abc', 4)
    input({ type: 'idle' }, 'I', insertAtText.ctx)
    expect(insertAtText.state.enteredInsertAt).toBe(2)

    const appendMiddle = makeContext('abc', 1)
    input({ type: 'idle' }, 'a', appendMiddle.ctx)
    expect(appendMiddle.state.enteredInsertAt).toBe(2)

    const appendEnd = makeContext('abc', 3)
    input({ type: 'idle' }, 'a', appendEnd.ctx)
    expect(appendEnd.state.enteredInsertAt).toBe(3)

    const appendLine = makeContext('abc')
    input({ type: 'idle' }, 'A', appendLine.ctx)
    expect(appendLine.state.enteredInsertAt).toBe(3)

    const openBelow = makeContext('one\ntwo')
    input({ type: 'idle' }, 'o', openBelow.ctx)
    expect(openBelow.state.text).toBe('one\n\ntwo')
    expect(openBelow.state.enteredInsertAt).toBe(4)

    const openAbove = makeContext('one\ntwo', 4)
    input({ type: 'idle' }, 'O', openAbove.ctx)
    expect(openAbove.state.text).toBe('one\n\ntwo')
    expect(openAbove.state.enteredInsertAt).toBe(4)

    const undo = makeContext('abc')
    input({ type: 'idle' }, 'u', undo.ctx)
    expect(undo.state.onUndo).toHaveBeenCalledTimes(1)

    const dotRepeat = makeContext('abc')
    input({ type: 'idle' }, '.', dotRepeat.ctx)
    expect(dotRepeat.state.onDotRepeat).toHaveBeenCalledTimes(1)

    const operatorFind = makeContext('abc-def')
    let command = input({ type: 'idle' }, 'd', operatorFind.ctx)
    command = input(command, 'f', operatorFind.ctx)
    expect(command).toEqual({
      type: 'operatorFind',
      op: 'delete',
      count: 1,
      find: 'f',
    })
    command = input(command, '-', operatorFind.ctx)
    expect(command).toEqual({ type: 'idle' })
    expect(operatorFind.state.text).toBe('def')
    expect(operatorFind.state.register).toBe('abc-')
    expect(operatorFind.state.lastFind).toEqual({ type: 'f', char: '-' })

    const lineOp = makeContext('one\ntwo')
    input({ type: 'operator', op: 'yank', count: 1 }, 'y', lineOp.ctx)
    expect(lineOp.state.register).toBe('one\n')
    expect(lineOp.state.linewise).toBe(true)

    const invalid = makeContext('abc')
    expect(transition({ type: 'idle' }, '?', invalid.ctx)).toEqual({})
    expect(input({ type: 'count', digits: '2' }, '?', invalid.ctx)).toEqual({
      type: 'idle',
    })
    expect(
      input({ type: 'operator', op: 'delete', count: 1 }, '?', invalid.ctx),
    ).toEqual({ type: 'idle' })
    expect(
      input(
        { type: 'operatorCount', op: 'delete', count: 2, digits: '3' },
        '?',
        invalid.ctx,
      ),
    ).toEqual({ type: 'idle' })
    expect(
      input(
        { type: 'operatorTextObj', op: 'delete', count: 1, scope: 'inner' },
        '?',
        invalid.ctx,
      ),
    ).toEqual({ type: 'idle' })
    expect(input({ type: 'g', count: 1 }, '?', invalid.ctx)).toEqual({
      type: 'idle',
    })
    expect(
      input({ type: 'operatorG', op: 'delete', count: 1 }, '?', invalid.ctx),
    ).toEqual({ type: 'idle' })
    expect(input({ type: 'indent', dir: '>', count: 1 }, '<', invalid.ctx))
      .toEqual({ type: 'idle' })
  })
})
