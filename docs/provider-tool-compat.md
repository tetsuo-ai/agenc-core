# Provider tool-schema compatibility

Strict OpenAI-compatible providers (x.ai / grok, DeepSeek) validate each tool's `parameters` schema and require the **root to be `type: "object"`**. Several AgenC tools (`exec_command`, `write_stdin`, `tool_search`) declare a root-level `anyOf`/`oneOf` to express alternative input shapes, e.g.:

```jsonc
{ "type": "object", "properties": { ... },
  "anyOf": [ { "required": ["cmd"] }, { "required": ["command"] } ] }
```

Lenient providers (OpenAI / Codex) accept this. Strict ones reject the whole request:

```
400 "exec_command: tool parameter root must be an object type
     (root schema is an anyOf/oneOf union with a non-object branch)"
```

The agent's turn then errors before it can call the tool — independent of which model is selected.

## Fix

`src/utils/toolParamSchema.ts` → `normalizeToolParamSchema(schema)` normalizes the schema **presented to the provider** only; execution-side validation (`src/tools/execution.ts`, which still understands `anyOf`/`oneOf`) is untouched.

- **Clean object root** (`type: "object"`, or has `properties` with no root `anyOf`/`oneOf`) → returned unchanged, strict-eligible.
- **Union root** (`anyOf`/`oneOf`) → merge the `properties` of all object-typed branches into a single `{ type: "object", properties: <merged>, additionalProperties: true }` (carrying `description`), props left optional, and the tool is sent with `strict: false` (a union means the fields are conditional).
- **Any other non-object root** → permissive empty object, `strict: false`.

It is applied at every place tools are serialized into a provider request, so whichever API path a provider uses is covered:

- `src/llm/wire/tools.ts` → `toolParameters()` (feeds chat-completions, OpenAI Responses, xAI Responses, and Anthropic tool builders)
- `src/services/api/openAiCodeTransform.ts` → `convertToolsToResponsesTools()` (normalize before `enforceStrictSchema`; union roots skip all-required and emit `strict: false`)
- `src/services/api/openaiShim.ts` → `convertTools()` (chat-completions)

Object-root tools keep their previous behavior exactly (`strict: true` + strict-schema enforcement).
