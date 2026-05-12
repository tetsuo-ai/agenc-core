import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { detectProvider, printStartupScreen } from './StartupScreen.js'

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../../utils/settings/settings.js', () => ({
  getInitialSettings: () => ({}),
}))

const ENV_KEYS = [
  'AGENC_USE_OPENAI',
  'AGENC_USE_GEMINI',
  'AGENC_USE_GITHUB',
  'AGENC_USE_BEDROCK',
  'AGENC_USE_VERTEX',
  'AGENC_USE_MISTRAL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'GEMINI_MODEL',
  'MISTRAL_MODEL',
  'ANTHROPIC_MODEL',
  'AGENC_MODEL',
  'NVIDIA_NIM',
  'MINIMAX_API_KEY',
  'CI',
]

const originalEnv: Record<string, string | undefined> = {}
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
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
  if (originalStdoutIsTTY) {
    Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTTY)
  } else {
    delete (process.stdout as { isTTY?: boolean }).isTTY
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setupOpenAIMode(baseUrl: string, model: string): void {
  process.env.AGENC_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = baseUrl
  process.env.OPENAI_MODEL = model
  process.env.OPENAI_API_KEY = 'test-key'
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '')
}

// --- Issue #855: aggregator URL must win over vendor-prefixed model name ---

describe('detectProvider — aggregator URL authoritative over model-name substring (#855)', () => {
  test('OpenRouter + deepseek/deepseek-chat labels as OpenRouter', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'deepseek/deepseek-chat')
    expect(detectProvider().name).toBe('OpenRouter')
  })

  test('OpenRouter + moonshotai/kimi-k2 labels as OpenRouter', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'moonshotai/kimi-k2')
    expect(detectProvider().name).toBe('OpenRouter')
  })

  test('OpenRouter + mistralai/mistral-large labels as OpenRouter', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'mistralai/mistral-large')
    expect(detectProvider().name).toBe('OpenRouter')
  })

  test('OpenRouter + meta-llama/llama-3.3 labels as OpenRouter', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'meta-llama/llama-3.3-70b-instruct')
    expect(detectProvider().name).toBe('OpenRouter')
  })

  test('Together + deepseek-ai/DeepSeek-V3 labels as Together AI', () => {
    setupOpenAIMode('https://api.together.xyz/v1', 'deepseek-ai/DeepSeek-V3')
    expect(detectProvider().name).toBe('Together AI')
  })

  test('Together + meta-llama/Llama-3.3 labels as Together AI', () => {
    setupOpenAIMode('https://api.together.xyz/v1', 'meta-llama/Llama-3.3-70B-Instruct-Turbo')
    expect(detectProvider().name).toBe('Together AI')
  })

  test('Groq + deepseek-r1-distill-llama-70b labels as Groq', () => {
    setupOpenAIMode('https://api.groq.com/openai/v1', 'deepseek-r1-distill-llama-70b')
    expect(detectProvider().name).toBe('Groq')
  })

  test('Groq + llama-3.3-70b-versatile labels as Groq', () => {
    setupOpenAIMode('https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile')
    expect(detectProvider().name).toBe('Groq')
  })

  test('Azure + any deepseek deployment labels as Azure provider', () => {
    setupOpenAIMode('https://my-resource.openai.azure.com/', 'deepseek-chat')
    expect(detectProvider().name).toBe('Azure OpenAI') // branding-scan: allow real provider display name
  })
})

describe('printStartupScreen', () => {
  test('renders AgenC-only first-frame block art', () => {
    setupOpenAIMode('https://api.openai.com/v1', 'gpt-4o')
    vi.stubGlobal('MACRO', { VERSION: '0.0.0-test' })
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    })
    let output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      output += typeof chunk === 'string' ? chunk : String(chunk)
      return true
    })

    printStartupScreen('gpt-4o')

    const plain = stripAnsi(output)
    expect(plain).toContain('█████╗  ██████╗  ███████╗███╗   ██╗ ██████╗')
    expect(plain).toContain('Orchestrator online. Multi-agent terminal ready.')
    expect(plain).toContain('agenc v0.0.0-test')
    expect(plain).not.toContain('████████╗ ████████╗ ████████╗ ██╗  ██╗')
    expect(plain).not.toContain('████████╗ ██╗      ████████╗ ██╗   ██╗')
  })
})

// --- Direct vendor endpoints still label correctly (regression) ---

describe('detectProvider — direct vendor endpoints', () => {
  test('api.deepseek.com labels as DeepSeek', () => {
    setupOpenAIMode('https://api.deepseek.com/v1', 'deepseek-chat')
    expect(detectProvider().name).toBe('DeepSeek')
  })

  test('api.kimi.com labels as Moonshot AI - Kimi Code', () => {
    setupOpenAIMode('https://api.kimi.com/coding/v1', 'kimi-for-coding')
    expect(detectProvider().name).toBe('Moonshot AI - Kimi Code')
  })

  test('api.moonshot.cn labels as Moonshot AI - API', () => {
    setupOpenAIMode('https://api.moonshot.cn/v1', 'moonshot-v1-8k')
    expect(detectProvider().name).toBe('Moonshot AI - API')
  })

  test('api.mistral.ai labels as Mistral', () => {
    setupOpenAIMode('https://api.mistral.ai/v1', 'mistral-large-latest')
    expect(detectProvider().name).toBe('Mistral')
  })

  test('api.z.ai labels as Z.AI GLM', () => {
    setupOpenAIMode('https://api.z.ai/api/coding/paas/v4', 'GLM-5.1')
    expect(detectProvider().name).toBe('Z.AI - GLM')
  })

  test('default provider URL + gpt-4o labels provider', () => {
    setupOpenAIMode('https://api.openai.com/v1', 'gpt-4o')
    expect(detectProvider().name).toBe('OpenAI') // branding-scan: allow real provider display name
  })
})

// --- rawModel fallback for generic/custom endpoints ---

describe('detectProvider — rawModel fallback when URL is generic', () => {
  test('custom proxy + deepseek-chat falls back to DeepSeek', () => {
    setupOpenAIMode('http://127.0.0.1:9999/v1', 'deepseek-chat')
    expect(detectProvider().name).toBe('DeepSeek')
  })

  test('custom proxy + kimi-for-coding falls back to Moonshot AI - Kimi Code', () => {
    setupOpenAIMode('http://127.0.0.1:9999/v1', 'kimi-for-coding')
    expect(detectProvider().name).toBe('Moonshot AI - Kimi Code')
  })

  test('custom proxy + kimi-k2 falls back to Moonshot AI - API', () => {
    setupOpenAIMode('http://127.0.0.1:9999/v1', 'kimi-k2-instruct')
    expect(detectProvider().name).toBe('Moonshot AI - API')
  })

  test('custom proxy + llama-3.3 falls back to Meta Llama', () => {
    setupOpenAIMode('http://127.0.0.1:9999/v1', 'llama-3.3-70b')
    expect(detectProvider().name).toBe('Meta Llama')
  })

  test('custom proxy + mistral-large falls back to Mistral', () => {
    setupOpenAIMode('http://127.0.0.1:9999/v1', 'mistral-large-latest')
    expect(detectProvider().name).toBe('Mistral')
  })

  test('custom proxy + exact uppercase GLM ID falls back to Z.AI GLM', () => {
    setupOpenAIMode('http://127.0.0.1:9999/v1', 'GLM-5.1')
    expect(detectProvider().name).toBe('Z.AI - GLM')
  })

  test('custom proxy + lowercase glm ID stays generic provider', () => {
    setupOpenAIMode('http://127.0.0.1:9999/v1', 'glm-5.1')
    const result = detectProvider()
    expect(result.name).not.toBe('Z.AI - GLM')
    expect(result.isLocal).toBe(true)
  })

  test('DashScope lowercase glm ID is not mislabeled as Z.AI', () => {
    setupOpenAIMode('https://dashscope.aliyuncs.com/compatible-mode/v1', 'glm-5.1')
    expect(detectProvider().name).toBe('OpenAI') // branding-scan: allow real provider display name
  })
})

// --- Explicit env flags win over URL heuristics ---

describe('detectProvider — explicit dedicated-provider env flags', () => {
  test('NVIDIA_NIM=1 overrides aggregator URL', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'some-nim-model')
    process.env.NVIDIA_NIM = '1'
    expect(detectProvider().name).toBe('NVIDIA NIM')
  })

  test('MINIMAX_API_KEY overrides aggregator URL', () => {
    setupOpenAIMode('https://openrouter.ai/api/v1', 'any-model')
    process.env.MINIMAX_API_KEY = 'test-key'
    expect(detectProvider().name).toBe('MiniMax')
  })
})

// --- modelOverride from --model flag ---

describe('detectProvider — modelOverride from --model flag', () => {
  test('modelOverride overrides default provider model', () => {
    const result = detectProvider('claude-opus-4-6')
    expect(result.name).toBe('Anthropic') // branding-scan: allow real provider display name
    expect(result.model).toContain('opus')
  })

  test('modelOverride alias follows current default model routing', () => {
    const result = detectProvider('opus')
    expect(result.name).toBe('Anthropic') // branding-scan: allow real provider display name
    expect(result.model).toBe('grok-4')
  })

  test('modelOverride takes priority over ANTHROPIC_MODEL env var', () => {
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
    const result = detectProvider('claude-opus-4-6')
    expect(result.name).toBe('Anthropic') // branding-scan: allow real provider display name
    expect(result.model).toContain('opus')
  })

  test('modelOverride takes priority over AGENC_MODEL env var', () => {
    process.env.AGENC_MODEL = 'claude-haiku-4-5-20251001'
    const result = detectProvider('claude-opus-4-6')
    expect(result.name).toBe('Anthropic') // branding-scan: allow real provider display name
    expect(result.model).toContain('opus')
  })

  test('modelOverride works for provider transport', () => {
    process.env.AGENC_USE_OPENAI = '1'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'gpt-4o'
    const result = detectProvider('gpt-4-turbo')
    expect(result.model).toContain('gpt-4-turbo')
  })

  test('modelOverride works for Gemini provider', () => {
    process.env.AGENC_USE_GEMINI = '1'
    const result = detectProvider('gemini-2.5-pro')
    expect(result.model).toBe('gemini-2.5-pro')
  })

  test('modelOverride works for Mistral provider', () => {
    process.env.AGENC_USE_MISTRAL = '1'
    const result = detectProvider('mistral-large-latest')
    expect(result.model).toBe('mistral-large-latest')
  })

  test('modelOverride works for GitHub provider', () => {
    process.env.AGENC_USE_GITHUB = '1'
    const result = detectProvider('gpt-4o')
    expect(result.model).toContain('gpt-4o')
  })

  test('undefined modelOverride preserves default behavior', () => {
    const result = detectProvider(undefined)
    expect(result.name).toBe('Anthropic') // branding-scan: allow real provider display name
    expect(result.model).toContain('sonnet')
  })

  test('no argument preserves default behavior', () => {
    const result = detectProvider()
    expect(result.name).toBe('Anthropic') // branding-scan: allow real provider display name
    expect(result.model).toContain('sonnet')
  })
})
