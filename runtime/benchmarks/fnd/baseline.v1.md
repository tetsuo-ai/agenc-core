# FND algorithm baseline v1

This artifact records bounded current and historical-reference observations.
Every row is informational: no result is a performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `0ef8dab783284ca56b94ea25ef24f1fa7e3199ba6670fc17ae67b1f8e6692205`
- Source revision: `2f7e4cdf5016978cfdf133f3cc4a1e66301ec30d`
- Production tree: `runtime/src` at Git object `f265aa3f89af797700f008f4d7bac3c768aa1ee2`
- Loaded production closure: `92` module bindings across `2` cases
- Plan SHA-256: `672538014498283c935efce76c0a5244abd280aadaeb5a03a9d835f041db2ebe`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 7.0.0-30-generic x64` / `AMD Ryzen 9 9900X 12-Core Processor` (24 logical)
- RAM: `32214454272` bytes
- Source filesystem: type `61267`, block `4096` bytes
- Fixture filesystem: type `61267`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 82.245 | 4.536 | 188878848 | 188878848 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 159.303 | 4.261 | 207867904 | 204939264 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 315.652 | 7.554 | 222863360 | 218628096 |
| `patch_delete_parser_historical_comparison` | `hunkCount=8000` | `completed` | 2.549 | 0.266 | 92422144 | 92422144 |
| `patch_delete_parser_historical_comparison` | `hunkCount=16000` | `completed` | 4.935 | 0.334 | 106762240 | 106565632 |
| `patch_delete_parser_historical_comparison` | `hunkCount=32000` | `completed` | 10.061 | 0.437 | 129093632 | 129093632 |

## Assessment notes

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_historical_comparison`: Historical comparison only: artifact commit 3431a40ea, bound to source revision 925f3ec2860abf48e0c6c0830d135da2587a4d69 (JSON SHA-256 8c72fc88fd10dfde2f91bd7cc3ce8028af552781b7b699db9931529cac0abd07), recorded a 355.764281 ms median for 32,000 delete hunks while the old parser repeatedly sliced the unconsumed suffix. Current production advances line indices without suffix slicing; this case replays the same generated workload and is not a performance threshold.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision 2f7e4cdf5016978cfdf133f3cc4a1e66301ec30d --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
