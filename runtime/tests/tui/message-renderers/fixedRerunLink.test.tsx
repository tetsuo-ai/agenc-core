import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Tool } from '../../tools/Tool.js'
import type { AgenCToolUseBlockParam } from '../../types/message.js'
import { renderToString } from '../../utils/staticRender.js'
import { isFixedRerunSuccess } from './fixedRerunLink.js'
import { AssistantToolUseMessage } from './AssistantToolUseMessage.js'

const classifierMock = vi.hoisted(() => ({ checking: false }))

const appStateMock = vi.hoisted(() => ({
  pendingWorkerRequest: undefined as undefined | { toolUseId: string },
  toolPermissionContext: {
    mode: 'default',
    strippedDangerousRules: undefined as undefined | Record<string, unknown>,
  },
}))

vi.mock('../../utils/classifierApprovalsHook.js', () => ({
  useIsClassifierChecking: () => classifierMock.checking,
}))

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}))

vi.mock('../state/AppState.js', () => ({
  useAppStateMaybeOutsideOfProvider: (
    selector: (state: typeof appStateMock) => unknown,
  ) => selector(appStateMock),
}))

vi.mock('../ink.js', async () => {
  const actual = await vi.importActual<typeof import('../ink.js')>('../ink.js')
  return { ...actual, useTheme: () => ['dark'] }
})

// The on-brand failure glyph the annotation references (= AURA_LIFECYCLE_GLYPHS.failed).
const FAIL_GLYPH = '✕'
const NOW_PASSING = 'now passing'

const tool = {
  name: 'Bash',
  inputSchema: {
    safeParse: (input: unknown) => ({ success: true, data: input }),
  },
  userFacingName: () => 'Bash',
  renderToolUseMessage: (input: { command: string }) => input.command,
  renderToolUseProgressMessage: () => null,
} as unknown as Tool

type ToolUseBlock = {
  id: string
  name: string
  input: unknown
}

/**
 * Build the `lookups` object the renderer receives. `runs` is the chronological
 * tool-use sequence; each carries its resolution state so we can reproduce a
 * fail-then-pass transcript.
 */
function buildLookups(
  runs: readonly {
    id: string
    name: string
    input: unknown
    resolved: boolean
    errored?: boolean
  }[],
) {
  const toolUseByToolUseID = new Map<string, ToolUseBlock>()
  const resolvedToolUseIDs = new Set<string>()
  const erroredToolUseIDs = new Set<string>()
  for (const run of runs) {
    toolUseByToolUseID.set(run.id, {
      id: run.id,
      name: run.name,
      input: run.input,
    })
    if (run.resolved) resolvedToolUseIDs.add(run.id)
    if (run.errored) erroredToolUseIDs.add(run.id)
  }
  return { toolUseByToolUseID, resolvedToolUseIDs, erroredToolUseIDs }
}

async function renderRow(
  param: AgenCToolUseBlockParam,
  lookups: ReturnType<typeof buildLookups>,
): Promise<string> {
  return renderToString(
    <AssistantToolUseMessage
      param={param}
      addMargin={false}
      tools={[tool]}
      commands={[]}
      verbose={false}
      // Resolved rows are NOT in-progress; pass an empty in-progress set so the
      // row renders in its resolved (done/failed) state.
      inProgressToolUseIDs={new Set<string>()}
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

describe('isFixedRerunSuccess (unit)', () => {
  const failThenPass = buildLookups([
    {
      id: 'fail1',
      name: 'Bash',
      input: { command: 'npm run build' },
      resolved: true,
      errored: true,
    },
    {
      id: 'pass1',
      name: 'Bash',
      input: { command: 'npm run build' },
      resolved: true,
    },
  ])

  it('links a passing row to an earlier failed run of the identical command', () => {
    expect(
      isFixedRerunSuccess(
        { id: 'pass1', name: 'Bash', input: { command: 'npm run build' } },
        failThenPass,
      ),
    ).toBe(true)
  })

  it('ignores leading/trailing whitespace when matching the command', () => {
    const lookups = buildLookups([
      {
        id: 'fail1',
        name: 'Bash',
        input: { command: 'npm run build' },
        resolved: true,
        errored: true,
      },
      {
        id: 'pass1',
        name: 'Bash',
        input: { command: '  npm run build  ' },
        resolved: true,
      },
    ])
    expect(
      isFixedRerunSuccess(
        { id: 'pass1', name: 'Bash', input: { command: '  npm run build  ' } },
        lookups,
      ),
    ).toBe(true)
  })

  it('does NOT link when the earlier run of the same command also passed', () => {
    const lookups = buildLookups([
      {
        id: 'pass0',
        name: 'Bash',
        input: { command: 'npm run build' },
        resolved: true,
      },
      {
        id: 'pass1',
        name: 'Bash',
        input: { command: 'npm run build' },
        resolved: true,
      },
    ])
    expect(
      isFixedRerunSuccess(
        { id: 'pass1', name: 'Bash', input: { command: 'npm run build' } },
        lookups,
      ),
    ).toBe(false)
  })

  it('only links the FIRST pass after a failure, not a later pass with no intervening failure', () => {
    const lookups = buildLookups([
      {
        id: 'fail1',
        name: 'Bash',
        input: { command: 'npm test' },
        resolved: true,
        errored: true,
      },
      {
        id: 'pass1',
        name: 'Bash',
        input: { command: 'npm test' },
        resolved: true,
      },
      {
        id: 'pass2',
        name: 'Bash',
        input: { command: 'npm test' },
        resolved: true,
      },
    ])
    // First pass after the failure → linked.
    expect(
      isFixedRerunSuccess(
        { id: 'pass1', name: 'Bash', input: { command: 'npm test' } },
        lookups,
      ),
    ).toBe(true)
    // Second pass, whose most recent prior run (pass1) already passed → NOT linked.
    expect(
      isFixedRerunSuccess(
        { id: 'pass2', name: 'Bash', input: { command: 'npm test' } },
        lookups,
      ),
    ).toBe(false)
  })

  it('does NOT link when the earlier failure was a DIFFERENT command', () => {
    const lookups = buildLookups([
      {
        id: 'fail1',
        name: 'Bash',
        input: { command: 'npm run lint' },
        resolved: true,
        errored: true,
      },
      {
        id: 'pass1',
        name: 'Bash',
        input: { command: 'npm run build' },
        resolved: true,
      },
    ])
    expect(
      isFixedRerunSuccess(
        { id: 'pass1', name: 'Bash', input: { command: 'npm run build' } },
        lookups,
      ),
    ).toBe(false)
  })

  it('does NOT link the failing row itself', () => {
    expect(
      isFixedRerunSuccess(
        { id: 'fail1', name: 'Bash', input: { command: 'npm run build' } },
        failThenPass,
      ),
    ).toBe(false)
  })

  it('does NOT link Write/Edit rows (no command field)', () => {
    const lookups = buildLookups([
      {
        id: 'edit_fail',
        name: 'Edit',
        input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' },
        resolved: true,
        errored: true,
      },
      {
        id: 'edit_pass',
        name: 'Edit',
        input: { file_path: '/a.ts', old_string: 'y', new_string: 'z' },
        resolved: true,
      },
    ])
    expect(
      isFixedRerunSuccess(
        {
          id: 'edit_pass',
          name: 'Edit',
          input: { file_path: '/a.ts', old_string: 'y', new_string: 'z' },
        },
        lookups,
      ),
    ).toBe(false)
  })

  it('does NOT cross-link different tool names sharing a command string', () => {
    const lookups = buildLookups([
      {
        id: 'ps_fail',
        name: 'PowerShell',
        input: { command: 'build' },
        resolved: true,
        errored: true,
      },
      {
        id: 'bash_pass',
        name: 'Bash',
        input: { command: 'build' },
        resolved: true,
      },
    ])
    expect(
      isFixedRerunSuccess(
        { id: 'bash_pass', name: 'Bash', input: { command: 'build' } },
        lookups,
      ),
    ).toBe(false)
  })
})

describe('AssistantToolUseMessage fixed re-run annotation (render)', () => {
  it('annotates a passing row that re-runs an earlier failed command', async () => {
    const lookups = buildLookups([
      {
        id: 'fail1',
        name: 'Bash',
        input: { command: 'npm run build' },
        resolved: true,
        errored: true,
      },
      {
        id: 'pass1',
        name: 'Bash',
        input: { command: 'npm run build' },
        resolved: true,
      },
    ])
    const output = await renderRow(
      {
        type: 'tool_use',
        id: 'pass1',
        name: 'Bash',
        input: { command: 'npm run build' },
      },
      lookups,
    )
    expect(output).toContain(NOW_PASSING)
    expect(output).toContain(`was ${FAIL_GLYPH} above`)
  })

  it('does NOT annotate when the earlier run of the same command succeeded', async () => {
    const lookups = buildLookups([
      {
        id: 'pass0',
        name: 'Bash',
        input: { command: 'npm run build' },
        resolved: true,
      },
      {
        id: 'pass1',
        name: 'Bash',
        input: { command: 'npm run build' },
        resolved: true,
      },
    ])
    const output = await renderRow(
      {
        type: 'tool_use',
        id: 'pass1',
        name: 'Bash',
        input: { command: 'npm run build' },
      },
      lookups,
    )
    expect(output).not.toContain(NOW_PASSING)
  })

  it('does NOT annotate when the earlier failure was a different command', async () => {
    const lookups = buildLookups([
      {
        id: 'fail1',
        name: 'Bash',
        input: { command: 'npm run lint' },
        resolved: true,
        errored: true,
      },
      {
        id: 'pass1',
        name: 'Bash',
        input: { command: 'npm run build' },
        resolved: true,
      },
    ])
    const output = await renderRow(
      {
        type: 'tool_use',
        id: 'pass1',
        name: 'Bash',
        input: { command: 'npm run build' },
      },
      lookups,
    )
    expect(output).not.toContain(NOW_PASSING)
  })

  it('does NOT annotate the failing row itself', async () => {
    const lookups = buildLookups([
      {
        id: 'fail1',
        name: 'Bash',
        input: { command: 'npm run build' },
        resolved: true,
        errored: true,
      },
      {
        id: 'pass1',
        name: 'Bash',
        input: { command: 'npm run build' },
        resolved: true,
      },
    ])
    const output = await renderRow(
      {
        type: 'tool_use',
        id: 'fail1',
        name: 'Bash',
        input: { command: 'npm run build' },
      },
      lookups,
    )
    expect(output).not.toContain(NOW_PASSING)
  })

  it('does NOT annotate a Write/Edit re-run', async () => {
    const editTool = {
      name: 'Edit',
      inputSchema: {
        safeParse: (input: unknown) => ({ success: true, data: input }),
      },
      userFacingName: () => 'Edit',
      renderToolUseMessage: () => '/a.ts',
      renderToolUseProgressMessage: () => null,
    } as unknown as Tool
    const lookups = buildLookups([
      {
        id: 'edit_fail',
        name: 'Edit',
        input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' },
        resolved: true,
        errored: true,
      },
      {
        id: 'edit_pass',
        name: 'Edit',
        input: { file_path: '/a.ts', old_string: 'y', new_string: 'z' },
        resolved: true,
      },
    ])
    const output = await renderToString(
      <AssistantToolUseMessage
        param={{
          type: 'tool_use',
          id: 'edit_pass',
          name: 'Edit',
          input: { file_path: '/a.ts', old_string: 'y', new_string: 'z' },
        }}
        addMargin={false}
        tools={[editTool]}
        commands={[]}
        verbose={false}
        inProgressToolUseIDs={new Set<string>()}
        progressMessagesForMessage={[]}
        shouldAnimate={false}
        shouldShowDot={false}
        lookups={lookups as never}
      />,
      80,
    )
    expect(output).not.toContain(NOW_PASSING)
  })
})
