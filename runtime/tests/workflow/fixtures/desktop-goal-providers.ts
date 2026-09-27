export default {
  "source": "Desktop 0.1.8 providerCatalog.ts, modelCatalog.ts, shared/*Provider.ts and effort.ts. Default models are the Core provider list consumed by defaultSessionModel.ts.",
  "rows": [
    {
      "provider": "agenc",
      "model": "agenc",
      "key": null,
      "efforts": [],
      "kind": "managed"
    },
    {
      "provider": "openai",
      "model": "gpt-5",
      "key": "OPENAI_API_KEY",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "kind": "cloud"
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "key": "ANTHROPIC_API_KEY",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "kind": "cloud"
    },
    {
      "provider": "grok",
      "model": "grok-4.6",
      "key": "XAI_API_KEY",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "kind": "cloud"
    },
    {
      "provider": "gemini",
      "model": "gemini-3.8-flash",
      "key": "GEMINI_API_KEY",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "kind": "cloud"
    },
    {
      "provider": "meta",
      "model": "muse-spark-1.3",
      "key": "MODEL_API_KEY",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "kind": "cloud"
    },
    {
      "provider": "qwen",
      "model": "qwen3.8-max",
      "key": "DASHSCOPE_API_KEY",
      "efforts": [
        "low",
        "medium",
        "xhigh"
      ],
      "kind": "cloud"
    },
    {
      "provider": "qwen-token-plan",
      "model": "qwen3.8-max",
      "key": "QWEN_TOKEN_PLAN_API_KEY",
      "efforts": [
        "low",
        "medium",
        "xhigh"
      ],
      "kind": "cloud"
    },
    {
      "provider": "cerebras",
      "model": "gpt-oss-120b",
      "key": "CEREBRAS_API_KEY",
      "efforts": [
        "low",
        "medium",
        "high"
      ],
      "kind": "cloud"
    },
    {
      "provider": "ollama-cloud",
      "model": "deepseek-v4.1-flash",
      "key": "OLLAMA_API_KEY",
      "efforts": [
        "low",
        "high",
        "max"
      ],
      "kind": "cloud"
    },
    {
      "provider": "openrouter",
      "model": "x-ai/grok-4.5",
      "key": "OPENROUTER_API_KEY",
      "efforts": [],
      "kind": "cloud"
    },
    {
      "provider": "deepseek",
      "model": "deepseek-flash",
      "key": "DEEPSEEK_API_KEY",
      "efforts": [
        "low",
        "high",
        "max"
      ],
      "kind": "cloud"
    },
    {
      "provider": "groq",
      "model": "llama-3.3-70b-versatile",
      "key": "GROQ_API_KEY",
      "efforts": [],
      "kind": "cloud"
    },
    {
      "provider": "mistral",
      "model": "mistral-medium-latest",
      "key": "MISTRAL_API_KEY",
      "efforts": [],
      "kind": "cloud"
    },
    {
      "provider": "github",
      "model": "gpt-5.3-codex",
      "key": "GITHUB_TOKEN",
      "efforts": [],
      "kind": "cloud"
    },
    {
      "provider": "minimax",
      "model": "MiniMax-M3",
      "key": "MINIMAX_API_KEY",
      "efforts": [
        "low",
        "high"
      ],
      "kind": "cloud"
    },
    {
      "provider": "nvidia-nim",
      "model": "nvidia/llama-3.1-nemotron-70b-instruct",
      "key": "NVIDIA_API_KEY",
      "efforts": [],
      "kind": "cloud"
    },
    {
      "provider": "amazon-bedrock",
      "model": "amazon.nova-pro-v1:0",
      "key": null,
      "efforts": [],
      "kind": "cloud"
    },
    {
      "provider": "zai",
      "model": "glm-5.3",
      "key": "ZAI_API_KEY",
      "efforts": [
        "low",
        "high",
        "max"
      ],
      "kind": "cloud"
    },
    {
      "provider": "zai-coding-plan",
      "model": "glm-5.3",
      "key": "ZAI_CODING_PLAN_API_KEY",
      "efforts": [
        "low",
        "high",
        "max"
      ],
      "kind": "cloud"
    },
    {
      "provider": "kimi",
      "model": "kimi-k3",
      "key": "MOONSHOT_API_KEY",
      "efforts": [
        "low",
        "high",
        "max"
      ],
      "kind": "cloud"
    },
    {
      "provider": "venice",
      "model": null,
      "key": "OPENAI_COMPATIBLE_API_KEY",
      "efforts": [],
      "kind": "preset"
    },
    {
      "provider": "ollama",
      "model": "llama3.3",
      "key": null,
      "efforts": [],
      "kind": "local"
    },
    {
      "provider": "lmstudio",
      "model": "gpt-4o-mini",
      "key": null,
      "efforts": [],
      "kind": "local"
    },
    {
      "provider": "openai-compatible",
      "model": "local-model",
      "key": null,
      "efforts": [],
      "kind": "local"
    }
  ]
} as { source: string; rows: { provider: string; model: string | null; key: string | null; efforts: string[]; kind: string }[] };
