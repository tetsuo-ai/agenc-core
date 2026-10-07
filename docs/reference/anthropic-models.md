# Anthropic models

Haiku 5.5 checked October 7, 2026 against the official model, migration,
thinking, effort and pricing pages. Earlier rows were checked September 29. The Anthropic default remains `claude-opus-5-5`.

| Model | Context | Maximum output | Input / output per million tokens | Effort |
| --- | ---: | ---: | ---: | --- |
| `claude-sonnet-5-5` | 1,000,000 | 128,000 | $2 / $10 | low, medium, high (default), xhigh, max |
| `claude-haiku-5-5` | 1,000,000 | 128,000 | $0.10 / $0.50 up to 100K prompt tokens; $0.50 / $2.50 above 100K | low, medium (default), high, xhigh, max |
| `claude-haiku-4-5-20251001` | 200,000 | 64,000 | $1 / $5 | No effort parameter |

Haiku 5.5 joins the current picker. Haiku 4.5 remains selectable as a legacy
model with no effort dial; it supports manual extended thinking, which is a separate API
control. AgenC reserves 64,000 output tokens by default for these catalog
entries and keeps the provider's higher output ceiling separately.

Sources: [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
and [Haiku 4.5](https://platform.claude.com/docs/en/models/haiku-4-5/overview).

Sonnet 5.5 uses adaptive thinking. AgenC requests summarized thinking so
progress updates remain visible. The Core provider option
`reasoningEffort: "none"` selects `thinking: {type: "between_tools"}`, the
model's lowest thinking setting. The ordinary effort dial exposes the five
provider effort tiers. Forced tool choices fall back to automatic selection,
including the synthetic structured-output tool. Sampling parameters and Fast
mode are omitted because this model does not accept those controls.

Anthropic binds Sonnet 5.5 thinking blocks to their producing model and
conversation prefix. AgenC currently renders the summaries without replaying
Anthropic thinking signatures. Tool calls and results remain in conversation
history, while opaque reasoning is not preserved across turns. This also
prevents sending stale signatures after changing models, instructions or
tools. See the [migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide).

Existing supported Claude models now carry explicit context and output
metadata instead of inheriting the generic fallback. Sonnet 4.5 keeps its
documented 200,000-token default; the Models API reports a 1,000,000-token
maximum. Fable 5.1 cache reads are corrected to $0.25 per million tokens;
Fable 5 remains $1.00. See [Fable 5.1 pricing](https://platform.claude.com/docs/en/models/fable-5-1/overview).

Older retired model identifiers remain available for historical configuration
and cost interpretation, but are not added to the current Anthropic picker.
Check [Anthropic's model lifecycle](https://platform.claude.com/docs/en/about-claude/model-deprecations)
before reusing an old configuration.

Haiku 5.5 uses the pinned, dateless ID `claude-haiku-5-5`, with no separate
alias. Bedrock uses `anthropic.claude-haiku-5-5` on the SigV4-signed
`https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages` endpoint.
Google Cloud uses `claude-haiku-5-5` without an `@date`. OpenRouter publishes
`anthropic/claude-haiku-5.5`.

Core requests adaptive thinking with `display: "summarized"`. All five effort
levels reach `output_config.effort`; `reasoningEffort: "none"` sends disabled
thinking with no effort override, using the API's medium default. Disabled
thinking is accepted only at high effort or below. Forced tool choices are
supported and produce a tool call without a thinking block. Sampling
parameters, Fast mode and Priority Tier are omitted. Assistant prefills become
user continuation requests. The same non-replay policy described above protects
Haiku 5.5 from stale thinking signatures after compaction, history edits, system
or tool changes, and tool-result clearing.

The 100,000-token price boundary includes uncached input, cache reads and
cache writes. At or below it, 5-minute writes cost $0.125, 1-hour writes $0.20,
and reads $0.01 per million tokens. Above it, those rates are $0.625, $1.00,
and $0.05. Both Core calculators handle the two tiers. Core has no batch
execution or batch-pricing mode. The provider's batch discount is 50% on input
and output.

The newer tokenizer counts approximately 30% more tokens than Haiku 4.5 for
the same text. Local estimates use the same denser ratio as the other newer
Claude models; provider counts remain authoritative. No default model changes.
The token-estimation service and tool-use summary generator still select Haiku
4.5.

Sources: [overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview),
[migration](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide),
[changes](https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5),
[effort](https://platform.claude.com/docs/en/build-with-claude/effort),
[thinking](https://platform.claude.com/docs/en/build-with-claude/thinking),
[pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[Bedrock](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock),
and [OpenRouter catalog](https://openrouter.ai/api/v1/models).
