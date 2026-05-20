import React from 'react'
import { describe, expect, test, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
}))

import { renderToString } from '../../utils/staticRender.js'
import { UserTextMessage } from './UserTextMessage.js'

describe('UserTextMessage coverage2', () => {
  test('routes MCP polling updates through the resource update renderer', async () => {
    const output = await renderToString(
      <UserTextMessage
        addMargin={false}
        param={{
          type: 'text',
          text: [
            '<mcp-polling-update type="tool" server="linear" tool="listIssues">',
            '<reason>sync requested</reason>',
            '</mcp-polling-update>',
          ].join(''),
        }}
        verbose={false}
      />,
      { columns: 100, rows: 24 },
    )

    expect(output).toContain('MCP')
    expect(output).toContain('linear')
    expect(output).toContain('listIssues')
    expect(output).toContain('sync requested')
    expect(output).not.toContain('mcp-polling-update')
  })
})
