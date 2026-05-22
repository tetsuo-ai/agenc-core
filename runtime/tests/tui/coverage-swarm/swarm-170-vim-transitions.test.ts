import { describe, expect, test, vi } from 'vitest'

import { TextCursor } from 'src/utils/TextCursor.js'
import { transition, type TransitionContext } from 'src/tui/vim/transitions.js'
import type { CommandState, FindType, RecordedChange } from 'src/tui/vim/types.js'

function makeContext(
  initialText: string,
  initialOffset = 0,
  includeCallbacks = true,
): {
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
  const callbacks = includeCallbacks
    ? { onUndo: state.onUndo, onDotRepeat: state.onDotRepeat }
    : {}
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
    ...callbacks,
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

describe('vim transitions coverage swarm row 170', () => {
  test('covers counted normal motions, missing find targets, and omitted callbacks', () => {
    const moved = makeContext('one two three')
    let command = input({ type: 'idle' }, '2', moved.ctx)
    command = input(command, 'w', moved.ctx)

    expect(command).toEqual({ type: 'idle' })
    expect(moved.state.offset).toBe('one two '.length)

    const missingFind = makeContext('abc')
    command = input({ type: 'idle' }, 'f', missingFind.ctx)
    expect(command).toEqual({ type: 'find', find: 'f', count: 1 })
    command = input(command, 'z', missingFind.ctx)

    expect(command).toEqual({ type: 'idle' })
    expect(missingFind.state.offset).toBe(0)
    expect(missingFind.state.lastFind).toBeNull()

    const noCallbacks = makeContext('abc', 0, false)
    expect(() => input({ type: 'idle' }, 'u', noCallbacks.ctx)).not.toThrow()
    expect(() => input({ type: 'idle' }, '.', noCallbacks.ctx)).not.toThrow()
    expect(noCallbacks.state.onUndo).not.toHaveBeenCalled()
    expect(noCallbacks.state.onDotRepeat).not.toHaveBeenCalled()
  })

  test('routes operator-count commands through motion, find, and text-object states', () => {
    const clamped = makeContext('alpha beta')
    expect(
      transition(
        { type: 'operatorCount', op: 'delete', count: 1, digits: '9999' },
        '9',
        clamped.ctx,
      ).next,
    ).toEqual({
      type: 'operatorCount',
      op: 'delete',
      count: 1,
      digits: '10000',
    })

    const motion = makeContext('one two three four')
    let command = input({ type: 'idle' }, 'd', motion.ctx)
    command = input(command, '2', motion.ctx)
    command = input(command, 'w', motion.ctx)

    expect(command).toEqual({ type: 'idle' })
    expect(motion.state.text).toBe('three four')
    expect(motion.state.register).toBe('one two ')
    expect(motion.state.changes).toEqual([
      { type: 'operator', op: 'delete', motion: 'w', count: 2 },
    ])

    const find = makeContext('a-b-c-d')
    command = input({ type: 'idle' }, 'd', find.ctx)
    command = input(command, '2', find.ctx)
    command = input(command, 'f', find.ctx)
    expect(command).toEqual({
      type: 'operatorFind',
      op: 'delete',
      count: 2,
      find: 'f',
    })
    command = input(command, '-', find.ctx)

    expect(command).toEqual({ type: 'idle' })
    expect(find.state.text).toBe('c-d')
    expect(find.state.register).toBe('a-b-')

    const textObject = makeContext('say "hello"', 6)
    command = input({ type: 'idle' }, 'y', textObject.ctx)
    command = input(command, '1', textObject.ctx)
    command = input(command, 'i', textObject.ctx)
    expect(command).toEqual({
      type: 'operatorTextObj',
      op: 'yank',
      count: 1,
      scope: 'inner',
    })
    command = input(command, '"', textObject.ctx)

    expect(command).toEqual({ type: 'idle' })
    expect(textObject.state.text).toBe('say "hello"')
    expect(textObject.state.register).toBe('hello')
  })

  test('covers g-prefixed operator branches and repeat-find reversal variants', () => {
    const oversizedGg = makeContext('one\ntwo\nthree')
    let command = input({ type: 'idle' }, '9', oversizedGg.ctx)
    command = input(command, 'g', oversizedGg.ctx)
    command = input(command, 'g', oversizedGg.ctx)

    expect(command).toEqual({ type: 'idle' })
    expect(oversizedGg.state.offset).toBe('one\ntwo\n'.length)

    const previousBigWordEnd = makeContext(
      'one two three',
      'one two three'.indexOf('three'),
    )
    command = input({ type: 'idle' }, 'g', previousBigWordEnd.ctx)
    command = input(command, 'E', previousBigWordEnd.ctx)

    expect(command).toEqual({ type: 'idle' })
    expect(previousBigWordEnd.state.offset).toBe('one two'.length - 1)

    const yankVisualDown = makeContext('a\nb')
    command = input(
      { type: 'operatorG', op: 'yank', count: 1 },
      'j',
      yankVisualDown.ctx,
    )

    expect(command).toEqual({ type: 'idle' })
    expect(yankVisualDown.state.changes).toEqual([
      { type: 'operator', op: 'yank', motion: 'gj', count: 1 },
    ])

    const yankVisualUp = makeContext('a\nb', 2)
    command = input(
      { type: 'operatorG', op: 'yank', count: 1 },
      'k',
      yankVisualUp.ctx,
    )

    expect(command).toEqual({ type: 'idle' })
    expect(yankVisualUp.state.changes).toEqual([
      { type: 'operator', op: 'yank', motion: 'gk', count: 1 },
    ])

    const deleteToFirst = makeContext('one\ntwo\nthree', 5)
    command = input({ type: 'idle' }, 'd', deleteToFirst.ctx)
    command = input(command, 'g', deleteToFirst.ctx)
    command = input(command, 'g', deleteToFirst.ctx)

    expect(command).toEqual({ type: 'idle' })
    expect(deleteToFirst.state.text).toBe('three')
    expect(deleteToFirst.state.register).toBe('one\ntwo\n')
    expect(deleteToFirst.state.linewise).toBe(true)

    const reverseTill = makeContext('ab-cd-ef', 7)
    reverseTill.state.lastFind = { type: 't', char: '-' }
    input({ type: 'idle' }, 'N', reverseTill.ctx)
    expect(reverseTill.state.offset).toBe(6)

    const forwardTill = makeContext('ab-cd-ef')
    forwardTill.state.lastFind = { type: 'T', char: '-' }
    input({ type: 'idle' }, 'N', forwardTill.ctx)
    expect(forwardTill.state.offset).toBe(1)

    const noOperatorFindMemory = makeContext('abc')
    command = input({ type: 'idle' }, 'd', noOperatorFindMemory.ctx)
    command = input(command, ';', noOperatorFindMemory.ctx)

    expect(command).toEqual({ type: 'idle' })
    expect(noOperatorFindMemory.state.text).toBe('abc')
    expect(noOperatorFindMemory.state.changes).toEqual([])
  })
})
