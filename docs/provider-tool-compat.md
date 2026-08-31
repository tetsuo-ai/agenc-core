# Provider tool-schema and local-wire compatibility

Provider request shaping lives in `runtime/src/llm/wire/`. Execution-side
validation (`runtime/src/tools/execution.ts`) always sees the original tool
schema. Only the **wire** copy is rewritten. An empty local or Gemini turn is
often a 400 on that wire copy, not a model that "did not answer".

Local window probes and `context_window_exceeded` text:
[providers.md](reference/providers.md#local-context-windows).

## Object-root tools (Grok / DeepSeek)

Strict OpenAI-compatible providers (x.ai / Grok, DeepSeek) require each tool
`parameters` schema root to be `type: "object"`. A supplied or future tool
schema can still declare a root-level `anyOf`/`oneOf` to express alternative
input shapes, for example:

```jsonc
{ "type": "object", "properties": { ... },
  "anyOf": [ { "required": ["cmd"] }, { "required": ["command"] } ] }
```

Lenient providers (OpenAI / Codex) accept this. Strict ones reject the whole
request:

```
400 "exec_command: tool parameter root must be an object type
     (root schema is an anyOf/oneOf union with a non-object branch)"
```

`runtime/src/utils/toolParamSchema.ts` → `normalizeToolParamSchema(schema)`
rewrites only the presented schema:

- **Clean object root** (`type: "object"`, or has `properties` with no root
  `anyOf`/`oneOf`) → unchanged, strict-eligible.
- **Union root** (`anyOf`/`oneOf`) → merge object-branch `properties` into
  `{ type: "object", properties: <merged>, additionalProperties: true }`,
  leave fields optional, and report `strictEligible: false`.
- **Any other non-object root** → use a permissive empty object and report
  `strictEligible: false`.

`toolParameters()` in `runtime/src/llm/wire/tools.ts` applies this for
chat-completions, OpenAI Responses, xAI Responses, and Anthropic builders.
The current builders use the normalized schema but do not serialize the
normalizer's `strictEligible` result or a `strict` field.

## Grammar-constrained local servers (LM Studio / openai-compatible)

`GRAMMAR_CONSTRAINED_TOOL_PROVIDERS` in
`runtime/src/llm/wire/capability-gating.ts` is **`lmstudio`** and
**`openai-compatible` only**. The Ollama slug is not in that set. Pointing
`openai-compatible` at an Ollama host *does* take this path.

llama.cpp-family servers compile tool JSON Schema to GBNF at request time and
400 the whole turn (`failed to parse grammar`) when any tool uses a keyword
outside their converter. `sanitizeToolSchemaForGrammar` keeps this subset
**including `required`**:

| Kept | Dropped (examples) |
| --- | --- |
| `type`, `description`, `properties`, `required`, `items`, `enum`, `const`, `additionalProperties`, `anyOf`, `oneOf` | `$ref`, `$schema`, `minLength`, `pattern`, `format`, `x-agenc-*` |

Nullable `type` arrays collapse to the concrete type (or `anyOf` / `const:
null`). Execution still validates the original schema.

Applied only on the chat-completions tool builder
(`toChatCompletionsTools(..., { grammarSafe: true })`). Responses / Anthropic
paths do not run this sanitizer.

### Local output ceiling

`DEFAULT_MAX_OUTPUT_TOKENS` is still **32_000**
(`runtime/src/utils/model/openaiContextWindows.ts`). Grammar-constrained
providers clamp `max_tokens` / `max_completion_tokens` to **8192**
(`outputTokensCeiling` in `buildChatCompletionsRequest`). That is a fixed
ceiling, not window/4.

The 8192 limit replaces the earlier 4096 limit while retaining a fixed bound
for these providers.

### Local tool catalog and compact prompt

`usesLocalToolProfile` / `filterToolsForLocalProfile` advertise this reduced
catalog to the two grammar-constrained provider slugs:

`exec_command`, `write_stdin`, `kill_process`, `FileRead`, `Edit`,
`MultiEdit`, `Write`, `Glob`, `Grep`, `Orient`, `AskUserQuestion`,
`TodoWrite`, `EnterPlanMode`, `ExitPlanMode`, `system.searchTools`,
`SendUserMessage` (`BRIEF_TOOL_NAME`), `StructuredOutput`.

Cloud slugs are untouched. Bootstrap also picks the **`compact`** instruction
profile for these two slugs (`runtime/src/bin/bootstrap.ts`).

### Qwen3 thinking switch

LM Studio ignores `chat_template_kwargs.enable_thinking`. For a
grammar-constrained provider whose model slug matches `qwen-?3`, the wire
appends a literal `/no_think` line to the system prompt
(`reasoningSoftSwitchSuffix`). That is the only thinking control that works
everywhere llama.cpp serves Qwen3.

### NVIDIA NIM `reasoning_effort`

`nvidia-nim` forwards `reasoning_effort` only when the model family documents
that enum (`kimi-k3`, `deepseek-v4-{pro,flash}`, `gpt-oss-<digits>b`,
`nemotron-3-super`, `nemotron-3-ultra`). Other NIM families strip the field so
the host default runs. Out-of-enum values are not translated.

## Gemini function-declaration allowlist

Gemini's OpenAPI subset fails the **whole request** on an unknown schema key
(`Unknown name "additionalProperties"`, then the same for `x-agenc-*`). Every
LIVE tool carried at least one, so the provider answered 400 and the UI looked
like an empty reply.

`sanitizeGeminiSchema` in `runtime/src/llm/providers/gemini/index.ts` keeps a
documented allowlist (`type`, `format`, `title`, `description`, `nullable`,
`enum`, `items`, `properties`, `required`, `anyOf`, numeric/length bounds,
`pattern`, and other documented keys). `required` and `properties` stay
**only** on `type: object` branches; carrying them onto an `anyOf` arm 400s
with "only allowed for
OBJECT type".

## When adding tools

Prefer a clean object root with optional fields when the provider surface must
stay strict-eligible. If a true union is required for execution-side clarity,
keep the union on the tool definition. The normalizer collapses it for the
wire and reports `strictEligible: false`. Do not rely on `$ref` or `x-agenc-*`
reaching LM Studio, openai-compatible, or Gemini.

For a tool to remain callable through the LM Studio/openai-compatible profile,
its registry name must appear in `LOCAL_PROFILE_TOOL_NAMES`, and its wire
schema must tolerate grammar-keyword stripping. `system.searchTools` does not
bypass this allowlist: discovery may find another tool, including an MCP tool,
but `builtTools` applies the local-profile filter afterward.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Grok/DeepSeek 400 "root must be an object type" | Root `anyOf`/`oneOf` before `normalizeToolParamSchema` |
| LM Studio/openai-compatible 400 `failed to parse grammar` | Tool schema contains a keyword outside the grammar-safe subset |
| LM Studio/openai-compatible empty turn after a long answer | Check whether the fixed 8192 output ceiling ended generation |
| LM Studio/openai-compatible session does not call team/task tools | Those tools are outside the reduced catalog; use another provider slug when they are required |
| Qwen3 think-trace burns minutes | `/no_think` only attaches on `lmstudio` / `openai-compatible` + qwen3 |
| Gemini 400 `Unknown name "additionalProperties"` / empty reply | Pre-allowlist wire schema; current code strips those keys |
| NIM ignores or 400s `reasoning_effort` | Family has no documented enum, or the value is outside it |

There is no operator config for the grammar-safe key set, the 8192 ceiling, or
the local catalog. The configured `max_output_tokens` still wins when it is
**lower** than 8192; it cannot raise this provider ceiling.
