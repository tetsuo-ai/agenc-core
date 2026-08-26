import { afterEach, describe, expect, test, vi } from 'vitest'

type SpawnFlagState = {
  readonly bypassPermissions?: boolean
  readonly chromeFlag?: boolean
  readonly inlinePlugins?: readonly string[]
  readonly settingsPath?: string
  readonly teammateMode?: string
}

afterEach(() => {
  vi.doUnmock('../../../src/bootstrap/state.js')
  vi.doUnmock('../../../src/utils/bundledMode.js')
  vi.doUnmock('../../../src/utils/swarm/backends/teammateModeSnapshot.js')
  vi.resetModules()
})

async function loadSpawnUtils(state: SpawnFlagState = {}) {
  vi.resetModules()
  vi.doMock('../../../src/bootstrap/state.js', () => ({
    getChromeFlagOverride: () => state.chromeFlag,
    getFlagSettingsPath: () => state.settingsPath,
    getInlinePlugins: () => state.inlinePlugins ?? [],
    getSessionBypassPermissionsMode: () => state.bypassPermissions ?? false,
  }))
  vi.doMock('../../../src/utils/bundledMode.js', () => ({
    isInBundledMode: () => false,
  }))
  vi.doMock(
    '../../../src/utils/swarm/backends/teammateModeSnapshot.js',
    () => ({
      getTeammateModeFromSnapshot: () => state.teammateMode ?? 'default',
    }),
  )

  return import('../../../src/utils/swarm/spawnUtils.js')
}

describe('buildInheritedCliFlags', () => {
  test('propagates auto permission mode and teammate mode together', async () => {
    const { buildInheritedCliFlags } = await loadSpawnUtils({
      teammateMode: 'tmux',
    })

    expect(buildInheritedCliFlags({ permissionMode: 'auto' })).toBe(
      '--permission-mode auto --teammate-mode tmux',
    )
  })

  test('uses the explicit teammate model', async () => {
    const { buildInheritedCliFlags } = await loadSpawnUtils()

    const flags = buildInheritedCliFlags({
      permissionMode: 'acceptEdits',
      model: 'worker model with spaces',
    })

    expect(flags).toBe(
      "--permission-mode acceptEdits --model 'worker model with spaces' --teammate-mode default",
    )
  })

  test('does not infer a model when the caller omits the resolved model', async () => {
    const { buildInheritedCliFlags } = await loadSpawnUtils()

    expect(buildInheritedCliFlags()).toBe('--teammate-mode default')
  })
})
