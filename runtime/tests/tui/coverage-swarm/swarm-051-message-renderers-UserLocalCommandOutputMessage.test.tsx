import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { DIAMOND_FILLED } from '../../../src/constants/figures.js'
import { NO_CONTENT_MESSAGE } from '../../../src/constants/messages.js'
import { UserLocalCommandOutputMessage } from '../../../src/tui/message-renderers/UserLocalCommandOutputMessage.js'
import { renderToString } from '../../../src/utils/staticRender.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../../src/tui/hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
}))

describe('UserLocalCommandOutputMessage coverage swarm 051', () => {
  test('renders stderr-only filled launch output without suffix or rest content', async () => {
    const output = await renderToString(
      <UserLocalCommandOutputMessage
        content={[
          '<local-command-stderr>',
          `${DIAMOND_FILLED} finished local setup`,
          '</local-command-stderr>',
        ].join('\n')}
      />,
      { columns: 100, rows: 8 },
    )

    expect(output).toContain(`${DIAMOND_FILLED} finished local setup`)
    expect(output).not.toContain('\u00b7')
    expect(output).not.toContain('\u23bf')
  })

  test('renders stdout-only ordinary output without requiring stderr', async () => {
    const output = await renderToString(
      <UserLocalCommandOutputMessage
        content={[
          '<local-command-stdout>',
          'setup completed',
          '</local-command-stdout>',
        ].join('\n')}
      />,
      { columns: 100, rows: 8 },
    )

    expect(output).toMatch(/\u23bf\s+setup completed/)
  })

  test('ignores whitespace-only output tags without using the fallback', async () => {
    const output = await renderToString(
      <UserLocalCommandOutputMessage
        content={[
          '<local-command-stdout>',
          '   ',
          '</local-command-stdout>',
          '<local-command-stderr>',
          '\t',
          '</local-command-stderr>',
        ].join('\n')}
      />,
      { columns: 100, rows: 8 },
    )

    expect(output.trim()).toBe('')
    expect(output).not.toContain(NO_CONTENT_MESSAGE)
  })
})
