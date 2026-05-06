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
    lastFind: { type: FindType; char: string } | null
    changes: RecordedChange[]
    enteredInsertAt: number | null
  }
} {
  const state = {
    text: initialText,
    offset: initialOffset,
    register: '',
    lastFind: null as { type: FindType; char: string } | null,
    changes: [] as RecordedChange[],
    enteredInsertAt: null as number | null,
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
    setRegister: content => {
      state.register = content
    },
    getLastFind: () => state.lastFind,
    setLastFind: (type, char) => {
      state.lastFind = { type, char }
    },
    recordChange: change => {
      state.changes.push(change)
    },
    onUndo: vi.fn(),
    onDotRepeat: vi.fn(),
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

describe('vim transitions', () => {
  test('runs count, operator, and motion states', () => {
    const { ctx, state } = makeContext('one two three')
    let command: CommandState = { type: 'idle' }
    command = input(command, '2', ctx)
    command = input(command, 'd', ctx)
    command = input(command, 'w', ctx)

    expect(command).toEqual({ type: 'idle' })
    expect(state.text).toBe('three')
    expect(state.register).toBe('one two ')
  })

  test('treats 0 as a line-start motion after operators', () => {
    const normal = makeContext('abc def', 4)
    let command: CommandState = { type: 'idle' }
    command = input(command, '0', normal.ctx)
    expect(command).toEqual({ type: 'idle' })
    expect(normal.state.offset).toBe(0)

    const deleted = makeContext('abc def', 4)
    command = { type: 'idle' }
    command = input(command, 'd', deleted.ctx)
    command = input(command, '0', deleted.ctx)
    expect(command).toEqual({ type: 'idle' })
    expect(deleted.state.text).toBe('def')
    expect(deleted.state.register).toBe('abc ')

    const changed = makeContext('abc def', 4)
    command = input({ type: 'idle' }, 'c', changed.ctx)
    command = input(command, '0', changed.ctx)
    expect(command).toEqual({ type: 'idle' })
    expect(changed.state.text).toBe('def')
    expect(changed.state.register).toBe('abc ')
    expect(changed.state.enteredInsertAt).toBe(0)

    const yanked = makeContext('abc def', 4)
    command = input({ type: 'idle' }, 'y', yanked.ctx)
    command = input(command, '0', yanked.ctx)
    expect(command).toEqual({ type: 'idle' })
    expect(yanked.state.text).toBe('abc def')
    expect(yanked.state.register).toBe('abc ')
  })

  test('clamps normal and operator counts to the maximum vim count', () => {
    const { ctx } = makeContext('one two three')
    let command: CommandState = { type: 'idle' }
    for (const key of ['1', '0', '0', '0', '0', '0']) {
      command = input(command, key, ctx)
    }
    expect(command).toEqual({ type: 'count', digits: '10000' })

    command = input({ type: 'idle' }, 'd', ctx)
    for (const key of ['1', '0', '0', '0', '0', '0']) {
      command = input(command, key, ctx)
    }
    expect(command).toEqual({
      type: 'operatorCount',
      op: 'delete',
      count: 1,
      digits: '10000',
    })
  })

  test('runs text-object, replace, and indent states', () => {
    const textObject = makeContext('say "hello"', 6)
    let command: CommandState = { type: 'idle' }
    command = input(command, 'c', textObject.ctx)
    command = input(command, 'i', textObject.ctx)
    command = input(command, '"', textObject.ctx)
    expect(command).toEqual({ type: 'idle' })
    expect(textObject.state.text).toBe('say ""')
    expect(textObject.state.enteredInsertAt).toBe(5)

    const replace = makeContext('abc')
    command = input({ type: 'idle' }, 'r', replace.ctx)
    command = input(command, 'x', replace.ctx)
    expect(replace.state.text).toBe('xbc')

    const canceledReplace = makeContext('abc')
    command = input({ type: 'idle' }, 'r', canceledReplace.ctx)
    command = input(command, '', canceledReplace.ctx)
    expect(command).toEqual({ type: 'idle' })
    expect(canceledReplace.state.text).toBe('abc')
    expect(canceledReplace.state.changes).toHaveLength(0)

    const indent = makeContext('one\ntwo')
    command = input({ type: 'idle' }, '>', indent.ctx)
    command = input(command, '>', indent.ctx)
    expect(indent.state.text).toBe('  one\ntwo')
  })

  test('runs g-prefixed normal and operator motions', () => {
    const normal = makeContext('one\ntwo\nthree', 8)
    let command = input({ type: 'idle' }, 'g', normal.ctx)
    command = input(command, 'g', normal.ctx)
    expect(normal.state.offset).toBe(0)

    const previousEnd = makeContext('one two three', 'one two three'.indexOf('three'))
    command = input({ type: 'idle' }, 'g', previousEnd.ctx)
    command = input(command, 'e', previousEnd.ctx)
    expect(previousEnd.state.offset).toBe(6)

    const operator = makeContext('one two three', 'one two three'.indexOf('three'))
    command = input({ type: 'idle' }, 'd', operator.ctx)
    command = input(command, 'g', operator.ctx)
    command = input(command, 'e', operator.ctx)
    expect(operator.state.text).toBe('one twthree')

    const operatorBigWord = makeContext(
      'one two three',
      'one two three'.indexOf('three'),
    )
    command = input({ type: 'idle' }, 'd', operatorBigWord.ctx)
    command = input(command, 'g', operatorBigWord.ctx)
    command = input(command, 'E', operatorBigWord.ctx)
    expect(operatorBigWord.state.text).toBe('one twthree')
  })

  test('runs counted G, gg, and visual-line g motions', () => {
    const bareG = makeContext('one\ntwo\nthree')
    let command = input({ type: 'idle' }, 'G', bareG.ctx)
    expect(command).toEqual({ type: 'idle' })
    expect(bareG.state.offset).toBe(8)

    const explicitOneG = makeContext('one\ntwo\nthree', 8)
    command = input({ type: 'idle' }, '1', explicitOneG.ctx)
    command = input(command, 'G', explicitOneG.ctx)
    expect(command).toEqual({ type: 'idle' })
    expect(explicitOneG.state.offset).toBe(0)

    const goToLine = makeContext('one\ntwo\nthree')
    command = input({ type: 'idle' }, '2', goToLine.ctx)
    command = input(command, 'G', goToLine.ctx)
    expect(goToLine.state.offset).toBe(4)

    const goToLineWithGg = makeContext('one\ntwo\nthree')
    command = input({ type: 'idle' }, '3', goToLineWithGg.ctx)
    command = input(command, 'g', goToLineWithGg.ctx)
    command = input(command, 'g', goToLineWithGg.ctx)
    expect(goToLineWithGg.state.offset).toBe(8)

    const visual = makeContext('a\nb', 0)
    command = input({ type: 'idle' }, 'g', visual.ctx)
    command = input(command, 'j', visual.ctx)
    expect(visual.state.offset).toBe(2)
    command = input({ type: 'idle' }, 'g', visual.ctx)
    command = input(command, 'k', visual.ctx)
    expect(visual.state.offset).toBe(0)
  })

  test('uses explicit operator counts for G line targets', () => {
    const explicitOneG = makeContext('one\ntwo\nthree', 4)
    let command = input({ type: 'idle' }, 'd', explicitOneG.ctx)
    command = input(command, '1', explicitOneG.ctx)
    command = input(command, 'G', explicitOneG.ctx)

    expect(command).toEqual({ type: 'idle' })
    expect(explicitOneG.state.text).toBe('three')
    expect(explicitOneG.state.register).toBe('one\ntwo\n')
    expect(explicitOneG.state.changes).toEqual([
      { type: 'operator', op: 'delete', motion: 'G', count: 1 },
    ])
  })

  test('runs find and repeat-find states including n and N', () => {
    const normal = makeContext('a-b-c')
    let command = input({ type: 'idle' }, 'f', normal.ctx)
    command = input(command, '-', normal.ctx)
    expect(normal.state.offset).toBe(1)
    command = input(command, ';', normal.ctx)
    expect(normal.state.offset).toBe(3)
    command = input(command, ',', normal.ctx)
    expect(normal.state.offset).toBe(1)
    command = input(command, 'n', normal.ctx)
    expect(normal.state.offset).toBe(3)
    command = input(command, 'N', normal.ctx)
    expect(normal.state.offset).toBe(1)

    const operator = makeContext('a-b-c')
    operator.state.lastFind = { type: 'f', char: '-' }
    command = input({ type: 'idle' }, 'd', operator.ctx)
    command = input(command, 'n', operator.ctx)
    expect(operator.state.text).toBe('b-c')

    const semicolonRepeat = makeContext('a-b-c-d')
    command = input({ type: 'idle' }, 'f', semicolonRepeat.ctx)
    command = input(command, '-', semicolonRepeat.ctx)
    expect(semicolonRepeat.state.offset).toBe(1)
    command = input(command, ';', semicolonRepeat.ctx)
    expect(semicolonRepeat.state.offset).toBe(3)

    const operatorSemicolon = makeContext('a-b-c-d')
    command = input({ type: 'idle' }, 'f', operatorSemicolon.ctx)
    command = input(command, '-', operatorSemicolon.ctx)
    command = input(command, 'd', operatorSemicolon.ctx)
    command = input(command, ';', operatorSemicolon.ctx)
    expect(operatorSemicolon.state.text).toBe('ac-d')
    expect(operatorSemicolon.state.register).toBe('-b-')

    const countedOperatorSemicolon = makeContext('a-b-c-d-e')
    countedOperatorSemicolon.state.lastFind = { type: 'f', char: '-' }
    command = input({ type: 'idle' }, '2', countedOperatorSemicolon.ctx)
    command = input(command, 'd', countedOperatorSemicolon.ctx)
    command = input(command, ';', countedOperatorSemicolon.ctx)
    expect(countedOperatorSemicolon.state.text).toBe('c-d-e')
    expect(countedOperatorSemicolon.state.register).toBe('a-b-')

    const operatorComma = makeContext('a-b-c-d', 5)
    operatorComma.state.lastFind = { type: 'f', char: '-' }
    command = input({ type: 'idle' }, 'd', operatorComma.ctx)
    command = input(command, ',', operatorComma.ctx)
    expect(operatorComma.state.text).toBe('a-bd')
    expect(operatorComma.state.register).toBe('-c-')

    const noFindMemory = makeContext('a-b-c', 2)
    for (const key of [';', ',', 'n', 'N']) {
      command = input({ type: 'idle' }, key, noFindMemory.ctx)
      expect(command).toEqual({ type: 'idle' })
      expect(noFindMemory.state.offset).toBe(2)
      expect(noFindMemory.state.text).toBe('a-b-c')
    }
  })

  test('runs all find variants and counted repeat-find commands', () => {
    const forward = makeContext('ab-cd-ef')
    let command = input({ type: 'idle' }, '2', forward.ctx)
    command = input(command, 'f', forward.ctx)
    command = input(command, '-', forward.ctx)
    expect(forward.state.offset).toBe(5)
    command = input(command, ';', forward.ctx)
    expect(forward.state.offset).toBe(5)

    const tillForward = makeContext('ab-cd')
    command = input({ type: 'idle' }, 't', tillForward.ctx)
    command = input(command, '-', tillForward.ctx)
    expect(tillForward.state.offset).toBe(1)

    const backward = makeContext('ab-cd-ef', 7)
    command = input({ type: 'idle' }, 'F', backward.ctx)
    command = input(command, '-', backward.ctx)
    expect(backward.state.offset).toBe(5)
    command = input(command, '2', backward.ctx)
    command = input(command, ',', backward.ctx)
    expect(backward.state.offset).toBe(5)

    const tillBackward = makeContext('ab-cd-ef', 7)
    command = input({ type: 'idle' }, 'T', tillBackward.ctx)
    command = input(command, '-', tillBackward.ctx)
    expect(tillBackward.state.offset).toBe(6)

    const reverseRepeat = makeContext('ab-cd-ef-gh', 7)
    command = input({ type: 'idle' }, 'F', reverseRepeat.ctx)
    command = input(command, '-', reverseRepeat.ctx)
    expect(reverseRepeat.state.offset).toBe(5)
    command = input(command, 'N', reverseRepeat.ctx)
    expect(reverseRepeat.state.offset).toBe(8)
  })
})
