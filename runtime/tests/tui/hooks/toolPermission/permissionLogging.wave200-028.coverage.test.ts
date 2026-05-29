import { beforeEach, describe, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  counter: {
    add: vi.fn(),
  },
  features: new Set<string>(),
  getCodeEditToolDecisionCounter: vi.fn(),
  getLanguageName: vi.fn(),
  logError: vi.fn(),
  sandboxEnabled: true,
  sanitizeToolNameForAnalytics: vi.fn((toolName: string) => `safe:${toolName}`),
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => harness.features.has(name),
}))

vi.mock('../../../services/analytics/metadata.js', () => ({
  sanitizeToolNameForAnalytics: harness.sanitizeToolNameForAnalytics,
}))

vi.mock('../../../bootstrap/state.js', () => ({
  getCodeEditToolDecisionCounter: harness.getCodeEditToolDecisionCounter,
}))

vi.mock('../../../utils/cliHighlight.js', () => ({
  getLanguageName: harness.getLanguageName,
}))

vi.mock('../../../utils/log.js', () => ({
  logError: harness.logError,
}))

vi.mock('../../../utils/sandbox/sandbox-runtime.js', () => ({
  SandboxManager: {
    isSandboxingEnabled: () => harness.sandboxEnabled,
  },
}))

import {
  buildCodeEditToolAttributes,
  isCodeEditingTool,
  logPermissionDecision,
} from './permissionLogging.js'

type ParseResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false }

function tool(
  name: string,
  parseResult: ParseResult = {
    success: true,
    data: { file_path: 'src/sample.ts' },
  },
  filePath: string | undefined = 'src/sample.ts',
) {
  return {
    name,
    inputSchema: {
      safeParse: vi.fn(() => parseResult),
    },
    getPath:
      filePath === undefined ? undefined : vi.fn(() => filePath),
  }
}

function context(
  overrides: Partial<{
    existingDecisions: Map<string, unknown>
    input: Record<string, unknown>
    messageId: string
    tool: ReturnType<typeof tool>
    toolUseID: string
  }> = {},
) {
  const toolUseContext: { toolDecisions?: Map<string, unknown> } = {}
  if (overrides.existingDecisions) {
    toolUseContext.toolDecisions = overrides.existingDecisions
  }
  return {
    ctx: {
      tool: overrides.tool ?? tool('Read', { success: false }),
      input: overrides.input ?? { file_path: 'src/sample.ts' },
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

describe('permissionLogging coverage', () => {
  beforeEach(() => {
    harness.counter.add.mockClear()
    harness.features = new Set()
    harness.getCodeEditToolDecisionCounter.mockReset()
    harness.getCodeEditToolDecisionCounter.mockReturnValue(harness.counter)
    harness.getLanguageName.mockReset()
    harness.getLanguageName.mockResolvedValue('TypeScript')
    harness.logError.mockClear()
    harness.sandboxEnabled = true
    harness.sanitizeToolNameForAnalytics.mockClear()
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
  })

  test('logs decision sources to code-edit counters and context state', async () => {
    expect(isCodeEditingTool('Edit')).toBe(true)
    expect(isCodeEditingTool('Write')).toBe(true)
    expect(isCodeEditingTool('NotebookEdit')).toBe(true)
    expect(isCodeEditingTool('Read')).toBe(false)

    const editTool = tool('Edit')
    await expect(
      buildCodeEditToolAttributes(
        editTool as never,
        { file_path: 'src/sample.ts' },
        'accept',
        'user_permanent',
      ),
    ).resolves.toEqual({
      decision: 'accept',
      language: 'TypeScript',
      source: 'user_permanent',
      tool_name: 'Edit',
    })
    expect(editTool.inputSchema.safeParse).toHaveBeenCalledWith({
      file_path: 'src/sample.ts',
    })
    expect(editTool.getPath).toHaveBeenCalledWith({ file_path: 'src/sample.ts' })

    const invalidInputTool = tool('Edit', { success: false })
    await expect(
      buildCodeEditToolAttributes(
        invalidInputTool as never,
        { file_path: 'bad.ts' },
        'reject',
        'hook',
      ),
    ).resolves.toEqual({
      decision: 'reject',
      source: 'hook',
      tool_name: 'Edit',
    })
    expect(invalidInputTool.getPath).not.toHaveBeenCalled()

    const editDecision = context({ tool: editTool, toolUseID: 'edit-1' })
    logPermissionDecision(
      editDecision.ctx as never,
      { decision: 'accept', source: { type: 'user', permanent: true } },
      1_250,
    )
    await flushMicrotasks()

    expect(harness.counter.add).toHaveBeenCalledWith(1, {
      decision: 'accept',
      language: 'TypeScript',
      source: 'user_permanent',
      tool_name: 'Edit',
    })
    expect(editDecision.toolUseContext.toolDecisions?.get('edit-1')).toEqual({
      decision: 'accept',
      source: 'user_permanent',
      timestamp: 2_000,
    })

    const existingDecisions = new Map<string, unknown>()
    logPermissionDecision(
      context({
        existingDecisions,
        toolUseID: 'config-allow',
      }).ctx as never,
      { decision: 'accept', source: 'config' },
      1_000,
    )

    expect(existingDecisions.get('config-allow')).toEqual({
      decision: 'accept',
      source: 'config',
      timestamp: 2_000,
    })
  })

  test('logs rejected code-edit metric enrichment without dropping the decision', async () => {
    const languageError = new Error('language detection failed')
    harness.getLanguageName.mockRejectedValueOnce(languageError)
    const editDecision = context({
      tool: tool('Write'),
      toolUseID: 'write-1',
    })

    logPermissionDecision(
      editDecision.ctx as never,
      { decision: 'accept', source: { type: 'user', permanent: false } },
      1_750,
    )
    await flushMicrotasks()

    expect(editDecision.toolUseContext.toolDecisions?.get('write-1')).toEqual({
      decision: 'accept',
      source: 'user_temporary',
      timestamp: 2_000,
    })
    expect(harness.counter.add).not.toHaveBeenCalled()
    expect(harness.logError).toHaveBeenCalledWith(languageError)
  })

  test('logs thrown code-edit counter updates without dropping the decision', async () => {
    const counterError = new Error('counter backend failed')
    harness.counter.add.mockImplementationOnce(() => {
      throw counterError
    })
    const editDecision = context({
      tool: tool('Edit'),
      toolUseID: 'edit-counter-1',
    })

    logPermissionDecision(
      editDecision.ctx as never,
      { decision: 'reject', source: { type: 'hook' } },
      1_500,
    )
    await flushMicrotasks()

    expect(editDecision.toolUseContext.toolDecisions?.get('edit-counter-1')).toEqual({
      decision: 'reject',
      source: 'hook',
      timestamp: 2_000,
    })
    expect(harness.counter.add).toHaveBeenCalledWith(1, {
      decision: 'reject',
      language: 'TypeScript',
      source: 'hook',
      tool_name: 'Edit',
    })
    expect(harness.logError).toHaveBeenCalledWith(counterError)
  })
})
