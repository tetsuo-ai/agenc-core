import React from 'react'
import { describe, expect, test, vi } from 'vitest'

import { renderToString } from '../../utils/staticRender.js'
import { MessageActionsSelectedContext } from '../components/messageActions.js'
import { AssistantTextMessage } from './AssistantTextMessage.js'

vi.mock('../hooks/useSettings.js', () => ({
  useSettings: () => ({
    syntaxHighlightingDisabled: true,
  }),
}))

describe('AssistantTextMessage ordinary text coverage', () => {
  test('renders ordinary assistant text through the AgenC message chrome when selected', async () => {
    const output = await renderToString(
      <MessageActionsSelectedContext.Provider value={true}>
        <AssistantTextMessage
          param={{ type: 'text', text: '**Ready** to proceed' }}
          addMargin={true}
          shouldShowDot={false}
          verbose={false}
        />
      </MessageActionsSelectedContext.Provider>,
      100,
    )

    expect(output).toContain('AGENC')
    expect(output).toContain('Ready to proceed')
  })
})
