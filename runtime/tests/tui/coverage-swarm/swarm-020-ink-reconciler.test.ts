import { PassThrough } from 'node:stream'

import React from 'react'
import { expect, test, vi } from 'vitest'

import type { DOMElement, ElementNames } from '../ink/dom.ts'
import type { Root } from '../ink/root.ts'

vi.mock('../../utils/fullscreen.js', () => ({
  isMouseClicksDisabled: () => false,
}))

type TestStdout = PassThrough & {
  columns: number
  rows: number
  isTTY: boolean
}

type TestStdin = PassThrough & {
  isTTY: boolean
  setRawMode: (mode: boolean) => void
  ref: () => void
  unref: () => void
}

type InstancesMap = {
  get: (stdout: NodeJS.WriteStream) => { rootNode?: DOMElement } | undefined
}

const RAW_TEXT_STYLE = {
  flexDirection: 'row',
  flexGrow: 0,
  flexShrink: 1,
  textWrap: 'wrap',
} as const

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createTestStreams(): {
  stdout: TestStdout
  stdin: TestStdin
  stderr: PassThrough
  stderrWrites: string[]
} {
  const stdout = new PassThrough() as TestStdout
  const stdin = new PassThrough() as TestStdin
  const stderr = new PassThrough()
  const stderrWrites: string[] = []

  stderr.on('data', chunk => {
    stderrWrites.push(Buffer.from(chunk).toString('utf8'))
  })

  stdout.columns = 80
  stdout.rows = 24
  stdout.isTTY = true

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}

  return { stdout, stdin, stderr, stderrWrites }
}

async function createHarness(): Promise<{
  root: Root
  stdout: TestStdout
  stdin: TestStdin
  stderr: PassThrough
  stderrWrites: string[]
  instances: InstancesMap
  dispose: () => Promise<void>
}> {
  const [{ createRoot }, { default: instances }] = await Promise.all([
    import('../ink/root.ts'),
    import('../ink/instances.ts'),
  ])
  const { stdout, stdin, stderr, stderrWrites } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })

  return {
    root,
    stdout,
    stdin,
    stderr,
    stderrWrites,
    instances: instances as InstancesMap,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      stderr.end()
      await sleep(25)
    },
  }
}

function getRootNode(stdout: TestStdout, instances: InstancesMap): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)

  if (!instance?.rootNode) {
    throw new Error('Ink root node not found')
  }

  return instance.rootNode
}

function collectElements(
  node: DOMElement,
  nodeName: ElementNames,
  found: DOMElement[] = [],
): DOMElement[] {
  if (node.nodeName === nodeName) {
    found.push(node)
  }

  for (const child of node.childNodes) {
    if (child.nodeName !== '#text') {
      collectElements(child, nodeName, found)
    }
  }

  return found
}

function requireElement(
  stdout: TestStdout,
  instances: InstancesMap,
  nodeName: ElementNames,
): DOMElement {
  const found = collectElements(getRootNode(stdout, instances), nodeName)[0]

  if (!found) {
    throw new Error(`Expected to find ${nodeName}`)
  }

  return found
}

async function waitForCondition(
  predicate: () => boolean,
  errorMessage: string,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < 1000) {
    if (predicate()) {
      return
    }

    await sleep(10)
  }

  throw new Error(errorMessage)
}

test('debug repaint flag is parsed lazily and cached', async () => {
  const previous = process.env.AGENC_DEBUG_REPAINTS

  try {
    vi.resetModules()
    process.env.AGENC_DEBUG_REPAINTS = '1'
    const enabledModule = await import('../ink/reconciler.ts')

    expect(enabledModule.isDebugRepaintsEnabled()).toBe(true)
    process.env.AGENC_DEBUG_REPAINTS = '0'
    expect(enabledModule.isDebugRepaintsEnabled()).toBe(true)

    vi.resetModules()
    process.env.AGENC_DEBUG_REPAINTS = '0'
    const disabledModule = await import('../ink/reconciler.ts')

    expect(disabledModule.isDebugRepaintsEnabled()).toBe(false)
  } finally {
    if (previous === undefined) {
      delete process.env.AGENC_DEBUG_REPAINTS
    } else {
      process.env.AGENC_DEBUG_REPAINTS = previous
    }
    vi.resetModules()
  }
})

test('owner chain walk stops at the reconciler fiber limit', async () => {
  const { getOwnerChain } = await import('../ink/reconciler.ts')
  let fiber: { elementType: { name: string }; return?: unknown } | undefined

  for (let index = 59; index >= 0; index--) {
    fiber = {
      elementType: { name: `Owner${index}` },
      return: fiber,
    }
  }

  expect(getOwnerChain(fiber)).toHaveLength(50)
  expect(getOwnerChain(fiber)[0]).toBe('Owner0')
  expect(getOwnerChain(fiber).at(-1)).toBe('Owner49')
})

test('profile counters expose last yoga time and reset cleanly', async () => {
  const {
    getLastCommitMs,
    getLastYogaMs,
    markCommitStart,
    recordYogaMs,
    resetProfileCounters,
  } = await import('../ink/reconciler.ts')

  recordYogaMs(12.5)
  markCommitStart()

  expect(getLastYogaMs()).toBe(12.5)

  resetProfileCounters()

  expect(getLastYogaMs()).toBe(0)
  expect(getLastCommitMs()).toBe(0)
})

test('test-mode commits call immediate render for content and skip empty unmounts', async () => {
  const harness = await createHarness()

  try {
    const rootNode = getRootNode(harness.stdout, harness.instances)
    const originalImmediateRender = rootNode.onImmediateRender
    const immediateRender = vi.fn(() => originalImmediateRender?.())
    rootNode.onImmediateRender = immediateRender

    harness.root.render(React.createElement('ink-box', null, 'content'))

    await waitForCondition(
      () => immediateRender.mock.calls.length > 0,
      'Timed out waiting for initial immediate render',
    )

    const callsAfterContent = immediateRender.mock.calls.length
    expect(rootNode.hasRenderedContent).toBe(true)

    harness.root.unmount()
    await sleep(50)

    expect(immediateRender).toHaveBeenCalledTimes(callsAfterContent)
  } finally {
    await harness.dispose()
  }
})

test('deleted host props reset attributes and style on rerender', async () => {
  const harness = await createHarness()

  try {
    harness.root.render(
      React.createElement(
        'ink-box',
        {
          role: 'button',
          style: { flexDirection: 'column', paddingLeft: 2 },
        },
        'first',
      ),
    )
    await sleep(25)

    const box = requireElement(harness.stdout, harness.instances, 'ink-box')
    expect(box.attributes.role).toBe('button')
    expect(box.style).toMatchObject({
      flexDirection: 'column',
      paddingLeft: 2,
    })

    harness.root.render(React.createElement('ink-box', null, 'second'))
    await sleep(25)

    const sameBox = requireElement(harness.stdout, harness.instances, 'ink-box')
    expect(sameBox).toBe(box)
    expect(sameBox.attributes.role).toBeUndefined()
    expect(sameBox.style).toEqual({})
  } finally {
    await harness.dispose()
  }
})

test('removed host child is detached and has layout references cleared', async () => {
  const harness = await createHarness()

  try {
    harness.root.render(
      React.createElement(
        'ink-box',
        null,
        React.createElement('ink-box', { id: 'removed-child' }, 'child'),
      ),
    )
    await sleep(25)

    const rootNode = getRootNode(harness.stdout, harness.instances)
    const removedChild = collectElements(rootNode, 'ink-box').find(
      node => node.attributes.id === 'removed-child',
    )

    if (!removedChild) {
      throw new Error('Expected nested child before removal')
    }

    expect(removedChild.parentNode).toBeDefined()
    expect(removedChild.yogaNode).toBeDefined()

    harness.root.render(React.createElement('ink-box', null, 'replacement'))

    await waitForCondition(
      () => removedChild.parentNode === undefined,
      'Timed out waiting for removed child to detach',
    )

    expect(removedChild.yogaNode).toBeUndefined()
  } finally {
    await harness.dispose()
  }
})

test('reconciler rejects boxes nested inside text hosts', async () => {
  const harness = await createHarness()

  try {
    harness.root.render(
      React.createElement(
        'ink-text',
        { style: RAW_TEXT_STYLE },
        React.createElement('ink-box', null, 'invalid'),
      ),
    )

    await waitForCondition(
      () =>
        harness.stderrWrites
          .join('')
          .includes("<Box> can't be nested inside <Text> component"),
      'Timed out waiting for nested box render error',
    )
  } finally {
    await harness.dispose()
  }
})
