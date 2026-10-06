/** Ollama Cloud catalog snapshot, verified with /api/tags and /api/show on 2026-09-11.
 * https://docs.ollama.com/cloud
 * https://docs.ollama.com/capabilities/thinking
 * IDs belong to the direct Cloud API; do not append the local proxy :cloud suffix.
 * Output budgets below are AgenC defaults, not advertised model output limits.
 */
export const OLLAMA_CLOUD_PROVIDER_ID = "ollama-cloud";
export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";
export const OLLAMA_CLOUD_API_KEY_ENV = "OLLAMA_API_KEY";
export const OLLAMA_CLOUD_DEFAULT_MODEL = "deepseek-v4.1-flash";
export const OLLAMA_CLOUD_MODELS = [
  {
    "model": "deepseek-v4.1-flash",
    "label": "DeepSeek V4.1 Flash",
    "contextWindow": 1048576,
    "vision": true,
    "thinking": true,
    "tools": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "defaultEffort": "low"
  },
  {
    "model": "deepseek-v4-flash:0731",
    "label": "DeepSeek V4 Flash 0731",
    "contextWindow": 1048576,
    "vision": false,
    "thinking": true,
    "tools": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "defaultEffort": "low"
  },
  {
    "model": "deepseek-v4-pro:0813",
    "label": "DeepSeek V4 Pro 0813",
    "contextWindow": 1048576,
    "vision": false,
    "thinking": true,
    "tools": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "defaultEffort": "low"
  },
  {
    "model": "gemma4:31b",
    "label": "Gemma 4 31B",
    "contextWindow": 262144,
    "vision": true,
    "thinking": true,
    "tools": true,
    "efforts": [
      "none",
      "high"
    ],
    "effortNote": "Thinking off or on; this model does not expose graded effort levels.",
    "defaultEffort": "none"
  },
  {
    "model": "glm-5.1",
    "label": "GLM 5.1",
    "contextWindow": 202752,
    "vision": false,
    "thinking": true,
    "tools": true,
    "efforts": [
      "none",
      "high"
    ],
    "effortNote": "Thinking off or on; this model does not expose graded effort levels.",
    "defaultEffort": "none"
  },
  {
    "model": "glm-5.2",
    "label": "GLM 5.2",
    "contextWindow": 1048576,
    "vision": false,
    "thinking": true,
    "tools": true,
    "efforts": [
      "none",
      "high"
    ],
    "effortNote": "Thinking off or on; this model does not expose graded effort levels.",
    "defaultEffort": "none"
  },
  {
    "model": "glm-5.3",
    "label": "GLM 5.3",
    "contextWindow": 1048576,
    "vision": false,
    "thinking": true,
    "tools": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "defaultEffort": "low"
  },
  {
    "model": "glm-5.3-flash",
    "label": "GLM 5.3 flash",
    "contextWindow": 1048576,
    "vision": true,
    "thinking": true,
    "tools": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "defaultEffort": "low"
  },
  {
    "model": "gpt-oss:120b",
    "label": "GPT OSS 120B",
    "contextWindow": 131072,
    "vision": false,
    "thinking": true,
    "tools": true,
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "defaultEffort": "low"
  },
  {
    "model": "gpt-oss:20b",
    "label": "GPT OSS 20B",
    "contextWindow": 131072,
    "vision": false,
    "thinking": true,
    "tools": true,
    "efforts": [
      "low",
      "medium",
      "high"
    ],
    "defaultEffort": "low"
  },
  {
    "model": "kimi-k2.6",
    "label": "Kimi K2.6",
    "contextWindow": 262144,
    "vision": true,
    "thinking": true,
    "tools": true,
    "efforts": [
      "none",
      "high"
    ],
    "effortNote": "Thinking off or on; this model does not expose graded effort levels.",
    "defaultEffort": "none"
  },
  {
    "model": "kimi-k2.7-code",
    "label": "Kimi K2.7 code",
    "contextWindow": 262144,
    "vision": true,
    "thinking": true,
    "tools": true,
    "efforts": [
      "none",
      "high"
    ],
    "effortNote": "Thinking off or on; this model does not expose graded effort levels.",
    "defaultEffort": "none"
  },
  {
    "model": "kimi-k3",
    "label": "Kimi K3",
    "contextWindow": 1048576,
    "vision": true,
    "thinking": true,
    "tools": true,
    "efforts": [
      "low",
      "high",
      "max"
    ],
    "defaultEffort": "low"
  },
  {
    "model": "minimax-m2.7",
    "label": "MiniMax m2.7",
    "contextWindow": 196608,
    "vision": false,
    "thinking": true,
    "tools": true,
    "efforts": []
  },
  {
    "model": "minimax-m3",
    "label": "MiniMax m3",
    "contextWindow": 512000,
    "vision": true,
    "thinking": true,
    "tools": true,
    "efforts": [
      "none",
      "high"
    ],
    "effortNote": "Thinking off or on; this model does not expose graded effort levels.",
    "defaultEffort": "none"
  },
  {
    "model": "mistral-large-3:675b",
    "label": "Mistral Large 3 675B",
    "contextWindow": 262144,
    "vision": true,
    "thinking": false,
    "tools": true,
    "efforts": []
  },
  {
    "model": "nemotron-3-nano:30b",
    "label": "Nemotron 3 Nano 30B",
    "contextWindow": 262144,
    "vision": false,
    "thinking": true,
    "tools": true,
    "efforts": [
      "none",
      "high"
    ],
    "effortNote": "Thinking off or on; this model does not expose graded effort levels.",
    "defaultEffort": "none"
  },
  {
    "model": "nemotron-3-super",
    "label": "Nemotron 3 super",
    "contextWindow": 262144,
    "vision": false,
    "thinking": true,
    "tools": true,
    "efforts": [
      "none",
      "high"
    ],
    "effortNote": "Thinking off or on; this model does not expose graded effort levels.",
    "defaultEffort": "none"
  },
  {
    "model": "nemotron-3-ultra",
    "label": "Nemotron 3 ultra",
    "contextWindow": 262144,
    "vision": false,
    "thinking": true,
    "tools": true,
    "efforts": [
      "none",
      "high"
    ],
    "effortNote": "Thinking off or on; this model does not expose graded effort levels.",
    "defaultEffort": "none"
  },
  {
    "model": "qwen3.5:397b",
    "label": "Qwen 3.5 397B",
    "contextWindow": 262144,
    "vision": true,
    "thinking": true,
    "tools": true,
    "efforts": [
      "none",
      "high"
    ],
    "effortNote": "Thinking off or on; this model does not expose graded effort levels.",
    "defaultEffort": "none"
  }
] as const;

export function ollamaCloudModel(model: string | undefined) {
  return OLLAMA_CLOUD_MODELS.find(entry => entry.model === model?.trim().toLowerCase());
}
