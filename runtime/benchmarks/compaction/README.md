# C2 compaction benchmarks

The C2 benchmark surface has two provider-independent parts. Neither makes a
provider-quality or network-latency claim.

## Maximum-scale transaction benchmark

This benchmark exercises the frozen maximum algorithmic inputs:

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
performance claims.

## Versioned held-out offline evaluation

[`held-out-corpus.v1.json`](held-out-corpus.v1.json) is a SHA-256-bound replay
corpus with fixed factual checklists, recovery-critical facts, and injection
canaries. Candidate code receives only the expanded messages and output budget;
the evaluator alone receives the answer keys. The checked-in
[`offline-results.v1.json`](offline-results.v1.json) can therefore be reproduced
without credentials or network access.

The candidates are deliberately named by what they actually are:

| Candidate | What is measured |
| --- | --- |
| `c2_planner_deterministic_extractive_proxy_v1` | The production C2 planner followed by a local deterministic extractive proxy. This is planner/safety evidence, not the production provider summarizer. |
| `tail_window_deterministic_extractive_baseline_v1` | A local tail-window extractor used as a weak comparison. It is not provider-native. |

Both candidates execute exactly zero provider calls. The report separately
records the C2 plan's preflighted provider-call and input-token counts, so
planned work cannot be mistaken for calls that happened.

Every candidate is scored under the same per-case gates:

- at least 80 percent exact factual-checklist recall;
- no injection canary in the output;
- every output statement bound to an exact source-message substring;
- at least 20 percent byte reduction and at least 1,024 estimated tokens saved;
- complete recall of recovery-critical facts.

The result also reports source/output bytes and deterministic token estimates,
planned and executed calls, planned input tokens, local elapsed time, RSS delta,
sentence-operation counts, and the production planner's work counters. Timings
and RSS are diagnostic measurements; `--check` compares only deterministic
fields against the committed result.

Run or verify it with the repository-pinned toolchain:

```sh
npm --workspace=@tetsuo-ai/runtime run benchmark:compaction-offline
npm --workspace=@tetsuo-ai/runtime run check:compaction-offline
```

After a reviewed corpus or candidate change, regenerate the committed artifact
with `benchmark:compaction-offline:write`, inspect the diff, and run the check.
Provider-native quality, cost, and network latency still require a separately
authorized online evaluation; this harness never fabricates those results.
