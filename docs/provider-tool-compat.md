# Provider tool-schema compatibility

How AgenC reshapes **tool payloads on the wire**. Execution still validates
the original schema. Local openai-compat sessions also get a reduced catalog
and a llama.cpp-safe keyword subset. Think-tag extraction and field
stripping live on the same chat-completions path; see
[providers.md — Local openai-compat wire](reference/providers.md#local-openai-compat-wire).

## Strict object root

Strict OpenAI-compatible providers (x.ai / Grok, DeepSeek) validate each tool's
`parameters` schema and require the **root to be `type: "object"`**. Several
AgenC tools (`exec_command`, `write_stdin`, `tool_search`) declare a root-level
`anyOf`/`oneOf` to express alternative input shapes, e.g.:

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

The agent's turn then errors before it can call the tool — independent of which
model is selected.

## Fix

`runtime/src/utils/toolParamSchema.ts` → `normalizeToolParamSchema(schema)`
normalizes the schema **presented to the provider** only; execution-side
validation (`runtime/src/tools/execution.ts`, which still understands
`anyOf`/`oneOf`) is untouched.

- **Clean object root** (`type: "object"`, or has `properties` with no root
  `anyOf`/`oneOf`) → returned unchanged, strict-eligible.
- **Union root** (`anyOf`/`oneOf`) → merge the `properties` of all object-typed
  branches into a single
  `{ type: "object", properties: <merged>, additionalProperties: true }`
  (carrying `description`), props left optional, and the tool is sent with
  `strict: false` (a union means the fields are conditional).
- **Any other non-object root** → permissive empty object, `strict: false`.

`runtime/src/llm/wire/tools.ts` applies the normalizer in `toolParameters()`,
which feeds chat-completions, OpenAI Responses, xAI Responses, and Anthropic
tool builders.

Object-root tools keep their previous behavior exactly (`strict: true` +
strict-schema enforcement).

## Grammar-safe schemas (LM Studio / generic compatible)

`lmstudio` and `openai-compatible` build a GBNF grammar from tool schemas at
request time (llama.cpp `json-schema-to-grammar`). A keyword outside that
converter's subset 400s the whole turn (`failed to parse grammar`) before the
model runs.

`sanitizeToolSchemaForGrammar` (`runtime/src/llm/wire/tools.ts`) keeps only:

`type`, `description`, `properties`, `required`, `items`, `enum`, `const`,
`additionalProperties`, `anyOf`, `oneOf`.

Constraints:

- A `type` array with one concrete type plus `null` becomes the concrete type.
  llama.cpp does not reliably compile nullable type arrays.
- A real multi-type union becomes `anyOf` of `{type}` / `{const: null}`. It is
  never collapsed to the first member.
- Dropped keywords only loosen the **wire** schema. Tool execution still
  checks the original definition.

`toChatCompletionsTools(..., { grammarSafe: true })` applies this after the
object-root normalizer. Cloud providers and the native `ollama` adapter do
not take this path. Pointing `openai-compatible` at an Ollama HTTP port
**does**.

## Local tool profile

The frontier catalog (~20 tools plus team/task orchestration) overwhelms
7–32B local models: they emit zero tool calls for whole sessions. For
`lmstudio` and `openai-compatible` only, `usesLocalToolProfile` /
`filterToolsForLocalProfile` (`runtime/src/llm/wire/capability-gating.ts`)
shrink the advertised list in `builtTools` (`session/run-turn.ts`) to:

| Kept | Role |
| --- | --- |
| `exec_command`, `write_stdin`, `kill_process` | Shell / process |
| `FileRead`, `Edit`, `MultiEdit`, `Write` | Files |
| `Glob`, `Grep`, `Orient` | Search |
| `AskUserQuestion`, `TodoWrite`, `SendUserMessage` | Interaction / progress |
| `EnterPlanMode`, `ExitPlanMode` | Plan mode |
| `system.searchTools` | Discover deferred tools (including MCP) |
| `StructuredOutput` | Structured final answer |

Names must match the registry. Cloud slugs and native `ollama` keep the full
catalog. MCP tools stay deferred behind `system.searchTools`; they are not
pre-advertised on this profile.

## When adding tools

Prefer a clean object root with optional fields when the provider surface must
stay strict-eligible. If a true union is required for execution-side clarity,
keep the union on the tool definition — the normalizer will collapse it for the
wire path and mark `strict: false`.

If the tool must be callable on `lmstudio` / `openai-compatible` without a
prior `system.searchTools`, add its registry name to
`LOCAL_PROFILE_TOOL_NAMES`. Keep its schema inside the grammar-safe keyword
set, or accept that those keywords are stripped on the wire.
