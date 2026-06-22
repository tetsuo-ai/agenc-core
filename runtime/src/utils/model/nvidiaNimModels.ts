/**
 * NVIDIA NIM model list for the /model picker.
 * Filtered to chat/instruct models only - embedding, reward, safety, vision, etc. excluded.
 */

import type { ModelOption } from './modelOptions.js'
import { getAPIProvider } from './providers.js'
import { isEnvTruthy } from '../envUtils.js'

export function isNvidiaNimProvider(): boolean {
  // Check if explicitly set via NVIDIA_NIM or via provider flag
  if (isEnvTruthy(process.env.NVIDIA_NIM)) {
    return true
  }
  // Also check if using NVIDIA NIM endpoint
  const baseUrl = process.env.OPENAI_BASE_URL ?? ''
  if (baseUrl.includes('nvidia') || baseUrl.includes('integrate.api.nvidia')) {
    return true
  }
  return getAPIProvider() === 'nvidia-nim'
}

type NvidiaNimModelEntry = readonly [value: string, label: string]

type NvidiaNimModelGroup = {
  readonly description: string
  readonly entries: readonly NvidiaNimModelEntry[]
}

const NVIDIA_NIM_MODEL_GROUPS: readonly NvidiaNimModelGroup[] = [
  {
    description: 'Reasoning',
    entries: [
      ['nvidia/cosmos-reason2-8b', 'Cosmos Reason 2 8B'],
      ['microsoft/phi-4-mini-flash-reasoning', 'Phi 4 Mini Flash Reasoning'],
      ['qwen/qwen3-next-80b-a3b-thinking', 'Qwen 3 Next 80B Thinking'],
      ['deepseek-ai/deepseek-r1-distill-qwen-32b', 'DeepSeek R1 Qwen 32B'],
      ['deepseek-ai/deepseek-r1-distill-qwen-14b', 'DeepSeek R1 Qwen 14B'],
      ['deepseek-ai/deepseek-r1-distill-qwen-7b', 'DeepSeek R1 Qwen 7B'],
      ['deepseek-ai/deepseek-r1-distill-llama-8b', 'DeepSeek R1 Llama 8B'],
      ['qwen/qwq-32b', 'QwQ 32B Reasoning'],
    ],
  },
  {
    description: 'Code',
    entries: [
      ['meta/codellama-70b', 'CodeLlama 70B'],
      ['bigcode/starcoder2-15b', 'StarCoder2 15B'],
      ['bigcode/starcoder2-7b', 'StarCoder2 7B'],
      ['mistralai/codestral-22b-instruct-v0.1', 'Codestral 22B'],
      ['mistralai/mamba-codestral-7b-v0.1', 'Mamba Codestral 7B'],
      ['deepseek-ai/deepseek-coder-6.7b-instruct', 'DeepSeek Coder 6.7B'],
      ['google/codegemma-7b', 'CodeGemma 7B'],
      ['google/codegemma-1.1-7b', 'CodeGemma 1.1 7B'],
      ['qwen/qwen2.5-coder-32b-instruct', 'Qwen 2.5 Coder 32B'],
      ['qwen/qwen2.5-coder-7b-instruct', 'Qwen 2.5 Coder 7B'],
      ['qwen/qwen3-coder-480b-a35b-instruct', 'Qwen 3 Coder 480B'],
      ['ibm/granite-34b-code-instruct', 'Granite 34B Code'],
      ['ibm/granite-8b-code-instruct', 'Granite 8B Code'],
    ],
  },
  {
    description: 'NVIDIA Flagship',
    entries: [
      ['nvidia/llama-3.1-nemotron-70b-instruct', 'Nemotron 70B Instruct'],
      ['nvidia/llama-3.1-nemotron-51b-instruct', 'Nemotron 51B Instruct'],
      ['nvidia/llama-3.1-nemotron-ultra-253b-v1', 'Nemotron Ultra 253B'],
      ['nvidia/llama-3.3-nemotron-super-49b-v1', 'Nemotron Super 49B v1'],
      [
        'nvidia/llama-3.3-nemotron-super-49b-v1.5',
        'Nemotron Super 49B v1.5',
      ],
      ['nvidia/nemotron-4-340b-instruct', 'Nemotron 4 340B'],
      ['nvidia/nemotron-3-super-120b-a12b', 'Nemotron 3 Super 120B'],
      ['nvidia/nemotron-3-nano-30b-a3b', 'Nemotron 3 Nano 30B'],
      ['nvidia/nemotron-mini-4b-instruct', 'Nemotron Mini 4B'],
      ['nvidia/llama-3.1-nemotron-nano-8b-v1', 'Nemotron Nano 8B'],
      ['nvidia/llama-3.1-nemotron-nano-4b-v1.1', 'Nemotron Nano 4B v1.1'],
    ],
  },
  {
    description: 'Chat',
    entries: [
      ['nvidia/llama3-chatqa-1.5-70b', 'Llama3 ChatQA 1.5 70B'],
      ['nvidia/llama3-chatqa-1.5-8b', 'Llama3 ChatQA 1.5 8B'],
    ],
  },
  {
    description: 'Meta Llama',
    entries: [
      ['meta/llama-3.1-405b-instruct', 'Llama 3.1 405B'],
      ['meta/llama-3.1-70b-instruct', 'Llama 3.1 70B'],
      ['meta/llama-3.1-8b-instruct', 'Llama 3.1 8B'],
      ['meta/llama-3.2-90b-vision-instruct', 'Llama 3.2 90B Vision'],
      ['meta/llama-3.2-11b-vision-instruct', 'Llama 3.2 11B Vision'],
      ['meta/llama-3.2-3b-instruct', 'Llama 3.2 3B'],
      ['meta/llama-3.2-1b-instruct', 'Llama 3.2 1B'],
      ['meta/llama-3.3-70b-instruct', 'Llama 3.3 70B'],
      ['meta/llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick 17B'],
      ['meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B'],
    ],
  },
  {
    description: 'Google Gemma',
    entries: [
      ['google/gemma-4-31b-it', 'Gemma 4 31B'],
      ['google/gemma-3-27b-it', 'Gemma 3 27B'],
      ['google/gemma-3-12b-it', 'Gemma 3 12B'],
      ['google/gemma-3-4b-it', 'Gemma 3 4B'],
      ['google/gemma-3-1b-it', 'Gemma 3 1B'],
      ['google/gemma-3n-e4b-it', 'Gemma 3N E4B'],
      ['google/gemma-3n-e2b-it', 'Gemma 3N E2B'],
      ['google/gemma-2-27b-it', 'Gemma 2 27B'],
      ['google/gemma-2-9b-it', 'Gemma 2 9B'],
      ['google/gemma-2-2b-it', 'Gemma 2 2B'],
    ],
  },
  {
    description: 'Mistral',
    entries: [
      [
        'mistralai/mistral-large-3-675b-instruct-2512',
        'Mistral Large 3 675B',
      ],
      ['mistralai/mistral-large-2-instruct', 'Mistral Large 2'],
      ['mistralai/mistral-large', 'Mistral Large'],
      ['mistralai/mistral-medium-3-instruct', 'Mistral Medium 3'],
      ['mistralai/mistral-small-4-119b-2603', 'Mistral Small 4 119B'],
      [
        'mistralai/mistral-small-3.1-24b-instruct-2503',
        'Mistral Small 3.1 24B',
      ],
      ['mistralai/mistral-small-24b-instruct', 'Mistral Small 24B'],
      ['mistralai/mistral-7b-instruct-v0.3', 'Mistral 7B v0.3'],
      ['mistralai/mistral-7b-instruct-v0.2', 'Mistral 7B v0.2'],
      ['mistralai/mixtral-8x22b-instruct-v0.1', 'Mixtral 8x22B'],
      ['mistralai/mixtral-8x7b-instruct-v0.1', 'Mixtral 8x7B'],
      ['mistralai/mistral-nemotron', 'Mistral Nemotron'],
      ['mistralai/ministral-14b-instruct-2512', 'Ministral 14B'],
    ],
  },
  {
    description: 'Code',
    entries: [['mistralai/devstral-2-123b-instruct-2512', 'Devstral 2 123B']],
  },
  {
    description: 'Mistral',
    entries: [
      ['mistralai/magistral-small-2506', 'Magistral Small'],
    ],
  },
  {
    description: 'Math',
    entries: [['mistralai/mathstral-7b-v0.1', 'Mathstral 7B']],
  },
  {
    description: 'Multimodal',
    entries: [['microsoft/phi-4-multimodal-instruct', 'Phi 4 Multimodal']],
  },
  {
    description: 'Phi',
    entries: [
      ['microsoft/phi-4-mini-instruct', 'Phi 4 Mini'],
      ['microsoft/phi-3.5-mini-instruct', 'Phi 3.5 Mini'],
      ['microsoft/phi-3-small-128k-instruct', 'Phi 3 Small 128K'],
      ['microsoft/phi-3-small-8k-instruct', 'Phi 3 Small 8K'],
      ['microsoft/phi-3-medium-128k-instruct', 'Phi 3 Medium 128K'],
      ['microsoft/phi-3-medium-4k-instruct', 'Phi 3 Medium 4K'],
      ['microsoft/phi-3-mini-128k-instruct', 'Phi 3 Mini 128K'],
      ['microsoft/phi-3-mini-4k-instruct', 'Phi 3 Mini 4K'],
    ],
  },
  {
    description: 'Qwen',
    entries: [
      ['qwen/qwen3.5-397b-a17b', 'Qwen 3.5 397B'],
      ['qwen/qwen3.5-122b-a10b', 'Qwen 3.5 122B'],
      ['qwen/qwen3-next-80b-a3b-instruct', 'Qwen 3 Next 80B'],
      ['qwen/qwen2.5-7b-instruct', 'Qwen 2.5 7B'],
      ['qwen/qwen2-7b-instruct', 'Qwen 2 7B'],
      ['qwen/qwen3-32b', 'Qwen 3 32B'],
      ['qwen/qwen3-8b', 'Qwen 3 8B'],
    ],
  },
  {
    description: 'DeepSeek',
    entries: [
      ['deepseek-ai/deepseek-r1', 'DeepSeek R1'],
      ['deepseek-ai/deepseek-v3', 'DeepSeek V3'],
      ['deepseek-ai/deepseek-v3.2', 'DeepSeek V3.2'],
      ['deepseek-ai/deepseek-v3.1-terminus', 'DeepSeek V3.1 Terminus'],
      ['deepseek-ai/deepseek-v3.1', 'DeepSeek V3.1'],
    ],
  },
  {
    description: 'IBM Granite',
    entries: [
      ['ibm/granite-3.3-8b-instruct', 'Granite 3.3 8B'],
      ['ibm/granite-3.0-8b-instruct', 'Granite 3.0 8B'],
      ['ibm/granite-3.0-3b-a800m-instruct', 'Granite 3.0 3B'],
    ],
  },
  {
    description: 'Other',
    entries: [
      ['databricks/dbrx-instruct', 'DBRX Instruct'],
      ['01-ai/yi-large', 'Yi Large'],
      ['ai21labs/jamba-1.5-large-instruct', 'Jamba 1.5 Large'],
      ['ai21labs/jamba-1.5-mini-instruct', 'Jamba 1.5 Mini'],
      ['writer/palmyra-creative-122b', 'Palmyra Creative 122B'],
      ['writer/palmyra-fin-70b-32k', 'Palmyra Fin 70B 32K'],
      ['writer/palmyra-med-70b', 'Palmyra Med 70B'],
      ['writer/palmyra-med-70b-32k', 'Palmyra Med 70B 32K'],
    ],
  },
  {
    description: 'Z-AI',
    entries: [
      ['z-ai/glm5', 'GLM-5'],
      ['z-ai/glm4.7', 'GLM-4.7'],
    ],
  },
  {
    description: 'MiniMax',
    entries: [['minimaxai/minimax-m2.5', 'MiniMax M2.5']],
  },
  {
    description: 'Moonshot',
    entries: [
      ['moonshotai/kimi-k2.5', 'Kimi K2.5'],
      ['moonshotai/kimi-k2-instruct', 'Kimi K2 Instruct'],
      ['moonshotai/kimi-k2-thinking', 'Kimi K2 Thinking'],
      ['moonshotai/kimi-k2.5-thinking', 'Kimi K2.5 Thinking'],
      ['moonshotai/kimi-k2-instruct-0905', 'Kimi K2 Instruct 0905'],
    ],
  },
]

function getNvidiaNimModels(): ModelOption[] {
  const seenValues = new Set<string>()
  const options: ModelOption[] = []

  for (const group of NVIDIA_NIM_MODEL_GROUPS) {
    for (const [value, label] of group.entries) {
      if (seenValues.has(value)) {
        throw new Error(`Duplicate NVIDIA NIM model option: ${value}`)
      }

      seenValues.add(value)
      options.push({ value, label, description: group.description })
    }
  }

  return options
}

let cachedNvidiaNimOptions: ModelOption[] | null = null

export function getCachedNvidiaNimModelOptions(): ModelOption[] {
  if (!cachedNvidiaNimOptions) {
    cachedNvidiaNimOptions = getNvidiaNimModels()
  }
  return cachedNvidiaNimOptions
}
