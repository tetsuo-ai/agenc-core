import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Tool } from '../../../src/tools/Tool.js'
import type {
  AgenCToolUseBlockParam,
  NormalizedMessage,
} from '../../../src/types/message.js'
import { renderToString } from '../../../src/utils/staticRender.js'
import { Text } from '../../../src/tui/ink.js'
import { AssistantToolUseMessage } from '../../../src/tui/message-renderers/AssistantToolUseMessage.js'
import { UserToolSuccessMessage } from '../../../src/tui/message-renderers/UserToolResultMessage/UserToolSuccessMessage.js'
import {
  buildEditRowPreview,
  successToolRowPreview,
  summarizeToolInput,
} from '../../../src/tui/message-renderers/toolRowPreview.js'

const classifierMock = vi.hoisted(() => ({ checking: false }))
const appStateMock = vi.hoisted(() => ({
  pendingWorkerRequest: undefined as undefined | { toolUseId: string },
  toolPermissionContext: {
    mode: 'default',
    strippedDangerousRules: undefined as undefined | Record<string, unknown>,
  },
}))

vi.mock('../../../src/tui/hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}))
vi.mock('../../../src/utils/classifierApprovalsHook.js', () => ({
  useIsClassifierChecking: () => classifierMock.checking,
}))
vi.mock('../../../src/tui/state/AppState.js', () => ({
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

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'Tool',
    inputSchema: { safeParse: (input: unknown) => ({ success: true, data: input }) },
    userFacingName: () => 'Tool',
    renderToolUseMessage: () => '',
    renderToolUseProgressMessage: () => null,
    ...overrides,
  } as unknown as Tool
}

/** Build lookups with a resolved tool result for `id`. */
function makeLookups(id: string, resultContent: string) {
  const resultMsg: NormalizedMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: id, content: resultContent },
      ],
    },
  } as unknown as NormalizedMessage
  return {
    resolvedToolUseIDs: new Set<string>([id]),
    erroredToolUseIDs: new Set<string>(),
    toolResultByToolUseID: new Map<string, NormalizedMessage>([[id, resultMsg]]),
    toolUseByToolUseID: new Map(),
  } as never
}

async function renderRow(
  param: AgenCToolUseBlockParam,
  tool: Tool,
  lookups: unknown,
): Promise<string> {
  return renderToString(
    <AssistantToolUseMessage
      param={param}
      addMargin={false}
      tools={[tool] as never}
      commands={[]}
      verbose={false}
      inProgressToolUseIDs={new Set()}
      progressMessagesForMessage={[]}
      shouldAnimate={false}
      shouldShowDot={false}
      lookups={lookups as never}
    />,
    80,
  )
}

beforeEach(() => {
  classifierMock.checking = false
  appStateMock.pendingWorkerRequest = undefined
  appStateMock.toolPermissionContext.mode = 'default'
  appStateMock.toolPermissionContext.strippedDangerousRules = undefined
})

describe('summarizeToolInput (FIX 1: readable args, no raw JSON)', () => {
  it('renders grep as "pattern" in path, ignoring flags', () => {
    expect(
      summarizeToolInput(
        { pattern: 'Reader, Lexer', path: 'PLAN.md', '-A': 3, '-i': true },
        'grep',
      ),
    ).toBe('"Reader, Lexer" in PLAN.md')
  })

  it('renders Read/Edit/Write file_path', () => {
    expect(summarizeToolInput({ file_path: 'src/lexer.c' }, 'read')).toBe(
      'src/lexer.c',
    )
  })

  it('renders Bash command', () => {
    expect(
      summarizeToolInput({ command: 'cmake --build build' }, 'bash'),
    ).toBe('cmake --build build')
  })

  it('never dumps raw JSON for unknown objects', () => {
    const out = summarizeToolInput({ alpha: 'one', beta: 2, gamma: true })
    expect(out).not.toContain('{')
    expect(out).not.toContain('"alpha"')
    expect(out).toContain('alpha=one')
  })
})

describe('successToolRowPreview (FIX 2: capped result preview)', () => {
  it('Read counts lines when no header present', () => {
    const body = Array.from({ length: 5 }, (_, i) => `${i + 1}\tline`).join('\n')
    expect(successToolRowPreview('read', body)).toBe('Read 5 lines')
  })

  it('Read honors an explicit "Read N lines" header', () => {
    expect(successToolRowPreview('read', 'Read 1592 lines\n...')).toBe(
      'Read 1592 lines',
    )
  })

  it('Bash caps stdout and appends "+N lines"', () => {
    const stdout = Array.from({ length: 20 }, (_, i) => `out ${i}`).join('\n')
    const preview = successToolRowPreview('bash', stdout, 6)
    expect(preview).toContain('out 0')
    expect(preview).toContain('out 5')
    expect(preview).not.toContain('out 6')
    expect(preview).toContain('+14 lines')
  })

  it('Bash strips the {exitCode,stdout} JSON wrapper', () => {
    const wrapped = JSON.stringify({ exitCode: 0, stdout: 'hello\nworld' })
    expect(successToolRowPreview('bash', wrapped)).toBe('hello\nworld')
  })

  it('Grep summarizes match count', () => {
    expect(successToolRowPreview('grep', 'Found 3 matches')).toBe('Found 3 matches')
  })
})

describe('AssistantToolUseMessage inline preview (call row)', () => {
  it('Read row shows "Read N lines" under the call', async () => {
    const id = 'tu_read'
    const param: AgenCToolUseBlockParam = {
      type: 'tool_use',
      id,
      name: 'Read',
      input: { file_path: 'PLAN.md' },
    }
    const tool = makeTool({
      name: 'Read',
      userFacingName: () => 'Read',
      renderToolUseMessage: () => 'PLAN.md',
    })
    const out = await renderRow(param, tool, makeLookups(id, 'a\nb\nc\nd'))
    expect(out).toContain('PLAN.md')
    expect(out).toContain('Read 4 lines')
  })

  it('Bash row shows capped stdout + "+N lines"', async () => {
    const id = 'tu_bash'
    const param: AgenCToolUseBlockParam = {
      type: 'tool_use',
      id,
      name: 'Bash',
      input: { command: 'seq 20' },
    }
    const tool = makeTool({
      name: 'Bash',
      userFacingName: () => 'Bash',
      renderToolUseMessage: () => 'seq 20',
    })
    const stdout = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
    const out = await renderRow(param, tool, makeLookups(id, stdout))
    expect(out).toContain('line0')
    expect(out).toContain('+14 lines')
  })

  it('Grep row shows readable "pattern" in path arg and match count', async () => {
    const id = 'tu_grep'
    const param: AgenCToolUseBlockParam = {
      type: 'tool_use',
      id,
      name: 'Grep',
      input: { pattern: 'Reader, Lexer', path: 'PLAN.md' },
    }
    const tool = makeTool({
      name: 'Grep',
      userFacingName: () => 'Grep',
      // Force the call-row arg summarizer (return '' so it falls back).
      renderToolUseMessage: () => '',
    })
    const out = await renderRow(param, tool, makeLookups(id, 'Found 3 matches'))
    expect(out).toContain('"Reader, Lexer" in PLAN.md')
    expect(out).toContain('Found 3 matches')
  })
})

describe('de-duplication (CRITICAL: result rendered exactly once)', () => {
  it('toolNameOwnsInlinePreview matches the Read/Bash/Grep/Edit/Write family', async () => {
    const { toolNameOwnsInlinePreview } = await import(
      '../../../src/tui/message-renderers/toolRowPreview.js'
    )
    expect(toolNameOwnsInlinePreview('Read')).toBe(true)
    expect(toolNameOwnsInlinePreview('Bash')).toBe(true)
    expect(toolNameOwnsInlinePreview('Grep')).toBe(true)
    expect(toolNameOwnsInlinePreview('Edit')).toBe(true)
    expect(toolNameOwnsInlinePreview('Write')).toBe(true)
    expect(toolNameOwnsInlinePreview('WebFetch')).toBe(false)
    expect(toolNameOwnsInlinePreview(undefined)).toBe(false)
  })

  it('the detached success body is suppressed for previewed tools (no double render)', async () => {
    const renderToolResultMessage = vi.fn(() => (
      <Text>DETACHED_RESULT_BODY</Text>
    ))
    const tool = {
      name: 'Read',
      renderToolResultMessage,
      userFacingName: () => 'Read',
    } as unknown as Tool
    const out = await renderToString(
      <UserToolSuccessMessage
        message={{
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_x',
                content: 'a\nb',
              },
            ],
          },
          toolUseResult: { ok: true },
        } as never}
        lookups={
          {
            toolUseByToolUseID: new Map([['tu_x', { input: {} }]]),
            inProgressHookCounts: new Map(),
            resolvedHookCounts: new Map(),
          } as never
        }
        toolUseID="tu_x"
        progressMessagesForMessage={[] as never}
        tool={tool}
        tools={[tool] as never}
        verbose={false}
        width={72}
      />,
      { columns: 80, rows: 12 },
    )
    // The call row owns the preview, so the detached body must NOT appear.
    expect(out).not.toContain('DETACHED_RESULT_BODY')
    expect(renderToolResultMessage).not.toHaveBeenCalled()
  })
})

describe('buildEditRowPreview (FIX 3: compact diff)', () => {
  it('returns +a -r stats and a diff node', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edit-preview-'))
    const file = join(dir, 'lexer.c')
    // The file on disk reflects the AFTER state (edit already applied).
    writeFileSync(file, 'int k = j;\nreturn k;\n')
    const preview = buildEditRowPreview('Edit', {
      file_path: file,
      old_string: 'int k = i;',
      new_string: 'int k = j;',
    })
    expect(preview).not.toBeNull()
    expect(preview!.stats).toBe('+1 -1')
  })

  it('renders green/red diff lines and "(+a -r)" on the row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edit-row-'))
    const file = join(dir, 'lexer.c')
    writeFileSync(file, 'int k = j;\nreturn k;\n')
    const id = 'tu_edit'
    const param: AgenCToolUseBlockParam = {
      type: 'tool_use',
      id,
      name: 'Edit',
      input: {
        file_path: file,
        old_string: 'int k = i;',
        new_string: 'int k = j;',
      },
    }
    const tool = makeTool({
      name: 'Edit',
      userFacingName: () => 'Edit',
      renderToolUseMessage: () => file,
    })
    const out = await renderRow(param, tool, makeLookups(id, 'File updated'))
    expect(out).toContain('(+1 -1)')
    expect(out).toContain('int k = j;')
    expect(out).toContain('int k = i;')
  })
})
