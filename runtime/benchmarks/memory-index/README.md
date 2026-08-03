# Full-corpus memory index benchmark

This benchmark is the C3b scaling and relevance gate. It measures initial
build, incremental update, query p50/p95, resident memory, derived database
size, watcher convergence, one bounded audit slice, and an actual two-process
writer-lease race against generated memory headers. The full profile covers
10k, 100k, and 1m entries; the quick profile is a bounded local smoke.

```sh
cd runtime
node --import tsx benchmarks/memory-index/run.mjs
node --import tsx benchmarks/memory-index/run.mjs --full
```

`held-out.v1.json` is the versioned relevance contract. Its deliberately old
relevant memories are absent from a newest-200 baseline. Changes to tokenizer,
BM25, RRF, or relevance tolerances require an explicit ranking-contract review
rather than silent constant tuning.
