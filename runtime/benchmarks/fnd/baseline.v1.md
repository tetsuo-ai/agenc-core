# FND algorithm baseline v1

This artifact records bounded observations of known failures. Every row is
informational: no current result is a passing performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `e6b7e2ad4e63928d531003e340f3d340b84deef3c20feffe51b775a076d4d2aa`
- Source revision: `bf9d4531e6f259e853dd03dcd2580ee10404c503`
- Production tree: `runtime/src` at Git object `1cf239e1710ad8923e8832c54d6b0706003cd0c4`
- Loaded production closure: `37` module bindings across `4` cases
- Plan SHA-256: `d158a4e11ca943e018af33c0df8ddeaef665dbb56ec0c92b07db76abc61cde46`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 7.0.0-28-generic x64` / `AMD Ryzen Threadripper PRO 9975WX 32-Cores` (64 logical)
- RAM: `1081089331200` bytes
- Source filesystem: type `61267`, block `4096` bytes
- Fixture filesystem: type `16914836`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 83.838 | 3.049 | 174833664 | 174833664 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 178.952 | 4.818 | 189100032 | 186261504 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 373.106 | 23.322 | 204140544 | 201629696 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=8000` | `completed` | 2.886 | 0.444 | 91709440 | 91709440 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=16000` | `completed` | 5.783 | 0.509 | 106840064 | 106840064 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=32000` | `completed` | 11.076 | 1.325 | 127021056 | 127021056 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=32,queryCodeUnits=8` | `completed` | 3.942 | 0.109 | 94523392 | 94523392 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=64,queryCodeUnits=8` | `completed` | 11.698 | 0.152 | 95350784 | 95350784 |
| `fuzzy_daemon_recursive_scaling` | `candidateCount=32,pathStemCodeUnits=128,queryCodeUnits=8` | `completed` | 47.870 | 0.626 | 102785024 | 102785024 |
| `fuzzy_tui_query_truncation` | `candidateCount=2,indexedQueryCodeUnits=64,queryCodeUnits=69` | `completed` | 0.014 | 0.002 | 80330752 | 80330752 |

## Known-failure policy

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_suffix_slicing`: Delete-only parsing repeatedly slices the unconsumed suffix; the prior audit observed about 28 ms/238 ms/2.98 s at 16k/32k/64k lines.
- `fuzzy_daemon_recursive_scaling`: The daemon matcher memoizes recursive states but scans remaining candidate positions from each state, yielding roughly O(m*n^2) work and allocation.
- `fuzzy_tui_query_truncation`: The TUI matcher silently truncates a 69-code-unit query at 64 and ranks the generated path ending WRONG ahead of the only full-query match ending RIGHT.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision bf9d4531e6f259e853dd03dcd2580ee10404c503 --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
