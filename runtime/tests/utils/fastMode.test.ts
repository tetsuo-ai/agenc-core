import { afterEach, describe, expect, test } from 'vitest'

import { snapshotProviderEnvironment } from '../../src/llm/provider-options.js'
import type { ProviderAuthReadContext } from '../../src/utils/auth.js'
import { isFastModeEnabledForContext } from '../../src/utils/fastMode.js'

const originalDisableFastMode = process.env.AGENC_DISABLE_FAST_MODE

function fastModeContext(
  environment: Readonly<Record<string, string | undefined>>,
): ProviderAuthReadContext {
  return Object.freeze({
    home: Object.freeze({ path: '/tmp/agenc-fast-mode-test-home' }) as never,
    environment,
    provider: 'anthropic',
  })
}

afterEach(() => {
  if (originalDisableFastMode === undefined) {
    delete process.env.AGENC_DISABLE_FAST_MODE
  } else {
    process.env.AGENC_DISABLE_FAST_MODE = originalDisableFastMode
  }
})

describe('fast-mode provider environment authority', () => {
  test('uses captured flags after source and process environments mutate', () => {
    const sourceEnvironment: Record<string, string | undefined> = {
      AGENC_DISABLE_FAST_MODE: '0',
    }
    const capturedEnvironment = snapshotProviderEnvironment(sourceEnvironment)
    const context = fastModeContext(capturedEnvironment)

    sourceEnvironment.AGENC_DISABLE_FAST_MODE = '1'
    process.env.AGENC_DISABLE_FAST_MODE = '1'

    expect(capturedEnvironment).toMatchObject({
      AGENC_DISABLE_FAST_MODE: '0',
    })
    expect(isFastModeEnabledForContext(context)).toBe(true)
  })
})
