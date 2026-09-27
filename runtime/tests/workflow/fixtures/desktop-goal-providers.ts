export default {
  "source": "Desktop providerCatalog.ts, modelCatalog.ts and effort.ts from the 0.1.9 integration. Includes defaults and every static catalog model and managed model with every offered effort; dynamic catalogs use explicit test responses.",
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
  ],
  "catalogRows": [
    {
      "provider": "openai",
      "model": "gpt-5.6-sol",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "openai",
      "model": "gpt-5.6-terra",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "openai",
      "model": "gpt-5.6-luna",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "openai",
      "model": "gpt-6-astra",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "openai",
      "model": "gpt-6-sol",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "openai",
      "model": "gpt-6-luna",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "openai",
      "model": "gpt-5.5",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    {
      "provider": "openai",
      "model": "gpt-5.4",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    {
      "provider": "openai",
      "model": "gpt-5.4-mini",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    {
      "provider": "openai",
      "model": "gpt-5.3-codex",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    {
      "provider": "openai",
      "model": "gpt-5.3-codex-spark",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    {
      "provider": "openai",
      "model": "gpt-5.2",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    {
      "provider": "openai",
      "model": "gpt-5",
      "key": "OPENAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5-5",
      "key": "ANTHROPIC_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "anthropic",
      "model": "claude-sonnet-5",
      "key": "ANTHROPIC_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "anthropic",
      "model": "claude-fable-5-1",
      "key": "ANTHROPIC_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "anthropic",
      "model": "claude-fable-5",
      "key": "ANTHROPIC_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "key": "ANTHROPIC_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-4-8",
      "key": "ANTHROPIC_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "anthropic",
      "model": "claude-opus-4-7",
      "key": "ANTHROPIC_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "grok",
      "model": "grok-4.6",
      "key": "XAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    {
      "provider": "grok",
      "model": "grok-4.7",
      "key": "XAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    {
      "provider": "grok",
      "model": "grok-4.5",
      "key": "XAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "grok",
      "model": "grok-composer-2.5-fast",
      "key": "XAI_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "grok",
      "model": "grok-build-0.1",
      "key": "XAI_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "grok",
      "model": "grok-4.3",
      "key": "XAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "grok",
      "model": "grok-4.20-0309-reasoning",
      "key": "XAI_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "grok",
      "model": "grok-4.20-0309-non-reasoning",
      "key": "XAI_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "grok",
      "model": "grok-4.20-multi-agent-0309",
      "key": "XAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "gemini",
      "model": "gemini-3.8-flash",
      "key": "GEMINI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "gemini",
      "model": "gemini-3.1-pro-preview",
      "key": "GEMINI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "gemini",
      "model": "gemini-3.7-flash",
      "key": "GEMINI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "gemini",
      "model": "gemini-3.6-flash",
      "key": "GEMINI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "gemini",
      "model": "gemini-3.5-flash",
      "key": "GEMINI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "gemini",
      "model": "gemini-3.5-flash-lite",
      "key": "GEMINI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "gemini",
      "model": "gemini-3.1-flash-lite",
      "key": "GEMINI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "meta",
      "model": "muse-spark-1.3",
      "key": "MODEL_API_KEY",
      "kind": "cloud",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    {
      "provider": "meta",
      "model": "muse-spark-1.3-contributor",
      "key": "MODEL_API_KEY",
      "kind": "cloud",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    {
      "provider": "meta",
      "model": "muse-spark-1.2",
      "key": "MODEL_API_KEY",
      "kind": "cloud",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    {
      "provider": "meta",
      "model": "muse-spark-1.2-contributor",
      "key": "MODEL_API_KEY",
      "kind": "cloud",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    {
      "provider": "meta",
      "model": "muse-spark-1.1",
      "key": "MODEL_API_KEY",
      "kind": "cloud",
      "efforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    {
      "provider": "qwen",
      "model": "qwen3.8-max",
      "key": "DASHSCOPE_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "xhigh"
      ]
    },
    {
      "provider": "qwen",
      "model": "qwen3.8-flash",
      "key": "DASHSCOPE_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "xhigh"
      ]
    },
    {
      "provider": "qwen",
      "model": "qwen3.7-max",
      "key": "DASHSCOPE_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "qwen",
      "model": "qwen3.7-plus",
      "key": "DASHSCOPE_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "qwen",
      "model": "qwen3.7-flash",
      "key": "DASHSCOPE_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "qwen",
      "model": "qwen3.6-plus",
      "key": "DASHSCOPE_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "qwen",
      "model": "qwen3.6-flash",
      "key": "DASHSCOPE_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "qwen",
      "model": "qwen3-coder-next",
      "key": "DASHSCOPE_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "qwen",
      "model": "qwen3-coder-plus",
      "key": "DASHSCOPE_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "qwen-token-plan",
      "model": "qwen3.8-max",
      "key": "QWEN_TOKEN_PLAN_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "xhigh"
      ]
    },
    {
      "provider": "qwen-token-plan",
      "model": "qwen3.8-flash",
      "key": "QWEN_TOKEN_PLAN_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "xhigh"
      ]
    },
    {
      "provider": "qwen-token-plan",
      "model": "qwen3.7-max",
      "key": "QWEN_TOKEN_PLAN_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "qwen-token-plan",
      "model": "qwen3.7-plus",
      "key": "QWEN_TOKEN_PLAN_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "qwen-token-plan",
      "model": "qwen3.6-flash",
      "key": "QWEN_TOKEN_PLAN_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "cerebras",
      "model": "gpt-oss-120b",
      "key": "CEREBRAS_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "cerebras",
      "model": "gemma-4-31b",
      "key": "CEREBRAS_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "cerebras",
      "model": "qwen-3.8-27b",
      "key": "CEREBRAS_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "deepseek-v4.1-flash",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "deepseek-v4-flash:0731",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "deepseek-v4-pro:0813",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "gemma4:31b",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "high"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "glm-5.1",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "high"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "glm-5.2",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "high"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "glm-5.3",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "glm-5.3-flash",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "gpt-oss:120b",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "gpt-oss:20b",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "kimi-k2.6",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "high"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "kimi-k2.7-code",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "high"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "kimi-k3",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "minimax-m2.7",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "ollama-cloud",
      "model": "minimax-m3",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "high"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "mistral-large-3:675b",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "ollama-cloud",
      "model": "nemotron-3-nano:30b",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "high"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "nemotron-3-super",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "high"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "nemotron-3-ultra",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "high"
      ]
    },
    {
      "provider": "ollama-cloud",
      "model": "qwen3.5:397b",
      "key": "OLLAMA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "none",
        "high"
      ]
    },
    {
      "provider": "openrouter",
      "model": "x-ai/grok-4.5",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "x-ai/grok-4.3",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "x-ai/grok-build-0.1",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "x-ai/grok-4.20",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "openai/gpt-5",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "openai/gpt-4o-mini",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "openai/gpt-5-nano",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "openai/gpt-4.1-nano",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "openai/gpt-oss-120b",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "anthropic/claude-haiku-4.5",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "google/gemini-2.5-flash",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "google/gemini-2.5-flash-lite",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "deepseek/deepseek-chat",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "deepseek/deepseek-v4-flash",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "deepseek/deepseek-v3.2",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "qwen/qwen3-coder-30b-a3b-instruct",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "qwen/qwen3-235b-a22b-2507",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "mistralai/mistral-small-3.2-24b-instruct",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "meta-llama/llama-3.3-70b-instruct",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "meta-llama/llama-4-scout",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "minimax/minimax-m2.5",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "openrouter",
      "model": "z-ai/glm-4.7-flash",
      "key": "OPENROUTER_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "deepseek",
      "model": "deepseek-flash",
      "key": "DEEPSEEK_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "deepseek",
      "model": "deepseek-v4-pro",
      "key": "DEEPSEEK_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "groq",
      "model": "llama-3.3-70b-versatile",
      "key": "GROQ_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "groq",
      "model": "llama-3.1-8b-instant",
      "key": "GROQ_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "mistral",
      "model": "mistral-medium-latest",
      "key": "MISTRAL_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "minimax",
      "model": "MiniMax-M3",
      "key": "MINIMAX_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high"
      ]
    },
    {
      "provider": "minimax",
      "model": "MiniMax-M2.7",
      "key": "MINIMAX_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "minimax",
      "model": "MiniMax-M2.7-highspeed",
      "key": "MINIMAX_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "minimax",
      "model": "MiniMax-M2.5",
      "key": "MINIMAX_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "minimax",
      "model": "MiniMax-M2.5-highspeed",
      "key": "MINIMAX_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "nvidia-nim",
      "model": "moonshotai/kimi-k3",
      "key": "NVIDIA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "nvidia-nim",
      "model": "moonshotai/kimi-k2.6",
      "key": "NVIDIA_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "nvidia-nim",
      "model": "deepseek-ai/deepseek-v4-pro-0813",
      "key": "NVIDIA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "high",
        "max"
      ]
    },
    {
      "provider": "nvidia-nim",
      "model": "deepseek-ai/deepseek-v4-flash-0731",
      "key": "NVIDIA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "high",
        "max"
      ]
    },
    {
      "provider": "nvidia-nim",
      "model": "minimaxai/minimax-m3",
      "key": "NVIDIA_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "nvidia-nim",
      "model": "openai/gpt-oss-120b",
      "key": "NVIDIA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "medium",
        "high"
      ]
    },
    {
      "provider": "nvidia-nim",
      "model": "nvidia/nemotron-3-super-120b-a12b",
      "key": "NVIDIA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high"
      ]
    },
    {
      "provider": "nvidia-nim",
      "model": "nvidia/nemotron-3-ultra-550b-a55b",
      "key": "NVIDIA_API_KEY",
      "kind": "cloud",
      "efforts": [
        "medium",
        "high"
      ]
    },
    {
      "provider": "zai",
      "model": "glm-5.3",
      "key": "ZAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "zai",
      "model": "glm-5.3-flash",
      "key": "ZAI_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "zai-coding-plan",
      "model": "glm-5.3",
      "key": "ZAI_CODING_PLAN_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "zai-coding-plan",
      "model": "glm-5.3-flash",
      "key": "ZAI_CODING_PLAN_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "kimi",
      "model": "kimi-k3",
      "key": "MOONSHOT_API_KEY",
      "kind": "cloud",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "kimi",
      "model": "kimi-k2.7-code",
      "key": "MOONSHOT_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "kimi",
      "model": "kimi-k2.7-code-highspeed",
      "key": "MOONSHOT_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "kimi",
      "model": "kimi-k2.6",
      "key": "MOONSHOT_API_KEY",
      "kind": "cloud",
      "efforts": []
    },
    {
      "provider": "ollama",
      "model": "llama3.3",
      "key": null,
      "kind": "local",
      "efforts": []
    },
    {
      "provider": "lmstudio",
      "model": "qwen/qwen3-14b",
      "key": null,
      "kind": "local",
      "efforts": []
    },
    {
      "provider": "lmstudio",
      "model": "qwen/qwen3.5-4b",
      "key": null,
      "kind": "local",
      "efforts": []
    },
    {
      "provider": "agenc",
      "model": "Qwen/Qwen3.8-Flash-Next",
      "key": null,
      "kind": "managed",
      "efforts": [
        "low",
        "medium",
        "xhigh"
      ]
    },
    {
      "provider": "agenc",
      "model": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "key": null,
      "kind": "managed",
      "efforts": []
    },
    {
      "provider": "agenc",
      "model": "deepseek/deepseek-v4-flash-0731",
      "key": null,
      "kind": "managed",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    },
    {
      "provider": "agenc",
      "model": "deepseek/deepseek-v4.1-flash",
      "key": null,
      "kind": "managed",
      "efforts": [
        "low",
        "high",
        "max"
      ]
    }
  ]
};
