import { join } from 'node:path'

import { vi } from 'vitest'

const managedInstructionsPath = (): string =>
  join(process.env.AGENC_HOME ?? '', 'managed-instructions', 'AGENC.md')

const managedRulesDir = (): string =>
  join(process.env.AGENC_HOME ?? '', 'managed-rules')

// Keep test isolation out of production policy code. Vitest resolves these
// mocks before loading each test module, so prompt/customization consumers do
// not inspect the host's machine-wide managed-policy assets.
vi.mock('../../src/utils/settings/managedPath.js', async importOriginal => {
  const original = await importOriginal<
    typeof import('../../src/utils/settings/managedPath.js')
  >()
  const getManagedFilePath = (): string => {
    const configured = process.env.AGENC_TEST_MANAGED_CONFIG_PATH
    if (configured) return configured
    return join(process.env.AGENC_HOME ?? '', 'managed-policy')
  }
  return {
    ...original,
    getManagedFilePath,
  }
})

// The prompt loader has a separate machine-wide policy surface from managed
// policy. Redirect both of its defaults at the module boundary so a default
// worker cannot stat or read /etc/agenc while preserving explicitly supplied
// fixture paths.
vi.mock('../../src/prompts/rules/discovery.js', async importOriginal => {
  const original = await importOriginal<
    typeof import('../../src/prompts/rules/discovery.js')
  >()
  return {
    ...original,
    DEFAULT_MANAGED_RULES_DIR: managedRulesDir(),
  }
})

vi.mock('../../src/prompts/agenc-md.js', async importOriginal => {
  const original = await importOriginal<
    typeof import('../../src/prompts/agenc-md.js')
  >()
  return {
    ...original,
    loadTieredInstructions: (
      options: Parameters<typeof original.loadTieredInstructions>[0],
    ) => original.loadTieredInstructions({
      ...options,
      managedPath: options.managedPath ?? managedInstructionsPath(),
    }),
  }
})
