import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConfigStore } from '../src/config/store.js'
import {
  clearTieredInstructionsCacheForTesting,
  loadTieredInstructions,
} from '../src/prompts/agenc-md.js'
import { resolveLiveInstructionEnvelope } from '../src/prompts/live-instructions.js'
import type { Session } from '../src/session/session.js'
import type { TurnContext } from '../src/session/turn-context.js'
import { runWithCanonicalSettingsAuthority } from '../src/utils/settings/canonicalAuthority.js'

const createdPaths: string[] = []

afterEach(async () => {
  clearTieredInstructionsCacheForTesting()
  await Promise.all(
    createdPaths.splice(0).map(path =>
      rm(path, { force: true, recursive: true }),
    ),
  )
})

describe('hermetic managed prompt policy', () => {
  it('routes machine-wide instructions and rules into the minted test home', async () => {
    const hermeticHome = process.env.AGENC_TEST_HERMETIC_HOME
    expect(hermeticHome).toBeTruthy()

    const managedInstructionsDir = join(
      hermeticHome as string,
      'managed-policy',
    )
    const managedInstructions = join(managedInstructionsDir, 'AGENC.md')
    const managedRules = join(managedInstructionsDir, 'rules')
    const project = join(hermeticHome as string, 'managed-prompt-project')
    const userHome = join(hermeticHome as string, 'managed-prompt-user')
    createdPaths.push(managedInstructionsDir, managedRules, project, userHome)

    await Promise.all([
      mkdir(managedInstructionsDir, { recursive: true }),
      mkdir(managedRules, { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(userHome, { recursive: true }),
    ])
    await Promise.all([
      writeFile(managedInstructions, 'hermetic managed instructions\n', 'utf8'),
      writeFile(
        join(managedRules, 'baseline.md'),
        'hermetic managed rule\n',
        'utf8',
      ),
    ])

    clearTieredInstructionsCacheForTesting()
    const tiers = await loadTieredInstructions({
      cwd: project,
      homeDir: userHome,
      managedPath: managedInstructions,
    })

    expect(tiers.managed?.path).toBe(managedInstructions)
    expect(tiers.managed?.content).toContain('hermetic managed instructions')
    expect(tiers.managed?.content).toContain('hermetic managed rule')
    expect(tiers.managed?.content).not.toContain('/etc/agenc')
  })

  it('keeps live turns on the ConfigStore-captured managed instruction path', async () => {
    const hermeticHome = process.env.AGENC_TEST_HERMETIC_HOME
    expect(hermeticHome).toBeTruthy()
    const root = join(hermeticHome as string, 'captured-live-policy')
    const ambientRoot = join(hermeticHome as string, 'ambient-live-policy')
    const project = join(hermeticHome as string, 'live-project')
    const userHome = join(hermeticHome as string, 'live-user')
    const capturedInstructions = join(root, 'Team.md')
    const ambientInstructions = join(ambientRoot, 'AGENC.md')
    createdPaths.push(root, ambientRoot, project, userHome)
    await Promise.all([
      mkdir(join(root, 'rules'), { recursive: true }),
      mkdir(join(ambientRoot, 'rules'), { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(userHome, { recursive: true }),
    ])
    await Promise.all([
      writeFile(
        capturedInstructions,
        'captured managed instructions\n',
        'utf8',
      ),
      writeFile(
        join(root, 'rules', 'captured.md'),
        'captured managed rule\n',
        'utf8',
      ),
      writeFile(
        ambientInstructions,
        'ambient managed instructions\n',
        'utf8',
      ),
      writeFile(
        join(ambientRoot, 'rules', 'ambient.md'),
        'ambient managed rule\n',
        'utf8',
      ),
    ])
    const store = new ConfigStore({
      home: userHome,
      cwd: project,
      projectRoot: project,
      env: {
        AGENC_HOME: userHome,
        AGENC_MANAGED_INSTRUCTIONS: capturedInstructions,
      },
      managedConfigPath: join(root, 'config.toml'),
      loader: async () => ({ configVersion: 2 }),
    })
    await store.reload()
    const session = {
      services: { configStore: store },
      setProjectMemoryWarnings: vi.fn(),
    } as unknown as Session
    const previousAmbient = process.env.AGENC_MANAGED_INSTRUCTIONS
    process.env.AGENC_MANAGED_INSTRUCTIONS = ambientInstructions
    clearTieredInstructionsCacheForTesting()
    try {
      const envelope = await runWithCanonicalSettingsAuthority(store, () =>
        resolveLiveInstructionEnvelope({
          session,
          ctx: { cwd: project } as TurnContext,
          baseInstructions: 'base instructions',
        }),
      )

      expect(envelope.text).toContain('captured managed instructions')
      expect(envelope.text).toContain('captured managed rule')
      expect(envelope.text).not.toContain('ambient managed instructions')
      expect(envelope.text).not.toContain('ambient managed rule')
    } finally {
      if (previousAmbient === undefined) {
        delete process.env.AGENC_MANAGED_INSTRUCTIONS
      } else {
        process.env.AGENC_MANAGED_INSTRUCTIONS = previousAmbient
      }
    }
  })
})
