// Updated 2026-04-06 after the runtime hardening batch (PR #174) and
// downstream typecheck/hardening fixes changed benchmark artifact serialization
// shape. The new hash captures the post-hardening artifact bytes for the
// `litesvm_protocol_smoke` corpus v1 baseline. If this drifts again,
// regenerate by running the failing test once and pasting the "Received" hash
// here.
export const BENCHMARK_ARTIFACT_GOLDEN_SHA256_V1 =
  '8691f6e07d2e7b6a60a72af9906d030c8de430d1299ebaa744af38a5f9daf645';
