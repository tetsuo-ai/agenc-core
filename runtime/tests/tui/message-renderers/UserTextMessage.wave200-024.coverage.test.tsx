import React from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
}))

import { TEAMMATE_MESSAGE_TAG } from '../../constants/xml.js'
import { renderToString } from '../../utils/staticRender.js'
import { UserTextMessage } from './UserTextMessage.js'

const originalUserType = process.env.USER_TYPE

afterEach(() => {
  if (originalUserType === undefined) {
    delete process.env.USER_TYPE
  } else {
    process.env.USER_TYPE = originalUserType
  }
})

describe('UserTextMessage wave200-024 coverage', () => {
  test('routes teammate messages when agent swarms are enabled', async () => {
    process.env.USER_TYPE = 'ant'

    const output = await renderToString(
      <UserTextMessage
        addMargin={false}
        isTranscriptMode={true}
        param={{
          type: 'text',
          text: `<${TEAMMATE_MESSAGE_TAG} teammate_id="reviewer" color="cyan" summary="coverage route">
Renderer selected the teammate branch.
</${TEAMMATE_MESSAGE_TAG}>`,
        }}
        verbose={false}
      />,
      { columns: 100 },
    )

    expect(output).toContain('@reviewer')
    expect(output).toContain('coverage route')
    expect(output).toContain('Renderer selected the teammate branch.')
    expect(output).not.toContain(`<${TEAMMATE_MESSAGE_TAG}`)
  })
})
