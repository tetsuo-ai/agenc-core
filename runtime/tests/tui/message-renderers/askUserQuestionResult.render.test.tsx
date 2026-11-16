import React from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

import type { Tools } from '../../../src/tools/Tool.js'
import { renderToString } from '../../../src/utils/staticRender.js'
// The REAL daemon transcript projection and the REAL result-row renderer: the
// owner saw the model-facing AskUserQuestion result ("User has answered your
// questions: ... You can now continue with the user's answers in mind.")
// printed in the transcript after answering a picker (0.19.36).
import { createTuiTools } from '../../../src/tui/tool-rendering.js'
import { adaptTranscriptEvents } from '../../../src/tui/session-transcript.js'
import { normalizeMessages } from '../../../src/utils/messages.js'
import { UserToolSuccessMessage } from '../../../src/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.js'

vi.mock('../../../src/tui/hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 100, rows: 24 }),
}))
vi.mock('../../../src/utils/classifierApprovalsHook.js', () => ({
  useIsClassifierChecking: () => false,
}))
vi.mock('../../../src/tui/state/AppState.js', () => ({
  useAppState: (selector: (state: { isBriefOnly: boolean }) => unknown) =>
    selector({ isBriefOnly: false }),
  useAppStateMaybeOutsideOfProvider: (selector: (state: unknown) => unknown) =>
    selector({ pendingWorkerRequest: undefined, toolPermissionContext: { mode: 'default' } }),
}))
vi.mock('../../../src/tui/ink.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/tui/ink.js')
  >('../../../src/tui/ink.js')
  return { ...actual, useTheme: () => ['dark'] }
})

const tools = createTuiTools(['AskUserQuestion']) as unknown as Tools
const SUFFIX = ". You can now continue with the user's answers in mind."
const QUESTIONS = [
  {
    header: 'Focus',
    question: 'What should I focus on?',
    options: [
      { label: 'General health check (Recommended)', description: 'Look at everything' },
      { label: 'Disk only', description: 'Only disks' },
    ],
  },
  {
    header: 'Depth',
    question: 'How deep?',
    options: [
      { label: 'Quick', description: 'Fast' },
      { label: 'Full', description: 'Slow' },
    ],
  },
]

const event = (id: string, type: string, payload: Record<string, unknown>) => ({ id, type, payload })

async function renderRow(completed: Record<string, unknown>, questions = QUESTIONS): Promise<{
  readonly screen: string
  readonly content: string
}> {
  const transcript = adaptTranscriptEvents([
    event('start', 'tool_call_started', {
      callId: 'ask-1',
      toolName: 'AskUserQuestion',
      args: JSON.stringify({ questions }),
    }),
    event('done', 'tool_call_completed', { callId: 'ask-1', toolName: 'AskUserQuestion', isError: false, ...completed }),
  ] as never)
  const normalized = normalizeMessages(transcript.messages as never)
  const message = normalized.find((row: any) => row.type === 'user') as any
  expect(message, 'tool result row').toBeDefined()
  const block = message.message.content[0]
  const content = typeof block.content === 'string'
    ? block.content
    : block.content.map((part: { text: string }) => part.text).join('\n')
  const tool = (tools as readonly { name: string }[]).find((t) => t.name === 'AskUserQuestion')
  const lookups = {
    resolvedToolUseIDs: new Set<string>(['ask-1']),
    erroredToolUseIDs: new Set<string>(),
    toolResultByToolUseID: new Map([['ask-1', message]]),
    toolUseByToolUseID: new Map([['ask-1', { input: { questions } }]]),
    inProgressHookCounts: new Map<string, Map<string, number>>(),
    resolvedHookCounts: new Map<string, Map<string, number>>(),
  } as never
  const screen = await renderToString(
    <UserToolSuccessMessage
      message={message}
      lookups={lookups}
      toolUseID="ask-1"
      progressMessagesForMessage={[]}
      tool={tool as never}
      tools={tools}
      verbose={false}
      width={100}
    />,
    100,
  )
  return { screen, content }
}

function expectNoModelText(text: string): void {
  expect(text).not.toContain('User has answered your questions')
  expect(text).not.toContain('You can now continue')
  expect(text).not.toContain("User answered AgenC's questions")
  expect(text).not.toContain('User skipped')
  expect(text).not.toContain('best judgment')
}

describe('AskUserQuestion result row (daemon transcript)', () => {
  it('shows the question and the chosen answer from the result metadata', async () => {
    const { screen, content } = await renderRow({
      result: `User has answered your questions: "What should I focus on?"="General health check (Recommended)"${SUFFIX}`,
      metadata: {
        askUserQuestion: {
          outcome: 'answered',
          entries: [{ question: 'What should I focus on?', answer: 'General health check (Recommended)' }],
        },
      },
    })
    expect(screen).toContain('What should I focus on?  General health check (Recommended)')
    expectNoModelText(screen)
    expectNoModelText(content)
  })

  it('shows a typed note and several questions', async () => {
    const { screen, content } = await renderRow({
      result: `User has answered your questions: "What should I focus on?"="Disk only" user notes: start with /var, "How deep?"="Full"${SUFFIX}`,
      metadata: {
        askUserQuestion: {
          outcome: 'answered',
          entries: [
            { question: 'What should I focus on?', answer: 'Disk only', note: 'start with /var' },
            { question: 'How deep?', answer: 'Full' },
          ],
        },
      },
    })
    expect(screen).toContain('What should I focus on?  Disk only')
    expect(screen).toContain('Note: start with /var')
    expect(screen).toContain('How deep?  Full')
    expectNoModelText(screen)
    expectNoModelText(content)
  })

  it('shows "Questions skipped" for a skip', async () => {
    const { screen, content } = await renderRow({
      result: 'User skipped these questions. Proceed with your best judgment — do not ask the same questions again unless something new makes the answer truly blocking.',
      metadata: { askUserQuestion: { outcome: 'skipped', entries: [] } },
    })
    expect(screen).toContain('Questions skipped')
    expectNoModelText(screen)
    expectNoModelText(content)
  })

  it('recovers a session recorded without metadata (0.19.36 and older)', async () => {
    const answered = await renderRow({
      result: `User has answered your questions: "What should I focus on?"="General health check (Recommended)" user notes: be quick, "How deep?"="Quick"${SUFFIX}`,
    })
    expect(answered.screen).toContain('What should I focus on?  General health check (Recommended)')
    expect(answered.screen).toContain('Note: be quick')
    expect(answered.screen).toContain('How deep?  Quick')
    expectNoModelText(answered.screen)
    expectNoModelText(answered.content)

    const skipped = await renderRow({
      result: 'User skipped these questions. Proceed with your best judgment — do not ask the same questions again unless something new makes the answer truly blocking.',
    })
    expect(skipped.screen).toContain('Questions skipped')
    expectNoModelText(skipped.screen)
    expectNoModelText(skipped.content)
  })
})
