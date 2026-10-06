import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('@ant/agenc-for-chrome-mcp', () => ({
  createAgenCForChromeMcpServer: vi.fn(),
}))

import { resolveHomeContext } from '../../../src/config/home.js'
import { createChromeContext } from '../../../src/utils/agencInChrome/mcpServer.js'

const originalLocalBridge = process.env.LOCAL_BRIDGE
const originalPermissionMode = process.env.AGENC_CHROME_PERMISSION_MODE

function restoreEnvironment(
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

afterEach(() => {
  restoreEnvironment('LOCAL_BRIDGE', originalLocalBridge)
  restoreEnvironment('AGENC_CHROME_PERMISSION_MODE', originalPermissionMode)
})

describe('Chrome MCP context environment authority', () => {
  test('keeps A/B session feature and bridge settings isolated from ambient mutation', () => {
    const homeA = resolveHomeContext(
      { AGENC_HOME: '/tmp/agenc-chrome-session-a' },
      { platformHome: '/tmp' },
    )
    const homeB = resolveHomeContext(
      { AGENC_HOME: '/tmp/agenc-chrome-session-b' },
      { platformHome: '/tmp' },
    )
    const mutableEnvironmentA: Record<string, string> = {
      AGENC_CHROME_PERMISSION_MODE: 'ask',
    }

    process.env.AGENC_CHROME_PERMISSION_MODE =
      'skip_all_permission_checks'

    const contextA = createChromeContext(
      mutableEnvironmentA,
      undefined,
      homeA,
    )
    const contextB = createChromeContext(Object.freeze({}), undefined, homeB)

    mutableEnvironmentA.AGENC_CHROME_PERMISSION_MODE =
      'skip_all_permission_checks'
    process.env.AGENC_CHROME_PERMISSION_MODE = 'follow_a_plan'

    expect(contextA.bridgeConfig).toBeUndefined()
    expect(contextA.initialPermissionMode).toBe('ask')
    expect(contextB.bridgeConfig).toBeUndefined()
    expect(contextB.initialPermissionMode).toBeUndefined()
  })
})
