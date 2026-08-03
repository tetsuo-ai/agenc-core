# FND algorithm baseline v1

This artifact records bounded observations of known failures. Every row is
informational: no current result is a passing performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `e5c85d8624b47f304fd155a390c474d894585ba72f3b2b0be6d0d7898f4e9a7a`
- Source revision: `c63592e6083adee1b48376d64c56c863cddd4045`
- Production tree: `runtime/src` at Git object `807c8b3479a0a8b4605650a31fc1effe0c64f165`
- Loaded production closure: `33` module bindings across `2` cases
- Plan SHA-256: `f845a0595da15849f819d413b42f995107befacfc67ef78a2bf96338fda92025`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 7.0.0-28-generic x64` / `AMD Ryzen Threadripper PRO 9975WX 32-Cores` (64 logical)
- RAM: `1081089331200` bytes
- Source filesystem: type `61267`, block `4096` bytes
- Fixture filesystem: type `16914836`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 86.527 | 5.162 | 173654016 | 173654016 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 169.951 | 4.391 | 190889984 | 186871808 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 366.888 | 15.981 | 206204928 | 202768384 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=8000` | `completed` | 2.681 | 0.381 | 90615808 | 90615808 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=16000` | `completed` | 5.293 | 0.262 | 106942464 | 106942464 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=32000` | `completed` | 12.270 | 0.797 | 127647744 | 127647744 |

## Known-failure policy

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_suffix_slicing`: Delete-only parsing repeatedly slices the unconsumed suffix; the prior audit observed about 28 ms/238 ms/2.98 s at 16k/32k/64k lines.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision c63592e6083adee1b48376d64c56c863cddd4045 --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
