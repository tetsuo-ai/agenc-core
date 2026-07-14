import { join } from 'node:path'

import { vi } from 'vitest'

type RawReadResult = {
  plistStdouts: Array<{ stdout: string; label: string }> | null
  hklmStdout: string | null
  hkcuStdout: string | null
}

const emptyRawReadResult = (): RawReadResult => ({
  hkcuStdout: null,
  hklmStdout: null,
  plistStdouts: null,
})

const managedInstructionsPath = (): string =>
  join(process.env.AGENC_HOME ?? '', 'managed-instructions', 'AGENC.md')

const managedRulesDir = (): string =>
  join(process.env.AGENC_HOME ?? '', 'managed-rules')

// Keep test isolation out of production policy code. Vitest resolves these
// mocks before loading each test module, so the default suite never reads the
// host's machine-wide managed-policy paths or invokes macOS/Windows MDM tools.
vi.mock('../../src/utils/settings/managedPath.js', async importOriginal => {
  const original = await importOriginal<
    typeof import('../../src/utils/settings/managedPath.js')
  >()
  const getManagedFilePath = (): string => {
    if (
      process.env.USER_TYPE === 'ant' &&
      process.env.AGENC_MANAGED_SETTINGS_PATH
    ) {
      return process.env.AGENC_MANAGED_SETTINGS_PATH
    }
    const configured = process.env.AGENC_TEST_MANAGED_SETTINGS_PATH
    if (configured) return configured
    return join(process.env.AGENC_HOME ?? '', 'managed-policy')
  }
  return {
    ...original,
    getManagedFilePath,
    getManagedSettingsDropInDir: () =>
      join(getManagedFilePath(), 'managed-settings.d'),
  }
})

vi.mock('../../src/utils/settings/mdm/rawRead.js', async importOriginal => {
  const original = await importOriginal<
    typeof import('../../src/utils/settings/mdm/rawRead.js')
  >()
  let rawReadPromise: Promise<RawReadResult> | null = null
  const fireRawRead = async (): Promise<RawReadResult> => emptyRawReadResult()
  return {
    ...original,
    fireRawRead,
    getMdmRawReadPromise: () => rawReadPromise,
    startMdmRawRead: () => {
      rawReadPromise ??= fireRawRead()
    },
  }
})

// The prompt loader has a separate machine-wide policy surface from managed
// settings. Redirect both of its defaults at the module boundary so a default
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
