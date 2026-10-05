import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/session/runtime-options.js', () => {
  throw new Error('process ingress must not load session option construction')
})
vi.mock('../../src/utils/subprocessEnv.js', () => {
  throw new Error('process ingress must not load subprocess environment helpers')
})
vi.mock('../../src/llm/registry/provider-info.js', () => {
  throw new Error('process ingress must not load provider metadata')
})

import { assertCanonicalEnvironmentIngress } from '../../src/config/environment-ingress.js'
import {
  AgentRuntimeOptionsError,
  RETIRED_AGENT_RUNTIME_ENV_REPLACEMENTS,
} from '../../src/session/runtime-options-ingress.js'
import { peekAgentRuntimeOptions } from '../../src/session/runtime-options-context.js'

describe('runtime validation before session setup', () => {
  it.each(Object.keys(RETIRED_AGENT_RUNTIME_ENV_REPLACEMENTS))('rejects every defined value of %s', key => {
    for (const value of ['', '0', 'false', '1']) {
      expect(() => assertCanonicalEnvironmentIngress({ [key]: value })).toThrow(AgentRuntimeOptionsError)
    }
    expect(() => assertCanonicalEnvironmentIngress({ [key]: undefined })).not.toThrow()
    expect(peekAgentRuntimeOptions()).toBeUndefined()
  })

  it('keeps the complete error message and precedence', () => {
    expect(() => assertCanonicalEnvironmentIngress({ AGENC_BARE: '0', AGENC_SIMPLE: '0', OPENAI_MODEL: 'old' }))
      .toThrow('AGENC_SIMPLE was removed; use --bare; AGENC_BARE was removed; use --bare')
  })
})
