# FND algorithm baseline v1

This artifact records bounded observations of known failures. Every row is
informational: no current result is a passing performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `ff38e7e34442d38083a0c582f92160bfdb94a11e90e8fb5f5a388ac7818150db`
- Source revision: `702d2b6eb0292b2ba99776ba70f49407358c43d8`
- Production tree: `runtime/src` at Git object `8d6a0075a7f4b2e86367be4e165192c87806b8c7`
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
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 4.948 | 0.302 | 92786688 | 92786688 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 14.561 | 1.689 | 121110528 | 121110528 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 42.425 | 4.469 | 134078464 | 134078464 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=8000` | `completed` | 6.572 | 0.297 | 121704448 | 121704448 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=16000` | `completed` | 31.443 | 2.246 | 157999104 | 157474816 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=32000` | `completed` | 349.164 | 6.773 | 265363456 | 237056000 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=32,queryCodeUnits=8` | `completed` | 3.971 | 0.211 | 93450240 | 93450240 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=64,queryCodeUnits=8` | `completed` | 12.479 | 0.121 | 93229056 | 93229056 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=128,queryCodeUnits=8` | `completed` | 49.577 | 0.262 | 99328000 | 99328000 |
| `fuzzy_tui_query_truncation` | `candidateCount=2,indexedQueryCodeUnits=64,queryCodeUnits=69` | `completed` | 0.013 | 0.002 | 81911808 | 81911808 |

## Known-failure policy

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_suffix_slicing`: Delete-only parsing repeatedly slices the unconsumed suffix; the prior audit observed about 28 ms/238 ms/2.98 s at 16k/32k/64k lines.
- `fuzzy_daemon_recursive_scaling`: The daemon matcher memoizes recursive states but scans remaining candidate positions from each state, yielding roughly O(m*n^2) work and allocation.
- `fuzzy_tui_query_truncation`: The TUI matcher silently truncates a 69-code-unit query at 64 and ranks the generated path ending WRONG ahead of the only full-query match ending RIGHT.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision 702d2b6eb0292b2ba99776ba70f49407358c43d8 --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
