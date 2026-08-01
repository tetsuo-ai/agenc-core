# FND algorithm baseline v1

This artifact records bounded observations of known failures. Every row is
informational: no current result is a passing performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `8c5929a319c1faed7c3a5617475df7cef248c0b9e9d6784d167929086aff20d9`
- Source revision: `925f3ec2860abf48e0c6c0830d135da2587a4d69`
- Production tree: `runtime/src` at Git object `d802c0cd2dccdfa714252859bcd7e19605a8c8fb`
- Loaded production closure: `64` module bindings across `5` cases
- Plan SHA-256: `c2377e6d378a616f8a8e3169a87687c354e6cf4e5a8c0f233ae6c0207281d4ed`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 7.0.0-28-generic x64` / `AMD Ryzen Threadripper PRO 9975WX 32-Cores` (64 logical)
- RAM: `1081089331200` bytes
- Source filesystem: type `61267`, block `4096` bytes
- Fixture filesystem: type `16914836`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 6.457 | 1.249 | 93339648 | 93339648 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 17.100 | 3.121 | 120053760 | 120053760 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 44.252 | 1.567 | 134074368 | 134074368 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=8000` | `completed` | 6.691 | 0.126 | 121462784 | 121462784 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=16000` | `completed` | 29.423 | 4.749 | 160075776 | 159551488 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=32000` | `completed` | 340.953 | 1.747 | 262549504 | 234049536 |
| `regex_fallback_catastrophic_backtracking` | `fileCount=1,repeatedCharacters=30` | `timed_out` | 2521.469 | 0.613 | n/a | 109387776 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=32,queryCodeUnits=8` | `completed` | 3.855 | 0.120 | 93728768 | 93728768 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=64,queryCodeUnits=8` | `completed` | 12.160 | 0.103 | 93052928 | 93052928 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=128,queryCodeUnits=8` | `completed` | 50.605 | 0.916 | 102248448 | 102248448 |
| `fuzzy_tui_query_truncation` | `candidateCount=2,indexedQueryCodeUnits=64,queryCodeUnits=69` | `completed` | 0.013 | 0.001 | 78651392 | 78651392 |

## Known-failure policy

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_suffix_slicing`: Delete-only parsing repeatedly slices the unconsumed suffix; the prior audit observed about 28 ms/238 ms/2.98 s at 16k/32k/64k lines.
- `regex_fallback_catastrophic_backtracking`: The synchronous JavaScript fallback cannot be preempted while V8 evaluates (a+)+$; 30 repeated characters exceeded the external two-second audit kill.
- `fuzzy_daemon_recursive_scaling`: The daemon matcher memoizes recursive states but scans remaining candidate positions from each state, yielding roughly O(m*n^2) work and allocation.
- `fuzzy_tui_query_truncation`: The TUI matcher silently truncates a 69-code-unit query at 64 and ranks the generated path ending WRONG ahead of the only full-query match ending RIGHT.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision 925f3ec2860abf48e0c6c0830d135da2587a4d69 --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
