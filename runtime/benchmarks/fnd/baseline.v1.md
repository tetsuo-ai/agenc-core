# FND algorithm baseline v1

This artifact records bounded current and historical-reference observations.
Every row is informational: no result is a performance threshold or gate.
Generated inputs are synthetic and created only for the benchmark process.

- JSON SHA-256: `ea915ff1ff5bdc93ea06dae6780f411762e00b66cb4e0837669cf462d92d82b6`
- Source revision: `60d9ffa9d63e9b3230ac1d43a8c1adbad11cbbb5`
- Production tree: `runtime/src` at Git object `421bd317ac78d52823d932655ddc1e6f86f26d2b`
- Loaded production closure: `51` module bindings across `2` cases
- Plan SHA-256: `672538014498283c935efce76c0a5244abd280aadaeb5a03a9d835f041db2ebe`
- Node/npm: `v26.5.0` / `11.17.0`
- OS/CPU: `darwin 25.5.0 arm64` / `Apple M4 Pro` (12 logical)
- RAM: `25769803776` bytes
- Source filesystem: type `26`, block `4096` bytes
- Fixture filesystem: type `26`, block `4096` bytes
- SQLite/ripgrep: `3.53.3` / `ripgrep 15.0.0 (rev 3a612f88b8)`

| Case | Input | Status | Median ms | MAD ms | Worker peak RSS bytes | RSS lower-bound bytes |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `csv_scheduler_progress_scan` | `rowCount=1000` | `completed` | 78.671 | 3.020 | 194281472 | 194281472 |
| `csv_scheduler_progress_scan` | `rowCount=2000` | `completed` | 157.134 | 5.802 | 263487488 | 263487488 |
| `csv_scheduler_progress_scan` | `rowCount=4000` | `completed` | 306.937 | 2.833 | 246628352 | 246628352 |
| `patch_delete_parser_historical_comparison` | `hunkCount=8000` | `completed` | 2.594 | 0.181 | 96223232 | 96223232 |
| `patch_delete_parser_historical_comparison` | `hunkCount=16000` | `completed` | 5.117 | 0.393 | 113246208 | 113033216 |
| `patch_delete_parser_historical_comparison` | `hunkCount=32000` | `completed` | 10.602 | 0.637 | 135184384 | 135168000 |

## Assessment notes

- `csv_scheduler_progress_scan`: Array.shift queue movement and full progress-map scans have quadratic operation counts; the prior audit observed about 35/112/392 ms at 8k/16k/32k items.
- `patch_delete_parser_historical_comparison`: Historical comparison only: artifact commit 3431a40ea, bound to source revision 925f3ec2860abf48e0c6c0830d135da2587a4d69 (JSON SHA-256 8c72fc88fd10dfde2f91bd7cc3ce8028af552781b7b699db9931529cac0abd07), recorded a 355.764281 ms median for 32,000 delete hunks while the old parser repeatedly sliced the unconsumed suffix. Current production advances line indices without suffix slicing; this case replays the same generated workload and is not a performance threshold.

## Reproduce

Run on the same pinned runtime and machine state; compare medians, MAD,
operation counts, and relative scaling rather than one wall-clock sample.

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --source-revision 60d9ffa9d63e9b3230ac1d43a8c1adbad11cbbb5 --output /tmp/agenc-fnd-baseline.v1.json --markdown-output /tmp/agenc-fnd-baseline.v1.md
npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
```

Completed workers report their actual process high-water RSS from
`process.resourceUsage().maxRSS`, normalized from KiB to bytes. A worker
terminated during synchronous work cannot emit that final high-water mark,
so its peak is `n/a`; its last start RSS remains a clearly labeled lower
bound. Endpoint observations are retained as diagnostics and are never
presented as the worker peak.
