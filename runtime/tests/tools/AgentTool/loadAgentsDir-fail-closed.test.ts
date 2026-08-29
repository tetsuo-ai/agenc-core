import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('../../utils/markdownConfigLoader.js')
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('agent markdown discovery failures', () => {
  test('fails closed instead of scanning an ambient home with a second loader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenc-agent-loader-failure-'))
    const workspace = join(root, 'workspace')
    const homeA = join(root, 'home-a')
    const homeB = join(root, 'home-b')
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(homeA, { recursive: true }),
      mkdir(join(homeB, 'agents'), { recursive: true }),
    ])
    await writeFile(
      join(homeB, 'agents', 'ambient.md'),
      [
        '---',
        'name: ambient-b',
        'description: Must never cross authorities',
        '---',
        'Ambient B prompt.',
      ].join('\n'),
    )
    vi.stubEnv('AGENC_HOME', homeB)

    const rejectedLoader = Object.assign(
      async () => {
        throw new Error('canonical markdown loader failed')
      },
      { cache: { clear: vi.fn() } },
    )
    vi.doMock('../../utils/markdownConfigLoader.js', () => ({
      loadMarkdownFilesForSubdir: rejectedLoader,
      loadMarkdownFilesForSubdirFresh: rejectedLoader,
    }))

    try {
      const [{ ConfigStore }, authorityModule, agentModule] = await Promise.all([
        import('../../config/store.js'),
        import('../../utils/settings/canonicalAuthority.js'),
        import('./loadAgentsDir.js'),
      ])
      const authority = new ConfigStore({
        home: homeA,
        cwd: workspace,
        projectRoot: workspace,
        projectTrusted: false,
        env: {},
        loader: async () => ({ configVersion: 2 }),
      })
      await authority.reload()

      const definitions = await authorityModule.runWithCanonicalSettingsAuthority(
        authority,
        () => agentModule.getAgentDefinitionsWithOverrides(
          workspace,
          join(homeA, 'plugins'),
        ),
      )

      expect(definitions.allAgents.map(agent => agent.agentType)).not.toContain(
        'ambient-b',
      )
      expect(definitions.activeAgents.map(agent => agent.agentType)).toContain(
        'default',
      )
      expect(definitions.failedFiles).toEqual([
        expect.objectContaining({
          path: 'unknown',
          error: 'canonical markdown loader failed',
        }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
