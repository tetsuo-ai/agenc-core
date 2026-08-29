import { describe, expect, test } from 'vitest'
import { modelSupportsThinking } from '../../src/utils/thinking.ts'
import { runWithStartupProviderSelection } from '../../src/utils/model/providers.ts'

function providerTest(
  name: string,
  environment: NodeJS.ProcessEnv,
  body: () => void | Promise<void>,
): void {
  test(name, () =>
    runWithStartupProviderSelection(
      { provider: 'openai', model: 'gpt-4o', environment },
      body,
    ),
  )
}

describe('modelSupportsThinking — Z.AI GLM', () => {
  providerTest(
    'enables thinking for exact GLM models on api.z.ai',
    { OPENAI_BASE_URL: 'https://api.z.ai/api/coding/paas/v4' },
    () => {
    expect(modelSupportsThinking('GLM-5.1')).toBe(true)
    expect(modelSupportsThinking('GLM-5-Turbo')).toBe(true)
    expect(modelSupportsThinking('GLM-4.7')).toBe(true)
    expect(modelSupportsThinking('GLM-4.5-Air')).toBe(true)
    },
  )

  providerTest(
    'does not enable GLM thinking on non-Z.AI openai-compatible endpoints',
    { OPENAI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    () => {
      expect(modelSupportsThinking('glm-5.1')).toBe(false)
      expect(modelSupportsThinking('GLM-5.1')).toBe(false)
    },
  )

  providerTest(
    'does not match unrelated GLM-looking model names',
    { OPENAI_BASE_URL: 'https://api.z.ai/api/coding/paas/v4' },
    () => {
      expect(modelSupportsThinking('glm-50')).toBe(false)
    },
  )

  test('rejects retired provider-specific capability overrides', () => {
    expect(() =>
      runWithStartupProviderSelection(
        {
          provider: 'openai',
          model: 'gpt-4o',
          environment: {
            OPENAI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'GLM-5.1',
            ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: '',
          },
        },
        () => modelSupportsThinking('GLM-5.1'),
      )
    ).toThrow(/obsolete configuration environment variable/)
  })
})
