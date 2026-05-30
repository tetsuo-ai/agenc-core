import { describe, expect, it } from 'vitest'

import {
  createAbortController,
  createChildAbortController,
} from 'src/utils/abortController.js'

describe('createChildAbortController', () => {
  it('cascades a parent abort to the child (the swarm kill→unblock invariant)', () => {
    const parent = createAbortController()
    const child = createChildAbortController(parent)
    expect(child.signal.aborted).toBe(false)

    parent.abort('killed')
    expect(child.signal.aborted).toBe(true)
  })

  it('does not abort the parent when only the child is aborted (Escape stops the turn, teammate survives)', () => {
    const parent = createAbortController()
    const child = createChildAbortController(parent)

    child.abort('escape')
    expect(child.signal.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
  })

  it('fast-paths an already-aborted parent', () => {
    const parent = createAbortController()
    parent.abort('already')
    const child = createChildAbortController(parent)
    expect(child.signal.aborted).toBe(true)
  })
})
