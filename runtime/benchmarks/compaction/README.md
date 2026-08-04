# C2 compaction transaction benchmark

This benchmark exercises the frozen maximum algorithmic inputs without a
network provider:

- 100,000 active-history references compacted, chunked, reconstructed, and
  deterministically hydrated;
- one 64 MiB source payload split into canonical JSONL-safe chunks and
  reconstructed with its digest chain intact; and
- the maximum 64-leaf map/reduce topology, which must require exactly 73
  provider calls and must never add calls for singleton remainders.

Run it with the repository-pinned toolchain:

```sh
npm --workspace=@tetsuo-ai/runtime run benchmark:compaction
```

The command writes one JSON result to stdout. `splitCodeUnitsVisited` must equal
the corresponding canonical UTF-8 byte count for these ASCII fixtures; this is
the deterministic operation-count proof for the single-pass splitter. The
elapsed-time and RSS ceilings are regression tripwires, not cross-machine
performance claims. Provider quality, cost, and latency need a separately
versioned held-out evaluation because a synthetic local benchmark cannot
measure summary quality honestly.
