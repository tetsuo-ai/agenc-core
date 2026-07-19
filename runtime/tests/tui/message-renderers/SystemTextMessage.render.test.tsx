import { PassThrough } from 'node:stream'

import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import type { DOMElement, DOMNode } from '../ink/dom.js'
import instances from '../ink/instances.js'
import { createRoot } from '../ink/root.js'
import { renderToString } from '../../utils/staticRender.js'
import { SystemTextMessage } from './SystemTextMessage.js'

const browserMock = vi.hoisted(() => ({
  openPath: vi.fn(),
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => ({ showTurnDuration: true }),
}))

vi.mock('../../utils/browser.js', () => browserMock)

vi.mock('../state/AppState.js', () => ({
  useAppStateStore: () => ({
    getState: () => ({ tasks: {} }),
  }),
}))

async function renderSystemMessage(
  message: Record<string, unknown>,
  options: {
    addMargin?: boolean
    verbose?: boolean
    isTranscriptMode?: boolean
    columns?: number
  } = {},
): Promise<string> {
  return renderToString(
    <SystemTextMessage
      message={{ type: 'system', ...message } as never}
      addMargin={options.addMargin ?? false}
      verbose={options.verbose ?? false}
      isTranscriptMode={options.isTranscriptMode}
    />,
    { columns: options.columns ?? 100, rows: 24 },
  )
}

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

function createStreams(): { stdin: TestStdin; stdout: PassThrough } {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough()

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.on('data', () => {})
  ;(stdout as unknown as { columns: number }).columns = 100
  ;(stdout as unknown as { rows: number }).rows = 24
  ;(stdout as unknown as { isTTY: boolean }).isTTY = true

  return { stdin, stdout }
}

function getRootNode(stdout: PassThrough): DOMElement {
  const instance = instances.get(stdout as unknown as NodeJS.WriteStream)
  if (!instance?.rootNode) throw new Error('Ink root node not found')
  return instance.rootNode
}

function collectText(node: DOMNode): string {
  if (node.nodeName === '#text') return node.nodeValue
  return node.childNodes.map(collectText).join('')
}

function findClickableBoxByText(node: DOMNode, text: string): DOMElement | undefined {
  if (
    node.nodeName !== '#text' &&
    node.nodeName === 'ink-box' &&
    typeof node._eventHandlers?.onClick === 'function' &&
    collectText(node).includes(text)
  ) {
    return node
  }
  if (node.nodeName === '#text') return undefined
  for (const child of node.childNodes) {
    const found = findClickableBoxByText(child, text)
    if (found) return found
  }
  return undefined
}

function textStyles(
  node: DOMNode,
  text: string,
  inheritedStyles: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  if (node.nodeName === '#text') {
    return node.nodeValue === text ? inheritedStyles : undefined
  }
  const nextStyles = node.textStyles
    ? { ...inheritedStyles, ...node.textStyles }
    : inheritedStyles
  for (const child of node.childNodes) {
    const found = textStyles(child, text, nextStyles)
    if (found) return found
  }
  return undefined
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 2_000) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(message)
}

describe('SystemTextMessage rendering', () => {
  test('renders generic info, warning, and error system messages', async () => {
    await expect(
      renderSystemMessage({
        level: 'info',
        content: 'Context compacted',
      }),
    ).resolves.toContain('Context compacted')

    await expect(
      renderSystemMessage({
        level: 'warning',
        content: 'Watch this',
      }),
    ).resolves.toContain('Watch this')

    await expect(
      renderSystemMessage({
        level: 'error',
        content: 'Broken',
      }),
    ).resolves.toContain('Broken')
  })

  test('renders lightweight status subtypes', async () => {
    await expect(
      renderSystemMessage({
        subtype: 'away_summary',
        content: 'Away summary is ready',
      }),
    ).resolves.toContain('Away summary is ready')

    await expect(
      renderSystemMessage({
        subtype: 'agents_killed',
        content: '',
      }),
    ).resolves.toContain('All background agents stopped')

    await expect(
      renderSystemMessage({
        subtype: 'scheduled_task_fire',
        content: 'Nightly task fired',
      }),
    ).resolves.toContain('Nightly task fired')

    await expect(
      renderSystemMessage({
        subtype: 'permission_retry',
        commands: ['Read', 'Bash'],
      }),
    ).resolves.toContain('Allowed Read, Bash')
  })

  test('renders agent, bridge, and protocol event messages', async () => {
    const agentOutput = await renderSystemMessage({
      subtype: 'collab_agent',
      state: 'running',
      title: 'Fixer is working',
      details: ['reading files', 'running tests'],
    })

    expect(agentOutput).toContain('Fixer is working')
    expect(agentOutput).toContain('reading files')
    expect(agentOutput).toContain('running tests')

    const bridgeOutput = await renderSystemMessage({
      subtype: 'bridge_status',
      url: 'https://example.test/session',
      upgradeNudge: 'Upgrade available',
    })

    expect(bridgeOutput).toContain('/remote-control')
    expect(bridgeOutput).toContain('https://example.test/session')
    expect(bridgeOutput).toContain('Upgrade available')

    const protocolOutput = await renderSystemMessage({
      subtype: 'protocol_event',
      protocolKind: 'stake',
      title: 'Stake posted',
      content: 'Protocol body',
      facts: [
        { label: 'Owner', value: 'AgenC' },
        { label: 'Ignored' },
      ],
    })

    expect(protocolOutput).toContain('Stake posted')
    expect(protocolOutput).toContain('Protocol body')
    expect(protocolOutput).toContain('OWNER')
    expect(protocolOutput).toContain('AgenC')
  })

  test('renders stop-hook summaries for compact, verbose, and transcript views', async () => {
    const message = {
      subtype: 'stop_hook_summary',
      hookCount: 2,
      hookInfos: [
        { command: 'prompt', promptText: 'Review this', durationMs: 200 },
        { command: 'lint', durationMs: 350 },
      ],
      hookErrors: ['lint failed'],
      preventedContinuation: true,
      stopReason: 'blocked by hook',
    }

    const compactOutput = await renderSystemMessage(message)
    expect(compactOutput).toContain('Ran 2 stop hooks')
    expect(compactOutput).toContain('blocked by hook')
    expect(compactOutput).toContain('Stop hook error: lint failed')

    const verboseOutput = await renderSystemMessage(message, { verbose: true })
    expect(verboseOutput).toContain('prompt: Review this')
    expect(verboseOutput).toContain('lint')

    const transcriptOutput = await renderSystemMessage(
      {
        ...message,
        hookLabel: 'notification',
        hookErrors: [],
        preventedContinuation: false,
      },
      { isTranscriptMode: true },
    )
    expect(transcriptOutput).toContain('Ran 2 notification hooks')
    expect(transcriptOutput).toContain('prompt: Review this')
  })

  test('suppresses below-threshold stop-hook summaries without warnings', async () => {
    await expect(
      renderSystemMessage({
        subtype: 'stop_hook_summary',
        hookCount: 1,
        hookInfos: [{ command: 'quick', durationMs: 1 }],
        hookErrors: [],
        preventedContinuation: false,
        totalDurationMs: 1,
      }),
    ).resolves.toBe('\n')
  })

  test('renders visible API retry errors', async () => {
    const output = await renderSystemMessage({
      subtype: 'api_error',
      level: 'error',
      error: new Error('provider unavailable'),
      retryAttempt: 4,
      retryInMs: 3000,
      maxRetries: 6,
    })

    expect(output).toContain('provider unavailable')
    expect(output).toContain('Retrying in 3 seconds... (attempt 4/6)')
  })

  test('renders turn-duration and memory-saved messages', async () => {
    const durationOutput = await renderSystemMessage({
      subtype: 'turn_duration',
      durationMs: 1500,
      budgetTokens: 500,
      budgetLimit: 1000,
      budgetNudges: 1,
    })

    expect(durationOutput).toContain('for 1s')
    expect(durationOutput).toContain('500 / 1.0k (50%)')
    expect(durationOutput).toContain('1 nudge')

    const memoryOutput = await renderSystemMessage({
      subtype: 'memory_saved',
      verb: 'Updated',
      writtenPaths: ['/tmp/agenc-memory-one.md', '/tmp/agenc-memory-two.md'],
    })

    expect(memoryOutput).toContain('Updated 2 memories')
    expect(memoryOutput).toContain('agenc-memory-one.md')
    expect(memoryOutput).toContain('agenc-memory-two.md')
  })

  test('wires memory file hover and click handlers to the rendered path row', async () => {
    const { stdin, stdout } = createStreams()
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    })

    try {
      root.render(
        <SystemTextMessage
          message={{
            type: 'system',
            subtype: 'memory_saved',
            writtenPaths: ['/tmp/agenc-memory-one.md'],
          } as never}
          addMargin={false}
          verbose={false}
        />,
      )

      await waitForCondition(
        () => Boolean(findClickableBoxByText(getRootNode(stdout), 'agenc-memory-one.md')),
        'memory file row did not mount',
      )

      const box = findClickableBoxByText(getRootNode(stdout), 'agenc-memory-one.md')
      expect(box?._eventHandlers?.onMouseEnter).toBeTypeOf('function')
      expect(box?._eventHandlers?.onMouseLeave).toBeTypeOf('function')

      ;(box?._eventHandlers?.onMouseEnter as (() => void) | undefined)?.()
      await waitForCondition(
        () => textStyles(getRootNode(stdout), 'agenc-memory-one.md')?.underline === true,
        'memory file row did not apply hover underline',
      )

      const hoveredBox = findClickableBoxByText(getRootNode(stdout), 'agenc-memory-one.md')
      ;(hoveredBox?._eventHandlers?.onMouseLeave as (() => void) | undefined)?.()
      await waitForCondition(
        () => textStyles(getRootNode(stdout), 'agenc-memory-one.md')?.underline !== true,
        'memory file row did not clear hover underline',
      )

      ;(hoveredBox?._eventHandlers?.onClick as (() => void) | undefined)?.()
      expect(browserMock.openPath).toHaveBeenCalledWith('/tmp/agenc-memory-one.md')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    }
  })

  test('returns no output for intentionally hidden system messages', async () => {
    await expect(
      renderSystemMessage({
        subtype: 'thinking',
        content: 'hidden thought',
      }),
    ).resolves.not.toContain('hidden thought')

    await expect(
      renderSystemMessage({
        level: 'info',
        content: { unexpected: true },
      }),
    ).resolves.toBe('\n')
  })
})

describe('error clamping in the live view', () => {
  const longError = [
    'model not found: grok-4.5-fast',
    'the provider rejected the model id',
    'run /model to pick another one, or check your plan',
    'extra diagnostic line that is noise for the user',
  ].join('\n')

  test('clamps multi-line errors to the first two lines plus an expand hint', async () => {
    const output = await renderSystemMessage(
      { subtype: 'informational', level: 'error', content: longError },
      { verbose: false },
    )

    expect(output).toContain('model not found: grok-4.5-fast')
    expect(output).toContain('the provider rejected the model id')
    expect(output).not.toContain('run /model to pick another one')
    expect(output).not.toContain('extra diagnostic line')
    expect(output).toContain('ctrl+o')
  })

  test('clamps very long single-line errors with an ellipsis', async () => {
    const output = await renderSystemMessage(
      { subtype: 'informational', level: 'error', content: `x${'y'.repeat(500)}` },
      { verbose: false },
    )

    expect(output).toContain('…')
    expect(output.length).toBeLessThan(500)
  })

  test('verbose mode keeps the full error text', async () => {
    const output = await renderSystemMessage(
      { subtype: 'informational', level: 'error', content: longError },
      { verbose: true },
    )

    expect(output).toContain('run /model to pick another one')
    expect(output).toContain('extra diagnostic line')
  })

  test('warnings are not clamped', async () => {
    const output = await renderSystemMessage(
      { subtype: 'informational', level: 'warning', content: longError },
      { verbose: false },
    )

    expect(output).toContain('extra diagnostic line')
  })
})
