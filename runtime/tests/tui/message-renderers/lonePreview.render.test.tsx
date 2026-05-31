import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `bun:bundle` feature() is a no-op in tests.
vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

import type { NormalizedMessage } from '../../../src/types/message.js'
import type { Tools } from '../../../src/tools/Tool.js'
import { renderToString } from '../../../src/utils/staticRender.js'
// REAL live registries + builders: createTuiTools is what App.tsx passes to the
// collapser/renderer; session-transcript builders adapt daemon events the same
// way the live TUI does. No REPL-primitive mock here, so the real Canonical
// FileRead/Grep fallback makes a lone read/search collapsible — exactly the
// live condition FIX 2 un-collapses.
import { createTuiTools } from '../../../src/tui/tool-rendering.js'
import {
  formatStructuredToolResult,
  makeToolResultMessage,
  makeToolUseMessage,
} from '../../../src/tui/session-transcript.js'
import { collapseReadSearchGroups } from '../../../src/utils/collapseReadSearch.js'
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
  useAppStateMaybeOutsideOfProvider: (selector: (state: any) => unknown) =>
    selector({
      pendingWorkerRequest: undefined,
      toolPermissionContext: { mode: 'default', strippedDangerousRules: undefined },
    }),
}))
vi.mock('../../../src/tui/ink.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/tui/ink.js')>(
    '../../../src/tui/ink.js',
  )
  return { ...actual, useTheme: () => ['dark'] }
})

// The live TUI render registry. Mirror onto each tool the search/read
// classification the runtime exposes (the daemon TUI reaches it via the
// canonical REPL-primitive fallback) so the collapser actually CONSIDERS
// FileRead/Grep for folding here — that is the precondition FIX 2's
// un-collapse path operates on. Without this, lone reads never enter a group
// at all and the test wouldn't exercise the fix.
const tools = createTuiTools(['FileRead', 'Grep', 'Edit']) as unknown as Tools
;(tools as readonly any[]).forEach((t) => {
  if (t.name === 'FileRead') {
    t.isSearchOrReadCommand = () => ({ isSearch: false, isRead: true })
  } else if (t.name === 'Grep') {
    t.isSearchOrReadCommand = () => ({ isSearch: true, isRead: false })
  }
})

function buildPair(opts: {
  readonly id: string
  readonly toolName: string
  readonly input: unknown
  readonly eventType: string
  readonly payload: Record<string, unknown>
}): { readonly use: NormalizedMessage; readonly resultMessage: NormalizedMessage } {
  const use = makeToolUseMessage(opts.id, opts.toolName, opts.input) as NormalizedMessage
  const structured = formatStructuredToolResult(
    opts.toolName,
    opts.eventType,
    opts.payload,
  )
  const resultMessage = makeToolResultMessage(opts.id, structured, false) as NormalizedMessage
  return { use, resultMessage }
}

/** Render the result body the way Message.tsx does for a tool_result. */
async function renderResultBody(opts: {
  readonly toolName: string
  readonly id: string
  readonly resultMessage: NormalizedMessage
}): Promise<string> {
  const tool = (tools as readonly { name: string }[]).find(
    (t) => t.name === opts.toolName,
  )
  const lookups = {
    resolvedToolUseIDs: new Set<string>([opts.id]),
    erroredToolUseIDs: new Set<string>(),
    toolResultByToolUseID: new Map<string, NormalizedMessage>([
      [opts.id, opts.resultMessage],
    ]),
    toolUseByToolUseID: new Map(),
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
  } as never
  return renderToString(
    <UserToolSuccessMessage
      message={opts.resultMessage as never}
      lookups={lookups}
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('lone Read/Grep keeps its per-call preview in NON-verbose live mode (FIX 2)', () => {
  it('a lone Read survives collapse and renders "Read N lines"', async () => {
    const fileBody = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
    const { use, resultMessage } = buildPair({
      id: 'tu_read',
      toolName: 'FileRead',
      input: { file_path: 'PLAN.md' },
      eventType: 'tool_call_completed',
      payload: { result: { path: 'PLAN.md', startLine: 1, endLine: 12, content: fileBody } },
    })

    // Run the REAL collapser over the lone read pair. FIX 2 must NOT fold it
    // into a one-line count summary.
    const out = collapseReadSearchGroups([use, resultMessage] as never, tools)
    expect(out.some((m: any) => m?.type === 'collapsed_read_search')).toBe(false)
    // The original result message survives so the per-call preview renders.
    const survived = out.find(
      (m: any) => m?.type === 'user' && m.message.content[0]?.type === 'tool_result',
    )
    expect(survived).toBeDefined()

    const body = await renderResultBody({
      toolName: 'FileRead',
      id: 'tu_read',
      resultMessage,
    })
    // Per-call result preview — NOT just a count summary.
    expect(body).toContain('Read 12 lines')
    // The file body must not be dumped.
    expect(body).not.toContain('line 7')
  })

  it('a lone Grep survives collapse and renders "Found N matches"', async () => {
    const { use, resultMessage } = buildPair({
      id: 'tu_grep',
      toolName: 'Grep',
      input: { pattern: 'IO_NUMBER', path: 'src/lexer.c' },
      eventType: 'tool_call_completed',
      payload: {
        result: {
          pattern: 'IO_NUMBER',
          matches: [
            { file: 'src/lexer.c', line: 41, content: 'IO_NUMBER a' },
            { file: 'src/lexer.c', line: 88, content: 'IO_NUMBER b' },
            { file: 'src/lexer.c', line: 90, content: 'IO_NUMBER c' },
          ],
        },
      },
    })

    const out = collapseReadSearchGroups([use, resultMessage] as never, tools)
    expect(out.some((m: any) => m?.type === 'collapsed_read_search')).toBe(false)

    const body = await renderResultBody({
      toolName: 'Grep',
      id: 'tu_grep',
      resultMessage,
    })
    expect(body).toContain('Found 3 matches')
    expect(body).not.toContain('IO_NUMBER a')
  })
})
