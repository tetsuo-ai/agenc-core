import { describe, expect, test } from 'vitest'

import { renderableSearchText } from './transcriptSearch.js'

describe('renderableSearchText transcript attachment coverage', () => {
  test('indexes visible transcript-only attachment text and collapsed memories', () => {
    expect(renderableSearchText({
      type: 'attachment',
      attachment: {
        type: 'relevant_memories',
        memories: [
          { content: 'Memory Alpha' },
          {
            content:
              'Before <system-reminder>hidden reminder</system-reminder> After',
          },
        ],
      },
    } as never)).toBe('memory alpha\nbefore  after')

    expect(renderableSearchText({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        commandMode: 'prompt',
        isMeta: false,
        prompt: [
          { type: 'text', text: 'Queued Followup' },
          { type: 'image', source: 'ignored-image' },
          { type: 'text', text: 'Second Line' },
        ],
      },
    } as never)).toBe('queued followup\nsecond line')

    expect(renderableSearchText({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        commandMode: 'task-notification',
        isMeta: false,
        prompt: 'Hidden task notice',
      },
    } as never)).toBe('')

    expect(renderableSearchText({
      type: 'collapsed_read_search',
      relevantMemories: [
        { content: 'Collapsed Memory' },
        { content: 'Visible Search Hit' },
      ],
    } as never)).toBe('collapsed memory\nvisible search hit')
  })
})
