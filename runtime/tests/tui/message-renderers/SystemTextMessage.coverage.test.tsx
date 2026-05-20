import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { SystemTextMessage } from './SystemTextMessage.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../utils/config.js', () => ({
  getGlobalConfig: () => ({ showTurnDuration: false }),
}))

vi.mock('../../utils/browser.js', () => ({
  openPath: () => {},
}))

vi.mock('../state/AppState.js', () => ({
  useAppStateStore: () => ({
    getState: () => ({ tasks: {} }),
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

describe('SystemTextMessage coverage', () => {
  test('keeps budget usage visible when turn-duration text is disabled', async () => {
    const budgetOnly = await renderSystemMessage({
      subtype: 'turn_duration',
      durationMs: 2400,
      budgetTokens: 4000,
      budgetLimit: 8000,
      budgetNudges: 0,
    })

    expect(budgetOnly).toContain('4.0k / 8.0k (50%)')
    expect(budgetOnly).not.toContain('for 2s')

    await expect(
      renderSystemMessage({
        subtype: 'turn_duration',
        durationMs: 2400,
        budgetNudges: 0,
      }),
    ).resolves.toBe('\n')
  })
})
