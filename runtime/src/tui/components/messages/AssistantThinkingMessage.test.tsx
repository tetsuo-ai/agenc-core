import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import { AppStateProvider } from '../../state/AppState.js'
import { AssistantRedactedThinkingMessage } from './AssistantRedactedThinkingMessage.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'

const previousGlyphMode = process.env.AGENC_TUI_GLYPHS

afterEach(() => {
  if (previousGlyphMode === undefined) {
    delete process.env.AGENC_TUI_GLYPHS
  } else {
    process.env.AGENC_TUI_GLYPHS = previousGlyphMode
  }
})

describe('AssistantThinkingMessage', () => {
  it('uses ASCII thinking labels when ASCII glyph mode is requested', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const output = await renderToString(
      <AppStateProvider>
        <AssistantThinkingMessage
          param={{ type: 'thinking', thinking: 'working' }}
          addMargin={false}
          isTranscriptMode={true}
          verbose={false}
        />
      </AppStateProvider>,
      80,
    )

    expect(output).toContain('Thinking...')
    expect(output).toContain('working')
    expect(output).not.toContain('∴')
    expect(output).not.toContain('…')
  })

  it('uses ASCII redacted-thinking labels when ASCII glyph mode is requested', async () => {
    process.env.AGENC_TUI_GLYPHS = 'ascii'

    const output = await renderToString(
      <AssistantRedactedThinkingMessage addMargin={false} />,
      80,
    )

    expect(output).toContain('* Thinking...')
    expect(output).not.toContain('✻')
    expect(output).not.toContain('…')
  })
})
