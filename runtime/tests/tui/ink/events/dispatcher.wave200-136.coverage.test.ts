import {
  ContinuousEventPriority,
  DefaultEventPriority,
  DiscreteEventPriority,
} from 'react-reconciler/constants.js'
import { expect, test } from 'vitest'

import { Dispatcher } from './dispatcher.ts'
import { TerminalEvent, type EventTarget } from './terminal-event.ts'

type TestTarget = EventTarget & {
  name: string
  _eventHandlers?: Record<string, (event: TerminalEvent) => void>
}

class RecordingEvent extends TerminalEvent {
  readonly preparedTargets: string[] = []

  override _prepareForTarget(target: EventTarget): void {
    this.preparedTargets.push(
      `${(target as TestTarget).name}:${this.eventPhase}`,
    )
  }
}

function node(
  name: string,
  parentNode?: TestTarget,
  _eventHandlers?: TestTarget['_eventHandlers'],
): TestTarget {
  return { name, parentNode, _eventHandlers }
}

test('dispatches terminal events through phases, propagation stops, and priority wrappers', () => {
  const dispatcher = new Dispatcher()
  const calls: string[] = []
  const priorities: number[] = []

  const root = node('root', undefined, {
    onKeyDownCapture: event => {
      calls.push(
        `${(event.currentTarget as TestTarget).name}:${event.eventPhase}`,
      )
      priorities.push(dispatcher.resolveEventPriority())
    },
    onKeyDown: event => {
      calls.push(
        `${(event.currentTarget as TestTarget).name}:${event.eventPhase}`,
      )
    },
  })
  const parent = node('parent', root, {
    onKeyDownCapture: event => {
      calls.push(
        `${(event.currentTarget as TestTarget).name}:${event.eventPhase}`,
      )
    },
    onKeyDown: event => {
      calls.push(
        `${(event.currentTarget as TestTarget).name}:${event.eventPhase}`,
      )
    },
  })
  const child = node('child', parent, {
    onKeyDownCapture: event => {
      calls.push(
        `${(event.currentTarget as TestTarget).name}:${event.eventPhase}`,
      )
      event.stopPropagation()
    },
    onKeyDown: event => {
      calls.push(
        `${(event.currentTarget as TestTarget).name}:${event.eventPhase}`,
      )
      event.preventDefault()
    },
  })

  const previousEvent = new TerminalEvent('previous')
  const event = new RecordingEvent('keydown')
  dispatcher.currentEvent = previousEvent

  expect(dispatcher.dispatch(child, event)).toBe(false)
  expect(dispatcher.currentEvent).toBe(previousEvent)
  expect(event.target).toBe(child)
  expect(event.currentTarget).toBeNull()
  expect(event.eventPhase).toBe('none')
  expect(calls).toEqual([
    'root:capturing',
    'parent:capturing',
    'child:at_target',
    'child:at_target',
  ])
  expect(event.preparedTargets).toEqual([
    'root:capturing',
    'parent:capturing',
    'child:at_target',
    'child:at_target',
  ])
  expect(priorities).toEqual([DiscreteEventPriority])

  const nonBubblingCalls: string[] = []
  const nonBubblingParent = node('non-bubbling-parent', undefined, {
    onKeyDown: () => nonBubblingCalls.push('parent'),
  })
  const nonBubblingChild = node('non-bubbling-child', nonBubblingParent, {
    onKeyDown: () => nonBubblingCalls.push('child'),
  })
  expect(
    dispatcher.dispatch(
      nonBubblingChild,
      new TerminalEvent('keydown', { bubbles: false }),
    ),
  ).toBe(true)
  expect(nonBubblingCalls).toEqual(['child'])

  const immediateCalls: string[] = []
  const immediateTarget = node('immediate', undefined, {
    onKeyDownCapture: event => {
      immediateCalls.push('capture')
      event.stopImmediatePropagation()
    },
    onKeyDown: () => immediateCalls.push('bubble'),
  })
  expect(dispatcher.dispatch(immediateTarget, new TerminalEvent('keydown'))).toBe(
    true,
  )
  expect(immediateCalls).toEqual(['capture'])

  expect(dispatcher.dispatch(child, new TerminalEvent('unknown'))).toBe(true)
  const clickTarget = node('clickable', undefined, { onClick: () => {} })
  expect(
    dispatcher.dispatch(clickTarget, new TerminalEvent('click')),
  ).toBe(true)

  for (const type of ['keydown', 'keyup', 'click', 'focus', 'blur', 'paste']) {
    dispatcher.currentEvent = new TerminalEvent(type)
    expect(dispatcher.resolveEventPriority()).toBe(DiscreteEventPriority)
  }
  for (const type of ['resize', 'scroll', 'mousemove']) {
    dispatcher.currentEvent = new TerminalEvent(type)
    expect(dispatcher.resolveEventPriority()).toBe(ContinuousEventPriority)
  }
  dispatcher.currentEvent = new TerminalEvent('custom')
  expect(dispatcher.resolveEventPriority()).toBe(DefaultEventPriority)
  dispatcher.currentEvent = null
  expect(dispatcher.resolveEventPriority()).toBe(DefaultEventPriority)

  const continuousPriorityTarget = node('continuous-priority', undefined, {
    onKeyDown: () => {
      priorities.push(dispatcher.resolveEventPriority())
    },
  })
  expect(
    dispatcher.dispatchContinuous(
      continuousPriorityTarget,
      new TerminalEvent('keydown'),
    ),
  ).toBe(true)
  expect(dispatcher.currentUpdatePriority).toBe(0)
  expect(priorities.at(-1)).toBe(ContinuousEventPriority)

  const fallbackDispatcher = new Dispatcher()
  expect(
    fallbackDispatcher.dispatchDiscrete(
      node('discrete-fallback'),
      new TerminalEvent('keydown'),
    ),
  ).toBe(true)
})
