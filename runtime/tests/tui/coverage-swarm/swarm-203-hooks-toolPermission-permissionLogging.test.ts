import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  counter: {
    add: vi.fn(),
  },
  features: new Set<string>(),
  getCodeEditToolDecisionCounter: vi.fn(),
  getLanguageName: vi.fn(),
  sandboxEnabled: false,
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => harness.features.has(name),
}))

vi.mock('../../../src/bootstrap/state.js', () => ({
  getCodeEditToolDecisionCounter: harness.getCodeEditToolDecisionCounter,
}))

vi.mock('../../../src/utils/cliHighlight.js', () => ({
  getLanguageName: harness.getLanguageName,
}))

vi.mock('../../../src/utils/sandbox/sandbox-runtime.js', () => ({
  SandboxManager: {
    isSandboxingEnabled: () => harness.sandboxEnabled,
  },
}))

import {
  buildCodeEditToolAttributes,
  logPermissionDecision,
} from '../../../src/tui/hooks/toolPermission/permissionLogging.js'

type ParseResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false }

function tool(
  overrides: Partial<{
    filePath: string | undefined
    name: string
    parseResult: ParseResult
    withGetPath: boolean
  }> = {},
) {
  const withGetPath = overrides.withGetPath ?? true
  const filePath =
    Object.hasOwn(overrides, 'filePath') ? overrides.filePath : 'src/demo.ts'

  return {
    name: overrides.name ?? 'Read',
    inputSchema: {
      safeParse: vi.fn(
        () =>
          overrides.parseResult ?? {
            success: true,
            data: { file_path: 'src/demo.ts' },
          },
      ),
    },
    ...(withGetPath
      ? {
          getPath: vi.fn(() => filePath),
        }
      : {}),
  }
}

function context(
  overrides: Partial<{
    input: Record<string, unknown> | undefined
    messageId: string
    tool: ReturnType<typeof tool>
    toolUseID: string
  }> = {},
) {
  const toolUseContext: { toolDecisions?: Map<string, unknown> } = {}

  return {
    ctx: {
      tool: overrides.tool ?? tool(),
      input: Object.hasOwn(overrides, 'input')
        ? overrides.input
        : { file_path: 'src/demo.ts' },
      toolUseContext,
      messageId: overrides.messageId ?? 'message-1',
      toolUseID: overrides.toolUseID ?? 'tool-use-1',
    },
    toolUseContext,
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('permissionLogging coverage swarm row 203', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    harness.counter.add.mockClear()
    harness.features = new Set()
    harness.getCodeEditToolDecisionCounter.mockReset()
    harness.getCodeEditToolDecisionCounter.mockReturnValue(harness.counter)
    harness.getLanguageName.mockReset()
    harness.getLanguageName.mockResolvedValue('TypeScript')
    harness.sandboxEnabled = false
    vi.spyOn(Date, 'now').mockReturnValue(4_000)
  })

  test('omits language attributes when path extraction is unavailable', async () => {
    const noPathTool = tool({ name: 'Edit', withGetPath: false })

    await expect(
      buildCodeEditToolAttributes(
        noPathTool as never,
        { file_path: 'src/demo.ts' },
        'accept',
        'hook',
      ),
    ).resolves.toEqual({
      decision: 'accept',
      source: 'hook',
      tool_name: 'Edit',
    })
    expect(noPathTool.inputSchema.safeParse).not.toHaveBeenCalled()

    const noInputTool = tool({ name: 'Write' })
    await expect(
      buildCodeEditToolAttributes(
        noInputTool as never,
        undefined,
        'reject',
        'config',
      ),
    ).resolves.toEqual({
      decision: 'reject',
      source: 'config',
      tool_name: 'Write',
    })
    expect(noInputTool.inputSchema.safeParse).not.toHaveBeenCalled()

    const noFilePathTool = tool({ filePath: undefined, name: 'NotebookEdit' })
    await expect(
      buildCodeEditToolAttributes(
        noFilePathTool as never,
        { file_path: 'src/demo.ts' },
        'accept',
        'user_temporary',
      ),
    ).resolves.toEqual({
      decision: 'accept',
      source: 'user_temporary',
      tool_name: 'NotebookEdit',
    })
    expect(noFilePathTool.inputSchema.safeParse).toHaveBeenCalledWith({
      file_path: 'src/demo.ts',
    })
    expect(harness.getLanguageName).not.toHaveBeenCalled()
  })

  test('logs permanent hook approval without prompt wait metadata', () => {
    const hookContext = context({ tool: tool({ name: 'Read' }) })

    logPermissionDecision(
      hookContext.ctx as never,
      { decision: 'accept', source: { type: 'hook', permanent: true } },
    )

    expect(hookContext.toolUseContext.toolDecisions?.get('tool-use-1')).toEqual({
      decision: 'accept',
      source: 'hook',
      timestamp: 4_000,
    })
  })

  test('keeps classifier approval unknown when classifier features are disabled', () => {
    const classifierContext = context({
      tool: tool({ name: 'Read' }),
      toolUseID: 'classifier-off',
    })

    logPermissionDecision(
      classifierContext.ctx as never,
      { decision: 'accept', source: { type: 'classifier' } },
      3_900,
    )

    expect(
      classifierContext.toolUseContext.toolDecisions?.get('classifier-off'),
    ).toEqual({
      decision: 'accept',
      source: 'unknown',
      timestamp: 4_000,
    })
  })

  test('uses transcript classifier feature and tolerates a missing code edit counter', async () => {
    harness.features.add('TRANSCRIPT_CLASSIFIER')
    harness.getCodeEditToolDecisionCounter.mockReturnValue(undefined)

    const editTool = tool({ name: 'Edit' })
    const classifierContext = context({
      tool: editTool,
      toolUseID: 'classifier-edit',
    })

    logPermissionDecision(
      classifierContext.ctx as never,
      { decision: 'accept', source: { type: 'classifier' } },
      3_750,
    )
    await flushMicrotasks()

    expect(harness.getLanguageName).toHaveBeenCalledWith('src/demo.ts')
    expect(harness.getCodeEditToolDecisionCounter).toHaveBeenCalled()
    expect(harness.counter.add).not.toHaveBeenCalled()
    expect(
      classifierContext.toolUseContext.toolDecisions?.get('classifier-edit'),
    ).toEqual({
      decision: 'accept',
      source: 'classifier',
      timestamp: 4_000,
    })
  })
})
