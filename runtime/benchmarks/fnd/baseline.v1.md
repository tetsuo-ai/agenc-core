# FND algorithm baseline v1

This artifact records bounded observations of known failures. Every row is
informational: no current result is a passing performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `c35253fa5335f4ebb56b7b8b4f93bc834a4177b9a3c0ba792631c164af54cc73`
- Source revision: `fd1fbde9c2f075bbb55b130029c49fe0dcd67504`
- Production tree: `runtime/src` at Git object `b80aaaefecf7a972e578de2b35cef01ae3a29c3c`
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
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 4.773 | 0.188 | 90755072 | 90755072 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 15.387 | 1.380 | 123645952 | 123645952 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 40.152 | 3.025 | 134135808 | 134135808 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=8000` | `completed` | 6.491 | 0.260 | 122109952 | 121585664 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=16000` | `completed` | 23.991 | 3.718 | 160219136 | 160219136 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=32000` | `completed` | 311.501 | 7.063 | 263974912 | 235163648 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=32,queryCodeUnits=8` | `completed` | 4.020 | 0.081 | 92233728 | 92233728 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=64,queryCodeUnits=8` | `completed` | 12.382 | 0.169 | 93200384 | 93200384 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=128,queryCodeUnits=8` | `completed` | 48.282 | 0.625 | 137109504 | 137109504 |
| `fuzzy_tui_query_truncation` | `candidateCount=2,indexedQueryCodeUnits=64,queryCodeUnits=69` | `completed` | 0.017 | 0.005 | 79798272 | 79273984 |

## Known-failure policy

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_suffix_slicing`: Delete-only parsing repeatedly slices the unconsumed suffix; the prior audit observed about 28 ms/238 ms/2.98 s at 16k/32k/64k lines.
- `fuzzy_daemon_recursive_scaling`: The daemon matcher memoizes recursive states but scans remaining candidate positions from each state, yielding roughly O(m*n^2) work and allocation.
- `fuzzy_tui_query_truncation`: The TUI matcher silently truncates a 69-code-unit query at 64 and ranks the generated path ending WRONG ahead of the only full-query match ending RIGHT.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision fd1fbde9c2f075bbb55b130029c49fe0dcd67504 --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
