import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import { renderToString } from '../../utils/staticRender.js'
import { UserLocalCommandOutputMessage } from './UserLocalCommandOutputMessage.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
}))

describe('UserLocalCommandOutputMessage wave200-125 coverage', () => {
  test('renders the no-content fallback when local command output tags are absent', async () => {
    const output = await renderToString(
      <UserLocalCommandOutputMessage content="plain command transcript" />,
      { columns: 80, rows: 6 },
    )

    expect(output).toContain(NO_CONTENT_MESSAGE)
    expect(output).not.toContain('plain command transcript')
    expect(output).not.toContain('local-command-stdout')
    expect(output).not.toContain('local-command-stderr')
  })
})
