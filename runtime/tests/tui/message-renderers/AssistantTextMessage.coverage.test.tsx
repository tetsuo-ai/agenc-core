import { homedir } from "node:os";
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

    // AgenC chrome is the ● glyph; the agenc label itself is hidden.
    expect(output).toContain('● Ready to proceed')
    expect(output).not.toContain('AGENC')
  })
})

 test('abbreviates assistant memory paths without mutating the message', async () => {
  const param = { type: 'text' as const, text: `Saved to ${homedir()}/.agenc/memory/topic.md` };
  const output = await renderToString(<AssistantTextMessage param={param} addMargin={false} shouldShowDot={false} verbose={false} />, 120);
  expect(output).toContain('~/.agenc/memory/topic.md');
  expect(output).not.toContain(homedir());
  expect(param.text).toContain(homedir());
});
