# Provider Matrix

AgenC is multi-provider. Grok is the default reference implementation
but **not** locked. Every provider implements the same `LLMProvider`
interface at `runtime/src/llm/types.ts`; per-provider quirks live in
adapter files behind capability flags.

---

## Providers in scope

| # | Provider | Base URL | Wire format | Auth | Default model |
|---|---|---|---|---|---|
| 1 | **Grok (xAI)** — *default* | `https://api.x.ai/v1` | xAI Responses API | Bearer `XAI_API_KEY` | `grok-4-fast` |
| 2 | OpenAI | `https://api.openai.com/v1` | Responses API (new) + Chat Completions (legacy) | Bearer `OPENAI_API_KEY` or ChatGPT OAuth | `gpt-5` / `o3` |
| 3 | Anthropic | `https://api.anthropic.com` | Messages API | Bearer `ANTHROPIC_API_KEY` | `claude-opus-4-7` |
| 4 | Ollama | `http://localhost:11434` | Ollama native (OpenAI-compat shim available) | none | `llama3.3` |
| 5 | LMStudio | `http://localhost:1234/v1` | OpenAI Chat Completions compatible | optional bearer | user-loaded |
| 6 | OpenRouter | `https://openrouter.ai/api/v1` | OpenAI Chat Completions compatible | Bearer `OPENROUTER_API_KEY` | routes to 100+ models |
| 7 | Groq | `https://api.groq.com/openai/v1` | OpenAI Chat Completions compatible | Bearer `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| 8 | DeepSeek | `https://api.deepseek.com/v1` | OpenAI Chat Completions compatible | Bearer `DEEPSEEK_API_KEY` | `deepseek-reasoner` |
| 9 | Gemini | `https://generativelanguage.googleapis.com/v1beta` | Gemini native (OpenAI-compat beta) | `GEMINI_API_KEY` | `gemini-2.5-pro` |

---

## Wire-format clusters

Four request shapes dominate. Provider adapters dispatch on the
family, not on the provider name.

| Family | Request endpoint | Providers using it |
|---|---|---|
| **xAI Responses** | `/v1/responses` | Grok |
| **OpenAI Responses** | `/v1/responses` | OpenAI |
| **Anthropic Messages** | `/v1/messages` | Anthropic |
| **OpenAI Chat Completions (compat)** | `/v1/chat/completions` | OpenAI (legacy), Ollama (shim), LMStudio, OpenRouter, Groq, DeepSeek, Gemini (beta) |

`runtime/src/llm/wire/` holds one shaping module per family. Adapters
(`runtime/src/llm/providers/*.ts`) compose: `base URL + auth + family
shim + capability flags`.

---

## Capability matrix

Rows = capability. Cols = provider. Value = how the adapter exposes
it. Shape requests accordingly; never assume a feature exists.

| Capability | Grok | OpenAI | Anthropic | Ollama | LMStudio | OpenRouter | Groq | DeepSeek | Gemini |
|---|---|---|---|---|---|---|---|---|---|
| Tool calls | ✅ | ✅ | ✅ | model-dependent | model-dependent | routes through | ✅ | ✅ | ✅ |
| Parallel tool calls | ✅ (flag) | ✅ (`parallel_tool_calls`) | ✅ | rarely | rarely | routes through | ✅ | ✅ | ✅ |
| Streaming | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `previous_response_id` incremental reuse | ✅ | ✅ (Responses API only) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `prompt_cache_key` / prompt caching | ✅ | ✅ | ✅ (`cache_control` blocks) | ❌ | ❌ | varies | ❌ | ❌ | ❌ |
| Encrypted reasoning / reasoning-redaction | ✅ (`reasoning.encrypted_content`) | ✅ (o-series) | ❌ | ❌ | ❌ | varies | ❌ | partial (`deepseek-reasoner`) | ❌ |
| Extended thinking / thinking blocks | ❌ | ✅ (o-series reasoning summary) | ✅ (`thinking` blocks) | ❌ | ❌ | varies | ❌ | ✅ | ✅ (2.5 thinking) |
| `reasoning_effort` / effort parameter | ❌ | ✅ (`reasoning.effort`) | ❌ | ❌ | ❌ | varies | ❌ | ❌ | ❌ |
| Context-edits / partial messages | ❌ | ❌ | ✅ (`context_edits` beta) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Image input | ✅ | ✅ | ✅ | model-dependent | model-dependent | varies | ❌ | ❌ | ✅ |
| Audio input/output | ❌ | ✅ (o-voice) | ❌ | ❌ | ❌ | varies | ❌ | ❌ | ✅ |
| JSON / structured outputs | ✅ | ✅ | ✅ (tool-based) | partial | partial | varies | ✅ | ✅ | ✅ |
| `tool_choice=none` mid-sentence fallback | used in AgenC Grok adapter | compatible | n/a (different semantic) | compatible | compatible | compatible | compatible | compatible | compatible |
| Server-side web search | ✅ | ✅ | ✅ | ❌ | ❌ | varies | ❌ | ❌ | ✅ |
| Long context (>200K) | 256K | 1M (o-series) | 200K | depends | depends | varies | 128K | 128K | 1M |

Capability detection is a **static registry** per
`(provider, model)` tuple. No runtime probe (RPC round-trips on
first-request are hostile to latency). The registry lives at
`runtime/src/llm/capabilities.ts`.

---

## Auth flows

Per-provider auth behavior — critical for the error path and for
`runtime/src/llm/*/auth-*.ts` modules.

### Bearer API key (Grok, Anthropic, Groq, DeepSeek, OpenRouter)

- `Authorization: Bearer <KEY>` on every request.
- 401 = bad key. **Hard-fail to user** with clear "check
  `<ENV_VAR>`" message. No refresh; no retry.
- No `auth-refresh.ts` module wired; the scaffold exists but is
  inert for these providers.

### OAuth (OpenAI ChatGPT, future OAuth providers)

- Access token with refresh token; access token expires.
- 401 → try refresh → retry original request.
- `consecutiveAuthFailures` counter incremented per 401; reset on
  success.
- **Hard cap: `MAX_CONSECUTIVE_AUTH_FAILURES = 10`** from openclaude
  `ccrClient.ts:68`. When hit, openclaude calls `onEpochMismatch()`
  which logs `cli_worker_auth_failures_exhausted` and exits
  (openclaude `ccrClient.ts:606-612`).
- AgenC port: same cap. After 10 consecutive 401s with a
  valid-looking token, emit `AuthFailed` event and hard-fail the
  session with message "OAuth refresh exhausted — re-authenticate
  via `<provider> login`."
- Lives in `runtime/src/llm/oauth/refresh-loop.ts` (shared) +
  `runtime/src/llm/providers/openai/auth.ts` (ChatGPT-specific
  re-auth command).

### API key + org/project (OpenAI API)

- `Authorization: Bearer <KEY>`, plus optional
  `OpenAI-Organization` and `OpenAI-Project` headers.
- 401 = key; 403 = org/project mismatch. Different error messages
  for each.

### Local / no auth (Ollama, LMStudio by default)

- No auth header. `LMSTUDIO_API_KEY` can be set if the server
  requires it.
- Connection-refused = server not running. Message user to start it.

### Google API key (Gemini)

- `?key=<KEY>` query param (or `x-goog-api-key` header in v1beta
  OpenAI-compat).
- 403 + `consumer: <project>` = billing/project issue. Separate
  branch.

---

## Default model resolution

Resolution order per session:

1. Explicit `--model <name>` CLI flag
2. `AGENC_MODEL` env var
3. Active profile's `model` field (`config/profiles.ts`)
4. Top-level `config.model` in `~/.agenc/config.toml`
5. Provider default from the matrix above
6. Hard default: Grok `grok-4-fast`

Provider resolution is similarly layered (`--provider`,
`AGENC_PROVIDER`, profile, config, default: `grok`).

### Resolution scope: session, not turn

Provider + model + capability profile are **resolved once at session
init** and cached in the `Session` struct. Mirrors codex's two-level
client design (`client.rs` Session-scoped `ModelClient` + Turn-scoped
`ModelClientSession`). Per-turn re-resolution is wasteful and breaks
prompt cache continuity.

**Mid-session provider/model switches** (via `/model` slash command
or `/provider` if added later) are explicit user actions: they update
the cached `Session.activeProvider` and `Session.activeModel`,
trigger an `I-2` cache clear (different provider = different
`previous_response_id` namespace), and emit a `provider_switched`
event. The next turn picks up the new selection. Phase 2 always
reads `session.activeProvider`; never re-resolves.

---

## Request shaping — branch by capability, not by name

```ts
// runtime/src/llm/shape-request.ts (pseudocode)

function shapeRequest(session: Session, caps: CapabilityProfile) {
  const req: Request = baseRequest(session);
  if (caps.previousResponseId && session.lastResponseId) {
    req.previous_response_id = session.lastResponseId;
    req.input = session.deltaItems;  // I-2: must be cleared on compact
  } else {
    req.input = session.fullHistory;
  }
  if (caps.promptCacheKey) req.prompt_cache_key = session.conversationId;
  if (caps.encryptedReasoning) req.include = ['reasoning.encrypted_content'];
  if (caps.reasoningEffort) req.reasoning = { effort: session.reasoningEffort };
  if (caps.thinkingBlocks) req.thinking = { type: 'enabled', budget_tokens: 8192 };
  if (caps.parallelToolCalls) req.parallel_tool_calls = true;
  return req;
}
```

Adapters never touch request shape directly; they supply `caps`
and let `shape-request.ts` do composition.

---

## Port scope impact

Multi-provider materially changes the codex/openclaude port plan
from the earlier "Grok locked" framing:

- **Codex `client.rs` (1,978 LOC)** — was cherry-pick-only. Now a
  full port. Its multi-provider dispatch pattern is the target
  architecture.
- **Existing Grok adapter (8,144 LOC)** — still ships unchanged as
  the *default* provider, but relocated from `runtime/src/llm/grok/`
  (implicit root) to `runtime/src/llm/providers/grok/`.
- **New adapters to build in T13** (multi-provider tranche):
  - `providers/openai/` — Responses + Chat Completions
  - `providers/anthropic/` — Messages + thinking blocks + cache_control
  - `providers/ollama/` — native client, OpenAI-compat fallback
  - `providers/lmstudio/` — OpenAI Chat Completions
  - `providers/openrouter/` — OpenAI Chat Completions + provider-routing header
  - `providers/groq/` — OpenAI Chat Completions
  - `providers/deepseek/` — OpenAI Chat Completions
  - `providers/gemini/` — native + OpenAI-compat v1beta
- **Shared infra:**
  - `llm/wire/responses-xai.ts`, `wire/responses-openai.ts`, `wire/messages-anthropic.ts`, `wire/chat-completions.ts`
  - `llm/capabilities.ts` — static registry
  - `llm/shape-request.ts` — capability-driven request composer
  - `llm/oauth/refresh-loop.ts` — shared OAuth helper for providers that need it
  - `llm/provider.ts` — `createProvider(name, config)` factory

---

## Testing strategy (multi-provider)

- **Unit**: every provider adapter has a mock server (`msw` or nock)
  that records/replays real responses. Snapshot the
  request-shape-per-capability matrix.
- **Integration (opt-in)**: one env-gated test per provider that hits
  the real API. Skipped by default in CI.
- **Provider parity**: a single "provider parity" test suite runs
  the same 10 prompts through all 9 providers and asserts
  tool-call + content-shape invariants.
- **Capability regression**: when the capability matrix changes, a
  regression suite verifies each cell still holds against recorded
  responses.

---

## What stays centralized

Capability detection, request shaping, response parsing, tool-call
extraction, error classification — all live in
`runtime/src/llm/` (not per-adapter). Adapters are thin:
`{ baseUrl, auth, wireFamily, capabilityOverrides }` plus whatever
provider-specific bug workarounds are real (e.g., xAI's mid-sentence
truncation retry stays in `providers/grok/`, not promoted).
