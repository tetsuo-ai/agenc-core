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

function renderSystemMessage(message: Record<string, unknown>): Promise<string> {
  return renderToString(
    <SystemTextMessage
      message={{ type: 'system', ...message } as never}
      addMargin={true}
      verbose={false}
    />,
    { columns: 80, rows: 24 },
  )
}

describe('SystemTextMessage wave200-010 coverage', () => {
  test('defaults malformed protocol events and keeps only string facts', async () => {
    const output = await renderSystemMessage({
      subtype: 'protocol_event',
      protocolKind: 'unknown',
      facts: [
        null,
        'ignored',
        { label: 'kept', value: 'visible fact' },
        { label: 'missing value' },
        { label: 42, value: 'wrong label' },
      ],
    })

    expect(output).toContain('protocol')
    expect(output).toContain('KEPT')
    expect(output).toContain('visible fact')
    expect(output).not.toContain('missing value')
    expect(output).not.toContain('wrong label')
  })
})
