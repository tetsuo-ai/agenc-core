// @ts-nocheck
// Moved-source note: this moved utility still imports not-yet-absorbed upstream subsystems.
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getPlatform } from '../platform.js'

export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

export function isPowerShellToolEnabled(): boolean {
  if (getPlatform() !== 'windows') return false
  return process.env.USER_TYPE === 'ant'
    ? !isEnvDefinedFalsy(process.env.AGENC_USE_POWERSHELL_TOOL)
    : isEnvTruthy(process.env.AGENC_USE_POWERSHELL_TOOL)
}

let cachedPowerShellTool: typeof import('../../tools/PowerShellTool/PowerShellTool.js').PowerShellTool | null = null
export function getPowerShellTool(): typeof import('../../tools/PowerShellTool/PowerShellTool.js').PowerShellTool {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  cachedPowerShellTool ??= (require('../../tools/PowerShellTool/PowerShellTool.js') as typeof import('../../tools/PowerShellTool/PowerShellTool.js')).PowerShellTool
  return cachedPowerShellTool
}
