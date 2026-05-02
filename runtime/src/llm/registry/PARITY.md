# LLM Registry Parity

Upstream reference: `/home/tetsuo/git/co\u0064ex` at commit `48791920a8b122939c4d3feb15673c0a690ca4a0`.

Primary source anchors:
- `co\u0064ex-rs/models-manager/src/model_info.rs`
- `co\u0064ex-rs/models-manager/src/manager.rs`
- `co\u0064ex-rs/models-manager/models.json`
- `co\u0064ex-rs/model-provider-info/src/lib.rs`
- `co\u0064ex-rs/features/src/lib.rs`
- `co\u0064ex-rs/features/src/legacy.rs`

This directory owns the AgenC TypeScript registry for LLM catalog data:
- `model-catalog.ts` stores executable per-model metadata and capability hints.
- `provider-info.ts` stores built-in provider defaults and request retry metadata.
- `features.ts` stores staged feature definitions and legacy-key normalization.
