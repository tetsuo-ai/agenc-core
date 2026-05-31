import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `bun:bundle` feature() resolves to a no-op in tests; BASH_CLASSIFIER off so
// the classifier-approval chrome stays out of the asserted output.
vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

import type {
  AgenCToolUseBlockParam,
  NormalizedMessage,
} from '../../../src/types/message.js'
import type { Tools } from '../../../src/tools/Tool.js'
import { renderToString } from '../../../src/utils/staticRender.js'
// REAL live-daemon thin-client tool registry + REAL transcript builders. These
// are the exact code paths the daemon TUI uses (App.tsx builds the tool list
// via createTuiTools; session-transcript adapts events into tool_use /
// tool_result messages). Driving them here — instead of mocking
// renderToolUseMessage to '' (the prior false-green) — reproduces the LIVE
// render path end to end.
import { createTuiTools } from '../../../src/tui/tool-rendering.js'
import {
  formatStructuredToolResult,
  makeToolResultMessage,
  makeToolUseMessage,
} from '../../../src/tui/session-transcript.js'
import { AssistantToolUseMessage } from '../../../src/tui/message-renderers/AssistantToolUseMessage.js'
import { UserToolSuccessMessage } from '../../../src/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.js'

const classifierMock = vi.hoisted(() => ({ checking: false }))
const appStateMock = vi.hoisted(() => ({
  pendingWorkerRequest: undefined as undefined | { toolUseId: string },
  toolPermissionContext: {
    mode: 'default',
    strippedDangerousRules: undefined as undefined | Record<string, unknown>,
  },
}))

vi.mock('../../../src/tui/hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 100, rows: 24 }),
}))
vi.mock('../../../src/utils/classifierApprovalsHook.js', () => ({
  useIsClassifierChecking: () => classifierMock.checking,
}))
vi.mock('../../../src/tui/state/AppState.js', () => ({
  useAppState: (selector: (state: { isBriefOnly: boolean }) => unknown) =>
    selector({ isBriefOnly: false }),
  useAppStateMaybeOutsideOfProvider: (
    selector: (state: typeof appStateMock) => unknown,
  ) => selector(appStateMock),
}))
vi.mock('../../../src/tui/ink.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/tui/ink.js')
  >('../../../src/tui/ink.js')
  return { ...actual, useTheme: () => ['dark'] }
})

// The live registered tool NAMES (file-read.ts -> FileRead, the shell tool ->
// exec_command, grep.ts -> Grep, file-edit.ts -> Edit). Build the registry the
// way App.tsx does.
const LIVE_TOOL_NAMES = ['FileRead', 'exec_command', 'Grep', 'Edit'] as const
const tools = createTuiTools([...LIVE_TOOL_NAMES]) as unknown as Tools

beforeEach(() => {
  classifierMock.checking = false
  appStateMock.pendingWorkerRequest = undefined
  appStateMock.toolPermissionContext.mode = 'default'
  appStateMock.toolPermissionContext.strippedDangerousRules = undefined
})

/**
 * Build the (call-row lookups, tool_use param, tool_result message) triple the
 * exact way the daemon path does: tool_use input is the JSON-parsed args, the
 * tool_result content comes from formatStructuredToolResult wrapped by
 * makeToolResultMessage (matching adaptTranscriptEvents / pushToolResult).
 */
function buildLiveCase(opts: {
  readonly id: string
  readonly toolName: string
  readonly input: unknown
  readonly eventType: string
  readonly payload: Record<string, unknown>
  readonly isError?: boolean
}): {
  readonly param: AgenCToolUseBlockParam
  readonly resultMessage: NormalizedMessage
  readonly lookups: never
} {
  const useMsg = makeToolUseMessage(opts.id, opts.toolName, opts.input)
  const param = useMsg.message.content[0] as AgenCToolUseBlockParam
  const structured = formatStructuredToolResult(
    opts.toolName,
    opts.eventType,
    opts.payload,
  )
  const resultMessage = makeToolResultMessage(
    opts.id,
    structured,
    opts.isError ?? false,
  ) as NormalizedMessage
  const lookups = {
    resolvedToolUseIDs: new Set<string>([opts.id]),
    erroredToolUseIDs: new Set<string>(),
    toolResultByToolUseID: new Map<string, NormalizedMessage>([
      [opts.id, resultMessage],
    ]),
    toolUseByToolUseID: new Map<string, { input: unknown }>([
      [opts.id, { input: opts.input }],
    ]),
    inProgressHookCounts: new Map<string, Map<string, number>>(),
    resolvedHookCounts: new Map<string, Map<string, number>>(),
  } as never
  return { param, resultMessage, lookups }
}

/** Render the call row exactly as Message.tsx (assistant tool_use) does. */
async function renderCallRow(
  param: AgenCToolUseBlockParam,
  lookups: never,
): Promise<string> {
  return renderToString(
    <AssistantToolUseMessage
      param={param}
      addMargin={false}
      tools={tools}
      commands={[]}
      verbose={false}
      inProgressToolUseIDs={new Set()}
      progressMessagesForMessage={[]}
      shouldAnimate={false}
      shouldShowDot={false}
      lookups={lookups}
    />,
    100,
  )
}

/**
 * Render the result body exactly as Message.tsx (tool_result ->
 * UserToolResultMessage -> UserToolSuccessMessage) does. Looks up the live tool
 * by name from the same registry the call row uses.
 */
async function renderResultBody(opts: {
  readonly toolName: string
  readonly id: string
  readonly resultMessage: NormalizedMessage
  readonly lookups: never
}): Promise<string> {
  const tool = (tools as readonly { name: string }[]).find(
    (t) => t.name === opts.toolName,
  )
  expect(tool, `tool ${opts.toolName} present in registry`).toBeDefined()
  return renderToString(
    <UserToolSuccessMessage
      message={opts.resultMessage as never}
      lookups={opts.lookups}
      toolUseID={opts.id}
      progressMessagesForMessage={[]}
      tool={tool as never}
      tools={tools}
      verbose={false}
      width={100}
    />,
    100,
  )
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

describe('live daemon TUI tool output (real createTuiTools render path)', () => {
  it('Grep: readable args ("pattern" in path), capped "Found N matches", once', async () => {
    const c = buildLiveCase({
      id: 'tu_grep',
      toolName: 'Grep',
      input: { pattern: 'IO_NUMBER', path: 'src/syntax/lexer.c' },
      eventType: 'tool_call_completed',
      payload: {
        result: {
          pattern: 'IO_NUMBER',
          matches: [
            { file: 'src/syntax/lexer.c', line: 41, content: 'IO_NUMBER a' },
            { file: 'src/syntax/lexer.c', line: 88, content: 'IO_NUMBER b' },
            { file: 'src/syntax/lexer.c', line: 90, content: 'IO_NUMBER c' },
          ],
        },
      },
    })
    const row = await renderCallRow(c.param, c.lookups)
    const body = await renderResultBody({
      toolName: 'Grep',
      id: 'tu_grep',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })

    // Readable args on the call row — NOT raw JSON.
    expect(row).toContain('"IO_NUMBER" in src/syntax/lexer.c')
    expect(row).not.toContain('{"pattern"')
    expect(row).not.toContain('"path":')

    // Capped result preview appears, exactly once.
    const combined = `${row}\n${body}`
    expect(body).toContain('Found 3 matches')
    expect(countOccurrences(combined, 'Found 3 matches')).toBe(1)
    // The raw match list must NOT be dumped under the call row.
    expect(combined).not.toContain('IO_NUMBER a')
  })

  it('FileRead: path args, "Read N lines" preview, once (never vanishes)', async () => {
    const fileBody = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    )
    const c = buildLiveCase({
      id: 'tu_read',
      toolName: 'FileRead',
      input: { file_path: 'PLAN.md' },
      eventType: 'tool_call_completed',
      payload: {
        result: { path: 'PLAN.md', startLine: 1, endLine: 12, content: fileBody },
      },
    })
    const row = await renderCallRow(c.param, c.lookups)
    const body = await renderResultBody({
      toolName: 'FileRead',
      id: 'tu_read',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })

    expect(row).toContain('PLAN.md')
    const combined = `${row}\n${body}`
    expect(body).toContain('Read 12 lines')
    expect(countOccurrences(combined, 'Read 12 lines')).toBe(1)
    // Result must NOT vanish and the file body must NOT be dumped.
    expect(body.trim().length).toBeGreaterThan(0)
    expect(combined).not.toContain('line 7')
  })

  it('exec_command: command args, capped stdout + "+N lines", once', async () => {
    const stdout = Array.from({ length: 9 }, (_, i) => `out ${i}`).join('\n')
    const c = buildLiveCase({
      id: 'tu_exec',
      toolName: 'exec_command',
      input: { command: 'cmake --build build' },
      eventType: 'exec_command_end',
      payload: { stdout, stderr: '', exitCode: 0, durationMs: 12 },
    })
    const row = await renderCallRow(c.param, c.lookups)
    const body = await renderResultBody({
      toolName: 'exec_command',
      id: 'tu_exec',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })

    // "Run" facing name + the command as readable args.
    expect(row).toContain('cmake --build build')

    const combined = `${row}\n${body}`
    // Capped stdout: first 5 lines shown, rest collapsed to "… +4 lines".
    expect(body).toContain('out 0')
    expect(body).toContain('out 4')
    expect(body).not.toContain('out 5')
    expect(body).toContain('+4 lines')
    expect(countOccurrences(combined, 'out 0')).toBe(1)
  })

  it('exec_command: non-zero exit surfaces stderr', async () => {
    const c = buildLiveCase({
      id: 'tu_exec_fail',
      toolName: 'exec_command',
      input: { command: 'make' },
      eventType: 'exec_command_end',
      payload: {
        stdout: '',
        stderr: 'error: undefined reference',
        exitCode: 2,
        durationMs: 5,
      },
      isError: true,
    })
    const body = await renderResultBody({
      toolName: 'exec_command',
      id: 'tu_exec_fail',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })
    expect(body).toContain('error: undefined reference')
  })

  it('Edit: path args, compact "(+a -r)" diff with green/red, once', async () => {
    const diff = [
      '--- a/src/syntax/lexer.c',
      '+++ b/src/syntax/lexer.c',
      '@@ -1,3 +1,3 @@',
      '-int old_token;',
      '+int new_token;',
      '+int extra_token;',
    ].join('\n')
    const c = buildLiveCase({
      id: 'tu_edit',
      toolName: 'Edit',
      input: {
        file_path: 'src/syntax/lexer.c',
        old_string: 'int old_token;',
        new_string: 'int new_token;\nint extra_token;',
      },
      eventType: 'tool_call_completed',
      payload: { result: { path: 'src/syntax/lexer.c', diff } },
    })
    const row = await renderCallRow(c.param, c.lookups)
    const body = await renderResultBody({
      toolName: 'Edit',
      id: 'tu_edit',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })

    // Args = path only, never char-count noise.
    expect(row).toContain('src/syntax/lexer.c')
    expect(row).not.toContain('->')
    expect(row).not.toContain('chars')

    const combined = `${row}\n${body}`
    // 2 additions, 1 removal.
    expect(body).toContain('(+2 -1)')
    expect(body).toContain('new_token')
    expect(body).toContain('old_token')
    expect(countOccurrences(combined, '(+2 -1)')).toBe(1)
  })
})
