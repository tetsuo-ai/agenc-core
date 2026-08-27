import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigStore } from '../../src/config/store.ts'
import {
  runWithStartupProviderSelection,
  type ProviderRuntimeSelection,
} from '../../src/utils/model/providers.ts'
import { runWithCanonicalSettingsAuthority } from '../../src/utils/settings/canonicalAuthority.ts'

interface CanonicalRuntimeAuthorityOptions {
  readonly provider?: string
  readonly model?: string
  readonly environment?: ProviderRuntimeSelection['environment']
  readonly cwd?: string
}

interface CanonicalRuntimeAuthorityContext {
  readonly configStore: ConfigStore
  readonly home: string
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null) ||
    typeof value === 'function'
  ) && 'then' in value
}

export function runWithCanonicalRuntimeAuthority<T>(
  operation: (context: CanonicalRuntimeAuthorityContext) => T,
  options: CanonicalRuntimeAuthorityOptions = {},
): T {
  const home = mkdtempSync(join(tmpdir(), 'agenc-bun-authority-'))
  let configStore: ConfigStore
  try {
    configStore = new ConfigStore({
      cwd: options.cwd ?? process.cwd(),
      env: { AGENC_HOME: home },
      home,
    })
  } catch (error) {
    rmSync(home, { force: true, recursive: true })
    throw error
  }

  let released = false
  const release = () => {
    if (released) return
    released = true
    configStore.stateRepository.close()
    rmSync(home, { force: true, recursive: true })
  }

  try {
    const result = runWithCanonicalSettingsAuthority(configStore, () =>
      runWithStartupProviderSelection(
        {
          environment: options.environment ?? {},
          model: options.model ?? 'gpt-5',
          provider: options.provider ?? 'openai',
        },
        () => operation({ configStore, home }),
      ),
    )
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(release) as T
    }
    release()
    return result
  } catch (error) {
    release()
    throw error
  }
}
