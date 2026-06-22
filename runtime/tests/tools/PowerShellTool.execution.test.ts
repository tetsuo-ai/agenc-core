import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import {
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../../src/bootstrap/state.ts'
import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../../src/tools/Tool.ts'
import { PowerShellTool } from '../../src/tools/PowerShellTool/PowerShellTool.tsx'

let tempRoot: string | undefined

function findPowerShellExecutable(): string | null {
  for (const candidate of ['pwsh', 'powershell']) {
    const result = spawnSync(
      candidate,
      ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion'],
      {
        encoding: 'utf8',
        timeout: 1_000,
      },
    )
    if (result.status === 0) return candidate
  }
  return null
}

async function makeToolUseContext(): Promise<ToolUseContext> {
  tempRoot = await mkdtemp(join(tmpdir(), 'agenc-powershell-tool-'))
  setProjectRoot(tempRoot)
  setOriginalCwd(tempRoot)
  setCwdState(tempRoot)

  const appState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
  }

  return {
    abortController: new AbortController(),
    getAppState() {
      return appState
    },
    setAppState() {},
    setToolJSX() {},
    toolUseId: 'powershell-smoke',
  } as unknown as ToolUseContext
}

afterEach(async () => {
  resetStateForTests()
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
  }
})

test('PowerShellTool executes a real PowerShell command when available', async () => {
  const executable = findPowerShellExecutable()
  if (executable === null) {
    expect(executable).toBeNull()
    return
  }

  const result = await PowerShellTool.call(
    {
      command: "Write-Output 'agenc-powershell-smoke'",
      timeout: 5_000,
      description: 'emit smoke marker',
    },
    await makeToolUseContext(),
    undefined as never,
    undefined as never,
  )

  expect(result.data.interrupted).toBe(false)
  expect(result.data.stderr).toBe('')
  expect(result.data.stdout).toContain('agenc-powershell-smoke')
})
