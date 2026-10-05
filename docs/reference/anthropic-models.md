# Anthropic models

Catalog checked September 29, 2026 against Anthropic's authenticated Models
API and official model pages. The Anthropic default remains `claude-opus-5-5`.

| Model | Context | Maximum output | Input / output per million tokens | Effort |
| --- | ---: | ---: | ---: | --- |
| `claude-sonnet-5-5` | 1,000,000 | 128,000 | $2 / $10 | low, medium, high (default), xhigh, max |
| `claude-haiku-4-5-20251001` | 200,000 | 64,000 | $1 / $5 | No effort parameter |

Sonnet 5.5 is a new selectable model. Haiku 4.5 rejoins the picker with no
effort dial; it supports manual extended thinking, which is a separate API
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
