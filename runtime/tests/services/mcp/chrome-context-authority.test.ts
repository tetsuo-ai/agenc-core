import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('@ant/agenc-for-chrome-mcp', () => ({
  createAgenCForChromeMcpServer: vi.fn(),
}))

import { resolveHomeContext } from '../../../src/config/home.js'
import { createChromeContext } from '../../../src/utils/agencInChrome/mcpServer.js'

const originalUserType = process.env.USER_TYPE
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
  restoreEnvironment('USER_TYPE', originalUserType)
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
      USER_TYPE: 'ant',
      LOCAL_BRIDGE: '1',
      AGENC_CHROME_PERMISSION_MODE: 'ask',
    }

    process.env.USER_TYPE = 'external'
    delete process.env.LOCAL_BRIDGE
    process.env.AGENC_CHROME_PERMISSION_MODE =
      'skip_all_permission_checks'

    const contextA = createChromeContext(
      mutableEnvironmentA,
      undefined,
      homeA,
    )
    const contextB = createChromeContext(Object.freeze({}), undefined, homeB)

    mutableEnvironmentA.USER_TYPE = 'external'
    delete mutableEnvironmentA.LOCAL_BRIDGE
    mutableEnvironmentA.AGENC_CHROME_PERMISSION_MODE =
      'skip_all_permission_checks'
    process.env.USER_TYPE = 'ant'
    process.env.LOCAL_BRIDGE = '1'
    process.env.AGENC_CHROME_PERMISSION_MODE = 'follow_a_plan'

    expect(contextA.bridgeConfig?.url).toBe('ws://localhost:8765')
    expect(contextA.bridgeConfig?.devUserId).toBe('dev_user_local')
    expect(contextA.initialPermissionMode).toBe('ask')
    expect(contextB.bridgeConfig).toBeUndefined()
    expect(contextB.initialPermissionMode).toBeUndefined()
  })
})
