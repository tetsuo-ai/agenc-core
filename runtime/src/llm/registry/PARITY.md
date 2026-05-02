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
  model row feeds guardian approval review selection.
- `provider-info.ts` stores built-in provider defaults, request retry metadata,
  and live metadata URL/auth defaults.
- `features.ts` stores the complete staged feature definition set and
  legacy-key normalization with AgenC-owned names, including structured
  feature config enablement semantics.
