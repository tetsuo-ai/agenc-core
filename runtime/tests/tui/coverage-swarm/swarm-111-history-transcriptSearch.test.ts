import { describe, expect, test, vi } from 'vitest'

import {
  renderableSearchText,
  toolResultSearchText,
  toolUseSearchText,
} from '../../../src/tui/history/transcriptSearch.js'

vi.mock('../../../src/utils/messages.js', () => ({
  INTERRUPT_MESSAGE: '[Request interrupted by user]',
  INTERRUPT_MESSAGE_FOR_TOOL_USE: '[Request interrupted by user for tool use]',
}))

const INTERRUPT_FOR_TOOL_USE = '[Request interrupted by user for tool use]'

describe('transcriptSearch coverage swarm row 111', () => {
  test('returns cached lowercase text for the same renderable message object', () => {
    const message = {
      type: 'user',
      message: {
        content: 'Original Search Text',
      },
    } as never

    expect(renderableSearchText(message)).toBe('original search text')

    ;(message as { message: { content: string } }).message.content =
      'Mutated Search Text'

    expect(renderableSearchText(message)).toBe('original search text')
  })

  test('filters user content blocks and strips only closed system reminders', () => {
    expect(
      renderableSearchText({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'Visible User Text' },
            { type: 'text', text: INTERRUPT_FOR_TOOL_USE },
            { type: 'tool_result', content: 'model-facing hidden text' },
            { type: 'image', source: 'ignored-image' },
          ],
        },
        toolUseResult: {
          file: {
            content:
              'File Body <system-reminder>hidden context</system-reminder> Tail',
          },
        },
      } as never),
    ).toBe('visible user text\nfile body  tail')

    expect(
      renderableSearchText({
        type: 'user',
        message: {
          content: 'Keep <system-reminder>unfinished reminder',
        },
      } as never),
    ).toBe('keep <system-reminder>unfinished reminder')
  })

  test('indexes only visible queued command prompt attachments', () => {
    expect(
      renderableSearchText({
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          isMeta: false,
          prompt: 'Queued Prompt Text',
        },
      } as never),
    ).toBe('queued prompt text')

    expect(
      renderableSearchText({
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          isMeta: true,
          prompt: 'Meta Prompt Text',
        },
      } as never),
    ).toBe('')

    expect(
      renderableSearchText({
        type: 'attachment',
        attachment: {
          type: 'other_attachment',
          prompt: 'Invisible Attachment Text',
        },
      } as never),
    ).toBe('')

    expect(
      renderableSearchText({
        type: 'collapsed_read_search',
      } as never),
    ).toBe('')
  })

  test('extracts tool use text from rendered fields and ignores malformed values', () => {
    expect(toolUseSearchText(null)).toBe('')
    expect(toolUseSearchText('command text')).toBe('')

    expect(
      toolUseSearchText({
        command: 'npm test',
        path: 'src/file.ts',
        description: 'short description',
        query: 123,
        args: ['--run', 'suite'],
        files: ['visible.txt', 2],
      }),
    ).toBe('npm test\nsrc/file.ts\nshort description\n--run suite')
  })

  test('extracts tool result text from known rendered shapes only', () => {
    expect(toolResultSearchText('plain result')).toBe('plain result')
    expect(toolResultSearchText(undefined)).toBe('')
    expect(toolResultSearchText({ stdout: 'only stdout' })).toBe('only stdout')

    expect(
      toolResultSearchText({
        file: { content: 'read file body' },
        output: 'ignored fallback',
      }),
    ).toBe('read file body')

    expect(
      toolResultSearchText({
        file: { path: 'missing-content.txt' },
        output: 'fallback output',
      }),
    ).toBe('fallback output')

    expect(
      toolResultSearchText({
        content: 'content field',
        output: 'output field',
        result: 'result field',
        text: 'text field',
        message: 'message field',
        filenames: ['a.ts', 'b.ts'],
        lines: ['line one'],
        results: ['match one'],
        mixed: ['ignored', 4],
        rawOutputPath: 'hidden metadata',
      }),
    ).toBe(
      'content field\noutput field\nresult field\ntext field\nmessage field\na.ts\nb.ts\nline one\nmatch one',
    )

    expect(toolResultSearchText({ durationMs: 'hidden metadata' })).toBe('')
  })
})
