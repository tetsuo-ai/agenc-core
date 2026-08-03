# FND algorithm baseline v1

This artifact records bounded observations of known failures. Every row is
informational: no current result is a passing performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `2e98826127e7a2ec265ac8d711a9f15bbdfbb94495fd398348a1dd5fcb6b871f`
- Source revision: `50d98df4fadda6ee413642c1bc1778db3efef923`
- Production tree: `runtime/src` at Git object `f513bf05f1d51d9337e0baff7b202eb5d9a5fd54`
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
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 96.943 | 1.136 | 171630592 | 171630592 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 188.725 | 6.763 | 224837632 | 224837632 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 350.727 | 8.547 | 195485696 | 195485696 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=8000` | `completed` | 3.008 | 0.242 | 88399872 | 88399872 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=16000` | `completed` | 5.891 | 0.808 | 104845312 | 104845312 |
| `patch_delete_parser_suffix_slicing` | `hunkCount=32000` | `completed` | 12.317 | 0.865 | 126595072 | 126595072 |

## Known-failure policy

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_suffix_slicing`: Delete-only parsing repeatedly slices the unconsumed suffix; the prior audit observed about 28 ms/238 ms/2.98 s at 16k/32k/64k lines.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision 50d98df4fadda6ee413642c1bc1778db3efef923 --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
