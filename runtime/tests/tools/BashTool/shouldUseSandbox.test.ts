import { afterEach, expect, test } from 'bun:test'

import { SandboxManager } from '../../../src/utils/sandbox/sandbox-runtime.ts'
import { BashTool } from '../../../src/tools/BashTool/BashTool.tsx'
import { PowerShellTool } from '../../../src/tools/PowerShellTool/PowerShellTool.tsx'
import { shouldUseSandbox } from '../../../src/tools/BashTool/shouldUseSandbox.ts'

const originalSandboxMethods = {
  isSandboxingEnabled: SandboxManager.isSandboxingEnabled,
  areUnsandboxedCommandsAllowed: SandboxManager.areUnsandboxedCommandsAllowed,
}

afterEach(() => {
  SandboxManager.isSandboxingEnabled =
    originalSandboxMethods.isSandboxingEnabled
  SandboxManager.areUnsandboxedCommandsAllowed =
    originalSandboxMethods.areUnsandboxedCommandsAllowed
})

test('model-facing Bash schema rejects dangerouslyDisableSandbox', () => {
  const result = BashTool.inputSchema.safeParse({
    command: 'cat /etc/passwd',
    dangerouslyDisableSandbox: true,
  })

  expect(result.success).toBe(false)
})

test('model-facing PowerShell schema rejects dangerouslyDisableSandbox', () => {
  const result = PowerShellTool.inputSchema.safeParse({
    command: 'Get-Content C:\\Windows\\System32\\drivers\\etc\\hosts',
    dangerouslyDisableSandbox: true,
  })

  expect(result.success).toBe(false)
})

test('model-controlled dangerouslyDisableSandbox does not bypass sandbox', () => {
  SandboxManager.isSandboxingEnabled = () => true
  SandboxManager.areUnsandboxedCommandsAllowed = () => true

  expect(
    shouldUseSandbox({
      command: 'cat /etc/passwd',
      dangerouslyDisableSandbox: true,
    }),
  ).toBe(true)
})

test('trusted internal approval can disable sandbox when policy allows it', () => {
  SandboxManager.isSandboxingEnabled = () => true
  SandboxManager.areUnsandboxedCommandsAllowed = () => true

  expect(
    shouldUseSandbox({
      command: 'cat /etc/passwd',
      dangerouslyDisableSandbox: true,
      _dangerouslyDisableSandboxApproved: true,
    }),
  ).toBe(false)
})

test('trusted internal approval cannot disable sandbox when policy forbids it', () => {
  SandboxManager.isSandboxingEnabled = () => true
  SandboxManager.areUnsandboxedCommandsAllowed = () => false

  expect(
    shouldUseSandbox({
      command: 'cat /etc/passwd',
      dangerouslyDisableSandbox: true,
      _dangerouslyDisableSandboxApproved: true,
    }),
  ).toBe(true)
})
