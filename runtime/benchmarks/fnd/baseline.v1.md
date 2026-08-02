# FND algorithm baseline v1

This artifact records bounded observations of known failures. Every row is
informational: no current result is a passing performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `bce843ef52156adb6fcb98a0e6beebb91bef6601faab2174600def0e65aa04c9`
- Source revision: `7b2ae4aba6c86cd6e083c3375ea997c3f25fff31`
- Production tree: `runtime/src` at Git object `ce15d13540397585b28a0f6005825505e216c726`
- Loaded production closure: `11` module bindings across `4` cases
- Plan SHA-256: `d158a4e11ca943e018af33c0df8ddeaef665dbb56ec0c92b07db76abc61cde46`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 7.0.0-28-generic x64` / `AMD Ryzen Threadripper PRO 9975WX 32-Cores` (64 logical)
- RAM: `1081089331200` bytes
- Source filesystem: type `61267`, block `4096` bytes
- Fixture filesystem: type `16914836`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 5.800 | 0.032 | 93896704 | 93896704 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 16.713 | 0.525 | 122593280 | 122593280 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 40.798 | 2.141 | 133062656 | 133062656 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=8000` | `completed` | 5.703 | 0.282 | 119492608 | 118968320 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=16000` | `completed` | 35.235 | 1.126 | 157224960 | 157224960 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=32000` | `completed` | 367.010 | 8.040 | 263073792 | 235520000 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=32,queryCodeUnits=8` | `completed` | 3.939 | 0.068 | 88780800 | 88780800 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=64,queryCodeUnits=8` | `completed` | 12.802 | 0.074 | 92938240 | 92938240 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=128,queryCodeUnits=8` | `completed` | 49.982 | 0.937 | 98557952 | 98557952 |
| `fuzzy_tui_query_truncation` | `candidateCount=2,indexedQueryCodeUnits=64,queryCodeUnits=69` | `completed` | 0.015 | 0.003 | 78041088 | 78041088 |

## Known-failure policy

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_suffix_slicing`: Delete-only parsing repeatedly slices the unconsumed suffix; the prior audit observed about 28 ms/238 ms/2.98 s at 16k/32k/64k lines.
- `fuzzy_daemon_recursive_scaling`: The daemon matcher memoizes recursive states but scans remaining candidate positions from each state, yielding roughly O(m*n^2) work and allocation.
- `fuzzy_tui_query_truncation`: The TUI matcher silently truncates a 69-code-unit query at 64 and ranks the generated path ending WRONG ahead of the only full-query match ending RIGHT.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision 7b2ae4aba6c86cd6e083c3375ea997c3f25fff31 --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
