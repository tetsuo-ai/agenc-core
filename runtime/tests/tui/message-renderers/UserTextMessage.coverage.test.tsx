import React from 'react'
import { describe, expect, test, vi } from 'vitest'

const features = vi.hoisted(() => new Set<string>())

vi.mock('bun:bundle', () => ({
  feature: (name: string) => features.has(name),
}))

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
}))

import { renderToString } from '../../utils/staticRender.js'
import { UserTextMessage } from './UserTextMessage.js'

function renderUserText(text: string): Promise<string> {
  return renderToString(
    <UserTextMessage
      addMargin={false}
      param={{ type: 'text', text }}
      verbose={false}
    />,
    { columns: 100, rows: 24 },
  )
}

describe('UserTextMessage coverage', () => {
  test('renders feature-gated channel messages with source, user, and body text', async () => {
    features.add('KAIROS_CHANNELS')

    const output = await renderUserText(
      [
        '<channel source="mcp:notifications" user="deploy-bot">',
        'Deploy finished for staging',
        '</channel>',
      ].join('\n'),
    )

    expect(output).toContain('notifications · deploy-bot')
    expect(output).toContain('Deploy finished for staging')
    expect(output).not.toContain('<channel')
  })
})
