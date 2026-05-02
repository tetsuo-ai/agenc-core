# LLM Registry Parity

Upstream reference: donor runtime repository at commit `48791920a8b122939c4d3feb15673c0a690ca4a0`.

Primary source anchors:
- `models-manager/src/model_info.rs`
- `models-manager/src/manager.rs`
- `models-manager/models.json`
- `model-provider-info/src/lib.rs`
- `features/src/lib.rs`
- `features/src/legacy.rs`
- `features/src/feature_configs.rs`

This directory owns the AgenC TypeScript registry for LLM catalog data:
- `model-catalog.ts` stores executable per-model metadata, capability hints,
  supported reasoning levels, and visibility metadata. The hidden review-only
  model row feeds guardian approval review selection, and model maximum context
  windows cap explicit provider configuration.
- `provider-info.ts` stores built-in provider defaults, request retry metadata,
  live metadata URL/auth defaults, and source rows that are intentionally
  outside AgenC's current runtime provider scope. Provider factories and
  adapter defaults consume this registry rather than exporting local model
  catalog tables.
- `features.ts` stores the complete staged feature definition set and
  legacy-key normalization with AgenC-owned names, including structured
  feature config enablement semantics.

Provider-info scope boundary:
- `amazon-bedrock` is documented as out of scope until AgenC has an AWS
  SigV4 Amazon Bedrock runtime provider. The registry and tests keep that
  decision explicit instead of silently pretending the provider exists.
