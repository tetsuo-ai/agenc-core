import { describe, expect, test, vi } from 'vitest'
import { existsSync, globSync, readFileSync } from 'node:fs'

import { AdmissionDeniedError } from '../../src/budget/admission-client.js'
import { execPromptHook } from '../../src/utils/hooks/execPromptHook.js'
import { sideQuery } from '../../src/utils/sideQuery.js'
import { createCommandPrefixExtractor } from '../../src/utils/shell/prefix.js'

const RETIRED_PROVIDER_STACK_FILES = [
  '../../src/llm/registry/provider-connection.ts',
  '../../src/services/api/anthropic.ts',
  '../../src/services/api/cacheMetrics.ts',
  '../../src/services/api/cacheStatsTracker.ts',
  '../../src/services/api/client.ts',
  '../../src/services/api/compressToolHistory.ts',
  '../../src/services/api/fetchWithProxyRetry.ts',
  '../../src/services/api/logging.ts',
  '../../src/services/api/openAiCodeTransform.ts',
  '../../src/services/api/openaiShim.ts',
  '../../src/services/api/promptCacheBreakDetection.ts',
  '../../src/services/api/providerConfig.ts',
  '../../src/services/api/thinkTagSanitizer.ts',
  '../../src/services/api/toolArgumentNormalization.ts',
  '../../src/services/api/withRetry.ts',
  '../../src/services/vcr.ts',
  '../../src/utils/aws.ts',
  '../../src/utils/contentArray.ts',
  '../../src/utils/fingerprint.ts',
  '../../src/utils/hybridContextStrategy.ts',
  '../../src/utils/requestLogging.ts',
  '../../src/utils/schemaSanitizer.ts',
  '../../src/utils/streamingOptimizer.ts',
  '../../src/utils/workloadContext.ts',
] as const

const RETIRED_REQUEST_ENVIRONMENT_NAMES = [
  'AGENC_ADDITIONAL_PROTECTION',
  'AGENC_ATTRIBUTION_HEADER',
  'AGENC_CONTAINER_ID',
  'AGENC_DISABLE_ADAPTIVE_THINKING',
  'AGENC_DISABLE_NONSTREAMING_FALLBACK',
  'AGENC_DISABLE_STRICT_TOOLS',
  'AGENC_DISABLE_THINKING',
  'AGENC_DISABLE_TOOL_HISTORY_COMPRESSION',
  'AGENC_EXTRA_BODY',
  'AGENC_EXTRA_METADATA',
  'AGENC_MAX_RETRIES',
  'AGENC_TEST_FIXTURES_ROOT',
  'AGENC_UNATTENDED_RETRY',
  'DISABLE_PROMPT_CACHING',
  'DISABLE_PROMPT_CACHING_HAIKU',
  'DISABLE_PROMPT_CACHING_OPUS',
  'DISABLE_PROMPT_CACHING_SONNET',
  'DISABLE_TOOL_HISTORY_COMPRESSION',
  'FALLBACK_FOR_ALL_PRIMARY_MODELS',
  'FORCE_VCR',
  'IS_SANDBOX',
  'VCR_RECORD',
] as const

describe('retired model shortcuts', () => {
  test('does not ship the retired compatibility request stack', () => {
    for (const path of RETIRED_PROVIDER_STACK_FILES) {
      expect(existsSync(new URL(path, import.meta.url)), path).toBe(false)
    }
  })

  test('does not read or document retired request environment names', () => {
    const repoRoot = new URL('../../../', import.meta.url)
    const paths = [
      ...globSync('runtime/src/**/*.{cjs,js,mjs,ts,tsx}', {
        cwd: repoRoot,
      }),
      'docs/reference/env.md',
    ]

    for (const path of paths) {
      const content = readFileSync(new URL(path, repoRoot), 'utf8')
      for (const name of RETIRED_REQUEST_ENVIRONMENT_NAMES) {
        expect(content, `${path} still contains ${name}`).not.toContain(name)
      }
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
