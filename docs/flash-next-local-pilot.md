# Flash Next through the AgenC connector

This local pilot keeps the normal AgenC device login and account lookup at
`id.agenc.ag`. A separately operated loopback relay verifies the real account,
checks its explicit allowlist and forwards only the selected model to a fixed
private inference endpoint. No production authentication or paid-usage service
is changed. GPU availability and successful inference require separate checks.

Use an isolated `AGENC_HOME` and the locally built Core executable. The pilot
configuration selects the exact hosted model:

```toml
config_version = 2
model_provider = "agenc"
model = "Qwen/Qwen3.8-Flash-Next"
reasoning_effort = "medium"
max_output_tokens = 16384

[auth]
backend = "remote"

[auth.managedKeys]
enabled = true

[providers.agenc]
default_model = "Qwen/Qwen3.8-Flash-Next"
context_window_tokens = 262144
max_output_tokens = 16384
```

Set `AGENC_REMOTE_AUTH_MODEL_URL`, `AGENC_REMOTE_AUTH_URL` and
`AGENC_REMOTE_AUTH_USAGE_URL` to the relay's `/v1/auth/infer-model`,
`/v1/auth/llm-credential` and `/v1/auth/llm-usage` endpoints. Keep login, account
lookup and subscription-tier endpoints on their normal hosted defaults. Desktop
uses `AGENC_BIN` to select the same executable and `AGENC_HOME` to select the
same isolated configuration, daemon and native credential namespace.

The relay receives authenticated POST JSON. Inference routing returns
`provider: "qwen"` and `model: "Qwen/Qwen3.8-Flash-Next"`. Credential vending
returns the requested provider and session ID, an opaque short-lived capability,
the loopback `/v1` base URL and an ISO `expiresAt`. Core keeps the capability in
memory; the upstream GPU receives separate relay-owned credentials.

A free account may use this exact route only when usage reports
`managedModelsEnabled: true`, an active nonempty allowance, and an unexpired
`pilotAccess` object containing `provider: "agenc"`, an exact `models` list and
ISO `expiresAt`. The account remains free. Missing, malformed, expired, exhausted
or unavailable access grants nothing. `providers --json` reports the configured
model and readiness, so Desktop can show the route without inventing a paid tier.
The relay must withhold active access when its upstream is unavailable.

The [pinned model template](https://huggingface.co/Qwen/Qwen3.8-Flash-Next/blob/de4b8e4d43b917e7706784d8bb445c9af86a3540/chat_template.jinja)
supports `low`, `medium` and `xhigh`. Core sends Chat Completions, preserves
same-model reasoning and tool-call IDs through continuations, and places vLLM
thinking switches inside `chat_template_kwargs`. It accepts both canonical
`reasoning` and legacy `reasoning_content` responses, then replays `reasoning`.
The [vLLM compatibility bridge](https://github.com/vllm-project/vllm/blob/98dff2a81d747d1dba01a47f939f48c3526d4206/vllm/entrypoints/chat_utils.py#L1999)
copies that canonical field into `reasoning_content` before rendering, matching
the pinned template's input. Verify this path again in the allocated runtime.
The 262,144-token context includes input and output. Metadata does not establish
hardware capacity or semantic quality, and the route is not added to the global
model picker solely by installing this change.

Focused offline tests cover authorization failures, readiness, both reasoning
field names, fragmented tool arguments and a synthetic two-turn continuation.
They do not establish a real login or live Flash Next inference. Use a real
account login and a separately verified live endpoint for those acceptance checks.
