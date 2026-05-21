import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { describe, expect, test } from 'vitest'

import { createRoot } from '../../../src/tui/ink.js'
import {
  getTaskAssignmentSummary,
  TaskAssignmentDisplay,
  tryRenderTaskAssignmentMessage,
} from '../../../src/tui/message-renderers/TaskAssignmentMessage.js'
import { renderToString } from '../../../src/utils/staticRender.js'
import type { TaskAssignmentMessage } from '../../../src/utils/teammateMailbox.js'

type TestStdin = PassThrough & {
  isTTY: boolean
  ref: () => void
  setRawMode: (mode: boolean) => void
  unref: () => void
}

type TestStdout = PassThrough & {
  columns: number
  rows: number
  isTTY: boolean
}

function createStreams(): {
  readonly stdin: TestStdin
  readonly stdout: TestStdout
} {
  const stdin = new PassThrough() as TestStdin
  const stdout = new PassThrough() as TestStdout

  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}

  stdout.columns = 100
  stdout.rows = 24
  stdout.isTTY = true
  stdout.resume()

  return { stdin, stdout }
}

function sleep(ms = 25): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalize(output: string): string {
  return output.replace(/\s+/g, ' ').trim()
}

function compact(output: string): string {
  return output.replace(/\s+/g, '')
}

function payload(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function assignment(overrides: Partial<TaskAssignmentMessage> = {}): TaskAssignmentMessage {
  return {
    type: 'task_assignment',
    taskId: '168',
    subject: 'Cover TaskAssignmentMessage',
    description: 'Exercise the assignment body branch.',
    assignedBy: 'lead',
    timestamp: '2026-05-20T00:00:00.000Z',
    ...overrides,
  }
}

function renderAssignment(
  value: TaskAssignmentMessage,
): React.ReactElement {
  return <TaskAssignmentDisplay assignment={value} />
}

async function renderAssignmentSequence(
  values: readonly TaskAssignmentMessage[],
): Promise<string> {
  const { stdin, stdout } = createStreams()
  let output = ''

  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  try {
    for (const value of values) {
      root.render(renderAssignment(value))
      await sleep()
    }
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await sleep()
  }

  return normalize(stripAnsi(output))
}

describe('TaskAssignmentMessage coverage swarm 168', () => {
  test('renders assignment details across cached rerenders and optional descriptions', async () => {
    const full = assignment()
    const withoutDescription = assignment({
      description: '',
      subject: 'Cover optional description branch',
    })

    const output = await renderAssignmentSequence([
      full,
      full,
      withoutDescription,
      withoutDescription,
      assignment({
        taskId: '168-next',
        subject: 'Cover changed assignment title',
        description: 'Exercise updated assignment details.',
      }),
    ])

    const compactOutput = compact(output)
    expect(compactOutput).toContain('Task#168assignedbylead')
    expect(compactOutput).toContain('CoverTaskAssignmentMessage')
    expect(compactOutput).toContain('Exercisetheassignmentbodybranch.')

    const emptyDescriptionOutput = normalize(
      await renderToString(renderAssignment(withoutDescription), {
        columns: 100,
        rows: 12,
      }),
    )

    expect(emptyDescriptionOutput).toContain('Task #168 assigned by lead')
    expect(emptyDescriptionOutput).toContain('Cover optional description branch')
    expect(emptyDescriptionOutput).not.toContain('undefined')

    const changedOutput = normalize(
      await renderToString(
        renderAssignment(
          assignment({
            taskId: '168-next',
            subject: 'Cover changed assignment title',
            description: 'Exercise updated assignment details.',
          }),
        ),
        { columns: 100, rows: 12 },
      ),
    )

    expect(changedOutput).toContain('Task #168-next assigned by lead')
    expect(changedOutput).toContain('Cover changed assignment title')
    expect(changedOutput).toContain('Exercise updated assignment details.')
  })

  test('parses valid assignment payloads and ignores non-assignment content', async () => {
    const content = payload(assignment({
      taskId: '168-json',
      subject: 'Parse task assignment payload',
      description: '',
      assignedBy: 'coordinator',
    }))

    const node = tryRenderTaskAssignmentMessage(content)
    expect(React.isValidElement(node)).toBe(true)

    const output = normalize(
      await renderToString(<>{node}</>, { columns: 100, rows: 12 }),
    )

    expect(output).toContain('Task #168-json assigned by coordinator')
    expect(output).toContain('Parse task assignment payload')
    expect(output).not.toContain('undefined')
    expect(getTaskAssignmentSummary(content)).toBe(
      '[Task Assigned] #168-json - Parse task assignment payload',
    )

    expect(
      tryRenderTaskAssignmentMessage(payload({ type: 'teammate_message' })),
    ).toBeNull()
    expect(tryRenderTaskAssignmentMessage('{not json')).toBeNull()
    expect(getTaskAssignmentSummary(payload({ type: 'teammate_message' }))).toBeNull()
    expect(getTaskAssignmentSummary('{not json')).toBeNull()
  })
})
