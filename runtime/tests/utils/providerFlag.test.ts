import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  parseProviderFlag,
  applyProviderFlag,
  applyProviderFlagFromArgs,
  VALID_PROVIDERS,
} from './providerFlag.js'
import { getAPIProvider } from './model/providers.js'

const ENV_KEYS = [
  'AGENC_USE_OPENAI',
  'AGENC_USE_GEMINI',
  'AGENC_USE_GITHUB',
  'AGENC_USE_MISTRAL',
  'AGENC_USE_MINIMAX',
  'AGENC_USE_BEDROCK',
  'AGENC_USE_VERTEX',
  'AGENC_USE_FOUNDRY',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'XAI_API_KEY',
  'GEMINI_MODEL',
  'GITHUB_MODEL',
  'MISTRAL_MODEL',
  'NVIDIA_NIM',
  'NVIDIA_BASE_URL',
  'NVIDIA_MODEL',
  'MINIMAX_BASE_URL',
  'MINIMAX_API_KEY',
  'MINIMAX_MODEL',
]

const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }
})

const RESET_KEYS = [
  'AGENC_USE_OPENAI',
  'AGENC_USE_GEMINI',
  'AGENC_USE_GITHUB',
  'AGENC_USE_MISTRAL',
  'AGENC_USE_MINIMAX',
  'AGENC_USE_BEDROCK',
  'AGENC_USE_VERTEX',
  'AGENC_USE_FOUNDRY',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'XAI_API_KEY',
  'GEMINI_MODEL',
  'GITHUB_MODEL',
  'MISTRAL_MODEL',
  'NVIDIA_NIM',
  'NVIDIA_BASE_URL',
  'NVIDIA_MODEL',
  'MINIMAX_BASE_URL',
  'MINIMAX_API_KEY',
  'MINIMAX_MODEL',
] as const

beforeEach(() => {
  for (const key of RESET_KEYS) {
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalEnv[key]
    }
  }
})

// --- parseProviderFlag ---

describe('parseProviderFlag', () => {
  test('returns provider name when --provider flag present', () => {
    expect(parseProviderFlag(['--provider', 'openai'])).toBe('openai')
  })

  test('returns provider name with --model alongside', () => {
    expect(parseProviderFlag(['--provider', 'gemini', '--model', 'gemini-2.0-flash'])).toBe('gemini')
  })

  test('returns null when --provider flag absent', () => {
    expect(parseProviderFlag(['--model', 'gpt-4o'])).toBeNull()
  })

  test('returns null for empty args', () => {
    expect(parseProviderFlag([])).toBeNull()
  })

  test('returns null when --provider has no value', () => {
    expect(parseProviderFlag(['--provider'])).toBeNull()
  })

  test('returns null when --provider value starts with --', () => {
    expect(parseProviderFlag(['--provider', '--model'])).toBeNull()
  })
})

// --- applyProviderFlag ---

describe('applyProviderFlag - anthropic', () => {
  test('sets no env vars for anthropic (default)', () => {
    const result = applyProviderFlag('anthropic', [])
    expect(result.error).toBeUndefined()
    expect(process.env.AGENC_USE_OPENAI).toBeUndefined()
    expect(process.env.AGENC_USE_GEMINI).toBeUndefined()
  })
})

describe('applyProviderFlag - openai', () => {
  test('sets AGENC_USE_OPENAI=1', () => {
    const result = applyProviderFlag('openai', [])
    expect(result.error).toBeUndefined()
    expect(process.env.AGENC_USE_OPENAI).toBe('1')
  })

  test('sets OPENAI_MODEL when --model is provided', () => {
    applyProviderFlag('openai', ['--model', 'gpt-4o'])
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
  })
})

describe('applyProviderFlag - gemini', () => {
  test('sets AGENC_USE_GEMINI=1', () => {
    const result = applyProviderFlag('gemini', [])
    expect(result.error).toBeUndefined()
    expect(process.env.AGENC_USE_GEMINI).toBe('1')
  })

  test('sets GEMINI_MODEL when --model is provided', () => {
    applyProviderFlag('gemini', ['--model', 'gemini-2.0-flash'])
    expect(process.env.GEMINI_MODEL).toBe('gemini-2.0-flash')
  })
})

describe('applyProviderFlag - github', () => {
  test('sets AGENC_USE_GITHUB=1', () => {
    const result = applyProviderFlag('github', [])
    expect(result.error).toBeUndefined()
    expect(process.env.AGENC_USE_GITHUB).toBe('1')
  })

  test('sets GITHUB_MODEL when --model is provided', () => {
    applyProviderFlag('github', ['--model', 'github:copilot'])
    expect(process.env.GITHUB_MODEL).toBe('github:copilot')
    expect(process.env.OPENAI_MODEL).toBeUndefined()
  })
})

describe('applyProviderFlag - mistral', () => {
  test('sets AGENC_USE_MISTRAL=1 and MISTRAL_MODEL when --model is provided', () => {
    const result = applyProviderFlag('mistral', ['--model', 'devstral-latest'])
    expect(result.error).toBeUndefined()
    expect(process.env.AGENC_USE_MISTRAL).toBe('1')
    expect(process.env.MISTRAL_MODEL).toBe('devstral-latest')
    expect(process.env.OPENAI_MODEL).toBeUndefined()
  })
})

describe('applyProviderFlag - nvidia-nim', () => {
  test('sets provider-specific NVIDIA defaults', () => {
    const result = applyProviderFlag('nvidia-nim', [])
    expect(result.error).toBeUndefined()
    expect(process.env.NVIDIA_NIM).toBe('1')
    expect(process.env.NVIDIA_BASE_URL).toBe('https://integrate.api.nvidia.com/v1')
    expect(process.env.NVIDIA_MODEL).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
    expect(process.env.AGENC_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBeUndefined()
  })

  test('sets NVIDIA_MODEL when --model is provided', () => {
    applyProviderFlag('nvidia-nim', ['--model', 'nvidia/custom-model'])
    expect(process.env.NVIDIA_MODEL).toBe('nvidia/custom-model')
  })
})

describe('applyProviderFlag - minimax', () => {
  test('sets provider-specific MiniMax defaults', () => {
    const result = applyProviderFlag('minimax', [])
    expect(result.error).toBeUndefined()
    expect(process.env.AGENC_USE_MINIMAX).toBe('1')
    expect(process.env.MINIMAX_BASE_URL).toBe('https://api.minimax.io/v1')
    expect(process.env.MINIMAX_MODEL).toBe('MiniMax-M2.5')
    expect(process.env.AGENC_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBeUndefined()
  })

  test('sets MINIMAX_MODEL when --model is provided', () => {
    applyProviderFlag('minimax', ['--model', 'MiniMax-M2.7'])
    expect(process.env.MINIMAX_MODEL).toBe('MiniMax-M2.7')
  })
})

describe('applyProviderFlag - removed legacy providers', () => {
  test.each(['bedrock', 'vertex', 'foundry'] as const)('rejects %s', provider => {
    const result = applyProviderFlag(provider, [])
    expect(result.error).toContain(provider)
    expect(process.env.AGENC_USE_BEDROCK).toBeUndefined()
    expect(process.env.AGENC_USE_VERTEX).toBeUndefined()
    expect(process.env.AGENC_USE_FOUNDRY).toBeUndefined()
  })
})

describe('applyProviderFlag - provider precedence cleanup', () => {
  test('clears stale NVIDIA_NIM when switching providers', () => {
    process.env.NVIDIA_NIM = '1'

    const result = applyProviderFlag('github', ['--model', 'github:copilot'])

    expect(result.error).toBeUndefined()
    expect(process.env.NVIDIA_NIM).toBeUndefined()
    expect(process.env.AGENC_USE_GITHUB).toBe('1')
    expect(getAPIProvider()).toBe('github')
  })

  test.each([
    {
      provider: 'mistral',
      model: 'devstral-latest',
      expected: 'mistral',
    },
    {
      provider: 'github',
      model: 'github:copilot',
      expected: 'github',
    },
    {
      provider: 'openai',
      model: 'gpt-4o',
      expected: 'openai',
    },
  ] as const)(
    'lets explicit $provider beat ambient MiniMax credentials',
    ({ provider, model, expected }) => {
      process.env.MINIMAX_API_KEY = 'ambient-minimax-key'

      const result = applyProviderFlag(provider, [
        '--provider',
        provider,
        '--model',
        model,
      ])

      expect(result.error).toBeUndefined()
      expect(getAPIProvider()).toBe(expected)
    },
  )
})

describe('applyProviderFlag - ollama', () => {
  test('sets AGENC_USE_OPENAI=1 with Ollama defaults when unset', () => {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY

    const result = applyProviderFlag('ollama', [])
    expect(result.error).toBeUndefined()
    expect(process.env.AGENC_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_API_KEY).toBe('ollama')
  })

  test('sets OPENAI_MODEL when --model is provided', () => {
    applyProviderFlag('ollama', ['--model', 'llama3.2'])
    expect(process.env.OPENAI_MODEL).toBe('llama3.2')
  })

  test('does not override existing OPENAI_BASE_URL when user set a custom one', () => {
    process.env.OPENAI_BASE_URL = 'http://my-ollama:11434/v1'
    applyProviderFlag('ollama', [])
    expect(process.env.OPENAI_BASE_URL).toBe('http://my-ollama:11434/v1')
  })

  test('preserves explicit OPENAI_BASE_URL and OPENAI_API_KEY overrides', () => {
    process.env.OPENAI_BASE_URL = 'http://remote-ollama.internal:11434/v1'
    process.env.OPENAI_API_KEY = 'secret-token'

    applyProviderFlag('ollama', [])

    expect(process.env.OPENAI_BASE_URL).toBe('http://remote-ollama.internal:11434/v1')
    expect(process.env.OPENAI_API_KEY).toBe('secret-token')
  })
})

describe('applyProviderFlag - xai', () => {
  test('sets AGENC_USE_OPENAI=1 with xAI defaults when unset', () => {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY

    const result = applyProviderFlag('xai', [])
    expect(result.error).toBeUndefined()
    expect(process.env.AGENC_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.x.ai/v1')
    expect(process.env.OPENAI_MODEL).toBe('grok-4')
  })

  test('sets OPENAI_MODEL when --model is provided', () => {
    applyProviderFlag('xai', ['--model', 'grok-3'])
    expect(process.env.OPENAI_MODEL).toBe('grok-3')
  })

  test('propagates XAI_API_KEY to OPENAI_API_KEY when only XAI_API_KEY is set', () => {
    delete process.env.OPENAI_API_KEY
    process.env.XAI_API_KEY = 'xai-secret-key'

    applyProviderFlag('xai', [])

    expect(process.env.OPENAI_API_KEY).toBe('xai-secret-key')
  })

  test('does not override existing OPENAI_API_KEY when both keys are set', () => {
    process.env.OPENAI_API_KEY = 'existing-openai-key'
    process.env.XAI_API_KEY = 'xai-secret-key'

    applyProviderFlag('xai', [])

    expect(process.env.OPENAI_API_KEY).toBe('existing-openai-key')
  })
})

describe('applyProviderFlag - invalid provider', () => {
  test('returns error for unknown provider', () => {
    const result = applyProviderFlag('unknown-provider', [])
    expect(result.error).toContain('unknown-provider')
    expect(result.error).toContain(VALID_PROVIDERS.join(', '))
  })
})

describe('applyProviderFlagFromArgs', () => {
  test('applies ollama provider and model from argv in one step', () => {
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY

    const result = applyProviderFlagFromArgs([
      '--provider',
      'ollama',
      '--model',
      'qwen2.5:3b',
    ])

    expect(result?.error).toBeUndefined()
    expect(process.env.AGENC_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_API_KEY).toBe('ollama')
    expect(process.env.OPENAI_MODEL).toBe('qwen2.5:3b')
  })

  test('returns undefined when --provider is absent', () => {
    expect(applyProviderFlagFromArgs(['--model', 'gpt-4o'])).toBeUndefined()
  })
})
