# FND algorithm baseline v1

This artifact records bounded current and historical-reference observations.
Every row is informational: no result is a performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `95f51ee4d8cd005956d833b85e03469b92a267169e3593ee793200c504a8d654`
- Source revision: `37bbad6db05f5a329d54a96bb8234905096dad3b`
- Production tree: `runtime/src` at Git object `e002972e3931d5c2984658d485294ef9fa879a99`
- Loaded production closure: `42` module bindings across `2` cases
- Plan SHA-256: `672538014498283c935efce76c0a5244abd280aadaeb5a03a9d835f041db2ebe`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `linux 7.0.0-29-generic x64` / `AMD Ryzen 9 9900X 12-Core Processor` (24 logical)
- RAM: `32214458368` bytes
- Source filesystem: type `61267`, block `4096` bytes
- Fixture filesystem: type `16914836`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 77.031 | 3.639 | 181284864 | 179363840 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 161.952 | 7.898 | 201412608 | 197804032 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 321.727 | 3.623 | 210829312 | 207405056 |
| `patch_delete_parser_historical_comparison` | `hunkCount=8000` | `completed` | 2.340 | 0.244 | 92405760 | 92405760 |
| `patch_delete_parser_historical_comparison` | `hunkCount=16000` | `completed` | 4.971 | 0.273 | 107880448 | 107683840 |
| `patch_delete_parser_historical_comparison` | `hunkCount=32000` | `completed` | 10.296 | 0.947 | 128454656 | 128454656 |

## Assessment notes

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_historical_comparison`: Historical comparison only: artifact commit 3431a40ea, bound to source revision 925f3ec2860abf48e0c6c0830d135da2587a4d69 (JSON SHA-256 8c72fc88fd10dfde2f91bd7cc3ce8028af552781b7b699db9931529cac0abd07), recorded a 355.764281 ms median for 32,000 delete hunks while the old parser repeatedly sliced the unconsumed suffix. Current production advances line indices without suffix slicing; this case replays the same generated workload and is not a performance threshold.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision 37bbad6db05f5a329d54a96bb8234905096dad3b --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
