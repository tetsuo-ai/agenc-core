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
// REAL live-daemon thin-client tool registry + REAL transcript builders — the
// exact code paths the daemon TUI uses. Unlike toolRowPreview.render.test.tsx
// (which feeds results through formatStructuredToolResult, i.e. the TAGGED
// envelope path), this suite feeds the RAW result strings the LIVE daemon
// actually sends (verified against session rollouts): the exec trailer string,
// line-numbered FileRead content, "updated successfully" Edit + an Edit
// tool-use input, and a "Found 1 file" Grep. Those raw strings carry NO
// <bash-stdout>/<edit-diff>/<read-content>/<grep-matches> envelope, so they
// exercise the live-format routing + capped views end to end.
import { createTuiTools } from '../../../src/tui/tool-rendering.js'
import {
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
// exec_command, grep.ts -> Grep, file-edit.ts -> Edit/MultiEdit, file-write.ts
// -> Write). Build the registry the way App.tsx does.
const LIVE_TOOL_NAMES = [
  'FileRead',
  'exec_command',
  'Grep',
  'Edit',
  'MultiEdit',
  'Write',
] as const
const tools = createTuiTools([...LIVE_TOOL_NAMES]) as unknown as Tools

beforeEach(() => {
  classifierMock.checking = false
  appStateMock.pendingWorkerRequest = undefined
  appStateMock.toolPermissionContext.mode = 'default'
  appStateMock.toolPermissionContext.strippedDangerousRules = undefined
})

/**
 * Build the (call-row lookups, tool_use param, tool_result message) triple the
 * way the LIVE daemon `tool_result` path does (session-transcript.ts:1953 ->
 * pushToolResult -> makeToolResultMessage): the result content is the RAW
 * string the daemon emitted, NOT wrapped by formatStructuredToolResult.
 */
function buildRawCase(opts: {
  readonly id: string
  readonly toolName: string
  readonly input: unknown
  readonly rawResult: string
  readonly isError?: boolean
}): {
  readonly param: AgenCToolUseBlockParam
  readonly resultMessage: NormalizedMessage
  readonly lookups: never
} {
  const useMsg = makeToolUseMessage(opts.id, opts.toolName, opts.input)
  const param = useMsg.message.content[0] as AgenCToolUseBlockParam
  // RAW result string straight into makeToolResultMessage — exactly the live
  // path. No envelope tags are added.
  const resultMessage = makeToolResultMessage(
    opts.id,
    opts.rawResult,
    opts.isError ?? false,
  ) as NormalizedMessage
  const lookups = {
    resolvedToolUseIDs: new Set<string>([opts.id]),
    erroredToolUseIDs: opts.isError
      ? new Set<string>([opts.id])
      : new Set<string>(),
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

describe('LIVE raw daemon tool results (no envelope) — capped industry-standard views', () => {
  it('exec_command: strips [exec ...] trailer, caps stdout to first lines + "+N lines"', async () => {
    // RAW shape: stdout, then blank lines, then the exec trailer line.
    const stdout = Array.from({ length: 9 }, (_, i) => `out ${i}`).join('\n')
    const raw = `${stdout}\n\n\n[exec exit_code=0 wall_time=0.0300s tokens=69]`
    const c = buildRawCase({
      id: 'tu_exec',
      toolName: 'exec_command',
      input: { cmd: 'cmake --build build' },
      rawResult: raw,
    })
    const row = await renderCallRow(c.param, c.lookups)
    const body = await renderResultBody({
      toolName: 'exec_command',
      id: 'tu_exec',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })
    const combined = `${row}\n${body}`

    // Capped stdout: first 5 lines shown, rest collapsed.
    expect(body).toContain('out 0')
    expect(body).toContain('out 4')
    expect(body).not.toContain('out 5')
    expect(body).toContain('+4 lines')
    // The [exec ...] trailer line must be stripped from the visible output.
    expect(combined).not.toContain('[exec exit_code')
    expect(combined).not.toContain('wall_time')
    expect(combined).not.toContain('tokens=69')
    expect(countOccurrences(combined, 'out 0')).toBe(1)
  })

  it('exec_command: non-zero exit shows a compact "(exit N)" indicator, no trailer', async () => {
    const raw = `boom\n\n\n[exec exit_code=2 wall_time=0.0860s tokens=526]`
    const c = buildRawCase({
      id: 'tu_exec_fail',
      toolName: 'exec_command',
      input: { cmd: 'make' },
      rawResult: raw,
    })
    const body = await renderResultBody({
      toolName: 'exec_command',
      id: 'tu_exec_fail',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })
    expect(body).toContain('boom')
    expect(body).toContain('(exit 2)')
    expect(body).not.toContain('[exec exit_code')
  })

  it('FileRead: line-numbered raw content renders "Read N lines", not the body', async () => {
    // RAW shape: file body with line-number prefixes "  N→...".
    const raw = Array.from(
      { length: 12 },
      (_, i) => `${String(i + 1).padStart(2, ' ')}→content line ${i + 1}`,
    ).join('\n')
    const c = buildRawCase({
      id: 'tu_read',
      toolName: 'FileRead',
      input: { file_path: 'include/agenc/ast.h' },
      rawResult: raw,
    })
    const row = await renderCallRow(c.param, c.lookups)
    const body = await renderResultBody({
      toolName: 'FileRead',
      id: 'tu_read',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })
    const combined = `${row}\n${body}`

    expect(row).toContain('ast.h')
    expect(body).toContain('Read 12 lines')
    expect(countOccurrences(combined, 'Read 12 lines')).toBe(1)
    // The raw body must NOT be dumped.
    expect(combined).not.toContain('content line 7')
  })

  it('Grep: files-with-matches "Found 1 file" renders a tidy file count', async () => {
    const raw = 'Found 1 file\nsrc/syntax/lexer.c'
    const c = buildRawCase({
      id: 'tu_grep_file',
      toolName: 'Grep',
      input: { pattern: 'IO_NUMBER', path: 'src/syntax/lexer.c' },
      rawResult: raw,
    })
    const row = await renderCallRow(c.param, c.lookups)
    const body = await renderResultBody({
      toolName: 'Grep',
      id: 'tu_grep_file',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })
    const combined = `${row}\n${body}`

    // Readable args, not raw JSON.
    expect(row).toContain('"IO_NUMBER" in src/syntax/lexer.c')
    expect(body).toContain('Found 1 file')
    expect(countOccurrences(combined, 'Found 1 file')).toBe(1)
    // The matched path must NOT be dumped under the call row.
    expect(body).not.toContain('src/syntax/lexer.c')
  })

  it('Grep: per-file count list with "Found N total occurrences" renders a tidy summary', async () => {
    const raw =
      'src/app/cli.c:2\nsrc/app/main.c:1\nsrc/common/io.c:2\n\nFound 5 total occurrences across 3 files.'
    const c = buildRawCase({
      id: 'tu_grep_count',
      toolName: 'Grep',
      input: { pattern: 'TODO' },
      rawResult: raw,
    })
    const body = await renderResultBody({
      toolName: 'Grep',
      id: 'tu_grep_count',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })
    expect(body).toContain('Found 5 matches in 3 files')
    // The raw per-file counts must NOT be dumped.
    expect(body).not.toContain('src/app/cli.c:2')
  })

  it('Edit: renders a compact "+a -r" green/red diff on the call row, suppresses the "updated successfully" body', async () => {
    const oldString =
      '/* Alias subsystem — M0 stubs. */\n#include "agenc/alias.h"\n#include <stdio.h>'
    const newString =
      '/* Alias substitution per PLAN §8.1. */\n#include "agenc/alias.h"\n#include <stdio.h>\n#include <string.h>'
    const c = buildRawCase({
      id: 'tu_edit',
      toolName: 'Edit',
      input: {
        file_path: 'src/syntax/alias.c',
        old_string: oldString,
        new_string: newString,
      },
      rawResult: 'The file src/syntax/alias.c has been updated successfully.',
    })
    const row = await renderCallRow(c.param, c.lookups)
    const body = await renderResultBody({
      toolName: 'Edit',
      id: 'tu_edit',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })
    const combined = `${row}\n${body}`

    // The diff stats + diff chrome render on the CALL ROW. An Edit to an
    // existing file is labelled EDIT (distinct from a first-write CREATE).
    expect(row).toContain('EDIT')
    expect(row).toContain('+3 -2')
    // The removed and added lines are present in the diff.
    expect(row).toContain('M0 stubs')
    expect(row).toContain('PLAN §8.1')
    // The redundant "updated successfully" body must be suppressed entirely.
    expect(combined).not.toContain('updated successfully')
    // Diff is rendered exactly once (no duplicate).
    expect(countOccurrences(combined, '+3 -2')).toBe(1)
  })

  it('MultiEdit: renders a combined diff on the call row, suppresses the success body', async () => {
    const c = buildRawCase({
      id: 'tu_medit',
      toolName: 'MultiEdit',
      input: {
        file_path: 'src/syntax/alias.c',
        edits: [
          { old_string: 'return NULL;', new_string: 'return aliasmap_alloc();' },
          { old_string: 'int count;', new_string: 'size_t count;' },
        ],
      },
      rawResult: 'The file src/syntax/alias.c has been updated successfully.',
    })
    const row = await renderCallRow(c.param, c.lookups)
    const body = await renderResultBody({
      toolName: 'MultiEdit',
      id: 'tu_medit',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })
    const combined = `${row}\n${body}`

    // A MultiEdit changes an existing file → EDIT (not a first-write CREATE).
    expect(row).toContain('EDIT')
    expect(row).toContain('+2 -2')
    expect(row).toContain('aliasmap_alloc')
    expect(combined).not.toContain('updated successfully')
  })

  it('Write: renders a whole-file add diff on the call row, suppresses the success body', async () => {
    const c = buildRawCase({
      id: 'tu_write',
      toolName: 'Write',
      input: {
        file_path: 'src/new.c',
        content: 'int main(void) {\n  return 0;\n}\n',
      },
      rawResult: 'The file src/new.c has been written successfully.',
    })
    const row = await renderCallRow(c.param, c.lookups)
    const body = await renderResultBody({
      toolName: 'Write',
      id: 'tu_write',
      resultMessage: c.resultMessage,
      lookups: c.lookups,
    })
    const combined = `${row}\n${body}`

    // A first Write of a new file is labelled CREATE (distinct from an EDIT to
    // an existing file), so the user can tell "made a new file" apart.
    expect(row).toContain('CREATE')
    // Whole-file add: 3 additions, 0 removals.
    expect(row).toContain('+3 -0')
    expect(row).toContain('int main')
    expect(combined).not.toContain('written successfully')
  })

  it('Edit FAILURE: still shows the error reason and renders NO diff (P0)', async () => {
    const c = buildRawCase({
      id: 'tu_edit_fail',
      toolName: 'Edit',
      input: {
        file_path: 'src/syntax/alias.c',
        old_string: 'does not exist',
        new_string: 'replacement',
      },
      rawResult: 'File has not been read yet. Read it first before writing to it.',
      isError: true,
    })
    const row = await renderCallRow(c.param, c.lookups)
    // Failed row surfaces the friendly reason, and no diff chrome at all —
    // neither the old 'DIFF' label nor the new operation labels render.
    expect(row).toContain('File must be read first')
    expect(row).not.toContain('DIFF')
    expect(row).not.toContain('EDIT')
    expect(row).not.toContain('CREATE')
  })
})
