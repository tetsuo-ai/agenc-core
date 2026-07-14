import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  clearTieredInstructionsCacheForTesting,
  loadTieredInstructions,
} from '../src/prompts/agenc-md.js'
import { DEFAULT_MANAGED_RULES_DIR } from '../src/prompts/rules/discovery.js'

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
      'managed-instructions',
    )
    const managedInstructions = join(managedInstructionsDir, 'AGENC.md')
    const managedRules = join(hermeticHome as string, 'managed-rules')
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

    const previousManagedInstructions =
      process.env.AGENC_MANAGED_INSTRUCTIONS
    process.env.AGENC_MANAGED_INSTRUCTIONS = '/etc/agenc/AGENC.md'
    clearTieredInstructionsCacheForTesting()
    try {
      const tiers = await loadTieredInstructions({ cwd: project, homeDir: userHome })

      expect(DEFAULT_MANAGED_RULES_DIR).toBe(managedRules)
      expect(tiers.managed?.path).toBe(managedInstructions)
      expect(tiers.managed?.content).toContain('hermetic managed instructions')
      expect(tiers.managed?.content).toContain('hermetic managed rule')
      expect(tiers.managed?.content).not.toContain('/etc/agenc')
    } finally {
      if (previousManagedInstructions === undefined) {
        delete process.env.AGENC_MANAGED_INSTRUCTIONS
      } else {
        process.env.AGENC_MANAGED_INSTRUCTIONS = previousManagedInstructions
      }
    }
  })
})
