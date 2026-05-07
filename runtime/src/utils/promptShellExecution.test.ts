import { afterEach, expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../tools/Tool.js'
import { CanonicalBashTool } from '../tools/canonicalToolSurface.js'
import { executeShellCommandsInPrompt } from './promptShellExecution.js'

const originalCall = CanonicalBashTool.call
const originalMapToolResultToToolResultBlockParam =
  CanonicalBashTool.mapToolResultToToolResultBlockParam

afterEach(() => {
  CanonicalBashTool.call = originalCall
  CanonicalBashTool.mapToolResultToToolResultBlockParam =
    originalMapToolResultToToolResultBlockParam
})

function promptContext() {
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'sonnet',
      tools: new Map(),
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: {
        systemDefinitions: [],
        projectDefinitions: [],
        userDefinitions: [],
      },
    },
    readFileState: new Map(),
    getAppState() {
      return {
        toolPermissionContext: {
          ...getEmptyToolPermissionContext(),
          alwaysAllowRules: { command: ['Bash(*)'] },
        },
      }
    },
    setAppState() {},
  } as never
}

test('executeShellCommandsInPrompt normalizes null shell output', async () => {
  let normalizedResult:
    | { stdout: string; stderr: string; interrupted: boolean }
    | undefined

  CanonicalBashTool.call = (async () => ({
    data: {
      stdout: null,
      stderr: null,
      interrupted: false,
    },
  })) as unknown as typeof CanonicalBashTool.call

  CanonicalBashTool.mapToolResultToToolResultBlockParam = (result, toolUseID) => {
    normalizedResult = result as {
      stdout: string
      stderr: string
      interrupted: boolean
    }
    return originalMapToolResultToToolResultBlockParam(result, toolUseID)
  }

  await executeShellCommandsInPrompt(
    '```!\ngit status\n```',
    promptContext(),
    'security-review',
  )

  expect(normalizedResult).toEqual({
    stdout: '',
    stderr: '',
    interrupted: false,
  })
})

test('executeShellCommandsInPrompt preserves failed canonical Bash result status', async () => {
  let mappedResult:
    | { content: string; isError?: boolean; metadata?: Record<string, unknown> }
    | undefined

  CanonicalBashTool.call = (async () => ({
    data: {
      content: 'failed',
      isError: true,
      metadata: {
        stdout: '',
        stderr: 'bad',
        interrupted: false,
      },
    },
  })) as unknown as typeof CanonicalBashTool.call

  CanonicalBashTool.mapToolResultToToolResultBlockParam = (result, toolUseID) => {
    mappedResult = result as {
      content: string
      isError?: boolean
      metadata?: Record<string, unknown>
    }
    return originalMapToolResultToToolResultBlockParam(result, toolUseID)
  }

  const rendered = await executeShellCommandsInPrompt(
    '```!\nfalse\n```',
    promptContext(),
    'security-review',
  )

  expect(mappedResult).toEqual({
    content: 'failed',
    isError: true,
    metadata: {
      stdout: '',
      stderr: 'bad',
      interrupted: false,
    },
  })
  expect(rendered).toContain('failed')
})
