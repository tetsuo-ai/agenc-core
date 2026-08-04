# FND algorithm baseline v1

This artifact records bounded observations of known failures. Every row is
informational: no current result is a passing performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `bcb50ed24e089a81cac5f993058e61e989c472854cc88fdb4c40b3fdf6b19e39`
- Source revision: `f6f3105db5daba0023073240aa3cecd815fbe7af`
- Production tree: `runtime/src` at Git object `14bc1742a431230bc8aa81dec458f88d3d0899da`
- Loaded production closure: `42` module bindings across `2` cases
- Plan SHA-256: `f845a0595da15849f819d413b42f995107befacfc67ef78a2bf96338fda92025`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 7.0.0-28-generic x64` / `AMD Ryzen Threadripper PRO 9975WX 32-Cores` (64 logical)
- RAM: `1081089331200` bytes
- Source filesystem: type `61267`, block `4096` bytes
- Fixture filesystem: type `16914836`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 82.820 | 2.662 | 179113984 | 177811456 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 158.624 | 3.854 | 194273280 | 190390272 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 325.574 | 11.884 | 207568896 | 203595776 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=8000` | `completed` | 2.799 | 0.126 | 91176960 | 91176960 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=16000` | `completed` | 5.249 | 0.589 | 104910848 | 104386560 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=32000` | `completed` | 10.959 | 0.766 | 127172608 | 127172608 |

## Known-failure policy

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_suffix_slicing`: Delete-only parsing repeatedly slices the unconsumed suffix; the prior audit observed about 28 ms/238 ms/2.98 s at 16k/32k/64k lines.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision f6f3105db5daba0023073240aa3cecd815fbe7af --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
