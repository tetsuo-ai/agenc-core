import { describe, expect, test, vi } from 'vitest'

import { AdmissionDeniedError } from '../../src/budget/admission-client.js'
import {
  queryHaiku,
  queryModelWithoutStreaming,
  queryModelWithStreaming,
  queryWithModel,
} from '../../src/services/api/anthropic.js'
import { execPromptHook } from '../../src/utils/hooks/execPromptHook.js'
import { sideQuery } from '../../src/utils/sideQuery.js'
import { createCommandPrefixExtractor } from '../../src/utils/shell/prefix.js'

describe('legacy model shortcuts', () => {
  test('legacy Anthropic model APIs deny outside the test harness before network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const calls: Array<() => Promise<unknown>> = [
        () => queryModelWithoutStreaming({} as never),
        () => queryModelWithStreaming({} as never).next(),
        () => queryHaiku({} as never),
        () => queryWithModel({} as never),
      ]
      for (const call of calls) {
        await expect(call()).rejects.toMatchObject<Partial<AdmissionDeniedError>>({
          code: 'ADMISSION_DENIED',
          reason: 'legacy_anthropic_model_api_disabled',
        })
      }
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      fetchSpy.mockRestore()
    }
  })

  test('prompt hooks fail closed with a machine-readable admission result', async () => {
    const result = await execPromptHook(
      { type: 'prompt', prompt: 'Approve only safe actions' },
      'policy-hook',
      'PreToolUse',
      '{}',
      new AbortController().signal,
      {} as never,
    )

    expect(result).toMatchObject({
      outcome: 'blocking',
      preventContinuation: true,
    })
    expect(JSON.parse(result.stopReason ?? '{}')).toEqual({
      code: 'ADMISSION_DENIED',
      decision: 'deny',
      reason: 'legacy_prompt_hook_model_path_disabled',
    })
  })

  test('side queries deny before constructing or calling a provider client', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = sideQuery({
      model: 'test-model',
      messages: [{ role: 'user', content: 'classify' }],
      querySource: 'memory_relevance',
    })

    await expect(result).rejects.toMatchObject<Partial<AdmissionDeniedError>>({
      code: 'ADMISSION_DENIED',
      reason: 'legacy_side_query_model_path_disabled',
      decision: 'deny',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  test('shell prefix extraction keeps local proofs and otherwise forces approval', async () => {
    const extract = createCommandPrefixExtractor({
      toolName: 'Bash',
      policySpec: 'unused while the legacy model path is disabled',
      eventName: 'test',
      querySource: 'bash_extract_prefix',
      preCheck: (command) =>
        command === 'help' ? { commandPrefix: 'help' } : null,
    })
    const signal = new AbortController().signal

    await expect(extract('help', signal, false)).resolves.toEqual({
      commandPrefix: 'help',
    })
    await expect(extract('git status', signal, false)).resolves.toEqual({
      commandPrefix: null,
    })
  })
})
