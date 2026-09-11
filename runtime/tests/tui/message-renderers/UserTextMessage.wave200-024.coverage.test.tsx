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

const originalAgentTeams = process.env.AGENC_EXPERIMENTAL_AGENT_TEAMS

afterEach(() => {
  if (originalUserType === undefined) {
    delete process.env.AGENC_EXPERIMENTAL_AGENT_TEAMS
  } else {
    process.env.AGENC_EXPERIMENTAL_AGENT_TEAMS = originalAgentTeams
  }
})

describe('UserTextMessage wave200-024 coverage', () => {
  test('routes teammate messages when agent swarms are enabled', async () => {
    process.env.AGENC_EXPERIMENTAL_AGENT_TEAMS = '1'

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
