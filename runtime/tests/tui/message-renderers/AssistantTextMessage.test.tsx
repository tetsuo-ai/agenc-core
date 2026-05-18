import React from 'react'
import { describe, expect, it } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { AssistantTextMessage } from './AssistantTextMessage.js'

describe('AssistantTextMessage', () => {
  it('renders classified rate-limit messages instead of dropping them', async () => {
    const output = await renderToString(
      <AssistantTextMessage
        param={{
          type: 'text',
          text: "You've hit your session limit",
        }}
        addMargin={false}
        shouldShowDot={false}
        verbose={false}
      />,
      80,
    )

    expect(output).toContain("You've hit your session limit")
  })
})
