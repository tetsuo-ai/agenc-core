/**
 * Active AWS model cards explicitly advertising Converse and client-side tools.
 * Reviewed 2026-09-29. IDs are literal card IDs, not invented inference profiles.
 * Rounded K/M limits, regional/account availability and regional prices remain
 * unknown. Vision stays disabled until the text-only Converse adapter supports it.
 */
export const BEDROCK_CONVERSE_MODELS = Object.freeze([
  {
    "model": "amazon.nova-2-lite-v1:0",
    "label": "Nova 2 Lite",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html"
  },
  {
    "model": "amazon.nova-lite-v1:0",
    "label": "Nova Lite",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-lite.html"
  },
  {
    "model": "amazon.nova-micro-v1:0",
    "label": "Nova Micro",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-micro.html"
  },
  {
    "model": "anthropic.claude-sonnet-4-6",
    "label": "Claude Sonnet 4.6",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-6.html"
  },
  {
    "model": "deepseek.v3-v1:0",
    "label": "DeepSeek-V3.1",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-1.html"
  },
  {
    "model": "deepseek.v3.2",
    "label": "DeepSeek V3.2",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html"
  },
  {
    "model": "google.gemma-3-12b-it",
    "label": "Gemma 3 12B IT",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-3-12b-it.html"
  },
  {
    "model": "google.gemma-3-27b-it",
    "label": "Gemma 3 27B PT",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-3-27b-pt.html"
  },
  {
    "model": "google.gemma-3-4b-it",
    "label": "Gemma 3 4B IT",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-3-4b-it.html"
  },
  {
    "model": "meta.llama3-1-70b-instruct-v1:0",
    "label": "Llama 3.1 70B Instruct",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-meta-llama-3-1-70b-instruct.html"
  },
  {
    "model": "meta.llama3-1-8b-instruct-v1:0",
    "label": "Llama 3.1 8B Instruct",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-meta-llama-3-1-8b-instruct.html"
  },
  {
    "model": "meta.llama4-maverick-17b-instruct-v1:0",
    "label": "Llama 4 Maverick 17B Instruct",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-meta-llama-4-maverick-17b-instruct.html"
  },
  {
    "model": "minimax.minimax-m2.1",
    "label": "MiniMax M2.1",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
  },
  {
    "model": "minimax.minimax-m2.5",
    "label": "MiniMax M2.5",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
  },
  {
    "model": "minimax.minimax-m2",
    "label": "MiniMax M2",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2.html"
  },
  {
    "model": "mistral.devstral-2-123b",
    "label": "Devstral 2 123B",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-devstral-2-123b.html"
  },
  {
    "model": "mistral.magistral-small-2509",
    "label": "Magistral Small 2509",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-magistral-small-2509.html"
  },
  {
    "model": "mistral.ministral-3-14b-instruct",
    "label": "Ministral 14B 3.0",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-ministral-14b-3-0.html"
  },
  {
    "model": "mistral.ministral-3-8b-instruct",
    "label": "Ministral 3 8B",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-ministral-3-8b.html"
  },
  {
    "model": "mistral.ministral-3-3b-instruct",
    "label": "Ministral 3B",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-ministral-3b.html"
  },
  {
    "model": "mistral.mistral-large-3-675b-instruct",
    "label": "Mistral Large 3",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-mistral-large-3.html"
  },
  {
    "model": "mistral.mistral-large-2402-v1:0",
    "label": "Mistral Large",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-mistral-large.html"
  },
  {
    "model": "mistral.mistral-small-2402-v1:0",
    "label": "Mistral Small",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-mistral-small.html"
  },
  {
    "model": "mistral.pixtral-large-2502-v1:0",
    "label": "Pixtral Large",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-pixtral-large.html"
  },
  {
    "model": "moonshotai.kimi-k2.5",
    "label": "Kimi K2.5",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html"
  },
  {
    "model": "moonshot.kimi-k2-thinking",
    "label": "Kimi K2 Thinking",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html"
  },
  {
    "model": "moonshotai.kimi-k3",
    "label": "Kimi K3",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k3.html"
  },
  {
    "model": "nvidia.nemotron-nano-3-30b",
    "label": "Nemotron Nano 3 30B",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nemotron-nano-3-30b.html"
  },
  {
    "model": "nvidia.nemotron-super-3-120b",
    "label": "NVIDIA Nemotron 3 Super 120B",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nemotron-super-3-120b.html"
  },
  {
    "model": "nvidia.nemotron-nano-12b-v2",
    "label": "NVIDIA Nemotron Nano 12B v2 VL BF16",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nvidia-nemotron-nano-12b-v2-vl-bf16.html"
  },
  {
    "model": "nvidia.nemotron-nano-9b-v2",
    "label": "NVIDIA Nemotron Nano 9B v2",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nvidia-nemotron-nano-9b-v2.html"
  },
  {
    "model": "openai.gpt-oss-120b-1:0",
    "label": "gpt-oss-120b",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html"
  },
  {
    "model": "openai.gpt-oss-20b-1:0",
    "label": "gpt-oss-20b",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-20b.html"
  },
  {
    "model": "qwen.qwen3-235b-a22b-2507-v1:0",
    "label": "Qwen3 235B A22B 2507",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-235b-a22b-2507.html"
  },
  {
    "model": "qwen.qwen3-32b-v1:0",
    "label": "Qwen3 32B",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-32b.html"
  },
  {
    "model": "qwen.qwen3-coder-30b-a3b-v1:0",
    "label": "Qwen3-Coder-30B-A3B-Instruct",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-30b-a3b-instruct.html"
  },
  {
    "model": "qwen.qwen3-coder-480b-a35b-v1:0",
    "label": "Qwen3 Coder 480B A35B Instruct",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-480b-a35b-instruct.html"
  },
  {
    "model": "qwen.qwen3-coder-next",
    "label": "Qwen3 Coder Next",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html"
  },
  {
    "model": "qwen.qwen3-next-80b-a3b",
    "label": "Qwen3 Next 80B A3B",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-next-80b-a3b.html"
  },
  {
    "model": "qwen.qwen3-vl-235b-a22b",
    "label": "Qwen3 VL 235B A22B",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-vl-235b-a22b.html"
  },
  {
    "model": "writer.palmyra-vision-7b",
    "label": "Palmyra Vision 7B",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-writer-palmyra-vision-7b.html"
  },
  {
    "model": "writer.palmyra-x4-v1:0",
    "label": "Palmyra X4",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-writer-palmyra-x4.html"
  },
  {
    "model": "writer.palmyra-x5-v1:0",
    "label": "Palmyra X5",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-writer-palmyra-x5.html"
  },
  {
    "model": "xai.grok-4.6",
    "label": "Grok 4.6",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-xai-grok-4-6.html"
  },
  {
    "model": "zai.glm-4.7-flash",
    "label": "GLM 4.7 Flash",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-4-7-flash.html"
  },
  {
    "model": "zai.glm-4.7",
    "label": "GLM 4.7",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-4-7.html"
  },
  {
    "model": "zai.glm-5",
    "label": "GLM 5",
    "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-5.html"
  }
] as const);
