import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
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
import { SandboxExecutionBroker } from '../../src/sandbox/execution-broker.ts'
import {
  clearCurrentRuntimeSession,
  setCurrentRuntimeSession,
} from '../../src/session/current-session.ts'

let tempRoot: string | undefined
const legacyTestSession = {
  conversationId: 'powershell-execution-test-session',
  services: { admissionRequired: false },
} as never

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

async function makeToolUseContext(
  boundary: 'danger' | 'unavailable' = 'danger',
): Promise<ToolUseContext> {
  setCurrentRuntimeSession(legacyTestSession)
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
    services: {
      sandboxExecutionBroker: boundary === 'danger'
        ? new SandboxExecutionBroker({
            mode: 'danger_full_access',
            cwd: tempRoot,
          })
        : new SandboxExecutionBroker({
            mode: 'workspace_write',
            cwd: tempRoot,
            platform: 'linux',
            probe: () => ({
              kind: 'unavailable',
              mode: 'workspace_write',
              platform: 'linux',
              reason: 'probe: namespaces disabled by test',
              remediation: 'repair namespaces',
            }),
          }),
    },
  } as unknown as ToolUseContext
}

afterEach(async () => {
  clearCurrentRuntimeSession(legacyTestSession)
  resetStateForTests()
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
  }
})

export function registerPowerShellToolExecutionTests(
  lane: 'default' | 'powershell',
): void {
  if (lane === 'powershell') {
    test('PowerShellTool executes a real command in the PowerShell capability lane', async () => {
      const executable = findPowerShellExecutable()
      if (executable === null) {
        throw new Error('PowerShell capability lane requires pwsh or powershell')
      }

      const result = await PowerShellTool.call(
        {
          command:
            "Write-Output 'agenc-powershell-smoke'; " +
            'Write-Output "$env:POWERSHELL_TELEMETRY_OPTOUT|' +
            '$env:POWERSHELL_UPDATECHECK|' +
            '$env:DOTNET_CLI_TELEMETRY_OPTOUT|' +
            '$env:DOTNET_NOLOGO"',
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
      expect(result.data.stdout).toContain('1|Off|1|1')
    })
    return
  }

  test('PowerShellTool preserves a required-sandbox readiness failure', async () => {
    await expect(
      PowerShellTool.call(
        {
          command: "Write-Output 'must-not-run'",
          timeout: 5_000,
          description: 'sandbox failure regression',
        },
        await makeToolUseContext('unavailable'),
        undefined as never,
        undefined as never,
      ),
    ).rejects.toMatchObject({
      code: 'sandbox_probe_failed',
      surface: 'interactive',
    })
  })
}
