import { join } from 'node:path'

import { vi } from 'vitest'

const managedRootPath = (): string =>
  join(process.env.AGENC_HOME ?? '', 'managed-policy')

// Keep test isolation out of production policy code. Vitest resolves these
// mocks before loading each test module, so prompt/customization consumers do
// not inspect the host's machine-wide managed-policy assets.
vi.mock('../../src/utils/settings/managedPath.js', async importOriginal => {
  const original = await importOriginal<
    typeof import('../../src/utils/settings/managedPath.js')
  >()
  return {
    ...original,
    resolveManagedPathContext: (
      env?: Parameters<typeof original.resolveManagedPathContext>[0],
      platform?: Parameters<typeof original.resolveManagedPathContext>[1],
      explicitRoot?: Parameters<typeof original.resolveManagedPathContext>[2],
    ) =>
      original.resolveManagedPathContext(
        env,
        platform,
        explicitRoot ?? managedRootPath(),
      ),
  }
})
