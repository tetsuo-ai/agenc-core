# Provider tool-schema and local-wire compatibility

Provider request shaping lives in `runtime/src/llm/wire/`. Execution-side
validation (`runtime/src/tools/execution.ts`) always sees the original tool
schema. Only the **wire** copy is rewritten. An empty local or Gemini turn is
often a 400 on that wire copy, not a model that "did not answer". Gemini
schemas that cannot be validated under the native contract and preserved
exactly now fail in-process with `LLMProviderError` instead of reaching
`generateContent` or `countTokens`.

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
`openai-compatible` at an Ollama host _does_ take this path.

llama.cpp-family servers compile tool JSON Schema to GBNF at request time and
400 the whole turn (`failed to parse grammar`) when any tool uses a keyword
outside their converter. `sanitizeToolSchemaForGrammar` keeps this subset
**including `required`**:

| Kept                                                                                                                | Dropped (examples)                                               |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
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

## Gemini native JSON Schema

Gemini requests use the provider's JSON Schema fields. AgenC does not convert
them to the older OpenAPI `Schema` message:

- tool declarations use `functionDeclarations[].parametersJsonSchema`
- structured output uses `generationConfig.responseJsonSchema`
- admission `countTokens` rebuilds the same request, including tool schemas

This wire shape is used for the Developer API v1beta, Vertex v1, and custom
native Gemini endpoints. A custom endpoint must accept the same current native
request fields as `models/*:generateContent`.

Tool schemas stay intact. Type arrays, `additionalProperties`, `$defs`, `$ref`,
URI-fragment pointers, `anyOf`, and `oneOf` reach the provider without local
inlining or keyword rewriting. Repeated and recursive refs do not consume a
local expansion budget. This also applies to MCP `inputSchema` after its
model-facing size and annotation sanitization.

Gemini requires tool parameters to describe a JSON object. AgenC checks that
root before dispatch without changing the accepted schema. An explicit object,
a local `$ref` to an object schema, or a union whose analyzed root domain is
exactly object can pass. Scalar, array, nullable, unconstrained, mixed-union,
and unresolved roots fail on chat, streaming, and admission token counting.
The root check is not a general JSON Schema satisfiability solver. It rejects an
empty root-type domain and an empty finite `const`/`enum` intersection reached
directly or through local `$ref` and `allOf`. It does not infer finite-literal
contradictions inside `anyOf`, `oneOf`, `not`, properties, or an enum with more
than 256 values.

Response schemas are checked against Google's documented common subset before
the request is built. AgenC accepts these keywords:

- `$id`, `$defs`, `$ref`, and `$anchor`
- `type`, `format`, `title`, `description`, and `enum`
- `items`, `prefixItems`, `minItems`, and `maxItems`
- `minimum`, `maximum`, and `anyOf`
- `properties`, `additionalProperties`, `required`, and `propertyOrdering`

Other keywords fail with their full source path. This includes `allOf`,
`const`, `pattern`, `minLength`, `not`, and unknown extension keywords. New or
unrecognized model families use the same common subset until the provider
capability record is updated.

Google lists `oneOf`, but interprets it as `anyOf`. A response sub-schema that
contains `$ref` may have only `$`-prefixed siblings. AgenC rejects both shapes
instead of changing their meaning. `$id` establishes a schema-resource base,
and `$anchor` names are scoped to that resource. A local `$ref` may select an
embedded resource by URI, then use an RFC 6901 JSON Pointer or declared anchor
within it. External and unresolved references fail locally. Recursive
references are accepted only when the reference appears in a non-required
property, as required by the Gemini contract.

Successful validation does not rewrite the response schema. Type arrays,
`$defs` maps, ordering, and optional recursive references reach the provider
unchanged. An error includes the source path, for example:

```text
Gemini cannot preserve schema at structuredOutput["answer"].schema.oneOf:
Gemini interprets oneOf as anyOf, which would weaken validation
```

Use `anyOf` only when inclusive-OR behavior is correct. For a response `$ref`,
move `description` and other non-`$` keywords into the referenced definition.
Move a recursive `$ref` out of `required` when omission is valid. Tool
parameter schemas are not subject to these local response-schema checks and
remain exact `parametersJsonSchema` values after the object-root check.

One plain-data snapshot is used for validation and the request wire. The
snapshot accepts at most 100,000 JSON values, 1,048,576 UTF-8 bytes across
property names and string values, and 256 nested JSON levels. Reference and
combinator analysis accepts at most 10,000 steps and 256 nested analysis
levels. These are local safety limits, not Gemini service limits. A schema
that exceeds one of them fails before chat, streaming, or token counting.

Primary API references:

- [Gemini Developer API: `FunctionDeclaration` and `GenerationConfig`](https://ai.google.dev/api/generate-content)
- [Vertex v1 REST discovery schema: `GoogleCloudAiplatformV1FunctionDeclaration` and `GoogleCloudAiplatformV1GenerationConfig`](https://aiplatform.googleapis.com/$discovery/rest?version=v1)
- [JSON Schema resource and reference rules](https://json-schema.org/draft/2020-12/draft-bhutton-json-schema-01#section-8.2)
- [`@google/genai` function-calling example](https://googleapis.github.io/js-genai/release_docs/index.html#function-calling)

## When adding tools

Prefer a clean object root with optional fields when the provider surface must
stay strict-eligible. If a true union is required for execution-side clarity,
keep the union on the tool definition. The Grok/DeepSeek normalizer collapses
a **root** union for those providers and reports `strictEligible: false`.
Gemini sends tool parameters through `parametersJsonSchema` without local
keyword rewriting after proving that every possible root is an object. LM
Studio and openai-compatible still use the grammar-safe subset, so do not rely
on `$ref`, `oneOf`, `allOf`, or `x-agenc-*` reaching those providers. Gemini
structured output rejects `oneOf` because Google treats it as `anyOf` there.

For a tool to remain callable through the LM Studio/openai-compatible profile,
its registry name must appear in `LOCAL_PROFILE_TOOL_NAMES`, and its wire
schema must tolerate grammar-keyword stripping. `system.searchTools` does not
bypass this allowlist: discovery may find another tool, including an MCP tool,
but `builtTools` applies the local-profile filter afterward.

## Troubleshooting

| Symptom                                                                             | Cause                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grok/DeepSeek 400 "root must be an object type"                                     | Root `anyOf`/`oneOf` before `normalizeToolParamSchema`                                                                                                                                                                           |
| LM Studio/openai-compatible 400 `failed to parse grammar`                           | Tool schema contains a keyword outside the grammar-safe subset                                                                                                                                                                   |
| LM Studio/openai-compatible empty turn after a long answer                          | Check whether the fixed 8192 output ceiling ended generation                                                                                                                                                                     |
| LM Studio/openai-compatible session does not call team/task tools                   | Those tools are outside the reduced catalog; use another provider slug when they are required                                                                                                                                    |
| Qwen3 think-trace burns minutes                                                     | `/no_think` only attaches on `lmstudio` / `openai-compatible` + qwen3                                                                                                                                                            |
| Gemini tool schema fails locally at `tools["name"].parameters`                      | The analyzed root is not object-only, a finite `const`/`enum` intersection reached through local `$ref` or `allOf` is empty, or a root reference does not resolve locally                                                        |
| Gemini response schema fails locally with `Gemini cannot preserve schema at <path>` | Structured output used an unsupported keyword, a lossy `oneOf`, an invalid or remote `$ref`, a non-`$` sibling beside `$ref`, or a required reference cycle. Follow the path in the error and use the documented response subset |
| Custom Gemini endpoint rejects `parametersJsonSchema` or `responseJsonSchema`       | `GEMINI_BASE_URL` must expose the current native Gemini request shape. Update the proxy or use the official Developer API or Vertex endpoint                                                                                     |
| NIM ignores or 400s `reasoning_effort`                                              | Family has no documented enum, or the value is outside it                                                                                                                                                                        |

There is no operator config for the grammar-safe key set, the 8192 ceiling, or
the local catalog. The configured `max_output_tokens` still wins when it is
**lower** than 8192; it cannot raise this provider ceiling.
