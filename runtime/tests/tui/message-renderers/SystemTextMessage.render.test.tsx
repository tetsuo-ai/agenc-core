import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { SystemTextMessage } from './SystemTextMessage.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => ({ showTurnDuration: true }),
}))

vi.mock('../../utils/browser.js', () => ({
  openPath: () => {},
}))

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
