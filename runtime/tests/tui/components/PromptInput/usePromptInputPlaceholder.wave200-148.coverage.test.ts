import { PassThrough } from 'node:stream'

import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const state = {
    appState: { promptSuggestionEnabled: true },
    enabledFeatures: new Set<string>(),
    exampleCommand: '/status',
    proactiveActive: false,
    queuedCommandUpHintCount: 0,
    queuedCommands: [] as Array<{ editable?: boolean }>,
  }

  return {
    state,
    getExampleCommandFromCache: vi.fn(() => state.exampleCommand),
    isPromptInputProactiveActive: vi.fn(() => state.proactiveActive),
    isQueuedCommandEditable: vi.fn(
      (cmd: { editable?: boolean }) => cmd.editable === true,
    ),
    reset() {
      state.appState = { promptSuggestionEnabled: true }
      state.enabledFeatures.clear()
      state.exampleCommand = '/status'
      state.proactiveActive = false
      state.queuedCommandUpHintCount = 0
      state.queuedCommands = []
      this.getExampleCommandFromCache.mockClear()
      this.isPromptInputProactiveActive.mockClear()
      this.isQueuedCommandEditable.mockClear()
    },
  }
})

vi.mock('bun:bundle', () => ({
  feature: (name: string) => fixture.state.enabledFeatures.has(name),
}))

vi.mock('../../hooks/useCommandQueue.js', () => ({
  useCommandQueue: () => fixture.state.queuedCommands,
}))

vi.mock('../../state/AppState.js', () => ({
  useAppState: (
    selector: (state: typeof fixture.state.appState) => unknown,
  ) => selector(fixture.state.appState),
}))

vi.mock('../../../utils/config.js', () => ({
  getGlobalConfig: () => ({
    queuedCommandUpHintCount: fixture.state.queuedCommandUpHintCount,
  }),
}))

vi.mock('../../../utils/exampleCommands.js', () => ({
  getExampleCommandFromCache: fixture.getExampleCommandFromCache,
}))

vi.mock('../../../utils/messageQueueManager.js', () => ({
  isQueuedCommandEditable: fixture.isQueuedCommandEditable,
}))

vi.mock('./proactiveAdapter.js', () => ({
  isPromptInputProactiveActive: fixture.isPromptInputProactiveActive,
}))

import { createRoot } from '../../ink/root.js'
import { usePromptInputPlaceholder } from './usePromptInputPlaceholder.js'

type PlaceholderProps = Parameters<typeof usePromptInputPlaceholder>[0]

function createStreams(): {
  readonly stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  readonly stdout: PassThrough
} {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  const stdout = new PassThrough()

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  ;(stdout as unknown as { columns: number }).columns = 100

  return { stdin, stdout }
}

async function sleep(ms = 0): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function renderPlaceholder(
  props: Partial<PlaceholderProps> = {},
): Promise<string | undefined> {
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  let didRender = false
  let placeholder: string | undefined

  function Harness(): null {
    placeholder = usePromptInputPlaceholder({
      input: '',
      submitCount: 0,
      ...props,
    })
    didRender = true
    return null
  }

  try {
    root.render(React.createElement(Harness))
    await sleep()
    if (!didRender) throw new Error('placeholder hook did not render')
    return placeholder
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await sleep()
  }
}

async function expectPlaceholder(
  setup: () => void,
  expected: string | undefined,
  props: Partial<PlaceholderProps> = {},
): Promise<void> {
  fixture.reset()
  setup()
  await expect(renderPlaceholder(props)).resolves.toBe(expected)
}

describe('usePromptInputPlaceholder coverage', () => {
  afterEach(() => {
    fixture.reset()
  })

  test('prioritizes teammate, queue, suggestion, and proactive placeholder states', async () => {
    await expectPlaceholder(
      () => {
        fixture.state.queuedCommands = [{ editable: true }]
      },
      undefined,
      { input: 'draft', viewingAgentName: 'builder' },
    )

    await expectPlaceholder(
      () => {},
      'Message @builder\u2026',
      { viewingAgentName: 'builder' },
    )

    await expectPlaceholder(
      () => {},
      'Message @abcdefghijklmnopq...\u2026',
      { viewingAgentName: 'abcdefghijklmnopqrstu' },
    )

    await expectPlaceholder(
      () => {
        fixture.state.queuedCommands = [{ editable: true }]
        fixture.state.queuedCommandUpHintCount = 2
      },
      'Press up to edit queued messages',
    )

    await expectPlaceholder(
      () => {
        fixture.state.queuedCommands = [{ editable: false }]
      },
      '/status',
    )

    await expectPlaceholder(
      () => {
        fixture.state.queuedCommands = [{ editable: true }]
        fixture.state.queuedCommandUpHintCount = 3
      },
      '/status',
    )

    await expectPlaceholder(
      () => {
        fixture.state.appState.promptSuggestionEnabled = false
      },
      // Cold start with suggestions disabled: instead of a blank composer, the
      // hook now surfaces the stable on-brand guidance hint, advertising both
      // the `/` command and `@` attach affordances.
      'Describe a task · / for commands · @ to attach a file',
    )

    await expectPlaceholder(() => {}, undefined, { submitCount: 1 })

    await expectPlaceholder(
      () => {
        fixture.state.proactiveActive = true
      },
      '/status',
    )

    await expectPlaceholder(
      () => {
        fixture.state.enabledFeatures.add('PROACTIVE')
      },
      '/status',
    )

    await expectPlaceholder(
      () => {
        fixture.state.enabledFeatures.add('PROACTIVE')
        fixture.state.proactiveActive = true
      },
      undefined,
    )

    await expectPlaceholder(
      () => {
        fixture.state.enabledFeatures.add('KAIROS')
        fixture.state.proactiveActive = true
      },
      undefined,
    )
  })
})
