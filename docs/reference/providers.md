# Providers reference

Built-in model providers for AgenC **0.3.0**. Source of truth:
`runtime/src/llm/registry/provider-info.ts`
(`BUILT_IN_PROVIDER_DEFAULT_MODELS`, base URLs, API key envs).

CLI: `agenc providers` · `agenc login` · `agenc config` · `/provider` and
`/model` in the TUI.

## Defaults

| Setting | Value |
| --- | --- |
| Default provider | `grok` (xAI; alias `xai` normalizes to `grok`) |
| Default model | `grok-4.3` |
| Config keys | `model_provider`, `model` in `config.toml` |
| Env overrides | `AGENC_PROVIDER`, `AGENC_MODEL` |

Grok API key resolution order:

1. `XAI_API_KEY`
2. `GROK_API_KEY`
3. `AGENC_XAI_API_KEY`

## Built-in providers (16)

| Slug | Display name | Default model | Base URL | API key env (primary) |
| --- | --- | --- | --- | --- |
| `grok` | xAI Grok | `grok-4.3` | `https://api.x.ai/v1` | `XAI_API_KEY` |
| `openai` | OpenAI | `gpt-5` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | Anthropic | `claude-opus-4-7` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` |
| `ollama` | Ollama | `llama3.3` | `http://localhost:11434` | _(none required)_ |
| `lmstudio` | LM Studio | `gpt-4o-mini` | `http://localhost:1234/v1` | `LMSTUDIO_API_KEY` (optional) |
| `openai-compatible` | OpenAI-compatible | `local-model` | `http://localhost:8000/v1` | `OPENAI_COMPATIBLE_API_KEY` |
| `openrouter` | OpenRouter | `x-ai/grok-4.3` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `groq` | Groq | `llama-3.3-70b-versatile` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `deepseek` | DeepSeek | `deepseek-reasoner` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `gemini` | Gemini | `gemini-2.5-pro` | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` |
| `mistral` | Mistral | `devstral-latest` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| `nvidia-nim` | NVIDIA NIM | `nvidia/llama-3.1-nemotron-70b-instruct` | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| `minimax` | MiniMax | `MiniMax-M2.5` | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` |
| `github` | GitHub Copilot | `gpt-4o` | `https://api.githubcopilot.com` | `GITHUB_TOKEN` |
| `amazon-bedrock` | Amazon Bedrock | `amazon.nova-pro-v1:0` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `AWS_ACCESS_KEY_ID` (or Bedrock-specific) |
| `agenc` | AgenC | `agenc` | `https://id.agenc.ag/v1` | managed auth (`requiresManagedAuth`) |

Slug aliases accepted on normalize:

| Input | Resolves to |
| --- | --- |
| `xai` | `grok` |
| `custom`, `openai_compatible` | `openai-compatible` |

## Auth model

Provider credentials are owned by the **auth backend** / BYOK config, not by
the provider registry. The registry stores **request and catalog metadata**
only (base URL, default model, retry/timeouts, catalog lists).

- **Local BYOK** — env keys and `auth.json` entries selected at startup.
- **Remote / managed** — `auth.backend = "remote"` with managed keys
  (`agenc` provider requires managed auth).
- **Discovery** — `agenc providers` reports readiness (key present, local
  server health for Ollama/LM Studio/openai-compatible, subscription tier).

See `runtime/src/auth/` and `runtime/src/llm/discovery/provider-discovery.ts`.

## Config & env

```toml
# ~/.agenc/config.toml (illustrative)
model_provider = "grok"
model = "grok-4.3"

[providers.openrouter]
# provider-specific overrides live under [providers.<slug>] when configured
```

```bash
export AGENC_PROVIDER=openrouter
export AGENC_MODEL=x-ai/grok-4.3
export OPENROUTER_API_KEY=…
```

Base URL overrides (examples; see `runtime/src/config/env.ts`):

| Provider | Env |
| --- | --- |
| OpenAI | `OPENAI_BASE_URL` |
| Anthropic | `ANTHROPIC_BASE_URL` |
| LM Studio | `LMSTUDIO_BASE_URL` |
| OpenAI-compatible | `OPENAI_COMPATIBLE_BASE_URL` |
| OpenRouter | `OPENROUTER_BASE_URL` |
| Groq | `GROQ_BASE_URL` |
| DeepSeek | `DEEPSEEK_BASE_URL` |
| Gemini | `GEMINI_BASE_URL` |
| Bedrock | `AWS_BEDROCK_BASE_URL`, region via `AWS_BEDROCK_REGION` / `AWS_REGION` |

## Wire layer

| Layer | Path |
| --- | --- |
| Registry / defaults | `runtime/src/llm/registry/provider-info.ts` |
| Model catalog | `runtime/src/llm/registry/model-catalog.ts` |
| Provider-neutral client | `runtime/src/llm/client.ts`, `provider.ts` |
| Per-provider modules | `runtime/src/llm/providers/*` |
| HTTP / SDK services | `runtime/src/services/` |
| Capabilities | `runtime/src/llm/provider-capabilities.ts` |

Default stream/request settings from the registry:

- request max retries: **4**
- stream max retries: **5**
- stream idle timeout: **300_000** ms
- websocket connect timeout: **15_000** ms
- websockets supported: **`openai` only** in built-in info

## Related docs

- Tool / provider compatibility notes: [`../provider-tool-compat.md`](../provider-tool-compat.md)
- Managed OpenRouter path: [`../managed-openrouter.md`](../managed-openrouter.md)
- Onboarding: `agenc onboard`
