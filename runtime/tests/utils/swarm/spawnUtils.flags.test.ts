import { afterEach, describe, expect, test, vi } from 'vitest'

type SpawnFlagState = {
  readonly chromeFlag?: boolean
  readonly inlinePlugins?: readonly string[]
  readonly settingsPath?: string
  readonly teammateMode?: string
  readonly simpleMode?: boolean
  readonly dangerouslyBypassApprovalsAndSandbox?: boolean
  readonly selectedModel?: string
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

  const spawnUtils = await import('../../../src/utils/swarm/spawnUtils.js')
  const { runWithAgentRuntimeOptions } = await import(
    '../../../src/session/runtime-options.js'
  )
  const { runWithStartupProviderSelection } = await import(
    '../../../src/utils/model/providers.js'
  )
  const runtimeOptions = Object.freeze({
    simpleMode: state.simpleMode ?? false,
    dangerouslyBypassApprovalsAndSandbox:
      state.dangerouslyBypassApprovalsAndSandbox ?? false,
    stdinDataMode: false,
    remoteMode: false,
    sessionTempRoot: '/tmp/agenc-spawn-flags-temp',
    pluginStorageRoot: '/tmp/agenc-spawn-flags-plugins',
    allowUntrustedHooks: false,
  })
  return {
    ...spawnUtils,
    buildInheritedCliFlags: (
      options?: Parameters<typeof spawnUtils.buildInheritedCliFlags>[0],
    ) =>
      runWithStartupProviderSelection(
        {
          provider: 'grok',
          model: state.selectedModel ?? 'leader-model',
          environment: {},
        },
        () =>
          runWithAgentRuntimeOptions(runtimeOptions, () =>
            spawnUtils.buildInheritedCliFlags(options),
          ),
      ),
  }
}

describe('buildInheritedCliFlags', () => {
  test('propagates approval bypass without inventing sandbox bypass', async () => {
    const { buildInheritedCliFlags } = await loadSpawnUtils()

    const flags = buildInheritedCliFlags({
      permissionMode: 'bypassPermissions',
    })

    expect(flags).toContain('--permission-mode bypassPermissions')
    expect(flags).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  test('does not invent bypass authority for a non-bypass mode', async () => {
    const { buildInheritedCliFlags } = await loadSpawnUtils()

    expect(buildInheritedCliFlags({ permissionMode: 'default' })).toBe(
      '--model leader-model --teammate-mode default',
    )
  })

  test('propagates auto permission mode and teammate mode together', async () => {
    const { buildInheritedCliFlags } = await loadSpawnUtils({
      teammateMode: 'tmux',
    })

    expect(buildInheritedCliFlags({ permissionMode: 'auto' })).toBe(
      '--permission-mode auto --model leader-model --teammate-mode tmux',
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

  test('uses the bound leader model when the caller omits an override', async () => {
    const { buildInheritedCliFlags } = await loadSpawnUtils({
      selectedModel: 'bound-leader-model',
    })

    expect(buildInheritedCliFlags()).toBe(
      '--model bound-leader-model --teammate-mode default',
    )
  })

  test('propagates immutable bare mode from the parent runtime', async () => {
    const { buildInheritedCliFlags } = await loadSpawnUtils({ simpleMode: true })

    const flags = buildInheritedCliFlags()

    expect(flags).toBe('--model leader-model --bare --teammate-mode default')
  })
})
