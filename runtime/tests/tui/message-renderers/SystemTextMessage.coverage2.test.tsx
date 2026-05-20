import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { SystemTextMessage } from './SystemTextMessage.js'

const appState = vi.hoisted(() => ({
  tasks: {
    shell: {
      id: 'shell',
      type: 'local_bash',
      status: 'running',
      description: 'npm test',
      command: 'npm test',
      startTime: 0,
      outputFile: 'urn:agenc:task:shell:output',
      outputOffset: 0,
      notified: false,
      isBackgrounded: true,
    },
  },
}))

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
    getState: () => appState,
  }),
}))

function renderSystemMessage(message: Record<string, unknown>): Promise<string> {
  return renderToString(
    <SystemTextMessage
      message={{ type: 'system', ...message } as never}
      addMargin={false}
      verbose={false}
    />,
    { columns: 100, rows: 24 },
  )
}

describe('SystemTextMessage additional coverage', () => {
  test('renders over-budget turn duration with plural nudges and running task summary', async () => {
    const output = await renderSystemMessage({
      subtype: 'turn_duration',
      durationMs: 3100,
      budgetTokens: 1200,
      budgetLimit: 1000,
      budgetNudges: 2,
    })

    expect(output).toContain('for 3s')
    expect(output).toContain('1.2k used (1.0k min')
    expect(output).toContain('2 nudges')
    expect(output).toContain('1 shell still running')
  })
})
