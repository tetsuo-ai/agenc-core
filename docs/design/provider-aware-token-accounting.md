# Provider-aware token accounting

Status: implemented runtime contract.

This document defines how AgenC bounds a complete model request before it can
reach a provider. The implementation authority is
`runtime/src/llm/token-accounting.ts`; provider capabilities live beside the
wire adapters that construct the corresponding inference request.

## Safety invariant

At final inference admission, AgenC requires:

```text
accounted input tokens + reserved maximum output tokens <= context window
```

The input side covers the same normalized request components used for
inference: system instructions, messages, tool schemas and tool choice,
structured-output schema, configured provider-native tool payloads, inline
media, provider framing, and request options that alter framing.
Auto-compaction uses the same component model. A provider call is denied when
a content type has neither a complete native count nor a documented
conservative upper bound. Remote MCP catalogs are provider-expanded content and
therefore remain inadmissible without a complete native count.

The structured result reports provider/model identity, input and reserved
output counts, source, confidence, complete component coverage, cache status,
calibration version, applied safety margin, and admissibility. A bare number is
not an admission contract.

## Count selection

| Provider surface | Admission source | Rationale |
| --- | --- | --- |
| Anthropic Messages | Native `/messages/count_tokens`, high confidence | The endpoint accepts system, messages, tools, images, and documents. Anthropic notes that a preflight count can differ slightly from later billed usage. |
| Amazon Bedrock Converse | Native `/model/{modelId}/count-tokens`, exact confidence | The CountTokens API accepts the Converse input and documents that its result matches the charged input count for that request. |
| Google Gemini | Native `models.countTokens` with `generateContentRequest`, high confidence | `generateContentRequest` carries the complete prompt, system instruction, tools, and media instead of the incomplete text-only form. |
| Vertex Gemini publisher paths | Native `models.countTokens` with the documented direct prompt fields, high confidence | Vertex accepts contents, system instruction, tools, and generation config directly. Requests using fields that Vertex CountTokens cannot represent, such as cached content or explicit tool configuration, fail closed to the conservative coverage result. |
| xAI / Grok | Conservative fallback | The public tokenization endpoint is text-oriented and does not prove complete accounting for system, tools, media, and all inference framing. It is calibration input, not an exact complete-request capability. |
| OpenAI, OpenAI-compatible, Ollama, and other local endpoints | Conservative fallback unless a future adapter proves a complete capability | Provider/model aliases alone do not establish tokenizer or endpoint equivalence. |

Primary provider contracts:

- [Anthropic Messages token counting](https://platform.claude.com/docs/en/api/messages/count_tokens)
- [Anthropic token-counting behavior](https://platform.claude.com/docs/en/build-with-claude/token-counting)
- [Amazon Bedrock CountTokens](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_CountTokens.html)
- [Google Gemini token counting](https://ai.google.dev/api/tokens)
- [Vertex Gemini token counting](https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/projects.locations.publishers.models/countTokens)
- [xAI tokenization API](https://docs.x.ai/developers/rest-api-reference/inference/other)

A native capability is optional on `LLMProvider`. It may return a complete
result only when its request builder can represent the entire outbound input.
Partial native results are combined with the conservative bound and retain the
fallback source; they are never relabeled exact. Exact provider counts are used
as returned. High-confidence counts receive the same once-only safety floor as
the local fallback because their provider contracts explicitly allow small
differences from later billed usage.

## Conservative fallback

The fallback is a single O(serialized request bytes) pass over a canonical
complete-request representation. It uses `TextEncoder` UTF-8 bytes, takes the
maximum byte length across NFC, NFD, NFKC, and NFKD so tokenizer normalization
cannot expand past the bound, applies a whole-request ceiling, and adds named
nonzero request, message, tool, tool-choice, and media framing costs. It
deliberately assumes at most **two** normalized UTF-8 bytes per ordinary input
token (`token-accounting-fallback-v2`). v1 used one byte/token and denied
Grok 500k windows at about 16% real usage. This is expensive but safe for
offline and unknown provider surfaces.

The initial safety floor is applied once after the complete input and framing
are summed, or once to a high-confidence native count:

```text
ceil(complete_input * 0.10) + 256 tokens
```

Per-provider calibration may raise that floor but cannot lower it. Inline
base64 image and PDF/document payloads are bounded by their actual serialized
bytes plus media framing. Remote media, server-side cached content, and unknown
provider-specific blocks are inadmissible without a complete native count
because their fetched or provider-expanded size is not locally bounded. There
is no universal
"2,000-token image" constant.

The deterministic corpus at
`runtime/tests/llm/fixtures/token-accounting-calibration.v1.json` contains
non-secret Unicode/tokenizer ceiling cases and an official Gemini documented
usage observation. Tests compare every bound to its recorded reference and
feed the same values through aggregate undercount metrics. Live usage
reconciliation extends that evidence by provider, model, source, and content
type.

## Canonical identity and cache isolation

Native results are keyed by a domain-separated SHA-256 digest over:

- provider and model;
- the canonical complete prompt and options;
- canonical endpoint identity;
- adapter and configuration revisions;
- model and tokenizer revisions;
- count-endpoint capability version;
- context window and output reserve.

Endpoint identity is only the lowercase origin and normalized API base path.
User information, credentials, query parameters, and fragments are stripped.
Equivalent credential/query variants can share a count, while `/v1` and `/v2`
or two different hosts cannot. Raw endpoint identities and stable request
digests are not emitted in normal telemetry.

The process-wide defaults are:

| Resource | Bound |
| --- | ---: |
| Cache entries | 1,024 |
| Cache key/value bytes | 67,108,864 |
| Cache TTL | 300,000 ms |
| Physical native-count calls | 64 |
| Waiters per digest | 1,024 |
| Waiters process-wide | 4,096 |
| Waiter metadata bytes | 4,194,304 |
| Canonical request bytes | 16,777,216 |
| Provider count deadline | 5,000 ms |
| Aggregate metric partitions | 4,096 |

The cache is a true access-ordered LRU with TTL and byte accounting. Shared
single-flight attaches only after waiter count and byte reservations succeed.
Overflow uses an already validated conservative result or denies the request.
It never evicts an existing waiter or starts a second call for the same digest.

One caller abort detaches only that caller. The shared provider call is asked
to cancel after its last waiter leaves, but its physical slot remains owned
until the provider promise actually settles. An abort-ignoring generation is
marked abandoned: new callers do not attach, late success is discarded, and no
replacement starts while the physical cap remains occupied. Errors, timeouts,
and abandoned results are never cached as zero.

## Enforcement and dependent surfaces

- The durable model-call admission boundary accounts before reservation,
  persists a denial reason for uncertainty or context overflow, and passes the
  admitted input count to provider-side final fitting.
- Model-call admission records a context overflow as
  `context_window_exceeded`. The live TUI renders that reason and suggests
  `/compact`; it does not currently show the input count, output reserve, or
  window. Compaction paths use a detailed error containing those values.
- Local servers may reply with a vendor-prefixed or differently cased model
  id (`unsloth/qwen3.8-27b` vs `qwen3.8-27b`). Admission treats those as the
  same model (`isSameModelIdentity` in `admitted-model-call.ts`). A raw
  string compare used to book a fallback against a spent step and drop the
  streamed answer (`AdmissionStepConflictError`, empty `lastAgentMessage`).
- Auto-compaction includes system, tools, tool choice, framing, and reserved
  output through the same accounting representation. Uncertain content forces
  compaction rather than being treated as free.
- MCP output validation uses the conservative service. Unavailable, unknown,
  remote, or oversized content enters bounded UTF-8 truncation; unsupported
  blocks are omitted, and the result is rejected if the truncated payload still
  cannot be proven below the cap.
- Historical rough estimators remain only for display, local file sizing, and
  other non-admission compatibility surfaces. They share the UTF-8 primitive
  and do not authorize inference. `execution_admission` is a canonical event
  and carries denied model-turn reasons. `warning` is forwarded as a separate
  canonical event type.

## Session context estimate

`session.snapshot` may include `contextBreakdown`, a best-effort diagnostic
estimate built from current daemon session state. It does not reproduce the
provider request and must not be used for admission or exact percentages. A
top-level failure omits the field; unreadable memory files and unserializable
history items are skipped.

| Field | Source |
| --- | --- |
| `windowTokens` | Resolved model context window from configuration, a probe, the catalog, or a fallback |
| `systemPromptTokens` | Rough estimate of session instructions |
| `messageTokens` | Rough estimate of serializable conversation history |
| `systemToolTokens` / `systemToolCount` | Rough estimate and count of resident non-MCP tool schemas |
| `mcpToolTokens` / `mcpToolCount` | Rough estimate and count of resident schemas in the `mcp.*` namespace |
| `deferredToolTokens` / `deferredToolCount` | Rough estimate and count of registered schemas that are not resident or already discovered |
| `memoryFileTokens` / `memoryFileCount` | Rough estimate and count of readable top-level memory Markdown files; paths are not deduplicated and this is not bound to sent attachments |

These categories do not form an authoritative used-token total. Admission
still uses the structured token-accounting result above. The raw daemon
protocol types the optional field; the public SDK's `SessionSnapshotResult`
does not currently expose it. Sources:
`runtime/src/app-server/background-agent-runner.ts`
(`#sessionContextBreakdown`) and
`SessionSnapshotResult` in `runtime/src/app-server/protocol/index.ts`.

## Observability and privacy

After provider settlement, AgenC compares the admitted input count with
provider-reported input usage. Metrics contain only provider, model, accounting
source, content-type partition, sample totals, aggregate estimated/reported
tokens, undercount samples, and maximum undercount. Prompt text, credentials,
endpoint paths, and request digests are excluded.
Metric cardinality is capped; excess provider/model partitions are folded into
a fixed `other` partition per accounting source.

An undercount is a calibration failure. The response still reconciles against
authoritative provider usage, while the recorded partition identifies which
provider/model/content calibration must be raised.

## Compatibility, rollout, and rollback

`LLMProvider.tokenCountCapability` and the internal
`LLMChatOptions.accountedInputTokens` field are additive runtime interfaces.
There is no daemon protocol, SDK protocol, persisted-state, or database-schema
change, so no reader/writer migration or package major-version boundary is
required. The legacy `services/tokenEstimation.ts` entry points remain as thin
compatibility adapters over `TokenAccountingService`; new enforcement code
must use the structured result.

The intentional behavioral change is fail-closed handling: a request that was
previously underestimated, treated as unlimited, or sent despite unbounded
media can now compact, truncate, or receive a deterministic admission denial.
This is a safety correction rather than a response-schema change.

Rollback can remove a provider's native capability and safely fall back to the
conservative implementation. It must not restore UTF-16 per-message rounding,
fixed media guesses, error-as-zero caching, or uncertainty-as-unlimited MCP
behavior. This implementation does not authorize a release or package-version
bump.
