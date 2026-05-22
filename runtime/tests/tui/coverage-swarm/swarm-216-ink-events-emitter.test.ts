import { describe, expect, test } from 'vitest'

import { Event } from '../../../src/tui/ink/events/event.ts'
import { EventEmitter } from '../../../src/tui/ink/events/emitter.ts'

describe('EventEmitter coverage swarm row 216', () => {
  test('disables max listener warnings for many input subscribers', () => {
    const emitter = new EventEmitter()

    expect(emitter.getMaxListeners()).toBe(0)
  })

  test('returns false when a normal event has no listeners', () => {
    const emitter = new EventEmitter()

    expect(emitter.emit('keypress', 'x')).toBe(false)
  })

  test('calls normal listeners with the emitter context and payload', () => {
    const emitter = new EventEmitter()
    const calls: Array<{ self: EventEmitter; value: string }> = []

    emitter.on('keypress', function (this: EventEmitter, value: string) {
      calls.push({ self: this, value })
    })
    emitter.on('keypress', function (this: EventEmitter, value: string) {
      calls.push({ self: this, value: value.toUpperCase() })
    })

    expect(emitter.emit('keypress', 'a')).toBe(true)
    expect(calls).toEqual([
      { self: emitter, value: 'a' },
      { self: emitter, value: 'A' },
    ])
  })

  test('stops dispatching Event instances after immediate propagation is stopped', () => {
    const emitter = new EventEmitter()
    const event = new Event()
    const calls: string[] = []

    emitter.on('keypress', (received) => {
      expect(received).toBe(event)
      calls.push('first')
      event.stopImmediatePropagation()
    })
    emitter.on('keypress', () => {
      calls.push('second')
    })

    expect(emitter.emit('keypress', event)).toBe(true)
    expect(calls).toEqual(['first'])
  })

  test('preserves once listeners while using raw listener dispatch', () => {
    const emitter = new EventEmitter()
    const calls: string[] = []

    emitter.once('resize', () => {
      calls.push('once')
    })

    expect(emitter.emit('resize')).toBe(true)
    expect(emitter.emit('resize')).toBe(false)
    expect(calls).toEqual(['once'])
  })

  test('delegates error events to the node emitter semantics', () => {
    const emitter = new EventEmitter()
    const error = new Error('boom')
    const seen: Error[] = []

    emitter.on('error', (received) => {
      seen.push(received)
    })

    expect(emitter.emit('error', error)).toBe(true)
    expect(seen).toEqual([error])
  })
})
